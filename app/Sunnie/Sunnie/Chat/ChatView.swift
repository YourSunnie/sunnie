import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// `person`: the one-chat mode's chat, a tab of its own that reads like messages with a person.
nonisolated enum ChatStyle: Hashable, Sendable { case standard, person }

/// Told when a new chat's first send has created its conversation (the Mac's sidebar selects it).
nonisolated struct ChatCreatedAction: Sendable {
    let created: @MainActor @Sendable (Conversation) -> Void

    @MainActor func callAsFunction(_ conversation: Conversation) { created(conversation) }
}

extension EnvironmentValues {
    @Entry var chatCreated: ChatCreatedAction?
}

struct ChatView: View {
    let style: ChatStyle
    /// The one-chat mode's hand-offs (Home's quotes and asks); only the one chat takes them.
    let oneChat: OneChat?
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(CheckInsModel.self) private var checkIns: CheckInsModel?
    @Environment(Notifications.self) private var notifications: Notifications?
    @Environment(\.chatCreated) private var chatCreated
    @State private var model: ChatModel
    @State private var renameText = ""
    @State private var showRename = false
    @State private var confirmStartOver = false
    @State private var compactResult: CompactResult?
    @State private var showCompactResult = false
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isImporting = false
    @State private var followsLatest = true
    @State private var isUserScrolling = false
    /// Steps rows the user opened; kept here so they stay open as the lazy stack recycles rows.
    @State private var expandedSteps: Set<String> = []
    @FocusState private var composerFocused: Bool

