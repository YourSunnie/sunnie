import Foundation
import Testing
@testable import Sunnie

struct RunEventDecodingTests {
    private func decode(_ json: String) throws -> RunEvent {
        try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    @Test func decodesEveryEventTypeTheServerSends() throws {
        #expect(try decode(#"{"type":"run.started","seq":1,"runId":"run_1","conversationId":"conv_1","model":"fake/m"}"#).kind
            == .runStarted(runId: "run_1", conversationId: "conv_1", model: "fake/m"))
        #expect(try decode(#"{"type":"route","seq":2,"router":"jev","decision":"tool","tool":"shell","confidence":0.9}"#).kind
            == .route(decision: "tool", tool: "shell", confidence: 0.9, reason: nil))
        #expect(try decode(#"{"type":"text.delta","seq":3,"text":"Hi"}"#).kind == .textDelta("Hi"))
        #expect(try decode(#"{"type":"reasoning.delta","seq":4,"text":"hmm"}"#).kind == .reasoningDelta("hmm"))
        #expect(try decode(#"{"type":"tool.call","seq":5,"toolCallId":"c1","name":"shell","input":{"command":"ls","timeout":5}}"#).kind
            == .toolCall(id: "c1", name: "shell", input: .object(["command": .string("ls"), "timeout": .number(5)])))
        #expect(try decode(#"{"type":"tool.result","seq":6,"toolCallId":"c1","name":"shell","output":"a\nb","isError":false}"#).kind
            == .toolResult(id: "c1", name: "shell", output: "a\nb", isError: false))
        #expect(try decode(#"{"type":"tool.approval.requested","seq":6,"toolCallId":"c1","name":"shell","input":{"command":"rm -rf x"},"risk":0.97}"#).kind
            == .toolApprovalRequested(id: "c1", name: "shell", input: .object(["command": .string("rm -rf x")]), risk: 0.97, reason: nil))
        #expect(try decode(#"{"type":"tool.approval.requested","seq":6,"toolCallId":"c1","name":"shell","input":{},"reason":"filter-unavailable"}"#).kind
            == .toolApprovalRequested(id: "c1", name: "shell", input: .object([:]), risk: nil, reason: "filter-unavailable"))
        // A held browser call says which element its ref stands for; a shape from a newer server is skipped, not fatal.
        let target = ApprovalTarget(element: #"button "Submit for approval""#, title: "New expense report", url: "https://hr.example.com/expenses/new")
        #expect(try decode(#"{"type":"tool.approval.requested","seq":6,"toolCallId":"c1","name":"browser_click","input":{"ref":"e36"},"target":{"element":"button \"Submit for approval\"","title":"New expense report","url":"https://hr.example.com/expenses/new"},"risk":0.9}"#).kind
            == .toolApprovalRequested(id: "c1", name: "browser_click", input: .object(["ref": .string("e36")]), risk: 0.9, reason: nil, target: target))
        #expect(try decode(#"{"type":"tool.approval.requested","seq":6,"toolCallId":"c1","name":"browser_click","input":{},"target":"soon"}"#).kind
            == .toolApprovalRequested(id: "c1", name: "browser_click", input: .object([:]), risk: nil, reason: nil))
        // A held skill install comes with what it is, in plain words, for the person deciding.
        #expect(try decode(#"{"type":"tool.approval.requested","seq":6,"toolCallId":"c2","name":"skill_install","input":{"repository":"https://github.com/o/r","path":"s","why":"For your reports."},"review":{"summary":"**What it is** — A helper.","caution":true,"checked":true},"reason":"skill-caution"}"#).kind
            == .toolApprovalRequested(id: "c2", name: "skill_install", input: .object(["repository": .string("https://github.com/o/r"), "path": .string("s"), "why": .string("For your reports.")]),
                                      risk: nil, reason: "skill-caution", review: SkillReview(summary: "**What it is** — A helper.", caution: true, checked: true)))
        #expect(target.label == "Submit for approval (button)")
        #expect(target.place == "New expense report · hr.example.com")
        #expect(ApprovalTarget(element: #"link "Say "hi"" (to /hi)"#).label == #"Say "hi" (link)"#)
        #expect(ApprovalTarget(element: "generic containing img, text: Next page").label == "generic containing img, text: Next page")
        #expect(ApprovalTarget(element: "generic", title: "", url: "about:blank").place == nil)
        #expect(try decode(#"{"type":"tool.approval.resolved","seq":6,"toolCallId":"c1","approved":true}"#).kind
            == .toolApprovalResolved(id: "c1", approved: true))
        // The agent asks for the browser, and hears back how it went.
        #expect(try decode(#"{"type":"browser.handoff.requested","seq":6,"toolCallId":"c1","handoffId":"hand_1","reason":"Solve the CAPTCHA."}"#).kind
            == .browserHandoffRequested(id: "c1", handoffId: "hand_1", reason: "Solve the CAPTCHA."))
        #expect(try decode(#"{"type":"browser.handoff.resolved","seq":7,"toolCallId":"c1","handoffId":"hand_1","outcome":"declined"}"#).kind
            == .browserHandoffResolved(id: "c1", handoffId: "hand_1", outcome: "declined"))
        #expect(try decode(#"{"type":"compaction.started","seq":7,"contextTokens":90000}"#).kind == .compactionStarted(contextTokens: 90000))
        #expect(try decode(#"{"type":"compaction.completed","seq":8,"summarizedMessages":12,"memoriesSaved":2}"#).kind
            == .compactionCompleted(summarizedMessages: 12, memoriesSaved: 2))
        #expect(try decode(#"{"type":"compaction.failed","seq":9,"error":"boom"}"#).kind == .compactionFailed(error: "boom"))
        let completed = try decode(#"{"type":"run.completed","seq":10,"finishReason":"stop","steps":2,"usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":80,"cacheWriteTokens":0}}"#)
        #expect(completed.seq == 10)
        #expect(completed.kind == .runCompleted(finishReason: "stop", steps: 2, usage: RunUsage(inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0)))
        #expect(try decode(#"{"type":"run.cancelled","seq":11}"#).kind == .runCancelled)
        #expect(try decode(#"{"type":"run.failed","seq":12,"error":"upstream"}"#).kind == .runFailed(error: "upstream"))
    }

    @Test func unknownEventTypesAreKeptNotFatal() throws {
        #expect(try decode(#"{"type":"something.new","seq":3,"payload":{}}"#).kind == .unknown(type: "something.new"))
    }

    @Test func decodesPersistedMessagesWithAllPartTypes() throws {
        let json = #"""
        {"type":"message","seq":2,"message":{"id":"msg_1","conversationId":"conv_1","seq":2,"role":"assistant","text":"done",
         "parts":[{"type":"reasoning","text":"think"},{"type":"tool_call","toolCallId":"c1","name":"shell","input":{"command":"ls"}},
                  {"type":"text","text":"done"},{"type":"tool_result","toolCallId":"c1","name":"shell","output":"x","isError":true}],
         "model":"fake/m","runId":"run_1","createdAt":"2026-10-01T10:00:00.123Z"}}
        """#
        guard case .message(let m) = try decode(json).kind else { Issue.record("not a message"); return }
        #expect(m.parts == [
            .reasoning("think"),
            .toolCall(id: "c1", name: "shell", input: .object(["command": .string("ls")])),
            .text("done"),
            .toolResult(id: "c1", name: "shell", output: "x", isError: true),
        ])
        #expect(m.createdDate != nil)
        #expect(ISO8601.parse("2026-10-01T10:00:00Z") != nil)
    }

    @Test func loginsDecodeWithoutSecretsAndInfoToleratesOlderServers() throws {
        let login = try JSONDecoder().decode(Login.self, from: Data(#"{"id":"login_1","name":"GitHub","site":"github.com","username":"adit","hasPassword":true,"hasTotp":false,"createdAt":"2026-10-01T10:00:00.000Z","updatedAt":"2026-10-01T10:00:00.000Z"}"#.utf8))
        #expect(login.name == "GitHub" && login.hasPassword && !login.hasTotp)

        let base = #""name":"Sunnie","version":"0.1.0","defaultModel":"fake/m","models":[],"providers":[],"router":{"type":"none","mode":"tool-choice"},"computer":"Linux","memoryCount":0"#
        let old = try JSONDecoder().decode(ServerInfo.self, from: Data("{\(base)}".utf8))
        #expect(old.browser == nil)
        #expect(old.skills == nil)
        let new = try JSONDecoder().decode(ServerInfo.self, from: Data("{\(base),\"browser\":{\"enabled\":true}}".utf8))
        #expect(new.browser?.enabled == true)
    }

    @Test func serverSettingsNormalizeWhatPeopleType() {
        #expect(ServerSettings.normalize("192.168.1.10:8787")?.absoluteString == "http://192.168.1.10:8787")
        #expect(ServerSettings.normalize(" https://sunnie.example.com/ ")?.absoluteString == "https://sunnie.example.com")
        #expect(ServerSettings.normalize("ftp://x") == nil)
        #expect(ServerSettings.normalize("") == nil)
    }
}
