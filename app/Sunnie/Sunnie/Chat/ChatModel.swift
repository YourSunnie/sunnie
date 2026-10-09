import Foundation
import Observation

/// One open conversation: loads history, sends messages, follows the run's stream and
/// re-attaches when the connection drops or the server restarts. The conversation is created on the first send.
@Observable
final class ChatModel {
    private let client: SunnieClient
    private(set) var conversation: Conversation?
    private(set) var timeline = ChatTimeline()
    private(set) var isLoadingHistory = false
    /// Asking the server to start the greeting; the chat shows no empty state meanwhile.
    private(set) var isGreeting = false
    private(set) var canLoadEarlier = false
    var draft = ""
    private(set) var quotes: [MessageQuote] = []
    private(set) var attachments: [PendingAttachment] = []
    private(set) var isUploading = false
    private(set) var uploadProgress: String?
    private var sentFiles: [String: PendingAttachment] = [:]
    var error: String?
    /// Model override chosen before the conversation exists; applied on create.
    var pendingModel: String?

    /// Approvals whose answer is on its way to the server.
    private(set) var answeringApprovals: Set<String> = []
    /// The browser the user holds (or is taking): shown as the take-over sheet while set.
    var browserHandoff: BrowserHandoff?
    /// Taking the browser, or declining to: the row's buttons wait meanwhile.
    private(set) var answeringHandoff = false
    /// What the user set in the interactive cards of this chat's replies.
    let cards: ChatCards

    private var streamTask: Task<Void, Never>?
    private var streamId: UUID?
    private static let pageSize = 60

    init(client: SunnieClient, conversation: Conversation?, draft: String = "", quotes: [MessageQuote] = []) {
        self.client = client
        self.cards = ChatCards(client: client)
        self.conversation = conversation
        self.draft = draft
        self.quotes = quotes
    }

    var title: String { conversation?.displayTitle ?? "New conversation" }
    var isRunning: Bool { timeline.isRunning }
    var items: [TimelineItem] { timeline.items }
    var modelSpec: String? { conversation?.model ?? pendingModel }
    var isCheckIns: Bool { conversation?.kind == "heartbeat" }

    /// The answers the last message offers as quick replies, once it has finished and the user
    /// has not written since.
    var quickReplies: [String] {
        guard !timeline.isRunning, timeline.pendingUser == nil, timeline.steers.isEmpty,
              case .assistantText(_, let text, _, false)? = timeline.items.last else { return [] }
        return Markdown.quickReplies(text)
    }

    // MARK: Loading