    /// `draft` and `quotes` start the composer with something for the user to send, as a Home
    /// widget's "ask" or a swiped widget does.
    init(client: SunnieClient, conversation: Conversation?, draft: String = "", quotes: [MessageQuote] = [],
         style: ChatStyle = .standard, oneChat: OneChat? = nil) {
        self.style = style
        self.oneChat = oneChat
        _model = State(initialValue: ChatModel(client: client, conversation: conversation, draft: draft, quotes: quotes))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: style == .person ? 12 : 18) {
                    if model.canLoadEarlier {
                        Button {
                            followsLatest = false
                            Task { await model.loadEarlier() }
                        } label: {
                            HStack(spacing: 8) {
                                if model.isLoadingHistory { ProgressView().controlSize(.small) }
                                Text("Load earlier messages")
                            }
                            .frame(minHeight: 44)
                            .frame(maxWidth: .infinity)
                        }
                            .font(.footnote)
                            .disabled(model.isLoadingHistory)
                    }
                    let rows = visibleRows(ChatRow.rows(from: model.items))
                    let liveActivity = model.isRunning ? model.timeline.activity : nil
                    let lastId = rows.last?.id
                    let endsInSteps = if case .steps? = rows.last { true } else { false }
                    ForEach(rows) { row in
                        switch row {
                        case .item(let item):
                            TimelineRow(item: item, approval: approval(for: item), handoff: handoff(for: item))
                                .id(row.id)
                        case let .steps(id, items):
                            StepsRow(
                                items: items,
                                activity: id == lastId ? liveActivity : nil,
                                expanded: expandedBinding(id),
                                approval: approval(for:),
                                handoff: handoff(for:)
                            )
                            .id(row.id)
                        }
                    }
                    let replies = model.quickReplies
                    if !replies.isEmpty, model.draft.isEmpty, model.attachments.isEmpty, model.quotes.isEmpty {
                        QuickReplies(answers: replies) { answer in
                            followsLatest = true
                            Task { await model.sendQuickReply(answer) }
                        } writeOwn: {
                            composerFocused = true
                        }
                        .id("replies")
                    }
                    if let activity = liveActivity {
                        // A trailing steps row already says what the run is doing.
                        if !endsInSteps { StatusRow(activity: activity) }
                    } else if style == .standard, !app.flavor.isHosted, let usage = model.timeline.lastUsage {
                        UsageRow(usage: usage, model: model.timeline.lastRunModel)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .frame(maxWidth: Garden.readingWidth)
                .frame(maxWidth: .infinity)
            }
            // Outside the lazy stack, so it centres in the visible area of an empty chat.
            .overlay {
                // While Sunnie says hello, the chat waits for her first words rather than suggesting any.
                if model.items.isEmpty, !model.isGreeting, !model.isRunning {
                    if model.isLoadingHistory {
                        ProgressView("Loading conversation…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        GeometryReader { geometry in
                            ScrollView {
                                EmptyChatHint(name: app.agentName, showsSuggestions: model.draft.isEmpty && model.attachments.isEmpty && model.quotes.isEmpty) { draft in
                                    model.draft = draft
                                    composerFocused = true
                                }
                                .frame(minHeight: geometry.size.height)
                            }
                            .scrollBounceBehavior(.basedOnSize)
                        }
                    }
                }
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollPhaseChange { _, phase, context in
                if phase == .tracking || phase == .interacting { isUserScrolling = true }
                if isUserScrolling {
                    followsLatest = isNearBottom(context.geometry)
                    if phase == .idle { isUserScrolling = false }
                }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                isNearBottom(geometry)
            } action: { _, nearBottom in
                if isUserScrolling { followsLatest = nearBottom }
            }
            .onScrollGeometryChange(for: CGSize.self) { geometry in
                geometry.contentSize
            } action: { _, _ in
                if followsLatest && !isUserScrolling { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: model.items) { _, _ in
                if followsLatest && !isUserScrolling { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !followsLatest && !model.items.isEmpty {
                    Button {
                        followsLatest = true
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .frame(width: 44, height: 44)
                            .background(.regularMaterial, in: Circle())
                    }
                    .accessibilityLabel("Jump to latest message")
                    .padding(12)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Composer(text: $model.draft, agentName: app.agentName, isRunning: model.isRunning,
                         quotes: model.quotes, removeQuote: model.removeQuote,
                         attachments: model.attachments, isBusy: model.isUploading || isImporting,
                         progress: model.uploadProgress ?? (isImporting ? "Preparing attachments…" : nil),
                         focused: $composerFocused, photos: { showPhotos = true }, camera: { showCamera = true }, files: { showFiles = true },
                         remove: model.removeAttachment) {
                    Task {
                        await model.send()
                        followsLatest = true
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                        if app.info?.push?.enabled == true { await notifications?.requestPermissionIfNeeded() }
                    }
                } cancel: {
                    Task { await model.cancel() }
                }
            }
        }
        .environment(\.quoteSelection, quoteAction)
        .environment(\.chatDraft, DraftAction { text in
            model.draft = model.draft.isEmpty ? text : model.draft + "\n\n" + text
            composerFocused = true
        })
        .environment(\.chatBubbles, style == .person)
        .environment(\.chatCards, model.cards)
        .environment(\.chatSend, DraftAction { text in
            followsLatest = true
            Task { await model.sendCardReply(text) }
        })
        .navigationTitle(style == .person ? app.agentName : model.title)
        .inlineNavigationTitle()
        // The one chat is a tab's root: the tab bar is the way to everything else.
        // Nor while a new user is being introduced: until then the chat is all there is.
        .tabBarVisibility(style == .person && !app.isIntroducing ? .automatic : .hidden)
        .toolbar {
            if style == .person {
                ToolbarItem(placement: .principal) { ChatPerson(name: app.agentName, isWorking: model.isRunning) }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    // The hosted service picks the models and looks after the context itself.
                    if !app.flavor.isHosted { modelPicker }
                    if let client = app.client, app.info?.interests != nil {
                        NavigationLink {
                            InterestsView(client: client, agentName: app.agentName)
                        } label: { Label("Interests & updates", systemImage: "sparkle.magnifyingglass") }
                    }
                    if app.info?.browser?.handoff == true {
                        Button { Task { await model.takeOverBrowser() } } label: {
                            Label("Take over the browser", systemImage: "hand.tap")
                        }
                        .disabled(model.answeringHandoff)
                    }
                    if style == .standard {
                        Button { renameText = model.conversation?.title ?? ""; showRename = true } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        .disabled(model.conversation == nil)
                    }
                    if !app.flavor.isHosted {
                        Button {
                            Task {
                                compactResult = await model.compact()
                                showCompactResult = compactResult != nil
                            }
                        } label: {
                            Label("Compact context", systemImage: "arrow.down.right.and.arrow.up.left")
                        }
                        .disabled(model.conversation == nil || model.isRunning)
                    }
                    if style == .person, app.isIntroducing {
                        Button {
                            Task {
                                try? await app.client?.finishIntroduction()
                                await app.refreshInfo()
                            }
                        } label: {
                            Label("Skip introduction", systemImage: "forward")
                        }
                    }
                    if style == .person {
                        Button { confirmStartOver = true } label: {
                            Label("Start a new chat", systemImage: "square.and.pencil")
                        }
                        .disabled(model.conversation == nil || model.isRunning)
                    }
                } label: {
                    Label("Conversation options", systemImage: "ellipsis.circle")
                }
            }
        }
        .task { await model.load() }
        // A user nobody has met yet: the one chat opens with Sunnie saying hello.
        .task(id: app.info?.greeting?.pending) {
            guard style == .person, app.info?.greeting?.pending == true, model.conversation == nil else { return }
            await model.greet()
            await app.refreshInfo()
        }
        // Each reply may be the one that ends the introduction.
        .onChange(of: model.isRunning) { _, running in
            if !running, style == .person, app.isIntroducing { Task { await app.refreshInfo() } }
        }
        .onChange(of: model.conversation?.id) { old, id in
            if let id, style == .person { oneChat?.adopt(id) }
            if old == nil, id != nil, let conversation = model.conversation { chatCreated?(conversation) }
        }
        .onChange(of: oneChat?.handoff?.id, initial: true) { _, _ in
            guard style == .person, let handoff = oneChat?.take() else { return }
            if let draft = handoff.draft {
                model.draft = model.draft.isEmpty ? draft : model.draft + "\n\n" + draft
            }
            if let quote = handoff.quote { model.addQuote(quote) }
            composerFocused = true
        }
        .confirmationDialog("Start a new chat?", isPresented: $confirmStartOver, titleVisibility: .visible) {
            Button("Start a new chat") { oneChat?.startOver() }
        } message: {
            Text(app.flavor.isHosted
                 ? "\(app.agentName) still remembers what it saved to memory, and can look back at this chat when you ask."
                 : "\(app.agentName) still remembers what it saved to memory. This chat stays on your server and shows in the list of conversations when one chat is turned off.")
        }
        .onChange(of: model.conversation?.id, initial: true) { _, id in notifications?.visibleConversationId = id }
        .onDisappear {
            if notifications?.visibleConversationId == model.conversation?.id { notifications?.visibleConversationId = nil }
        }
        // Reading Check-ins is what clears its dot in the toolbars.
        .onChange(of: model.timeline.lastMessageSeq, initial: true) { _, seq in
            if model.isCheckIns { checkIns?.markSeen(seq, in: model.conversation?.id) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): importFiles(urls)
            case .failure(let error): model.error = error.localizedDescription
            }
        }
        #if os(macOS)
        // Files dragged from Finder onto the chat attach as if chosen with the + button.
        .dropDestination(for: URL.self) { urls, _ in
            let files = urls.filter(\.isFileURL)
            guard !files.isEmpty, !model.isUploading, !isImporting else { return false }
            guard model.attachments.count + files.count <= PendingAttachment.maxCount else {
                model.error = "Attach up to \(PendingAttachment.maxCount) files to one message."
                return false
            }
            importFiles(files)
            return true
        }
        #endif
        #if os(iOS)
        .fullScreenCover(isPresented: $showCamera) {
            CameraCaptureView(captured: { url in
                showCamera = false
                importFiles([url])
            }, cancelled: { showCamera = false })
            .ignoresSafeArea()
        }
        #endif
        .photosPicker(isPresented: $showPhotos, selection: $selectedPhotos,
                      maxSelectionCount: max(1, PendingAttachment.maxCount - model.attachments.count),
                      matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: selectedPhotos) { _, selected in
            guard !selected.isEmpty else { return }
            isImporting = true
            Task {
                var imported: [PendingAttachment] = []
                do {
                    for photo in selected {
                        guard let picked = try await photo.loadTransferable(type: PickedPhoto.self) else {
                            throw AttachmentError.message("This photo couldn’t be loaded. Try choosing it from Files.")
                        }
                        imported.append(picked.file)
                    }
                    model.addAttachments(imported)
                } catch {
                    imported.forEach { $0.removeLocalFile() }
                    model.error = error.localizedDescription
                }
                selectedPhotos = []
                isImporting = false
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.reconnectIfNeeded() } }
        }
        .sheet(item: Binding(get: { model.browserHandoff }, set: { model.browserHandoff = $0 })) { handoff in
            if let client = app.client {
                BrowserTakeoverView(client: client, handoff: handoff, agentName: app.agentName) { model.browserHandoff = nil }
            }
        }
        .alert("Rename conversation", isPresented: $showRename) {
            TextField("Title", text: $renameText)
            Button("Save") { Task { await model.rename(renameText) } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Compaction", isPresented: $showCompactResult, presenting: compactResult) { _ in
            Button("OK") {}
        } message: { result in
            if result.compacted {
                Text("Summarised \(result.summarizedMessages) messages and saved \(result.memoriesSaved) memories. Context was \(result.contextTokensBefore.formatted()) tokens of a \(result.contextBudget.formatted()) budget.")
            } else {
                Text("Nothing to compact: the context is \(result.contextTokensBefore.formatted()) tokens, within the \(result.contextBudget.formatted()) budget.")
            }
        }
        .alert("Something went wrong", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") {}
        } message: {
            Text(model.error ?? "")
        }
    }

    private func importFiles(_ urls: [URL]) {
        var imported: [PendingAttachment] = []
        do {
            for url in urls { imported.append(try PendingAttachment.importFile(url: url)) }
            model.addAttachments(imported)
        } catch {
            imported.forEach { $0.removeLocalFile() }
            model.error = error.localizedDescription
        }
    }

    private var quoteAction: QuoteAction? {
        guard app.info?.quoting?.enabled == true else { return nil }
        return QuoteAction { quote in
            model.addQuote(quote)
            composerFocused = true
        }
    }

    /// The hosted app shows a conversation, not how it was worked out: no steps ("Updated its
    /// memory") and no memory or follow-up cards — they confuse people who are not technical. A
    /// call waiting for the user's OK stays, since that is where they answer it.
    private func visibleRows(_ rows: [ChatRow]) -> [ChatRow] {
        guard app.flavor.isHosted else { return rows }
        return rows.compactMap { row in
            switch row {
            case .item(.card): return nil
            case let .steps(id, items):
                let waiting = items.filter { approval(for: $0) != nil || handoff(for: $0) != nil }
                return waiting.isEmpty ? nil : .steps(id: id, items: waiting)
            default: return row
            }
        }
    }

    private func isNearBottom(_ geometry: ScrollGeometry) -> Bool {
        geometry.contentSize.height - geometry.visibleRect.maxY <= 60
    }

    private func expandedBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { expandedSteps.contains(id) },
            set: { if $0 { expandedSteps.insert(id) } else { expandedSteps.remove(id) } }
        )
    }

    private func handoff(for item: TimelineItem) -> ToolHandoff? {
        guard let reason = model.handoffReason(for: item) else { return nil }
        return ToolHandoff(reason: reason, isAnswering: model.answeringHandoff,
                           takeOver: { Task { await model.takeOverBrowser() } },
                           decline: { Task { await model.declineHandoff() } })
    }

    private func approval(for item: TimelineItem) -> ToolApproval? {
        guard case .tool(_, let callId, _, _, _, _) = item, model.awaitsApproval(item) else { return nil }
        return ToolApproval(target: model.timeline.approvalTargets[callId], review: model.timeline.approvalReviews[callId], explanation: model.timeline.approvalExplanations[callId], isAnswering: model.answeringApprovals.contains(callId)) { approved in
            Task { await model.resolveApproval(callId, approved: approved) }
        }
    }

    @ViewBuilder
    private var modelPicker: some View {
        let models = app.info?.models ?? []
        let current = model.modelSpec
        Menu {
            Button {
                Task { await model.setModel(nil) }
            } label: {
                if current == nil { Label(defaultLabel, systemImage: "checkmark") } else { Text(defaultLabel) }
            }
            ForEach(models.filter { !$0.isDefault }) { info in
                Button {
                    Task { await model.setModel(info.spec) }
                } label: {
                    if current == info.spec { Label(info.spec, systemImage: "checkmark") } else { Text(info.spec) }
                }
            }
        } label: {
            Label("Model: \(current ?? "default")", systemImage: "cpu")
        }
        .disabled(model.isRunning)
    }

    private var defaultLabel: String {
        if model.conversation == nil, let defaults = app.info?.newChatDefaults {
            return "Default (\(defaults.model))"
        }
        if let spec = app.info?.defaultModel { return "Default (\(spec))" }
        return "Default"
    }
}

