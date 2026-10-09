import Foundation

/// One row of the chat. Persisted messages and the live stream both reduce to these.
nonisolated enum TimelineItem: Identifiable, Hashable, Sendable {
    case user(id: String, text: String, pending: Bool, attachments: [Attachment] = [], quotes: [MessageQuote] = [])
    /// The opener of a turn the agent started on its own (a heartbeat check-in).
    case checkIn(id: String, text: String)
    case assistantText(id: String, text: String, model: String?, streaming: Bool)
    case reasoning(id: String, text: String, streaming: Bool)
    case tool(id: String, toolCallId: String, name: String, input: JSONValue, output: String?, isError: Bool)
    case notice(id: String, text: String, isError: Bool)
    /// Drawn from a finished tool call, never stored or streamed by itself (see `ChatCard`).
    case card(id: String, card: ChatCard)

    var id: String {
        switch self {
        case .user(let id, _, _, _, _), .checkIn(let id, _), .assistantText(let id, _, _, _), .reasoning(let id, _, _),
             .tool(let id, _, _, _, _, _), .notice(let id, _, _), .card(let id, _):
            return id
        }
    }
}

/// What a tool call left behind that the user should see without opening the steps.
nonisolated enum ChatCard: Hashable, Sendable {
    nonisolated enum MemoryPlace: Hashable, Sendable { case archive, user, persona }

    /// A follow-up the agent set for itself, or moved. `when` is the server's wording of the time.
    case followUp(text: String, when: String?, moved: Bool)
    case memory(text: String, about: MemoryPlace)

    /// The card for a tool row, if it is one that succeeded and is worth showing.
    init?(tool name: String, input: JSONValue, output: String?, isError: Bool) {
        guard let output, !isError else { return nil }
        switch name {
        case "task_add", "task_update":
            // The result reads "Added <id> [next look <time>] <content> — note: …".
            guard let m = output.firstMatch(of: /^(?:Added|Updated) \S+ \[([^\]]*)\] (.*)/.dotMatchesNewlines()) else { return nil }
            var when: String? = String(m.1)
            // "next look at the next check-in" names no time worth showing.
            if let look = when, look.hasPrefix("next look "), !look.hasSuffix("check-in") {
                when = Self.shortTime(String(look.dropFirst(10)))
            } else {
                when = nil
            }
            let text = input["content"]?.stringValue ?? String(m.2).components(separatedBy: " — note: ")[0]
            self = .followUp(text: text, when: when, moved: name == "task_update")
        case "memory_save":
            guard output.hasPrefix("Saved"), let text = input["content"]?.stringValue else { return nil }
            self = .memory(text: text, about: .archive)
        case "memory_update":
            guard let text = input["content"]?.stringValue, !text.isEmpty else { return nil }
            self = .memory(text: text, about: .archive)
        case "core_memory_append", "core_memory_replace":
            guard let text = (input["text"] ?? input["new_text"])?.stringValue, !text.isEmpty else { return nil }
            self = .memory(text: text, about: input["block"]?.stringValue == "persona" ? .persona : .user)
        default:
            return nil
        }
    }

    /// "Thursday 1 October 2026 at 14:05 GMT+7" → "Thursday 1 October at 14:05": on a phone the
    /// year and the zone are noise.
    static func shortTime(_ text: String) -> String {
        text.replacing(/\ \d{4}(?= at )/, with: "").replacing(/\ (GMT|UTC)[+\-−]?[\d:]*$/, with: "")
    }
}

/// What a run is doing right now, for the status line under the last message.
nonisolated enum RunActivity: Hashable, Sendable {
    case thinking
    case routing
    case writing
    case tool(name: String)
    case awaitingApproval
    /// The agent handed the browser to the user and waits for it back.
    case awaitingHandoff
    case compacting

    var label: String {
        switch self {
        case .thinking: return "Thinking…"
        case .routing: return "Deciding what to do…"
        case .writing: return "Writing…"
        case .tool(let name): return ChatRow.StepKind(tool: name).progress
        case .awaitingApproval: return "Waiting for your approval…"
        case .awaitingHandoff: return "Waiting for you in the browser…"
        case .compacting: return "Compacting context…"
        }
    }
}

