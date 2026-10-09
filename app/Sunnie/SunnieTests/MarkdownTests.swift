import Foundation
import Testing
@testable import Sunnie

struct MarkdownTests {
    @Test func blocksAreReadFromOrdinaryMarkdown() {
        let text = """
        ## Plan
        First **this**,
        then that.

        - one
        - two
          - nested
            wrapped line
        1. first
        2) second

        - [x] done
        - [ ] open

        > quoted
        > twice

        ---
        | Hotel | Price |
        |:--|--:|
        | Aurora | EUR 180 |
        | Luna \\| Sol |
        """
        #expect(Markdown.parse(text) == [
            .heading(level: 2, text: "Plan"),
            .paragraph("First **this**,\nthen that."),
            .list([
                .init(level: 0, marker: .bullet, text: "one"),
                .init(level: 0, marker: .bullet, text: "two"),
                .init(level: 1, marker: .bullet, text: "nested wrapped line"),
                .init(level: 0, marker: .number("1"), text: "first"),
                .init(level: 0, marker: .number("2"), text: "second"),
                .init(level: 0, marker: .todo(done: true), text: "done"),
                .init(level: 0, marker: .todo(done: false), text: "open"),
            ]),
            .quote("quoted\ntwice"),
            .rule,
            .table(header: ["Hotel", "Price"], rows: [["Aurora", "EUR 180"], ["Luna | Sol", ""]]),
        ])
    }

    @Test func aLineThatIsOnlyALinkBecomesALinkBlock() {
        #expect(Markdown.parse("See:\n\n[The menu](https://example.com/menu)\n\nhttps://www.example.org/a") == [
            .paragraph("See:"),
            .link(title: "The menu", url: URL(string: "https://example.com/menu")!),
            .link(title: "www.example.org", url: URL(string: "https://www.example.org/a")!),
        ])
        // A link inside a sentence stays in the sentence.
        #expect(Markdown.parse("Try [this](https://example.com) first") == [.paragraph("Try [this](https://example.com) first")])
    }

    @Test func bareURLsInProseBecomeLinks() {
        let text = Markdown.inline("Booked at https://example.com/x, see **also** [here](https://example.org).")
        let links = text.runs.compactMap(\.link).map(\.absoluteString)
        #expect(links == ["https://example.com/x", "https://example.org"])
        #expect(String(text.characters) == "Booked at https://example.com/x, see also here.")
    }

    @Test func theAgentsCardBlocksAreRead() {
        let text = """
        Booked.
        ```event
        title: Dinner with Sam
        start: 2026-03-14 19:00
        end: 2026-03-14 21:00
        place: Trattoria Roma, Via Appia 12
        note: Table for two
        ```
        ```schedule
        title: Saturday in Rome
        09:00 | Breakfast at the hotel
        - 10:30 | Colosseum | tickets are in your email
        13:00 Lunch
        ```
        ```card
        title: Hotel Aurora
        subtitle: Trastevere
        price: EUR 180 per night
        link: https://example.com/aurora
        ```
        """
        #expect(Markdown.parse(text) == [
            .paragraph("Booked."),
            .event(EventCard(title: "Dinner with Sam", start: "2026-03-14 19:00", end: "2026-03-14 21:00", place: "Trattoria Roma, Via Appia 12", note: "Table for two")),
            .schedule(ScheduleCard(title: "Saturday in Rome", entries: [
                .init(time: "09:00", what: "Breakfast at the hotel", detail: nil),
                .init(time: "10:30", what: "Colosseum", detail: "tickets are in your email"),
                .init(time: "13:00", what: "Lunch", detail: nil),
            ])),
            .card(InfoCard(title: "Hotel Aurora", subtitle: "Trastevere", link: URL(string: "https://example.com/aurora"), fields: [.init(label: "Price", value: "EUR 180 per night")])),
        ])
    }

    @Test func aCardBlockThatCannotBeReadStaysCode_andOneStillStreamingIsReadAsFarAsItGoes() {
        #expect(Markdown.parse("```event\nno fields here\n```") == [.code(language: "event", text: "no fields here")])
        #expect(Markdown.parse("```event\ntitle: Lunch\nstart: 2026-03-1") == [
            .event(EventCard(title: "Lunch", start: "2026-03-1", end: nil, place: nil, note: nil)),
        ])
    }

    @Test func aWidgetBlockIsACardMadeOfHomeWidgetParts() throws {
        let text = """
        Here is your week.

        ```widget
        {"type":"stack","gradient":["#0B3D91","#1F6FEB"],"color":"white","children":[
          {"type":"stat","value":"8,412","label":"Steps"},
          {"type":"hologram","text":"from a newer server"},
          {"type":"button","text":"Ask about it","action":{"type":"ask","prompt":"Why so few steps?"}}]}
        ```
        """
        let blocks = Markdown.parse(text)
        guard blocks.count == 2, case .widget(let node) = blocks[1], case .stack(let children) = node.kind else {
            Issue.record("expected a paragraph and a widget card, got \(blocks)")
            return
        }
        #expect(node.style.gradient == ["#0b3d91", "#1f6feb"] || node.style.gradient == ["#0B3D91", "#1F6FEB"])
        #expect(children.count == 3)
        #expect(children[2].action == .ask("Why so few steps?"))

        // Quoted as what it says, like a Home widget.
        let quote = try #require(blocks[1].messageQuote)
        #expect(quote.kind == "card")
        #expect(quote.title == "Steps: 8,412")
    }

    @Test func aWidgetBlockThatCannotBeDrawnFallsBackToCode_andWaitsWhileItIsStillBeingWritten() {
        func isCode(_ block: MarkdownBlock?) -> Bool { if case .code("widget", _)? = block { true } else { false } }
        // Not JSON, nothing the app knows, and Home's own types.
        #expect(isCode(Markdown.parse("```widget\ntitle: Steps\n```").first))
        #expect(isCode(Markdown.parse(#"```widget\#n{"type":"stack","children":[{"type":"hologram"}]}\#n```"#).first))
        #expect(isCode(Markdown.parse(#"```widget\#n{"type":"headline","text":"Hi"}\#n```"#).first))

        let half = #"```widget\#n{"type":"stack","children":[{"type":"text","#
        #expect(Markdown.parse(half, streaming: true) == [.pendingCard])
        // A stored message that ends there is shown as it is.
        #expect(isCode(Markdown.parse(half).first))
        // Only the open block at the end waits.
        #expect(isCode(Markdown.parse("```widget\nnope\n```\nmore", streaming: true).first))
    }

    @Test func anEventBecomesACalendarFileInLocalTime() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Jakarta")!
        let start = try #require(LocalTime("2026-03-14 19:00", calendar: calendar))
        #expect(start.hasTime)
        #expect(calendar.component(.hour, from: start.date) == 19)
        #expect(LocalTime("2026-02-30", calendar: calendar) == nil)
        #expect(LocalTime("tomorrow", calendar: calendar) == nil)

        let event = EventCard(title: "Dinner, with Sam", start: "2026-03-14 19:00", end: nil, place: "Roma; Via Appia", note: nil)
        let ics = try #require(event.ics(uid: "u1", now: Date(timeIntervalSince1970: 0)))
        #expect(ics.contains("DTSTART:20260314T190000\r\n"))
        #expect(ics.contains("DTEND:20260314T200000\r\n"))
        #expect(ics.contains("SUMMARY:Dinner\\, with Sam\r\n"))
        #expect(ics.contains("LOCATION:Roma\\; Via Appia\r\n"))
        #expect(ics.contains("DTSTAMP:19700101T000000Z\r\n"))

        let allDay = EventCard(title: "Trip", start: "2026-03-14", end: "2026-03-16", place: nil, note: nil)
        let trip = try #require(allDay.ics(uid: "u2"))
        #expect(trip.contains("DTSTART;VALUE=DATE:20260314\r\n"))
        #expect(trip.contains("DTEND;VALUE=DATE:20260317\r\n"))
        #expect(EventCard(title: "Sometime", start: "next week", end: nil, place: nil, note: nil).ics(uid: "u3") == nil)
    }

    @Test func followUpsAndMemoriesTheAgentWroteShowAsCardsAfterTheSteps() {
        let add = TimelineItem.tool(id: "t1", toolCallId: "c1", name: "task_add",
                                    input: .object(["content": .string("Check the train strike"), "due": .string("2026-10-03 08:00")]),
                                    output: "Added task_1 [next look Saturday 3 October 2026 at 08:00 GMT+7] Check the train strike", isError: false)
        let save = TimelineItem.tool(id: "t2", toolCallId: "c2", name: "memory_save", input: .object(["content": .string("Sam is vegetarian")]),
                                     output: "Saved as mem_1", isError: false)
        let known = TimelineItem.tool(id: "t3", toolCallId: "c3", name: "memory_save", input: .object(["content": .string("Sam is vegetarian")]),
                                      output: "Already remembered as mem_1", isError: false)
        let failed = TimelineItem.tool(id: "t4", toolCallId: "c4", name: "task_add", input: .object(["content": .string("x")]), output: "Could not read due", isError: true)
        let running = TimelineItem.tool(id: "t5", toolCallId: "c5", name: "memory_save", input: .object(["content": .string("y")]), output: nil, isError: false)
        let persona = TimelineItem.tool(id: "t6", toolCallId: "c6", name: "core_memory_append",
                                        input: .object(["block": .string("persona"), "text": .string("Prefers short answers.")]), output: "Core memory updated", isError: false)
        let reply = TimelineItem.assistantText(id: "a", text: "Done.", model: nil, streaming: false)

        let rows = ChatRow.rows(from: [add, save, known, failed, running, persona, reply])
        #expect(rows == [
            .steps(id: "steps-c1", items: [add, save, known, failed, running, persona]),
            .item(.card(id: "t1-card", card: .followUp(text: "Check the train strike", when: "Saturday 3 October at 08:00", moved: false))),
            .item(.card(id: "t2-card", card: .memory(text: "Sam is vegetarian", about: .archive))),
            .item(.card(id: "t6-card", card: .memory(text: "Prefers short answers.", about: .persona))),
            .item(reply),
        ])

        let moved = ChatCard(tool: "task_update", input: .object(["id": .string("task_1"), "wait_minutes": .number(60)]),
                             output: "Updated task_1 [next look at the next check-in] Check the train strike — note: still on", isError: false)
        #expect(moved == .followUp(text: "Check the train strike", when: nil, moved: true))
    }

    @Test func aRunThatStartsAgainAfterARestartDropsWhatTheLostStepHadStreamed() {
        var t = ChatTimeline()
        t.beginSend(text: "go")
        t.apply(RunEvent(seq: 1, kind: .runStarted(runId: "run_1", conversationId: "c", model: "m")))
        t.apply(RunEvent(seq: 2, kind: .textDelta("Half an ans")))
        t.apply(RunEvent(seq: 3, kind: .toolApprovalRequested(id: "c1", name: "shell", input: .null, risk: nil, reason: nil)))
        #expect(t.live.count == 2)

        t.apply(RunEvent(seq: 1_000_001, kind: .runStarted(runId: "run_1", conversationId: "c", model: "m")))
        #expect(t.live.isEmpty)
        #expect(t.awaitingApproval.isEmpty)
        #expect(t.isRunning)
        #expect(t.lastSeq == 1_000_001)
    }
}