private struct EmptyChatHint: View {
    let name: String
    let showsSuggestions: Bool
    let choose: (String) -> Void

    var body: some View {
        GardenEmptyState(
            title: "How can \(name) help?",
            message: "Make a plan, find an answer, or remember something for later.",
            markSize: 80
        ) {
            if showsSuggestions {
                VStack(spacing: 0) {
                    suggestion("Plan something", icon: "calendar", draft: "Help me plan ")
                    Divider()
                    suggestion("Find an answer", icon: "magnifyingglass", draft: "Help me find ")
                    Divider()
                    suggestion("Remember a detail", icon: "brain", draft: "Remember that ")
                }
                .frame(maxWidth: 300)
            }
        }
    }

    private func suggestion(_ title: String, icon: String, draft: String) -> some View {
        Button { choose(draft) } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .frame(width: 22)
                    .foregroundStyle(.tint)
                Text(title)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.left")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.subheadline)
            .padding(.vertical, 10)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityHint("Adds a draft you can finish before sending")
    }
}

private struct StatusRow: View {
    let activity: RunActivity
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            TurningStar(size: 13)
                .accessibilityHidden(true)
            Text(activity.label)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .contentTransition(.numericText())
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .animation(reduceMotion ? nil : .default, value: activity)
    }
}

