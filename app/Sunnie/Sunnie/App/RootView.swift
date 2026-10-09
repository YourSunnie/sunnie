import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(Notifications.self) private var notifications
    @State private var claiming = false
    @State private var linkError: String?

    var body: some View {
        Group {
            if let client = app.client {
                MainView(client: client)
                    // A different server means fresh models and lists everywhere.
                    .id(client.baseURL)
                    .task { await app.refreshInfo() }
            } else {
                ConnectView()
            }
        }
        // A connect link opened from the host's page or a message: `sunnie://connect?link=…`.
        .onOpenURL { url in
            guard let link = ConnectLink.parse(url.absoluteString), !claiming else { return }
            claiming = true
            Task {
                do {
                    try await app.connect(link: link, pushToken: notifications.deviceToken)
                } catch {
                    linkError = error.localizedDescription
                }
                claiming = false
            }
        }
        .overlay {
            if claiming {
                ProgressView("Connecting…")
                    .padding(24)
                    .background(.regularMaterial, in: .rect(cornerRadius: 16))
            }
        }
        .alert("Could not connect", isPresented: Binding(get: { linkError != nil }, set: { if !$0 { linkError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(linkError ?? "")
        }
    }
}

/// The connected app: tabs on iOS, a sidebar window on the Mac (Mac/MacMainView.swift).
struct MainView: View {
    let client: SunnieClient

    var body: some View {
        #if os(macOS)
        MacMainView(client: client)
        #else
        MainTabs(client: client)
        #endif
    }
}

#if os(iOS)
struct MainTabs: View {
    let client: SunnieClient
    @Environment(AppModel.self) private var app
    @State private var checkIns: CheckInsModel
    @State private var phone: PhoneModel
    @State private var oneChat: OneChat
    @State private var tab: MainTab = .home
    /// One chat (Settings): the Chats tab is a single conversation. The hosted app is always in it.
    @AppStorage(OneChat.settingKey) private var oneChatSetting = true
    private var single: Bool { app.flavor.isHosted || oneChatSetting }

    nonisolated enum MainTab: Hashable { case home, chats, drive, memory, settings }

    init(client: SunnieClient) {
        self.client = client
        _checkIns = State(initialValue: CheckInsModel(client: client))
        _phone = State(initialValue: PhoneModel(client: client))
        _oneChat = State(initialValue: OneChat(server: client.baseURL))
    }

    var body: some View {
        TabView(selection: $tab) {
            if app.info?.home?.enabled == true {
                Tab("Home", systemImage: "sun.horizon", value: MainTab.home) {
                    HomeView(client: client)
                }
            }
            if single {
                Tab(app.agentName, systemImage: "bubble.left.and.text.bubble.right", value: MainTab.chats) {
                    OneChatView(client: client, oneChat: oneChat)
                }
            } else {
                Tab("Chats", systemImage: "bubble.left.and.bubble.right", value: MainTab.chats) {
                    ConversationListView(client: client)
                }
            }
            if app.info?.drive?.enabled == true {
                Tab("Drive", systemImage: "folder", value: MainTab.drive) {
                    DriveView(client: client)
                }
            }
            // Memory lives in Drive, as a folder of its own; a server without Drive keeps the tab.
            if let info = app.info, info.drive?.enabled != true {
                Tab("Memory", systemImage: "brain", value: MainTab.memory) {
                    MemoryView(client: client)
                }
            }
            Tab("Settings", systemImage: "gearshape", value: MainTab.settings) {
                SettingsView()
            }
        }
        .modifier(SessionEffects(client: client, checkIns: checkIns, phone: phone, oneChat: oneChat, single: single,
                                 showChats: { tab = .chats },
                                 // An older server has no Home: start where the conversations are.
                                 homeUnavailable: { if tab == .home { tab = .chats } }))
    }
}
#endif

/// What runs while the app is connected, whatever the screens look like: the models the screens
/// share, sending device data, the Check-ins dot, this device's push token, and the chats a
/// hand-off or a tapped notification asks for (`showChats`).
struct SessionEffects: ViewModifier {
    let client: SunnieClient
    let checkIns: CheckInsModel
    let phone: PhoneModel
    let oneChat: OneChat
    let single: Bool
    let showChats: () -> Void
    let homeUnavailable: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(Notifications.self) private var notifications
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .environment(checkIns)
            .environment(phone)
            // Only in the one-chat mode: Home then hands its quotes and asks to the one chat.
            .environment(single ? oneChat : nil)
            .onChange(of: oneChat.handoff) { _, handoff in
                if handoff != nil { showChats() }
            }
            // Someone Sunnie has not met yet stays in the chat, where she says hello, until the
            // introduction is over (the chat hides the tab bar meanwhile).
            .task(id: app.isIntroducing) {
                if single, app.isIntroducing { showChats() }
            }
            // What the phone shares goes to the server as the app comes to the front.
            .task(id: app.info?.phone?.sources) {
                guard let sources = app.info?.phone?.sources else { return }
                await phone.sendDue(supported: sources)
                #if os(macOS)
                await PhoneBackground.keepSending(phone, supported: sources)
                #endif
            }
            // The check-ins dot stays current wherever the user is: a light request a minute.
            .task(id: app.info?.home?.enabled) {
                guard app.info?.home?.enabled == true else { return }
                while !Task.isCancelled {
                    await checkIns.refresh()
                    try? await Task.sleep(for: .seconds(60))
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, app.info?.home?.enabled == true { Task { await checkIns.refresh() } }
                // The user may have turned notifications on or off in Settings meanwhile.
                if phase == .active { Task { await notifications.refresh() } }
                if phase == .active, let sources = app.info?.phone?.sources { Task { await phone.sendDue(supported: sources) } }
                if phase == .background { PhoneBackground.schedule() }
            }
            // Kept even while the server cannot send them yet, so they start once it can.
            .task(id: notifications.deviceToken) {
                guard let token = notifications.deviceToken else { return }
                _ = try? await client.registerDevice(token: token, environment: PushRoute.environment)
            }
            // A tapped notification opens its chat, which lives in the Chats tab.
            .onChange(of: notifications.pendingConversationId, initial: true) { _, id in
                if id != nil { showChats() }
            }
            .onChange(of: app.info?.home?.enabled) { _, enabled in
                if enabled != true { homeUnavailable() }
            }
    }
}