struct SteeringTests {
    private func user(_ id: String, seq: Int, _ text: String) -> Message {
        Message(id: id, conversationId: "c", seq: seq, role: .user, text: text, parts: [.text(text)], model: nil, runId: "run_1", createdAt: "2026-10-02T10:00:00.000Z")
    }

    @Test func whatIsSentToARunAtWorkShowsPendingUntilTheServerStoresIt() {
        var t = ChatTimeline()
        t.beginSend(text: "Plan it")
        t.apply(RunEvent(seq: 1, kind: .runStarted(runId: "run_1", conversationId: "c", model: "m")))
        t.apply(RunEvent(seq: 2, kind: .message(user("u1", seq: 1, "Plan it"))))
        t.apply(RunEvent(seq: 3, kind: .toolCall(id: "c1", name: "shell", input: .null)))

        t.beginSteer(id: "s1", text: "Make it vegetarian")
        t.beginSteer(id: "s2", text: "And cheap")
        #expect(t.items.suffix(2) == [.user(id: "s1", text: "Make it vegetarian", pending: true), .user(id: "s2", text: "And cheap", pending: true)])
        // The message that opened the run coming back does not clear them.
        #expect(t.steers.count == 2)

        // The server stores both as one message.
        t.apply(RunEvent(seq: 4, kind: .message(user("u2", seq: 4, "Make it vegetarian\n\nAnd cheap"))))
        #expect(t.steers.isEmpty)
        #expect(t.items.contains(.user(id: "u2", text: "Make it vegetarian\n\nAnd cheap", pending: false)))
        #expect(t.isRunning)
    }