private struct UsageRow: View {
    let usage: RunUsage
    let model: String?
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 6) {
                if let model {
                    Text(model)
                        .textSelection(.enabled)
                }
                Text("\(usage.inputTokens.formatted()) input tokens · \(usage.outputTokens.formatted()) output tokens")
                if usage.cacheReadTokens > 0 {
                    Text("\(Int((usage.cacheHitRatio * 100).rounded()))% of input from cache")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 8)
        } label: {
            Text("Response details")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(minHeight: 44)
        }
    }
}

private struct Composer: View {
    @Binding var text: String
    let agentName: String
    let isRunning: Bool
    let quotes: [MessageQuote]
    let removeQuote: (String) -> Void
    let attachments: [PendingAttachment]
    let isBusy: Bool
    let progress: String?
    var focused: FocusState<Bool>.Binding
    let photos: () -> Void
    let camera: () -> Void
    let files: () -> Void
    let remove: (String) -> Void
    let send: () -> Void
    let cancel: () -> Void

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { (hasText || !attachments.isEmpty || !quotes.isEmpty) && !isBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !quotes.isEmpty { DraftQuotesView(quotes: quotes, disabled: isBusy, remove: removeQuote) }
            if !attachments.isEmpty {
                DraftAttachmentsView(files: attachments, disabled: isBusy, remove: remove)
            }
            if let progress {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(progress).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .glassEffect(.regular, in: .capsule)
            }
            HStack(alignment: .bottom, spacing: 4) {
                Menu {
                    #if os(iOS)
                    if CameraCaptureView.isAvailable {
                        Button(action: camera) { Label("Take Photo", systemImage: "camera") }
                    }
                    #endif
                    Button(action: photos) { Label("Photo Library", systemImage: "photo.on.rectangle") }
                    Button(action: files) { Label("Choose Files", systemImage: "doc") }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .frame(width: 44, height: 48)
                }
                .disabled(isBusy || attachments.count >= PendingAttachment.maxCount)
                .accessibilityLabel("Add attachments")
                // While a run works, what is typed joins it; the placeholder says so.
                TextField(isRunning ? "Add to what \(agentName) is doing" : "Message \(agentName)", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused(focused)
                    .padding(.leading, 0)
                    .padding(.trailing, 8)
                    .padding(.vertical, 12)
                    .frame(minHeight: 48)
                    .accessibilityLabel("Message")
                    .accessibilityIdentifier("Message")
                    .disabled(isBusy)
                    #if os(macOS)
                    // Return sends, as in Messages; Option-Return still starts a new line.
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.isEmpty else { return .ignored }
                        if canSend { send() }
                        return .handled
                    }
                    #endif
                if isRunning {
                    Button(action: cancel) {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Stop")
                    .accessibilityHint("Stops the current response")
                }
                // While a run works, what is typed can still be sent: it joins the run.
                if !isRunning || hasText || !attachments.isEmpty || !quotes.isEmpty {
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(canSend ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(isRunning ? "Send to the run at work" : "Send")
                }
            }
            .buttonStyle(.plain)
            .padding(.trailing, 4)
            .padding(.vertical, 2)
            // Liquid Glass, floating over the chat: the conversation scrolls on underneath it.
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: Garden.readingWidth)
        .frame(maxWidth: .infinity)
    }
}

/// The one chat's title: who you are talking to, as Messages shows a contact.
private struct ChatPerson: View {
    let name: String
    let isWorking: Bool

    var body: some View {
        VStack(spacing: 1) {
            SunnieMark(size: 26)
                .padding(3)
                .background(Color.systemGray6, in: Circle())
            HStack(spacing: 4) {
                Text(name).font(.caption.weight(.semibold))
                if isWorking { TurningStar(size: 9) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isWorking ? "\(name), working" : name)
        .accessibilityAddTraits(.isHeader)
    }
}
