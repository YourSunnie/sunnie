#if os(macOS)
import SwiftUI

/// What the Mac window shows in its detail column. The sidebar holds what iOS puts in tabs, with
/// the conversations listed in it directly, as a Mac mail or messages app does.
nonisolated enum MacDestination: Hashable {
    case home
    case oneChat
    case chat(String)
    /// A fresh chat; the id keeps each "new" distinct, and stays its identity once it is created.
    case newChat(UUID)
    case drive
    case memory
    case settings
}

/// The connected Mac app: a sidebar of places and conversations, and what is chosen beside it.
/// The screens are the iOS ones; only the way between them is the Mac's.
struct MacMainView: View {
    let client: SunnieClient
    @Environment(AppModel.self) private var app
    @Environment(Notifications.self) private var notifications
    @Environment(\.scenePhase) private var scenePhase
    @State private var checkIns: CheckInsModel
    @State private var phone: PhoneModel
    @State private var oneChat: OneChat
    @State private var conversations: ConversationsModel
    @State private var selection: MacDestination? = .home
    /// Conversations opened from elsewhere (a notification, Check-ins) that the list does not hold.
    @State private var opened: [String: Conversation] = [:]
    /// A new chat keeps its screen once its first send creates the conversation.
    @State private var adopted: [String: UUID] = [:]
    @State private var deleting: Conversation?
    @AppStorage(OneChat.settingKey) private var oneChatSetting = true
    /// One chat is the hosted app's only way; a self-hosted user can turn it off in Settings.
    private var single: Bool { app.flavor.isHosted || oneChatSetting }

