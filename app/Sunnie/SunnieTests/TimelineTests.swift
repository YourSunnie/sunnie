import Foundation
import Testing
@testable import Sunnie

struct TimelineTests {
    private func message(_ id: String, seq: Int, role: Message.Role, text: String = "", parts: [MessagePart] = []) -> Message {
        Message(id: id, conversationId: "conv_1", seq: seq, role: role, text: text,
                parts: parts.isEmpty && role == .user ? [.text(text)] : parts,
                model: role == .user ? nil : "fake/m", runId: "run_1", createdAt: "2026-10-01T10:00:00.000Z")
    }

    private func event(_ seq: Int, _ kind: RunEvent.Kind) -> RunEvent { RunEvent(seq: seq, kind: kind) }

    @Test func aHandoffHoldsTheRunUntilTheUserHandsTheBrowserBack() {
        var t = ChatTimeline()
        t.apply(event(1, .runStarted(runId: "run_1", conversationId: "conv_1", model: "fake/m")))
        // The request can overtake the call itself; the row is made from it.
        t.apply(event(2, .browserHandoffRequested(id: "c1", handoffId: "hand_1", reason: "Solve the CAPTCHA.")))
        #expect(t.awaitingHandoff == ["c1": "Solve the CAPTCHA."])
        #expect(t.activity == .awaitingHandoff)
        #expect(t.activity?.label == "Waiting for you in the browser…")
        #expect(t.items == [.tool(id: "live-1", toolCallId: "c1", name: "browser_handoff", input: .object(["reason": .string("Solve the CAPTCHA.")]), output: nil, isError: false)])
        t.apply(event(3, .toolCall(id: "c1", name: "browser_handoff", input: .object(["reason": .string("Solve the CAPTCHA.")]))))
        #expect(t.items.count == 1, "the call that follows its own request adds no row")

        t.apply(event(4, .browserHandoffResolved(id: "c1", handoffId: "hand_1", outcome: "done")))
        #expect(t.awaitingHandoff.isEmpty)
        #expect(t.activity == .tool(name: "browser_handoff"))
        t.apply(event(5, .toolResult(id: "c1", name: "browser_handoff", output: "Page: Home", isError: false)))
        #expect(t.activity == .thinking)
        #expect(ChatRow.summary(of: t.items) == "Handed you the browser")

        // A run that ends, or a new one, waits for nothing any more.
        t.apply(event(6, .browserHandoffRequested(id: "c2", handoffId: "hand_2", reason: "Sign in.")))
        t.apply(event(1_000_001, .runStarted(runId: "run_1", conversationId: "conv_1", model: "fake/m")))
        #expect(t.awaitingHandoff.isEmpty)
        t.apply(event(1_000_002, .browserHandoffRequested(id: "c3", handoffId: "hand_3", reason: "Sign in.")))
        t.apply(event(1_000_003, .runCancelled))
        #expect(t.awaitingHandoff.isEmpty)
        #expect(!t.isRunning)
    }

    @Test func browserInputIsSentAsTheServerReadsIt() {
        #expect(BrowserInput.tap(x: 10, y: 20).body.compactMapValues { $0 } as NSDictionary == ["kind": "tap", "x": 10.0, "y": 20.0] as NSDictionary)
        #expect(BrowserInput.text("hunter2", secret: true).body.compactMapValues { $0 } as NSDictionary == ["kind": "text", "text": "hunter2", "secret": true] as NSDictionary)
        #expect(BrowserInput.key("Enter").body.compactMapValues { $0 } as NSDictionary == ["kind": "key", "key": "Enter"] as NSDictionary)
        #expect(BrowserInput.scroll(x: 1, y: 2, dx: 0, dy: 700).body.compactMapValues { $0 } as NSDictionary == ["kind": "scroll", "x": 1.0, "y": 2.0, "dx": 0.0, "dy": 700.0] as NSDictionary)
    }

