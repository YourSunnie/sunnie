import Foundation
import Observation
import SwiftUI

/// What another screen hands to the chat: text for the composer, or a quote to attach.
nonisolated struct ChatHandoff: Hashable, Sendable {
    var id = UUID()
    var draft: String?
    var quote: MessageQuote?
}

/// The "one chat" mode, how Sunnie works by default: instead of a list of conversations, the Chats
/// tab is a single ongoing conversation with Sunnie, like a thread with a person. The app remembers
/// which conversation that is, per server; the server knows nothing of the mode, so earlier
/// conversations stay where they were. The hosted app is always in it; a self-hosted user can turn
/// it off in Settings to get the list back.
@Observable
final class OneChat {
    /// The switch in Settings (UserDefaults, app-wide); unset means on.
    nonisolated static let settingKey = "chat.single"

    let server: URL
    private let defaults: UserDefaults
    /// The conversation that is the one chat; nil until the first message creates it.
    private(set) var conversationId: String?
    /// Bumped by "Start a new chat", so the chat screen starts afresh.
    private(set) var generation = 0
    /// Waiting for the chat to pick it up; the tab switches to the chat when one arrives.
    private(set) var handoff: ChatHandoff?

    init(server: URL, defaults: UserDefaults = .standard) {
        self.server = server
        self.defaults = defaults
        conversationId = defaults.string(forKey: Self.key(server))
    }

    nonisolated static func key(_ server: URL) -> String { "chat.single.conversation.\(server.absoluteString)" }

    /// The chat's conversation was created (on its first send): it is the one chat from now on.
    func adopt(_ id: String) {
        guard id != conversationId else { return }
        conversationId = id
        defaults.set(id, forKey: Self.key(server))
    }

    /// The remembered conversation is gone (deleted elsewhere), or the user wants a fresh start.
    /// The old conversation is not deleted: it stays on the server and in the list.
    func startOver() {
        conversationId = nil
        defaults.removeObject(forKey: Self.key(server))
        generation += 1
    }

    func hand(_ handoff: ChatHandoff) { self.handoff = handoff }

    func take() -> ChatHandoff? {
        defer { handoff = nil }
        return handoff
    }
}

extension EnvironmentValues {
    /// Draw Sunnie's words in bubbles, as in a messaging app (the one-chat mode).
    @Entry var chatBubbles = false
}
