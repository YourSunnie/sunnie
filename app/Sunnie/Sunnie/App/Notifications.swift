import Observation
import SwiftUI
import UserNotifications
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// What the app reads from a notification, and the decisions that depend on nothing else.
nonisolated enum PushRoute {
    /// Debug builds get tokens for Apple's sandbox; TestFlight and App Store builds for production.
    static let environment: String = {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }()

    /// The conversation a notification is about (the server puts it beside `aps`).
    static func conversationId(from userInfo: [AnyHashable: Any]) -> String? {
        guard let id = userInfo["conversationId"] as? String, !id.isEmpty else { return nil }
        return id
    }

    /// The token as the server expects it: lowercase hex.
    static func token(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// No banner for the chat already on screen: its reply is right there.
    static func shouldShow(conversationId: String?, visibleConversationId: String?) -> Bool {
        conversationId == nil || conversationId != visibleConversationId
    }
}

/// Notification state the views share: permission, this device's token, which chat is on screen,
/// and which chat a tapped notification asked to open.
@Observable
final class Notifications {
    private(set) var deviceToken: String?
    private(set) var status: UNAuthorizationStatus = .notDetermined
    /// Set by a tapped notification; the Chats tab opens it and clears it.
    var pendingConversationId: String?
    /// Set by the chat on screen, so its own notifications stay quiet.
    var visibleConversationId: String?

    var isAllowed: Bool {
        #if os(iOS)
        status == .authorized || status == .provisional || status == .ephemeral
        #else
        status == .authorized || status == .provisional
        #endif
    }

    /// Reads the current permission and, when allowed, asks iOS for this device's token.
    func refresh() async {
        status = await Self.authorizationStatus()
        #if canImport(UIKit)
        if isAllowed { UIApplication.shared.registerForRemoteNotifications() }
        #else
        if isAllowed { NSApplication.shared.registerForRemoteNotifications() }
        #endif
    }

    /// Asks once, at a moment the user can see why: right after they hand Sunnie something to do.
    func requestPermissionIfNeeded() async {
        status = await Self.authorizationStatus()
        guard status == .notDetermined else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        await refresh()
    }

    func didRegister(_ token: Data) {
        deviceToken = PushRoute.token(token)
    }

    private nonisolated static func authorizationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }
}

#if canImport(UIKit)
/// Receives the device token from iOS and decides how a notification is shown and what a tap opens.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let notifications = Notifications()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task { await notifications.refresh() }
        // HealthKit's wake-ups and iOS's visits reach only what is set up again at launch,
        // background launches included.
        PhoneBackground.resume()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        notifications.didRegister(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Nothing to do: without a token the server simply has no device to notify.
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let conversationId = PushRoute.conversationId(from: notification.request.content.userInfo)
        let visible = await MainActor.run { notifications.visibleConversationId }
        return PushRoute.shouldShow(conversationId: conversationId, visibleConversationId: visible) ? [.banner, .list, .sound] : []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let conversationId = PushRoute.conversationId(from: response.notification.request.content.userInfo) else { return }
        await MainActor.run { notifications.pendingConversationId = conversationId }
    }
}
#else
/// The Mac's counterpart: the same token and the same rules for what is shown and opened.
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let notifications = Notifications()

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        Task { await notifications.refresh() }
        PhoneBackground.resume()
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        notifications.didRegister(deviceToken)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Nothing to do: without a token the server simply has no device to notify.
    }

    /// Closing the window leaves Sunnie running (a run and the shared device data keep going);
    /// clicking the Dock icon brings the window back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let conversationId = PushRoute.conversationId(from: notification.request.content.userInfo)
        let visible = await MainActor.run { notifications.visibleConversationId }
        return PushRoute.shouldShow(conversationId: conversationId, visibleConversationId: visible) ? [.banner, .list, .sound] : []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let conversationId = PushRoute.conversationId(from: response.notification.request.content.userInfo) else { return }
        await MainActor.run {
            NSApplication.shared.activate()
            notifications.pendingConversationId = conversationId
        }
    }
}
#endif