    @Test func aTurnStreamsThenSettlesIntoPersistedMessages() {
        var t = ChatTimeline()
        t.beginSend(text: "run: ls")
        #expect(t.isRunning)
        #expect(t.items == [.user(id: "pending", text: "run: ls", pending: true)])

        t.apply(event(1, .runStarted(runId: "run_1", conversationId: "conv_1", model: "fake/m")))
        t.apply(event(2, .message(message("msg_u", seq: 1, role: .user, text: "run: ls"))))
        #expect(t.items == [.user(id: "msg_u", text: "run: ls", pending: false)])

        t.apply(event(3, .route(decision: "tool", tool: "shell", confidence: 0.9, reason: nil)))
        #expect(t.activity == .tool(name: "shell"))
        t.apply(event(4, .toolCall(id: "c1", name: "shell", input: .object(["command": .string("ls")]))))
        t.apply(event(5, .toolResult(id: "c1", name: "shell", output: "a.txt", isError: false)))
        #expect(t.items.last == .tool(id: "live-1", toolCallId: "c1", name: "shell", input: .object(["command": .string("ls")]), output: "a.txt", isError: false))

        // The step is persisted as an assistant message plus a tool message; live rows are replaced.
        t.apply(event(6, .message(message("msg_a1", seq: 2, role: .assistant, parts: [.toolCall(id: "c1", name: "shell", input: .object(["command": .string("ls")]))]))))
        t.apply(event(7, .message(message("msg_t1", seq: 3, role: .tool, parts: [.toolResult(id: "c1", name: "shell", output: "a.txt", isError: false)]))))
        #expect(t.items == [
            .user(id: "msg_u", text: "run: ls", pending: false),
            .tool(id: "msg_a1-0", toolCallId: "c1", name: "shell", input: .object(["command": .string("ls")]), output: "a.txt", isError: false),
        ])

        t.apply(event(8, .textDelta("Tool said: ")))
        t.apply(event(9, .textDelta("a.txt")))
        #expect(t.activity == .writing)
        #expect(t.items.last == .assistantText(id: "live-2", text: "Tool said: a.txt", model: "fake/m", streaming: true))

        t.apply(event(10, .message(message("msg_a2", seq: 4, role: .assistant, text: "Tool said: a.txt", parts: [.text("Tool said: a.txt")]))))
        let usage = RunUsage(inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0)
        t.apply(event(11, .runCompleted(finishReason: "stop", steps: 2, usage: usage)))
        #expect(!t.isRunning)
        #expect(t.runId == nil)
        #expect(t.lastSeq == 11)
        #expect(t.lastUsage == usage)
        #expect(t.items.count == 3)
        #expect(t.items.last == .assistantText(id: "msg_a2-0", text: "Tool said: a.txt", model: "fake/m", streaming: false))
    }

    @Test func aCheckInOpenerIsNotDrawnAsSomethingTheUserSaid() throws {
        let json = #"{"id":"msg_h","conversationId":"conv_1","seq":1,"role":"user","text":"Check-in on a follow-up:\n- Water the plants","origin":"heartbeat","parts":[{"type":"text","text":"Check-in on a follow-up:\n- Water the plants"}],"model":null,"runId":"run_1","createdAt":"2026-10-01T10:00:00.000Z"}"#
        let opener = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        #expect(opener.origin == "heartbeat")

        var t = ChatTimeline()
        t.insert([opener, message("msg_a", seq: 2, role: .assistant, text: "Done.", parts: [.toolCall(id: "c1", name: "task_done", input: .null), .text("Done.")])])
        #expect(t.items.first == .checkIn(id: "msg_h", text: "Check-in on a follow-up:\n- Water the plants"))
        #expect(ChatRow.summary(of: t.items) == "Updated its follow-ups")

        // A message from a server without the field is an ordinary user message.
        #expect(message("msg_u", seq: 3, role: .user, text: "hi").origin == nil)
    }

    @Test func theGreetingStartsWithSunniesWordsAndOffersHerQuickReplies() throws {
        let json = #"{"id":"msg_g","conversationId":"conv_1","seq":1,"role":"user","text":"Connected for the first time","origin":"greeting","parts":[{"type":"text","text":"Connected for the first time"}],"model":null,"runId":"run_1","createdAt":"2026-10-06T10:00:00.000Z"}"#
        let opener = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        let hello = "Nice to meet you, John! Which of these matches you?\n\n```choices\nStudent\nEmployee\nArtist\n```"

        var t = ChatTimeline()
        t.insert([opener, message("msg_a", seq: 2, role: .assistant, text: hello, parts: [.text(hello)])])
        #expect(t.items == [.assistantText(id: "msg_a-0", text: hello, model: "fake/m", streaming: false)])
        guard case .assistantText(_, let text, _, _)? = t.items.last else { Issue.record("no reply"); return }
        #expect(Markdown.quickReplies(text) == ["Student", "Employee", "Artist"])
    }

    @Test func aHeldToolCallWaitsForTheUsersAnswer() {
        let input = JSONValue.object(["command": .string("rm -rf notes")])
        let row = TimelineItem.tool(id: "live-1", toolCallId: "c1", name: "shell", input: input, output: nil, isError: false)

        var t = ChatTimeline()
        t.apply(event(1, .runStarted(runId: "run_1", conversationId: "conv_1", model: "fake/m")))
        t.apply(event(2, .toolCall(id: "c1", name: "shell", input: input)))
        t.apply(event(3, .toolApprovalRequested(id: "c1", name: "shell", input: input, risk: 0.97, reason: nil)))
        #expect(t.awaitingApproval == ["c1"])
        #expect(t.activity == .awaitingApproval)
        #expect(t.items == [row])

        t.apply(event(4, .toolApprovalResolved(id: "c1", approved: true)))
        #expect(t.awaitingApproval.isEmpty)
        #expect(t.activity == .tool(name: "shell"))
        t.apply(event(5, .toolResult(id: "c1", name: "shell", output: "", isError: false)))
        #expect(t.activity == .thinking)

        // A held browser call keeps what its ref stands for; a later call reusing the id does not inherit it.
        let target = ApprovalTarget(element: #"button "Submit""#, title: "Expenses", url: "https://hr.example.com/x")
        t.apply(event(6, .toolApprovalRequested(id: "c1", name: "browser_click", input: .object(["ref": .string("e3")]), risk: 0.9, reason: nil, target: target)))
        #expect(t.approvalTargets["c1"] == target)
        t.apply(event(7, .toolApprovalRequested(id: "c1", name: "shell", input: input, risk: 0.9, reason: nil)))
        #expect(t.approvalTargets["c1"] == nil)

        // The request can arrive before the call it is about; there is still one row.
        var early = ChatTimeline()
        early.apply(event(1, .toolApprovalRequested(id: "c1", name: "shell", input: input, risk: nil, reason: "filter-unavailable")))
        early.apply(event(2, .toolCall(id: "c1", name: "shell", input: input)))
        #expect(early.items == [row])
        #expect(early.activity == .awaitingApproval)
        early.apply(event(3, .toolApprovalResolved(id: "c1", approved: false)))
        early.apply(event(4, .toolResult(id: "c1", name: "shell", output: "The user declined this action.", isError: true)))
        #expect(early.awaitingApproval.isEmpty)
        #expect(early.items == [.tool(id: "live-1", toolCallId: "c1", name: "shell", input: input, output: "The user declined this action.", isError: true)])

        // A run that ends while waiting (stopped from the composer) leaves nothing to answer.
        var stopped = ChatTimeline()
        stopped.apply(event(1, .toolApprovalRequested(id: "c1", name: "shell", input: input, risk: 0.9, reason: nil)))
        stopped.apply(event(2, .runCancelled))
        #expect(stopped.awaitingApproval.isEmpty)
    }

    @Test func replayedEventsDoNotDuplicateMessages() {
        var t = ChatTimeline()
        t.insert([message("msg_u", seq: 1, role: .user, text: "hi")])
        t.resume(runId: "run_1")
        t.apply(event(1, .runStarted(runId: "run_1", conversationId: "conv_1", model: "fake/m")))
        t.apply(event(2, .message(message("msg_u", seq: 1, role: .user, text: "hi"))))
        t.apply(event(3, .message(message("msg_a", seq: 2, role: .assistant, text: "hello", parts: [.text("hello")]))))
        t.apply(event(3, .message(message("msg_a", seq: 2, role: .assistant, text: "hello", parts: [.text("hello")]))))
        #expect(t.messages.map(\.id) == ["msg_u", "msg_a"])
        #expect(t.items.count == 2)
    }

    @Test func replyRoutingDoesNotPretendToExecuteATool() {
        var t = ChatTimeline()
        t.apply(event(1, .route(decision: "auto", tool: "reply_to_user", confidence: 0.4, reason: nil)))
        #expect(t.activity == .thinking)
        t.apply(event(2, .route(decision: "auto", tool: "shell", confidence: 0.4, reason: nil)))
        #expect(t.activity == .thinking)
        t.apply(event(3, .route(decision: "respond", tool: nil, confidence: 0.9, reason: nil)))
        #expect(t.activity == .writing)
        t.apply(event(4, .textDelta("Here is the reply.")))
        #expect(t.items.last == .assistantText(id: "live-1", text: "Here is the reply.", model: nil, streaming: true))
    }

    @Test func replayCursorBelongsToTheCurrentRun() {
        var t = ChatTimeline()
        t.resume(runId: "run_1")
        t.apply(event(122, .runCompleted(finishReason: "stop", steps: 2, usage: RunUsage(inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0))))
        t.beginSend(text: "Again")
        #expect(t.lastSeq == 0)
        t.apply(event(1, .runStarted(runId: "run_2", conversationId: "conv_1", model: "fake/m")))
        t.apply(event(3, .textDelta("New answer")))
        t.resume(runId: "run_2")
        #expect(t.lastSeq == 3)
        #expect(t.live.count == 1)

        // A successor run starts its own sequence; a restart keeps the same run's epoch.
        t.resume(runId: "run_3")
        #expect(t.lastSeq == 0)
        t.apply(event(1_000_001, .runStarted(runId: "run_3", conversationId: "conv_1", model: "fake/m")))
        #expect(t.lastSeq == 1_000_001)
        #expect(t.live.isEmpty)
        t.apply(event(1, .runStarted(runId: "run_4", conversationId: "conv_1", model: "fake/m")))
        #expect(t.lastSeq == 1)
    }

    @Test func olderPagesInsertInSeqOrderAndOrphanResultsStillShow() {
        var t = ChatTimeline()
        t.insert([message("msg_t", seq: 5, role: .tool, parts: [.toolResult(id: "c9", name: "shell", output: "late", isError: true)])])
        t.insert([message("msg_u", seq: 1, role: .user, text: "first")])
        #expect(t.messages.map(\.seq) == [1, 5])
        #expect(t.firstSeq == 1)
        #expect(t.items == [
            .user(id: "msg_u", text: "first", pending: false),
            .tool(id: "msg_t-0", toolCallId: "c9", name: "shell", input: .null, output: "late", isError: true),
        ])
    }

    @Test func failuresAndCancellationsBecomeNoticesAndEndTheRun() {
        var t = ChatTimeline()
        t.beginSend(text: "hi")
        t.apply(event(1, .runStarted(runId: "run_1", conversationId: "conv_1", model: "fake/m")))
        t.apply(event(2, .compactionStarted(contextTokens: 90000)))
        #expect(t.activity == .compacting)
        t.apply(event(3, .compactionFailed(error: "summariser down")))
        t.apply(event(4, .runFailed(error: "upstream exploded")))
        #expect(!t.isRunning)
        #expect(t.items.filter { if case .notice = $0 { return true } else { return false } }.count == 2)
        #expect(t.items.contains(.notice(id: "live-2", text: "upstream exploded", isError: true)))

        var c = ChatTimeline()
        c.beginSend(text: "slow")
        c.apply(event(1, .runStarted(runId: "run_2", conversationId: "conv_1", model: "fake/m")))
        c.apply(event(2, .textDelta("Thinking")))
        c.apply(event(3, .runCancelled))
        #expect(!c.isRunning)
        #expect(c.items == [.notice(id: "live-2", text: "Stopped.", isError: false)])
    }

    @Test func aFailedSendPutsTheTimelineBack() {
        var t = ChatTimeline()
        t.beginSend(text: "hi")
        t.cancelSend()
        #expect(!t.isRunning)
        #expect(t.items.isEmpty)
    }

    @Test func markdownSplitsFencedCodeFromProse() {
        let blocks = Markdown.parse("Here:\n```sh\nls -la\n```\nDone **ok**")
        #expect(blocks == [.paragraph("Here:"), .code(language: "sh", text: "ls -la"), .paragraph("Done **ok**")])
        #expect(Markdown.parse("```\nunterminated") == [.code(language: nil, text: "unterminated")])
    }

    @Test func reasoningAndToolRowsFoldIntoOneStepsRowBetweenReplies() {
        let user = TimelineItem.user(id: "u", text: "hi", pending: false)
        let think = TimelineItem.reasoning(id: "r", text: "hmm", streaming: false)
        let ls = TimelineItem.tool(id: "t1", toolCallId: "c1", name: "shell", input: .null, output: "a", isError: false)
        let page = TimelineItem.tool(id: "t2", toolCallId: "c2", name: "web_fetch", input: .null, output: "b", isError: false)
        let reply = TimelineItem.assistantText(id: "a", text: "done", model: nil, streaming: false)
        let again = TimelineItem.tool(id: "t3", toolCallId: "c1", name: "shell", input: .null, output: nil, isError: false)

        let rows = ChatRow.rows(from: [user, think, ls, page, reply, again])
        #expect(rows == [
            .item(user),
            .steps(id: "steps-c1", items: [think, ls, page]),
            .item(reply),
            // A reused tool call id still gives a distinct row.
            .steps(id: "steps-c1#1", items: [again]),
        ])
        // Streamed rows are replaced by stored ones with new ids; the row keeps its identity.
        let stored = TimelineItem.tool(id: "msg-0", toolCallId: "c1", name: "shell", input: .null, output: "a", isError: false)
        #expect(ChatRow.rows(from: [stored]).map(\.id) == ["steps-c1"])
    }

    @Test func aStepsRowReadsAsPlainLanguage() {
        func tool(_ name: String, failed: Bool = false) -> TimelineItem {
            .tool(id: name, toolCallId: "c", name: name, input: .null, output: "x", isError: failed)
        }
        #expect(ChatRow.summary(of: [.reasoning(id: "r", text: "", streaming: true)]) == "Thought it through")
        #expect(ChatRow.summary(of: [tool("shell")]) == "Ran a command")
        #expect(ChatRow.summary(of: [tool("shell"), tool("shell"), tool("browser_open"), tool("browser_click")])
                == "Ran 2 commands and used the browser")
        #expect(ChatRow.summary(of: [tool("web_fetch"), tool("read_file"), tool("memory_save"), tool("conversation_search")])
                == "Read a web page, read a file, updated its memory and more")
        #expect(ChatRow.summary(of: [tool("shell", failed: true)]) == "Ran a command · 1 step failed")
        #expect(ChatRow.summary(of: [tool("delegate"), tool("web_fetch")]) == "Sent out helpers and read a web page")
        #expect(RunActivity.tool(name: "shell").label == "Running a command…")
    }
}
