import Foundation
import Observation
import UniformTypeIdentifiers

struct SharedItem: Identifiable {
    let id = UUID()
    let provider: NSItemProvider
    var pending: PendingAttachment?
    var error: String?
    var isLoading = false

    var filename: String { pending?.filename ?? provider.suggestedName ?? "Shared file" }
}

@Observable
final class ShareModel {
    private weak var context: NSExtensionContext?
    private var client: SunnieClient?
    private var settings: ServerSettings?
    private var didPrepare = false
    private var closed = false
    private var progress: [UUID: Progress] = [:]
    private var createdConversationId: String?
    private let requestId = UUID().uuidString
    private var delivery: Delivery?
    private var deliveryUncertain = false

    private enum Delivery {
        case message(String)
        case steer(String)
    }

    private(set) var items: [SharedItem] = []
    private(set) var conversations: [Conversation] = []
    private(set) var selectedConversationId: String?
    private(set) var needsConnection = false
    private(set) var isPreparing = true
    private(set) var loadingConversations = false
    private(set) var conversationError: String?
    private(set) var isSending = false
    private(set) var submissionStarted = false
    private(set) var needsDeliveryReview = false
    private(set) var sendStatus = ""
    private(set) var error: String?
    var note = ""

    init(context: NSExtensionContext?) {
        self.context = context
    }

    var destinationTitle: String {
        guard let selectedConversationId else { return "New conversation" }
        return conversations.first(where: { $0.id == selectedConversationId })?.displayTitle ?? "Selected conversation"
    }

    var canEdit: Bool { !isSending && !submissionStarted }

    var validationMessage: String? {
        if items.count > PendingAttachment.maxCount { return "Choose up to 8 files to share at once." }
        do {
            try PendingAttachment.validate(items.compactMap(\.pending))
            return nil
        } catch { return error.localizedDescription }
    }

    var canSend: Bool {
        !closed && !needsConnection && !needsDeliveryReview && !isPreparing && !isSending && !items.isEmpty
            && items.allSatisfy { $0.pending != nil && !$0.isLoading && $0.error == nil }
            && validationMessage == nil
    }