/// The client-side state of one conversation: persisted messages plus whatever the current
/// run has streamed but not yet persisted. Pure, so `apply` is unit-tested without a server.
nonisolated struct ChatTimeline: Hashable, Sendable {
    private(set) var messages: [Message] = []
    private var seen: Set<String> = []

    /// The message just sent, until the server echoes it back as a persisted `message`.
    private(set) var pendingUser: TimelineItem?
    /// Messages sent while the run was at work, until the server stores them into the conversation.
    private(set) var steers: [TimelineItem] = []
    /// Steers that went down with a stopped or failed run, for the composer to take back.
    private(set) var unsentSteers: [String] = []
    private(set) var unsentAttachments: [Attachment] = []
    private(set) var unsentQuotes: [MessageQuote] = []
    /// Streamed parts of the model step in progress; replaced by the persisted message.
    private(set) var live: [TimelineItem] = []
    /// Run-level notices (compaction, failure, cancellation). Cleared on the next send.
    private(set) var notices: [TimelineItem] = []
    /// Tool calls (by id) the run is holding until the user allows or denies them.
    private(set) var awaitingApproval: Set<String> = []
    /// What a held browser call acts on, by tool call id; only read for a call that is waiting.
    private(set) var approvalTargets: [String: ApprovalTarget] = [:]
    /// What a held skill install would bring, in plain words, by tool call id.
    private(set) var approvalReviews: [String: SkillReview] = [:]
    /// Why a held call was flagged by the model's provider, in its words, by tool call id.
    private(set) var approvalExplanations: [String: String] = [:]
    /// Browser hand-offs the run is waiting for, by tool call id: what the agent wants done on the page.
    private(set) var awaitingHandoff: [String: String] = [:]

    private(set) var runId: String?
    private(set) var isRunning = false
    private(set) var activity: RunActivity?
    private(set) var lastSeq = 0
    private(set) var lastUsage: RunUsage?
    private(set) var lastRunModel: String?
    private var liveCounter = 0

    var isEmpty: Bool { messages.isEmpty && pendingUser == nil && live.isEmpty && steers.isEmpty }
    var firstSeq: Int? { messages.first?.seq }
    var lastMessageSeq: Int? { messages.last?.seq }

    // MARK: Persisted messages

    /// Merges messages in, ignoring any already known. Keeps ascending `seq` order.
    mutating func insert(_ incoming: [Message]) {
        var added = false
        for m in incoming where !seen.contains(m.id) {
            if m.role == .user { acknowledge(m) }
            seen.insert(m.id)
            messages.append(m)
            added = true
        }
        if added { messages.sort { $0.seq < $1.seq } }
    }

    /// HTTP catch-up and SSE must acknowledge the same pending rows.
    private mutating func acknowledge(_ message: Message) {
        let storedIds = Set((message.attachments ?? []).map(\.id))
        let storedQuotes = Set((message.quotes ?? []).map(\.id))
        func matches(_ item: TimelineItem, merged: Bool) -> Bool {
            guard case .user(_, let text, _, let attachments, let quotes) = item else { return false }
            return (!text.isEmpty || !attachments.isEmpty || !quotes.isEmpty)
                && (merged ? text.isEmpty || message.text.contains(text) : message.text == text)
                && attachments.allSatisfy { storedIds.contains($0.id) }
                && quotes.allSatisfy { storedQuotes.contains($0.id) }
        }
        if let pendingUser, matches(pendingUser, merged: false) { self.pendingUser = nil }
        steers.removeAll { matches($0, merged: true) }
    }

    // MARK: Sending

    mutating func beginSend(text: String, attachments: [Attachment] = [], quotes: [MessageQuote] = []) {
        pendingUser = .user(id: "pending", text: text, pending: true, attachments: attachments, quotes: quotes)
        notices = []
        live = []
        steers = []
        unsentSteers = []
        unsentAttachments = []
        unsentQuotes = []
        awaitingApproval = []
        awaitingHandoff = [:]
        lastUsage = nil
        runId = nil
        lastSeq = 0
        isRunning = true
        activity = .thinking
    }

    /// The user wrote to a run that is at work. Shown at once, pending, below what is streaming.
    mutating func beginSteer(id: String, text: String, attachments: [Attachment] = [], quotes: [MessageQuote] = []) {
        steers.append(.user(id: id, text: text, pending: true, attachments: attachments, quotes: quotes))
    }

    /// The steer did not reach the run (it had just ended, or the request failed).
    mutating func cancelSteer(id: String) {
        steers.removeAll { $0.id == id }
    }

    mutating func takeUnsentSteers() -> [String] {
        defer { unsentSteers = [] }
        return unsentSteers
    }

    mutating func takeUnsentAttachments() -> [Attachment] {
        defer { unsentAttachments = [] }
        return unsentAttachments
    }

    mutating func takeUnsentQuotes() -> [MessageQuote] {
        defer { unsentQuotes = [] }
        return unsentQuotes
    }

    private var steerTexts: [String] {
        steers.compactMap { if case .user(_, let text, _, _, _) = $0 { return text } else { return nil } }
    }

    /// The send failed before any event arrived; put the text back in the user's hands.
    mutating func cancelSend() {
        pendingUser = nil
        isRunning = false
        activity = nil
    }

    /// The app reopened a conversation the server says is still running.
    mutating func resume(runId: String) {
        if self.runId != runId { lastSeq = 0 }
        self.runId = runId
        isRunning = true
        activity = .thinking
    }

    mutating func finish() {
        isRunning = false
        activity = nil
        live = []
        awaitingApproval = []
        awaitingHandoff = [:]
        runId = nil
    }

    // MARK: Events

    mutating func apply(_ event: RunEvent) {
        // Event sequences belong to a run, not to the conversation.
        if case .runStarted(let id, _, _) = event.kind, id != runId { lastSeq = 0 }
        if event.seq > lastSeq { lastSeq = event.seq }
        switch event.kind {
        case let .runStarted(runId, _, model):
            // Also the start of a run picked up after a server restart: what the lost step had
            // streamed is redone, so it must not stay on screen.
            live = []
            awaitingApproval = []
            awaitingHandoff = [:]
            self.runId = runId
            isRunning = true
            lastRunModel = model
            activity = .thinking

        case .message(let message):
            if message.role == .assistant {
                // The persisted message carries exactly what was streamed.
                live = []
                awaitingApproval = []
                awaitingHandoff = [:]
                activity = .thinking
            }
            insert([message])

        case .route(let decision, let tool, _, _):
            // An auto route's tool is only a low-confidence suggestion, including reply_to_user.
            if decision == "tool", let tool {
                activity = .tool(name: tool)
            } else {
                activity = decision == "respond" ? .writing : .thinking
            }

        case .textDelta(let text):
            activity = .writing
            if case .assistantText(let id, let current, let model, _)? = live.last {
                live[live.count - 1] = .assistantText(id: id, text: current + text, model: model, streaming: true)
            } else {
                closeStreamingItems()
                live.append(.assistantText(id: nextLiveId(), text: text, model: lastRunModel, streaming: true))
            }

        case .reasoningDelta(let text):
            activity = .thinking
            if case .reasoning(let id, let current, _)? = live.last {
                live[live.count - 1] = .reasoning(id: id, text: current + text, streaming: true)
            } else {
                closeStreamingItems()
                live.append(.reasoning(id: nextLiveId(), text: text, streaming: true))
            }

        case let .toolCall(id, name, input):
            // The approval request for a call can overtake the call itself.
            guard liveToolIndex(id) == nil else { break }
            closeStreamingItems()
            activity = .tool(name: name)
            live.append(.tool(id: nextLiveId(), toolCallId: id, name: name, input: input, output: nil, isError: false))

        case let .toolApprovalRequested(id, name, input, _, _, target, review, explanation):
            if liveToolIndex(id) == nil {
                closeStreamingItems()
                live.append(.tool(id: nextLiveId(), toolCallId: id, name: name, input: input, output: nil, isError: false))
            }
            approvalTargets[id] = target
            approvalReviews[id] = review
            approvalExplanations[id] = explanation
            awaitingApproval.insert(id)
            activity = .awaitingApproval

        case let .toolApprovalResolved(id, approved):
            awaitingApproval.remove(id)
            if !awaitingApproval.isEmpty {
                activity = .awaitingApproval
            } else if approved, let index = liveToolIndex(id), case let .tool(_, _, name, _, _, _) = live[index] {
                activity = .tool(name: name)
            } else {
                activity = waitingActivity ?? .thinking
            }

        case let .browserHandoffRequested(id, _, reason):
            // The request can overtake the call itself, as an approval's can.
            if liveToolIndex(id) == nil {
                closeStreamingItems()
                live.append(.tool(id: nextLiveId(), toolCallId: id, name: "browser_handoff", input: .object(["reason": .string(reason)]), output: nil, isError: false))
            }
            awaitingHandoff[id] = reason
            activity = .awaitingHandoff

        case let .browserHandoffResolved(id, _, _):
            awaitingHandoff.removeValue(forKey: id)
            activity = waitingActivity ?? .tool(name: "browser_handoff")

        case let .toolResult(id, name, output, isError):
            awaitingApproval.remove(id)
            awaitingHandoff.removeValue(forKey: id)
            activity = waitingActivity ?? .thinking
            if let index = liveToolIndex(id),
               case let .tool(itemId, callId, _, input, _, _) = live[index] {
                live[index] = .tool(id: itemId, toolCallId: callId, name: name, input: input, output: output, isError: isError)
            } else {
                live.append(.tool(id: nextLiveId(), toolCallId: id, name: name, input: .null, output: output, isError: isError))
            }

        case .compactionStarted:
            activity = .compacting

        case let .compactionCompleted(summarized, memories):
            activity = .thinking
            notices.append(.notice(id: nextLiveId(), text: "Context compacted: \(summarized) messages summarised, \(memories) memories saved.", isError: false))

        case .compactionFailed(let error):
            activity = .thinking
            notices.append(.notice(id: nextLiveId(), text: "Compaction failed: \(error)", isError: true))

        case let .runCompleted(_, _, usage):
            lastUsage = usage
            finish()

        case .runCancelled:
            notices.append(.notice(id: nextLiveId(), text: "Stopped.", isError: false))
            dropSteers()
            finish()

        case .runFailed(let error):
            notices.append(.notice(id: nextLiveId(), text: error, isError: true))
            dropSteers()
            finish()

        case .unknown:
            break
        }
    }

    /// The stream dropped and the run is gone from the server: whatever was streamed but not
    /// persisted is discarded (the server never stores a partial step).
    mutating func abandonRun(message: String?) {
        if let message { notices.append(.notice(id: nextLiveId(), text: message, isError: true)) }
        pendingUser = nil
        finish()
    }

    /// The server drops what was said to a run that is stopped or fails; hand it back.
    private mutating func dropSteers() {
        if case .user(_, let text, _, let attachments, let quotes) = pendingUser {
            unsentSteers.append(text)
            unsentAttachments += attachments
            unsentQuotes += quotes
        }
        pendingUser = nil
        unsentSteers += steerTexts
        unsentAttachments += steers.flatMap { item -> [Attachment] in
            if case .user(_, _, _, let attachments, _) = item { return attachments }
            return []
        }
        unsentQuotes += steers.flatMap { item -> [MessageQuote] in
            if case .user(_, _, _, _, let quotes) = item { return quotes }
            return []
        }
        steers = []
    }

    /// What the run is still waiting on the user for, if anything.
    private var waitingActivity: RunActivity? {
        if !awaitingApproval.isEmpty { return .awaitingApproval }
        if !awaitingHandoff.isEmpty { return .awaitingHandoff }
        return nil
    }

    private func liveToolIndex(_ toolCallId: String) -> Int? {
        live.firstIndex { if case .tool(_, let callId, _, _, _, _) = $0 { return callId == toolCallId } else { return false } }
    }

    private mutating func nextLiveId() -> String {
        liveCounter += 1
        return "live-\(liveCounter)"
    }

    private mutating func closeStreamingItems() {
        live = live.map {
            switch $0 {
            case let .assistantText(id, text, model, _): return .assistantText(id: id, text: text, model: model, streaming: false)
            case let .reasoning(id, text, _): return .reasoning(id: id, text: text, streaming: false)
            default: return $0
            }
        }
    }

    // MARK: Rendering

    /// What a check-in says when it has nothing for the user (an interest check-in stores no text).
    nonisolated static let quietWords: Set<String> = ["", "nothing_to_share", "nothing to report.", "nothing to report"]

    /// Check-ins that came to nothing: runs the agent opened itself, nobody else wrote in, and
    /// whose last words were at most "nothing to report". The run in progress is never one: it
    /// has not finished speaking. The server leaves the same runs out of a `quiet=hide` listing;
    /// this catches one that ended while the chat was open.
    static func quietRuns(in messages: [Message], running: String?) -> Set<String> {
        var opened: Set<String> = [], joined: Set<String> = [], lastWords: [String: String] = [:]
        for m in messages {
            guard let run = m.runId else { continue }
            switch m.role {
            case .user: if m.origin == nil { joined.insert(run) } else { opened.insert(run) }
            case .assistant:
                let text = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { lastWords[run] = text }
            case .tool: break
            }
        }
        return opened.subtracting(joined).filter { run in
            run != running && quietWords.contains(lastWords[run]?.lowercased() ?? "")
        }
    }

    /// Everything to draw, oldest first.
    var items: [TimelineItem] {
        var out: [TimelineItem] = []
        var toolRows: [String: Int] = [:]
        let quiet = Self.quietRuns(in: messages, running: isRunning ? runId : nil)
        for m in messages where !(m.runId.map(quiet.contains) ?? false) {
            switch m.role {
            case .user:
                // The greeting opens with a line nobody said: Sunnie speaks first.
                if m.origin == "greeting" { continue }
                // Any origin means the user did not type it; an unknown one still must not look like them.
                out.append(m.origin == nil ? .user(id: m.id, text: m.text, pending: false, attachments: m.attachments ?? [], quotes: m.quotes ?? []) : .checkIn(id: m.id, text: m.text))
            case .assistant:
                for (i, part) in m.parts.enumerated() {
                    let id = "\(m.id)-\(i)"
                    switch part {
                    case .text(let text):
                        if !text.isEmpty { out.append(.assistantText(id: id, text: text, model: m.model, streaming: false)) }
                    case .reasoning(let text):
                        if !text.isEmpty { out.append(.reasoning(id: id, text: text, streaming: false)) }
                    case let .toolCall(callId, name, input):
                        toolRows[callId] = out.count
                        out.append(.tool(id: id, toolCallId: callId, name: name, input: input, output: nil, isError: false))
                    case .toolResult:
                        break
                    }
                }
            case .tool:
                for (i, part) in m.parts.enumerated() {
                    guard case let .toolResult(callId, name, output, isError) = part else { continue }
                    if let row = toolRows[callId], case let .tool(id, _, _, input, _, _) = out[row] {
                        out[row] = .tool(id: id, toolCallId: callId, name: name, input: input, output: output, isError: isError)
                    } else {
                        // The call is on a page that was not loaded; still show what came back.
                        out.append(.tool(id: "\(m.id)-\(i)", toolCallId: callId, name: name, input: .null, output: output, isError: isError))
                    }
                }
            }
        }
        if let pendingUser { out.append(pendingUser) }
        out.append(contentsOf: live)
        out.append(contentsOf: steers)
        out.append(contentsOf: notices)
        return out
    }
}