    func load() async {
        guard let conversation, !isLoadingHistory else { return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }
        do {
            let fresh = try await client.getConversation(conversation.id)
            self.conversation = fresh
            let messages = try await client.listMessages(conversation.id, limit: Self.pageSize, hideQuiet: isCheckIns)
            insertMessages(messages)
            canLoadEarlier = messages.count >= Self.pageSize
            await cards.load(conversation.id)
            if let runId = fresh.activeRunId, streamTask == nil {
                timeline.resume(runId: runId)
                follow { [client] in client.runEvents(runId, after: 0) }
            }
        } catch {
            // The screen went away mid-load (a tab that came and went at launch); it loads
            // again when it is back.
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func loadEarlier() async {
        guard let conversation, let first = timeline.firstSeq, !isLoadingHistory else { return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }
        do {
            let older = try await client.listMessages(conversation.id, beforeSeq: first, limit: Self.pageSize, hideQuiet: isCheckIns)
            insertMessages(older)
            canLoadEarlier = older.count >= Self.pageSize
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Called when the app comes back to the foreground: catch up on anything missed.
    func reconnectIfNeeded() async {
        guard let conversation else { return }
        if let runId = timeline.runId, timeline.isRunning {
            // A suspended URLSession stream can remain alive without delivering its last events.
            _ = await refresh()
            guard timeline.isRunning, timeline.runId == runId else { return }
            let after = timeline.lastSeq
            follow { [client] in client.runEvents(runId, after: after) }
            return
        }
        // Not running as far as we know; the server may have finished (or started) something.
        do {
            let fresh = try await client.getConversation(conversation.id)
            self.conversation = fresh
            let newer = try await client.listMessages(conversation.id, afterSeq: timeline.lastMessageSeq ?? 0, limit: 500, hideQuiet: isCheckIns)
            insertMessages(newer)
            if let runId = fresh.activeRunId {
                timeline.resume(runId: runId)
                follow { [client] in client.runEvents(runId, after: 0) }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Opens a new user's first chat: the server starts Sunnie's greeting, and the chat follows it.
    func greet() async {
        guard conversation == nil, !timeline.isRunning, !isGreeting else { return }
        isGreeting = true
        defer { isGreeting = false }
        do {
            let started = try await client.startGreeting(timezone: TimeZone.current.identifier)
            conversation = started
            if let runId = started.activeRunId {
                timeline.resume(runId: runId)
                follow { [client] in client.runEvents(runId, after: 0) }
            }
        } catch {
            // A greeting is a nicety: met already (another device), or not now, the chat is still a chat.
        }
    }

    /// Sends a quick reply as if the user had typed it.
    /// A card's "reply": sent as the user's message, or put in the message box when they are
    /// already writing one, so nothing they typed is lost.
    func sendCardReply(_ text: String) async {
        guard draft.isEmpty, attachments.isEmpty, quotes.isEmpty, !isRunning else {
            draft = draft.isEmpty ? text : draft + "\n\n" + text
            return
        }
        draft = text
        await send()
    }

    func sendQuickReply(_ answer: String) async {
        guard draft.isEmpty, attachments.isEmpty, quotes.isEmpty else { return }
        draft = answer
        await send()
    }

    // MARK: Sending

    func addAttachments(_ files: [PendingAttachment]) {
        do {
            try PendingAttachment.validate(attachments + files)
            attachments += files
        } catch {
            files.forEach { $0.removeLocalFile() }
            self.error = error.localizedDescription
        }
    }

    func removeAttachment(_ id: String) {
        guard !isUploading, let file = attachments.first(where: { $0.id == id }) else { return }
        file.removeLocalFile()
        attachments.removeAll { $0.id == id }
    }

    func addQuote(_ quote: MessageQuote) {
        guard !isUploading else { return }
        guard !quotes.contains(where: { $0.kind == quote.kind && $0.text == quote.text }) else { return }
        guard quotes.count < MessageQuote.maxCount,
              quote.text.utf16.count <= MessageQuote.maxCharacters,
              quotes.reduce(quote.text.utf16.count, { $0 + $1.text.utf16.count }) <= MessageQuote.maxTotalCharacters else {
            error = "Attach up to 8 quotes, with 8,000 characters each and 32,000 in total. Select a shorter passage if needed."
            return
        }
        quotes.append(quote)
    }

    func removeQuote(_ id: String) {
        guard !isUploading else { return }
        quotes.removeAll { $0.id == id }
    }

    private func restoreQuotes(_ restored: [MessageQuote]) {
        let ids = Set(quotes.map(\.id))
        quotes += restored.filter { !ids.contains($0.id) }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isUploading, !text.isEmpty || !attachments.isEmpty || !quotes.isEmpty else { return }
        guard !timeline.isRunning || timeline.runId != nil else { return }
        isUploading = true
        defer { isUploading = false; uploadProgress = nil }
        do {
            try PendingAttachment.validate(attachments)
            guard quotes.count <= MessageQuote.maxCount,
                  quotes.allSatisfy({ $0.text.utf16.count <= MessageQuote.maxCharacters }),
                  quotes.reduce(0, { $0 + $1.text.utf16.count }) <= MessageQuote.maxTotalCharacters else {
                throw AttachmentError.message("Remove some quotes before sending. A message can contain up to 8 quotes and 32,000 quoted characters.")
            }
            for index in attachments.indices where attachments[index].uploaded == nil {
                uploadProgress = "Uploading \(index + 1) of \(attachments.count)…"
                attachments[index].uploaded = try await client.uploadAttachment(attachments[index])
            }
        } catch {
            self.error = error.localizedDescription
            return
        }
        let files = attachments
        let quoted = quotes
        let uploaded = files.compactMap(\.uploaded)
        if timeline.isRunning {
            await steer(text, files: files, quotes: quoted)
            return
        }
        draft = ""
        attachments = []
        quotes = []
        for file in files { if let id = file.uploaded?.id { sentFiles[id] = file } }
        timeline.beginSend(text: text, attachments: uploaded, quotes: quoted)
        do {
            if conversation == nil {
                conversation = try await client.createConversation(model: pendingModel)
            }
        } catch {
            timeline.cancelSend()
            draft = text
            attachments = files
            restoreQuotes(quoted)
            self.error = error.localizedDescription
            return
        }
        // One id for this message, however often it has to be sent: a retry after a dropped
        // connection attaches to the run the first attempt started rather than asking twice.
        let id = conversation!.id
        let requestId = UUID().uuidString
        let zone = TimeZone.current.identifier
        follow(sending: text, files: files, quotes: quoted) { [client] in
            client.sendMessage(id, text: text, timezone: zone, requestId: requestId, attachmentIds: uploaded.map(\.id), quotes: quoted)
        }
    }

    /// Says something to the run that is at work. The server lets it join between two steps, or
    /// makes it the next run if this one ends first.
    private func steer(_ text: String, files: [PendingAttachment], quotes quoted: [MessageQuote]) async {
        // Until the run has an id there is nothing to address; the text stays in the composer.
        guard let runId = timeline.runId else { return }
        draft = ""
        attachments = []
        quotes = []
        let uploaded = files.compactMap(\.uploaded)
        for file in files { if let id = file.uploaded?.id { sentFiles[id] = file } }
        let id = UUID().uuidString
        timeline.beginSteer(id: id, text: text, attachments: uploaded, quotes: quoted)
        do {
            _ = try await client.steer(runId: runId, text: text, timezone: TimeZone.current.identifier, requestId: id, attachmentIds: uploaded.map(\.id), quotes: quoted)
        } catch {
            timeline.cancelSteer(id: id)
            if draft.isEmpty { draft = text }
            restoreFiles(files)
            restoreQuotes(quoted)
            // 409: the run ended a moment ago, so sending again is an ordinary send.
            if (error as? APIError)?.status != 409 { self.error = error.localizedDescription }
        }
    }

    func cancel() async {
        guard let runId = timeline.runId else { return }
        do {
            _ = try await client.cancelRun(runId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Whether the run is holding this tool call until the user allows or denies it.
    /// Only a row of the step in progress can be waiting: some providers reuse tool call ids, so
    /// an earlier, finished call may carry the same one.
    func awaitsApproval(_ item: TimelineItem) -> Bool {
        guard case .tool(_, let callId, _, _, _, _) = item else { return false }
        return timeline.awaitingApproval.contains(callId) && timeline.live.contains(item)
    }

    func resolveApproval(_ toolCallId: String, approved: Bool) async {
        guard let runId = timeline.runId, !answeringApprovals.contains(toolCallId) else { return }
        answeringApprovals.insert(toolCallId)
        defer { answeringApprovals.remove(toolCallId) }
        do {
            _ = try await client.resolveApproval(runId: runId, toolCallId: toolCallId, approved: approved)
        } catch let error as APIError where error.status == 404 {
            // Already answered (or the run is over); the stream will say what happened.
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Browser hand-off

    /// What the run wants the user to do in the browser, when this row is the call waiting for it.
    func handoffReason(for item: TimelineItem) -> String? {
        guard case .tool(_, let callId, _, _, _, _) = item, timeline.live.contains(item) else { return nil }
        return timeline.awaitingHandoff[callId]
    }

    /// Takes the browser over: the agent's request, or a hand-off of the user's own. Opens the sheet.
    func takeOverBrowser() async {
        guard !answeringHandoff else { return }
        answeringHandoff = true
        defer { answeringHandoff = false }
        do {
            browserHandoff = try await client.takeBrowser()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Will not take the browser right now; the agent carries on without it.
    func declineHandoff() async {
        guard !answeringHandoff else { return }
        answeringHandoff = true
        defer { answeringHandoff = false }
        do {
            try await client.endBrowserHandoff(outcome: "declined")
        } catch let error as APIError where error.status == 404 {
            // Already over (the run was stopped, or it was answered elsewhere).
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Conversation settings

    func rename(_ title: String) async {
        guard let conversation else { return }
        do {
            self.conversation = try await client.updateConversation(conversation.id, title: .some(title.isEmpty ? nil : title))
        } catch {
            self.error = error.localizedDescription
        }
    }

    func setModel(_ spec: String?) async {
        guard let conversation else {
            pendingModel = spec
            return
        }
        do {
            self.conversation = try await client.updateConversation(conversation.id, model: .some(spec))
        } catch {
            self.error = error.localizedDescription
        }
    }

    func compact() async -> CompactResult? {
        guard let conversation else { return nil }
        do {
            return try await client.compact(conversation.id)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    // MARK: Streaming

    /// How often a dropped stream is taken up again before giving up: with the pauses below,
    /// about a minute and a half — long enough for the server to be restarted under a run.
    private static let maxReconnects = 14

    /// Follows a run's event stream until the run is over. A stream that drops is taken up again:
    /// after the last event seen while the run is known, or — for a send that never got an
    /// answer — by sending again under the same request id. The server keeps a run going
    /// through a restart, so "the stream ended" only means "ask again".
    private func follow(sending text: String? = nil, files: [PendingAttachment] = [], quotes: [MessageQuote] = [], _ open: @escaping () -> AsyncThrowingStream<RunEvent, Error>) {
        streamTask?.cancel()
        let id = UUID()
        streamId = id
        streamTask = Task { [weak self] in
            guard let self else { return }
            defer {
                // A cancelled stream must not clear the replacement stream's handle.
                if streamId == id { streamTask = nil; streamId = nil }
            }
            var stream = open()
            var attempt = 0
            while !Task.isCancelled {
                var failure: Error?
                do {
                    for try await event in stream {
                        if Task.isCancelled { break }
                        attempt = 0
                        timeline.apply(event)
                        if case .message(let message) = event.kind {
                            for attachment in message.attachments ?? [] {
                                sentFiles.removeValue(forKey: attachment.id)?.removeLocalFile()
                            }
                        }
                    }
                } catch {
                    failure = error
                }
                if Task.isCancelled { break }
                if !timeline.isRunning {
                    restoreQuotes(timeline.takeUnsentQuotes())
                    let unsent = timeline.takeUnsentSteers()
                    if !unsent.isEmpty, draft.isEmpty { draft = unsent.joined(separator: "\n\n") }
                    restoreFiles(timeline.takeUnsentAttachments().compactMap { self.sentFiles.removeValue(forKey: $0.id) })
                    // A steer that came too late for the run becomes the next run on the server.
                    guard !timeline.steers.isEmpty, let fresh = await refresh(), let next = fresh.activeRunId else { break }
                    if Task.isCancelled { break }
                    timeline.resume(runId: next)
                    stream = client.runEvents(next, after: 0)
                    continue
                }

                // The server said no (409: a run is already active, 400, 404…): trying again will not help.
                if let refused = failure as? APIError, refused.status != nil {
                    giveUp(text, files: files, quotes: quotes, message: refused.localizedDescription)
                    break
                }
                attempt += 1
                guard attempt <= Self.maxReconnects else {
                    giveUp(text, files: files, quotes: quotes, message: "Connection lost: \(failure?.localizedDescription ?? "the server stopped answering").")
                    break
                }
                try? await Task.sleep(for: .seconds(min(8, Double(attempt) * 1.5)))
                if Task.isCancelled { break }

                if let runId = timeline.runId {
                    // The run may have finished while the stream was down; the conversation says.
                    let fresh = await refresh()
                    if Task.isCancelled { break }
                    if let fresh, fresh.activeRunId == nil {
                        timeline.abandonRun(message: nil)
                        break
                    }
                    stream = client.runEvents(runId, after: timeline.lastSeq)
                } else {
                    stream = open()
                }
            }
        }
    }

    /// The run cannot be followed any further. A message that never reached a run goes back
    /// into the composer.
    private func giveUp(_ text: String?, files: [PendingAttachment], quotes: [MessageQuote], message: String) {
        if let text, timeline.runId == nil {
            timeline.cancelSend()
            if draft.isEmpty { draft = text }
            restoreFiles(files)
            restoreQuotes(quotes)
            error = message
        } else {
            timeline.abandonRun(message: message)
        }
    }

    private func restoreFiles(_ files: [PendingAttachment]) {
        let current = Set(attachments.map(\.id))
        attachments += files.filter { !current.contains($0.id) }
    }

    /// Catches up on stored messages. Nil when the server cannot be reached.
    private func refresh() async -> Conversation? {
        guard let conversation else { return nil }
        do {
            let fresh = try await client.getConversation(conversation.id)
            let newer = try await client.listMessages(conversation.id, afterSeq: timeline.lastMessageSeq ?? 0, limit: 500, hideQuiet: isCheckIns)
            guard !Task.isCancelled else { return nil }
            self.conversation = fresh
            insertMessages(newer)
            await cards.load(conversation.id)
            return fresh
        } catch {
            return nil
        }
    }

    private func insertMessages(_ messages: [Message]) {
        timeline.insert(messages)
        for message in messages {
            for attachment in message.attachments ?? [] {
                sentFiles.removeValue(forKey: attachment.id)?.removeLocalFile()
            }
        }
    }
}