    init(client: SunnieClient) {
        self.client = client
        _checkIns = State(initialValue: CheckInsModel(client: client))
        _phone = State(initialValue: PhoneModel(client: client))
        _oneChat = State(initialValue: OneChat(server: client.baseURL))
        _conversations = State(initialValue: ConversationsModel(client: client))
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 380)
        } detail: {
            detail
                .environment(\.chatCreated, ChatCreatedAction { conversation in created(conversation) })
        }
        .modifier(SessionEffects(client: client, checkIns: checkIns, phone: phone, oneChat: oneChat, single: single,
                                 showChats: { if single { selection = .oneChat } },
                                 homeUnavailable: { if selection == .home { selection = defaultSelection } }))
        .focusedSceneValue(\.sunnieActions, SunnieActions(
            newChat: { newChat() },
            showSettings: { selection = .settings },
            refresh: { Task { await refresh() } }))
        .task(id: notifications.pendingConversationId) {
            // The one chat opens its own (OneChatView); otherwise the chat is selected here.
            guard !single, let id = notifications.pendingConversationId else { return }
            defer { notifications.pendingConversationId = nil }
            await open(id)
        }
        // The list keeps up with titles and new conversations made elsewhere (the phone, a check-in).
        .task(id: single) {
            guard !single else { return }
            while !Task.isCancelled {
                await conversations.refresh()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, !single { Task { await conversations.refresh() } }
        }
        .onChange(of: app.info?.home?.enabled, initial: true) { _, enabled in
            if enabled != true, selection == .home { selection = defaultSelection }
        }
        .onChange(of: single) { _, on in
            if on, case .chat? = selection { selection = .oneChat }
            if on, case .newChat? = selection { selection = .oneChat }
            if !on, selection == .oneChat { selection = defaultSelection }
        }
        .confirmationDialog("Delete “\(deleting?.displayTitle ?? "conversation")”?",
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let conversation = deleting else { return }
                Task { await delete(conversation) }
            }
        } message: {
            Text("The conversation is removed from your server. What \(app.agentName) saved to memory stays.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { conversations.error != nil }, set: { if !$0 { conversations.error = nil } })) {
            Button("OK") {}
        } message: {
            Text(conversations.error ?? "")
        }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        List(selection: $selection) {
            Section {
                if app.info?.home?.enabled == true {
                    Label("Home", systemImage: "sun.horizon").tag(MacDestination.home)
                }
                if single {
                    Label(app.agentName, systemImage: "bubble.left.and.text.bubble.right").tag(MacDestination.oneChat)
                }
                if pinsCheckIns, let conversation = checkIns.conversation {
                    Label {
                        HStack {
                            Text("Check-ins")
                            if checkIns.hasNew {
                                Spacer()
                                NewDot().accessibilityLabel("New updates")
                            }
                        }
                    } icon: {
                        Image(systemName: "clock.arrow.circlepath")
                    }
                    .tag(MacDestination.chat(conversation.id))
                }
                if app.info?.drive?.enabled == true {
                    Label("Drive", systemImage: "folder").tag(MacDestination.drive)
                }
                // Memory lives in Drive, as a folder of its own; a server without Drive keeps it here.
                if let info = app.info, info.drive?.enabled != true {
                    Label("Memory", systemImage: "brain").tag(MacDestination.memory)
                }
                Label("Settings", systemImage: "gearshape").tag(MacDestination.settings)
            }
            if !single {
                Section("Conversations") {
                    if case .newChat(let id)? = selection, !adopted.values.contains(id) {
                        Label("New conversation", systemImage: "square.and.pencil")
                            .foregroundStyle(.secondary)
                            .tag(MacDestination.newChat(id))
                    }
                    ForEach(listed) { conversation in
                        MacConversationRow(conversation: conversation)
                            .tag(MacDestination.chat(conversation.id))
                            .contextMenu {
                                Button("Delete…", systemImage: "trash", role: .destructive) { deleting = conversation }
                            }
                    }
                    if listed.isEmpty, conversations.hasLoaded {
                        Text("No conversations yet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .overlay {
            if !single, !conversations.hasLoaded, conversations.isLoading {
                ProgressView().controlSize(.small)
            }
        }
        .toolbar {
            if !single {
                ToolbarItem {
                    Button { newChat() } label: {
                        Label("New conversation", systemImage: "square.and.pencil")
                    }
                    .help("New conversation (⌘N)")
                }
            }
        }
    }

    // MARK: Detail

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .home?:
            HomeView(client: client)
        case .oneChat?:
            OneChatView(client: client, oneChat: oneChat)
        // One branch for both, so a new chat keeps its screen (and its run) when it is created.
        case .chat?, .newChat?:
            if let slot = chatSlot {
                NavigationStack { ChatView(client: client, conversation: slot.conversation) }
                    .id(slot.identity)
            } else {
                ProgressView("Loading conversation…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        case .drive?:
            DriveView(client: client)
        case .memory?:
            MemoryView(client: client)
        case .settings?:
            SettingsView()
        case nil:
            GardenEmptyState(
                title: "Nothing selected",
                message: "Choose a conversation, or start a new one with ⌘N."
            ) {
                Button("New conversation") { newChat() }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: Actions

    /// With Home, Check-ins has its own row instead of a place among the conversations.
    private var pinsCheckIns: Bool { app.info?.home?.enabled == true }

    private var listed: [Conversation] {
        pinsCheckIns ? conversations.conversations.filter { $0.kind != "heartbeat" } : conversations.conversations
    }

    private var defaultSelection: MacDestination {
        if app.info?.home?.enabled == true { return .home }
        if single { return .oneChat }
        return listed.first.map { .chat($0.id) } ?? .newChat(UUID())
    }

    /// The chat on screen: which screen it is, and the conversation it starts from.
    private var chatSlot: (identity: AnyHashable, conversation: Conversation?)? {
        switch selection {
        case .newChat(let id)?: return (AnyHashable(id), nil)
        case .chat(let id)?:
            guard let conversation = conversation(id) else { return nil }
            return (adopted[id].map(AnyHashable.init) ?? AnyHashable(id), conversation)
        default: return nil
        }
    }

    private func conversation(_ id: String) -> Conversation? {
        conversations.conversations.first { $0.id == id } ?? opened[id]
            ?? (checkIns.conversation?.id == id ? checkIns.conversation : nil)
    }

    private func newChat() {
        if single {
            selection = .oneChat
        } else if case .newChat(let id)? = selection, !adopted.values.contains(id) {
            // Already on an empty new chat.
        } else {
            selection = .newChat(UUID())
        }
    }

    /// A new chat's first send made its conversation: it joins the list, keeping its screen.
    private func created(_ conversation: Conversation) {
        guard case .newChat(let id)? = selection else { return }
        adopted[conversation.id] = id
        opened[conversation.id] = conversation
        selection = .chat(conversation.id)
        Task { await conversations.refresh() }
    }

    private func open(_ id: String) async {
        if conversation(id) == nil, let fetched = try? await client.getConversation(id) { opened[id] = fetched }
        if conversation(id) != nil { selection = .chat(id) }
    }

    private func delete(_ conversation: Conversation) async {
        await conversations.delete(conversation)
        guard conversations.error == nil else { return }
        opened[conversation.id] = nil
        if selection == .chat(conversation.id) { selection = defaultSelection }
    }

    private func refresh() async {
        await app.refreshInfo()
        if !single { await conversations.refresh() }
        if app.info?.home?.enabled == true { await checkIns.refresh() }
    }
}

private struct MacConversationRow: View {
    let conversation: Conversation

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(conversation.displayTitle)
                .lineLimit(1)
            HStack(spacing: 4) {
                if conversation.activeRunId != nil {
                    TurningStar(size: 10)
                        .accessibilityHidden(true)
                    Text("Working")
                        .foregroundStyle(Color.accentColor)
                } else if let date = conversation.updatedDate {
                    Text(date, format: .relative(presentation: .named))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
#endif
