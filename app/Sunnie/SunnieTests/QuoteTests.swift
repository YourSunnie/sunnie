import Foundation
import Testing
@testable import Sunnie

struct QuoteTests {
    private let quote = MessageQuote(id: "q", kind: "text", title: "Selected text", text: "A passage 🌻 with an emoji")

    @Test func quoteOnlySendWaitsForItsOwnSnapshot() {
        var timeline = ChatTimeline()
        timeline.beginSend(text: "", quotes: [quote])
        timeline.insert([Message(id: "unrelated", conversationId: "c", seq: 1, role: .user, text: "", parts: [], createdAt: "")])
        #expect(timeline.pendingUser != nil)
        var message = Message(id: "stored", conversationId: "c", seq: 2, role: .user, text: "", parts: [], createdAt: "")
        message.quotes = [quote]
        timeline.insert([message])
        #expect(timeline.pendingUser == nil)
        #expect(timeline.items.contains(.user(id: "stored", text: "", pending: false, quotes: [quote])))
    }

    @Test func cancelledSteerRestoresQuotesAndDoesNotLoseTheTypedMessage() {
        var timeline = ChatTimeline()
        timeline.beginSteer(id: "s", text: "Tell me more", quotes: [quote])
        timeline.apply(RunEvent(seq: 1, kind: .runCancelled))
        #expect(timeline.takeUnsentSteers() == ["Tell me more"])
        #expect(timeline.takeUnsentQuotes() == [quote])
        #expect(timeline.takeUnsentQuotes().isEmpty)
    }

    @Test func quotedScheduleKeepsAllEntriesAndTheirDetails() throws {
        let original = Markdown.parse("```schedule\ntitle: Saturday\n09:00 | Breakfast | At the hotel\n10:30 | Concert | Bring tickets\n```")[0]
        let quote = try #require(original.messageQuote)
        #expect(Markdown.parse(quote.text) == [original])
    }

    @Test func quoteSnapshotsRoundTripAndOldMessagesStillDecode() throws {
        let data = try JSONEncoder().encode(quote)
        #expect(try JSONDecoder().decode(MessageQuote.self, from: data) == quote)
        let old = Data(#"{"id":"m","conversationId":"c","seq":1,"role":"user","text":"Hi","parts":[],"createdAt":""}"#.utf8)
        #expect(try JSONDecoder().decode(Message.self, from: old).quotes == nil)
    }

    @Test func whatsAppDraftKeepsItsMessageAndShortcutWhenQuoted() throws {
        let draft = "Hi Sam, dinner & dessert at 7? +1 🌻 #Friday"
        let encoded = "Hi%20Sam%2C%20dinner%20%26%20dessert%20at%207%3F%20%2B1%20%F0%9F%8C%BB%20%23Friday"
        for recipient in ["", "15555550123"] {
            let link = "https://wa.me/\(recipient)?text=\(encoded)"
            let original = Markdown.parse("```card\ntitle: Message Sam on WhatsApp\nmessage: \(draft)\nlink: \(link)\n```")[0]
            guard case .card(let card) = original else { Issue.record("Expected a card"); return }
            #expect(card.opensWhatsApp)
            #expect(card.fields == [.init(label: "Message", value: draft)])
            #expect(card.link?.absoluteString == link)
            #expect(URLComponents(string: link)?.queryItems?.first { $0.name == "text" }?.value == draft)
            let quote = try #require(original.messageQuote)
            #expect(Markdown.parse(quote.text) == [original])
        }
        for link in ["https://wa.me.example.com/?text=Hi", "https://wa.me@example.com/?text=Hi", "http://wa.me/?text=Hi"] {
            #expect(!InfoCard(title: "Draft", link: URL(string: link), fields: []).opensWhatsApp)
        }
    }

    @Test func cardTitleFitsTheServersUTF16LimitWithoutSplittingAnEmoji() {
        let title = MessageQuote.cardTitle(String(repeating: "a", count: 199) + "🌻")
        #expect(title.utf16.count == 199)
        #expect(!title.contains("�"))
    }
}
