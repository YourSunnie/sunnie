import SwiftUI

@main
struct SunnieApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    #else
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    #endif
    @State private var app = AppModel()

    var body: some Scene {
        #if os(macOS)
        // One window: the chats, runs and notifications all belong to one connected session.
        Window("Sunnie", id: "main") {
            RootView()
                .environment(app)
                .environment(delegate.notifications)
                .preferredColorScheme(.light)
                .formStyle(.grouped)
                .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 1180, height: 800)
        .commands { SunnieCommands() }
        #else
        WindowGroup {
            RootView()
                .environment(app)
                .environment(delegate.notifications)
                .preferredColorScheme(.light)
        }
        // Keeps what the phone shares fresh while the app is closed (Phone/PhoneBackground.swift).
        .backgroundTask(.appRefresh(PhoneBackground.refreshTask)) {
            await PhoneBackground.refresh()
        }
        #endif
    }
}