/// What the chat draws: replies and notices as they are, and every run of reasoning and tool
/// rows between them folded into one `steps` row that reads as a single plain-language line.
nonisolated enum ChatRow: Identifiable, Hashable, Sendable {
    case item(TimelineItem)
    case steps(id: String, items: [TimelineItem])

    var id: String {
        switch self {
        case .item(let item): return item.id
        case .steps(let id, _): return id
        }
    }

    static func rows(from items: [TimelineItem]) -> [ChatRow] {
        var out: [ChatRow] = []
        var run: [TimelineItem] = []
        var keysUsed: [String: Int] = [:]

        func flush() {
            guard !run.isEmpty else { return }
            // Keyed by the first tool call rather than the first row's id, so the row keeps its
            // identity (and its expanded state) when a streamed step is replaced by the stored one.
            let firstCall = run.lazy.compactMap { item -> String? in
                if case .tool(_, let callId, _, _, _, _) = item { return callId } else { return nil }
            }.first
            var key = "steps-" + (firstCall ?? run[0].id)
            // Some providers reuse tool call ids.
            let n = keysUsed[key, default: 0]
            keysUsed[key] = n + 1
            if n > 0 { key += "#\(n)" }
            out.append(.steps(id: key, items: run))
            for item in run {
                guard case let .tool(id, _, name, input, output, isError) = item,
                      let card = ChatCard(tool: name, input: input, output: output, isError: isError) else { continue }
                out.append(.item(.card(id: id + "-card", card: card)))
            }
            run = []
        }

        for item in items {
            switch item {
            case .reasoning, .tool:
                run.append(item)
            default:
                flush()
                out.append(.item(item))
            }
        }
        flush()
        return out
    }

    /// One line saying what the agent did, without tool names or arguments.
    static func summary(of items: [TimelineItem]) -> String {
        var counts: [StepKind: Int] = [:]
        var order: [StepKind] = []
        var failed = 0
        for item in items {
            guard case let .tool(_, _, name, _, output, isError) = item else { continue }
            let kind = StepKind(tool: name)
            if counts[kind] == nil { order.append(kind) }
            counts[kind, default: 0] += 1
            if isError, output != nil { failed += 1 }
        }
        guard !order.isEmpty else { return "Thought it through" }

        var phrases = order.prefix(3).map { $0.phrase(count: counts[$0]!) }
        if order.count > 3 { phrases.append("more") }
        var line = phrases.count == 1
            ? phrases[0]
            : phrases.dropLast().joined(separator: ", ") + " and " + phrases.last!
        line = line.prefix(1).uppercased() + line.dropFirst()
        if failed > 0 { line += failed == 1 ? " · 1 step failed" : " · \(failed) steps failed" }
        return line
    }

    nonisolated enum StepKind: Hashable, Sendable {
        case command, webPage, browser, handoff, readFile, editFile, searchMemory, updateMemory, searchChats, followUps, helpers
        case readSkill, writeSkill, installSkill
        case other(String)

        init(tool name: String) {
            switch name {
            case "bash", "shell": self = .command
            case "web_fetch": self = .webPage
            case "browser_handoff": self = .handoff
            case _ where name.hasPrefix("browser_"): self = .browser
            case "read_file": self = .readFile
            case "write_file", "edit_file": self = .editFile
            case "memory_search": self = .searchMemory
            case "memory_save", "memory_update", "memory_delete", "core_memory_append", "core_memory_replace":
                self = .updateMemory
            case "conversation_search": self = .searchChats
            case _ where name.hasPrefix("task_"): self = .followUps
            case "delegate", "helper_message": self = .helpers
            case "skill_list", "skill_read": self = .readSkill
            case "skill_write": self = .writeSkill
            case "skill_install": self = .installSkill
            default: self = .other(name.replacingOccurrences(of: "_", with: " "))
            }
        }

        func phrase(count n: Int) -> String {
            switch self {
            case .command: return n == 1 ? "ran a command" : "ran \(n) commands"
            case .webPage: return n == 1 ? "read a web page" : "read \(n) web pages"
            case .browser: return "used the browser"
            case .handoff: return "handed you the browser"
            case .readFile: return n == 1 ? "read a file" : "read \(n) files"
            case .editFile: return n == 1 ? "edited a file" : "edited \(n) files"
            case .searchMemory: return "searched its memory"
            case .updateMemory: return "updated its memory"
            case .searchChats: return "searched past chats"
            case .followUps: return "updated its follow-ups"
            case .helpers: return "sent out helpers"
            case .readSkill: return "read its skills"
            case .writeSkill: return "saved a skill"
            case .installSkill: return "installed a skill"
            case .other(let name): return "used \(name)"
            }
        }

        var progress: String {
            switch self {
            case .command: return "Running a command…"
            case .webPage: return "Reading a web page…"
            case .browser: return "Using the browser…"
            case .handoff: return "Waiting for you in the browser…"
            case .readFile: return "Reading a file…"
            case .editFile: return "Editing a file…"
            case .searchMemory: return "Searching its memory…"
            case .updateMemory: return "Updating its memory…"
            case .searchChats: return "Searching past chats…"
            case .followUps: return "Updating its follow-ups…"
            case .helpers: return "Helpers are at work…"
            case .readSkill: return "Reading its skills…"
            case .writeSkill: return "Saving a skill…"
            case .installSkill: return "Installing a skill…"
            case .other(let name): return "Using \(name)…"
            }
        }
    }
}