    func prepare() async {
        guard !didPrepare else { return }
        didPrepare = true
        defer { isPreparing = false }
        let settings = ServerSettings.loadShared()
        guard settings.isConfigured, let url = settings.baseURL else {
            needsConnection = true
            return
        }
        self.settings = settings
        client = SunnieClient(baseURL: url, apiKey: settings.apiKey)
        let input = context?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = input.flatMap { $0.attachments ?? [] }
        let files = providers.filter { fileType($0) != nil || $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        // Safari includes its page URL alongside a PDF; it is metadata, not a second file.
        items = (files.isEmpty ? providers : files).map { SharedItem(provider: $0) }
        if items.isEmpty { error = "No files were shared. Select an image or document and try again." }
        await refreshConversations()
        await loadMissingItems()
    }

    func refreshConversations() async {
        guard let client, !loadingConversations, !closed else { return }
        loadingConversations = true
        defer { loadingConversations = false }
        do {
            conversations = try await client.listConversations(limit: 100)
            conversationError = nil
        } catch { conversationError = error.localizedDescription }
    }

    func selectConversation(_ id: String?) {
        guard canEdit else { return }
        selectedConversationId = id
        createdConversationId = nil
        error = nil
    }

    func remove(_ id: UUID) {
        guard canEdit, let item = items.first(where: { $0.id == id }) else { return }
        progress.removeValue(forKey: id)?.cancel()
        item.pending?.removeLocalFile()
        items.removeAll { $0.id == id }
        error = nil
        Task { await loadMissingItems() }
    }

    func retry(_ id: UUID) async {
        guard canEdit, items.count <= PendingAttachment.maxCount else { return }
        await loadItem(id)
    }

    private func loadMissingItems() async {
        guard items.count <= PendingAttachment.maxCount, !closed else { return }
        for id in items.filter({ $0.pending == nil && $0.error == nil && !$0.isLoading }).map(\.id) {
            await loadItem(id)
        }
    }

    private func loadItem(_ id: UUID) async {
        guard !closed, let index = items.firstIndex(where: { $0.id == id }), !items[index].isLoading else { return }
        let provider = items[index].provider
        items[index].isLoading = true
        items[index].error = nil
        do {
            let pending = try await readFile(provider, id: id)
            guard !closed, let current = items.firstIndex(where: { $0.id == id }) else {
                pending.removeLocalFile()
                return
            }
            do { try PendingAttachment.validate(items.compactMap(\.pending) + [pending]) }
            catch {
                pending.removeLocalFile()
                throw error
            }
            items[current].pending?.removeLocalFile()
            items[current].pending = pending
        } catch {
            if let current = items.firstIndex(where: { $0.id == id }) {
                items[current].error = error.localizedDescription
            }
        }
        progress[id] = nil
        if let current = items.firstIndex(where: { $0.id == id }) { items[current].isLoading = false }
    }

    private func readFile(_ provider: NSItemProvider, id: UUID) async throws -> PendingAttachment {
        let name = provider.suggestedName
        if let type = fileType(provider) {
            return try await withCheckedThrowingContinuation { continuation in
                progress[id] = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                    do {
                        guard let url else { throw error ?? AttachmentError.message("This file could not be opened. Try sharing it again.") }
                        // The provider removes this URL after its callback returns.
                        continuation.resume(returning: try PendingAttachment.importFile(url: url, suggestedName: name))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier), provider.canLoadObject(ofClass: NSURL.self) {
            return try await withCheckedThrowingContinuation { continuation in
                progress[id] = provider.loadObject(ofClass: NSURL.self) { item, error in
                    do {
                        guard let url = item as? URL, url.isFileURL else {
                            throw error ?? AttachmentError.message("Choose a file rather than a web link.")
                        }
                        continuation.resume(returning: try PendingAttachment.importFile(url: url, suggestedName: name))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
        throw AttachmentError.message("This item is not a supported file. Share an image or document instead.")
    }

    private func fileType(_ provider: NSItemProvider) -> String? {
        provider.registeredTypeIdentifiers.first { identifier in
            guard identifier != "com.apple.active-webpage", let type = UTType(identifier) else { return false }
            return type.conforms(to: .data) && !type.conforms(to: .url)
        }
    }

    func send() async {
        guard canSend, let client else { return }
        // A connection changed in the containing app must never send to the old server.
        guard ServerSettings.loadShared() == settings else {
            error = "Your connection changed. Close this sheet and share again."
            return
        }
        isSending = true
        error = nil
        defer { isSending = false; sendStatus = "" }
        do {
            let conversationId: String
            if let existing = selectedConversationId ?? createdConversationId {
                conversationId = existing
            } else {
                sendStatus = "Creating conversation…"
                let conversation = try await client.createConversation()
                guard !closed else { return }
                createdConversationId = conversation.id
                conversationId = conversation.id
            }
            for id in items.map(\.id) {
                guard let index = items.firstIndex(where: { $0.id == id }), var pending = items[index].pending else { continue }
                if pending.uploaded == nil {
                    sendStatus = "Uploading \(pending.filename)…"
                    pending.uploaded = try await client.uploadAttachment(pending)
                    guard !closed else { return }
                    items[index].pending = pending
                }
            }
            let attachmentIds = items.compactMap { $0.pending?.uploaded?.id }
            guard attachmentIds.count == items.count else { throw AttachmentError.message("Some files have not uploaded. Try again.") }
            sendStatus = "Sending to Sunnie…"
            if delivery == nil {
                let conversation = try await client.getConversation(conversationId)
                guard !closed else { return }
                delivery = conversation.activeRunId.map(Delivery.steer) ?? .message(conversationId)
            }
            submissionStarted = true
            for attempt in 0..<2 {
                do {
                    switch delivery {
                    case .steer(let run):
                        _ = try await client.steer(runId: run, text: note, timezone: TimeZone.current.identifier,
                                                   requestId: requestId, attachmentIds: attachmentIds)
                    case .message(let id):
                        _ = try await client.submitMessage(id, text: note, attachmentIds: attachmentIds,
                                                           timezone: TimeZone.current.identifier, requestId: requestId)
                    case nil:
                        throw AttachmentError.message("Choose a conversation and try again.")
                    }
                    finish()
                    return
                } catch let failure as APIError where failure.status == 409 && attempt == 0 {
                    guard !deliveryUncertain else {
                        needsDeliveryReview = true
                        throw AttachmentError.message("Delivery could not be confirmed. Check this conversation in Sunnie before sharing again.")
                    }
                    // A run can start or finish while the user chooses where to share.
                    let conversation = try await client.getConversation(conversationId)
                    guard !closed else { return }
                    delivery = conversation.activeRunId.map(Delivery.steer) ?? .message(conversationId)
                } catch {
                    if let failure = error as? APIError, let status = failure.status, (400..<500).contains(status) {
                        throw error
                    }
                    deliveryUncertain = true
                    throw error
                }
            }
        } catch { self.error = error.localizedDescription }
    }

    func cancel() {
        guard !isSending else { return }
        discard()
        context?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    func discard() {
        closed = true
        for task in progress.values { task.cancel() }
        progress.removeAll()
        for item in items { item.pending?.removeLocalFile() }
    }

    private func finish() {
        discard()
        context?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