    @Test func aSteerToARunThatIsStoppedGoesBackToTheComposer_oneThatOutlivesItsRunStays() {
        var t = ChatTimeline()
        t.beginSend(text: "Go")
        t.apply(RunEvent(seq: 1, kind: .runStarted(runId: "run_1", conversationId: "c", model: "m")))
        t.beginSteer(id: "s1", text: "Wait, not that")
        t.apply(RunEvent(seq: 2, kind: .runCancelled))
        #expect(t.steers.isEmpty)
        // Stopped before the server stored "Go": that comes back too, ahead of the steer.
        #expect(t.takeUnsentSteers() == ["Go", "Wait, not that"])
        #expect(t.takeUnsentSteers().isEmpty)

        t.beginSend(text: "Go again")
        t.apply(RunEvent(seq: 1, kind: .runStarted(runId: "run_2", conversationId: "c", model: "m")))
        t.beginSteer(id: "s2", text: "One more thing")
        t.apply(RunEvent(seq: 2, kind: .runCompleted(finishReason: "stop", steps: 1, usage: RunUsage(inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0))))
        // The server makes it the next run; it stays on screen until that run stores it.
        #expect(t.steers.count == 1)
        #expect(t.takeUnsentSteers().isEmpty)
    }

    @Test func quickRepliesAreReadFromAChoicesBlockAndNotDrawnInTheMessage() {
        let text = """
        Which of these describes you best?

        ```choices
        - Student
        2. Employee
        Employee
        Artist

        ```
        """
        #expect(Markdown.parse(text) == [.paragraph("Which of these describes you best?"), .choices(["Student", "Employee", "Artist"])])
        #expect(Markdown.quickReplies(text) == ["Student", "Employee", "Artist"])
        #expect(Markdown.quickReplies("No question here.").isEmpty)
        // An empty block is shown as it was written rather than lost.
        #expect(Markdown.parse("```choices\n```") == [.code(language: "choices", text: "")])
    }
}
