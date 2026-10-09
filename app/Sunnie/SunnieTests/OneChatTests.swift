import Foundation
import Testing
@testable import Sunnie

@MainActor
struct OneChatTests {
    private func defaults() -> UserDefaults {
        let name = "OneChatTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test func theOneChatIsRememberedPerServerUntilAFreshStart() {
        let store = defaults()
        let home = URL(string: "https://home.example")!
        let work = URL(string: "https://work.example")!
        let chat = OneChat(server: home, defaults: store)
        #expect(chat.conversationId == nil, "nothing until the first message creates it")
        chat.adopt("conv_1")
        #expect(OneChat(server: home, defaults: store).conversationId == "conv_1")
        #expect(OneChat(server: work, defaults: store).conversationId == nil, "each server has its own")

        let generation = chat.generation
        chat.startOver()
        #expect(chat.conversationId == nil && chat.generation == generation + 1)
        #expect(OneChat(server: home, defaults: store).conversationId == nil)
    }

    @Test func aHandoffIsTakenOnce() {
        let chat = OneChat(server: URL(string: "https://home.example")!, defaults: defaults())
        let quote = MessageQuote(kind: "card", title: "Home · Steps", text: "8,412 steps")
        chat.hand(ChatHandoff(quote: quote))
        #expect(chat.take()?.quote == quote)
        #expect(chat.take() == nil)
    }
}
