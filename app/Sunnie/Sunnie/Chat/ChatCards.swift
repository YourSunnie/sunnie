import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// What the user set in the interactive cards of one conversation's replies: loaded with its
/// messages, and each change saved (after a moment's pause) so every device shows the same card
/// and Sunnie hears about it with the next message.
@MainActor @Observable
final class ChatCards {
    private let client: SunnieClient
    private(set) var states: [String: [Int: [String: StateValue]]] = [:]
    @ObservationIgnored private var pending: [String: Task<Void, Never>] = [:]

    init(client: SunnieClient) {
        self.client = client
    }

    func load(_ conversationId: String) async {
        guard let list = try? await client.listCardStates(conversationId) else { return }
        var next: [String: [Int: [String: StateValue]]] = [:]
        for card in list { next[card.messageId, default: [:]][card.card] = card.state }
        // A change still on its way wins over what the server had a moment ago.
        for key in pending.keys {
            let parts = key.split(separator: "#")
            if parts.count == 2, let index = Int(parts[1]), let mine = states[String(parts[0])]?[index] { next[String(parts[0]), default: [:]][index] = mine }
        }
        states = next
    }

    func state(_ messageId: String, _ card: Int) -> [String: StateValue]? { states[messageId]?[card] }

    /// Puts the card, as it stands, on Home. What is still waiting to be saved is saved first.
    func pin(_ messageId: String, _ card: Int) async throws {
        let key = "\(messageId)#\(card)"
        if pending[key] != nil, let state = states[messageId]?[card] {
            pending[key]?.cancel()
            pending[key] = nil
            try await client.saveCardState(messageId: messageId, card: card, state: state)
        }
        _ = try await client.pinCard(messageId: messageId, card: card)
    }

    func save(_ messageId: String, _ card: Int, _ state: [String: StateValue]) {
        states[messageId, default: [:]][card] = state
        let key = "\(messageId)#\(card)"
        pending[key]?.cancel()
        pending[key] = Task { [client] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            try? await client.saveCardState(messageId: messageId, card: card, state: state)
            self.pending[key] = nil
        }
    }
}

private struct ChatCardsKey: EnvironmentKey {
    static let defaultValue: ChatCards? = nil
}

extension EnvironmentValues {
    var chatCards: ChatCards? {
        get { self[ChatCardsKey.self] }
        set { self[ChatCardsKey.self] = newValue }
    }
}

extension WidgetAction {
    /// The action with any `{formula}` in its words worked out from the widget's state now.
    func resolved(_ state: [String: StateValue]) -> WidgetAction {
        switch self {
        case .ask(let prompt): return .ask(Formula.interpolate(prompt, state))
        case .reply(let text): return .reply(Formula.interpolate(text, state))
        case .copy(let text): return .copy(Formula.interpolate(text, state))
        case let .calendar(title, start, end, place, note):
            let show = { (s: String) in Formula.interpolate(s, state) }
            return .calendar(title: show(title), start: show(start), end: end.map(show), place: place.map(show), note: note.map(show))
        default: return self
        }
    }
}

/// Sends words as the user's message in this chat: a card's "reply".
private struct ChatSendKey: EnvironmentKey {
    static let defaultValue: DraftAction? = nil
}

extension EnvironmentValues {
    var chatSend: DraftAction? {
        get { self[ChatSendKey.self] }
        set { self[ChatSendKey.self] = newValue }
    }
}

extension WidgetAction {
    /// The event a "calendar" action offers, as an event card draws it.
    var event: EventCard? {
        if case let .calendar(title, start, end, place, note) = self { EventCard(title: title, start: start, end: end, place: place, note: note) } else { nil }
    }
}

enum Clipboard {
    @MainActor static func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
