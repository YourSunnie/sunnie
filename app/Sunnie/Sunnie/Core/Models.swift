import Foundation

// Client-side mirrors of the server DTOs (api/src/agent/events.ts, api/src/api/server.ts).
// Every type here is nonisolated so it can be decoded and compared off the main actor.

nonisolated struct Conversation: Codable, Hashable, Identifiable, Sendable {
    var id: String
    /// "heartbeat" for the conversation the agent's own check-ins go to. Absent on older servers.
    var kind: String?
    var title: String?
    /// Per-conversation model override; nil means the server's default model.
    var model: String?
    var reasoning: String? = nil
    var hasSummary: Bool
    /// The run currently in progress, if any. Used to re-attach after the app was away.
    var activeRunId: String?
    var createdAt: String
    var updatedAt: String

    var displayTitle: String { title?.isEmpty == false ? title! : "New conversation" }
    var updatedDate: Date? { ISO8601.parse(updatedAt) }
}

nonisolated struct Message: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var conversationId: String
    var seq: Int
    var role: Role
    /// What the human sees; `content` (the model's view) is never sent to clients.
    var text: String
    /// "heartbeat" when the agent started the turn itself; nil when the user wrote the message.
    var origin: String?
    var parts: [MessagePart]
    var model: String?
    var runId: String?
    var createdAt: String

    nonisolated enum Role: String, Codable, Sendable {
        case user, assistant, tool
    }

    var createdDate: Date? { ISO8601.parse(createdAt) }
    /// Absent on servers that predate attachments.
    var attachments: [Attachment]? = nil
    var quotes: [MessageQuote]? = nil
}

nonisolated enum MessagePart: Hashable, Sendable {
    case text(String)
    case reasoning(String)
    case toolCall(id: String, name: String, input: JSONValue)
    case toolResult(id: String, name: String, output: String, isError: Bool)
}

extension MessagePart: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, text, toolCallId, name, input, output, isError
    }

    nonisolated init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "text":
            self = .text(try c.decode(String.self, forKey: .text))
        case "reasoning":
            self = .reasoning(try c.decode(String.self, forKey: .text))
        case "tool_call":
            self = .toolCall(
                id: try c.decode(String.self, forKey: .toolCallId),
                name: try c.decode(String.self, forKey: .name),
                input: try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null
            )
        case "tool_result":
            self = .toolResult(
                id: try c.decode(String.self, forKey: .toolCallId),
                name: try c.decode(String.self, forKey: .name),
                output: try c.decode(String.self, forKey: .output),
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            )
        case let other:
            // The API only ever adds part types; an unknown one degrades to plain text.
            self = .text(try c.decodeIfPresent(String.self, forKey: .text) ?? "[\(other)]")
        }
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try c.encode("text", forKey: .type)
            try c.encode(text, forKey: .text)
        case .reasoning(let text):
            try c.encode("reasoning", forKey: .type)
            try c.encode(text, forKey: .text)
        case let .toolCall(id, name, input):
            try c.encode("tool_call", forKey: .type)
            try c.encode(id, forKey: .toolCallId)
            try c.encode(name, forKey: .name)
            try c.encode(input, forKey: .input)
        case let .toolResult(id, name, output, isError):
            try c.encode("tool_result", forKey: .type)
            try c.encode(id, forKey: .toolCallId)
            try c.encode(name, forKey: .name)
            try c.encode(output, forKey: .output)
            try c.encode(isError, forKey: .isError)
        }
    }
}

nonisolated struct RunUsage: Codable, Hashable, Sendable {
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var cacheWriteTokens: Int

    /// Share of input served from the provider's prompt cache, 0…1.
    var cacheHitRatio: Double { inputTokens > 0 ? Double(cacheReadTokens) / Double(inputTokens) : 0 }
}

nonisolated struct RunDto: Codable, Hashable, Sendable {
    var id: String
    var conversationId: String
    var status: String
    var startedAt: String
    var finishedAt: String?
    var error: String?
    /// Tool calls the run is holding until the user allows or denies them. Absent on older servers.
    var pendingApprovals: [PendingApproval]?

    nonisolated struct PendingApproval: Codable, Hashable, Sendable {
        var toolCallId: String
        var name: String
        var input: JSONValue?
        var target: ApprovalTarget?
    }
}

/// A skill about to be installed, for the person deciding: what it is, why it was chosen, what it
/// helps with and what it can reach, in plain words (Markdown). `caution`: the server's check found
/// something, or could not be done. Absent on older servers and for other tools.
nonisolated struct SkillReview: Codable, Hashable, Sendable {
    var summary: String
    var caution: Bool
    var checked: Bool
}

/// What a held browser call acts on: the element behind its ref, in the page outline's words
/// (`button "Submit for approval"`), and the page it is on. Absent on older servers and for other tools.
nonisolated struct ApprovalTarget: Codable, Hashable, Sendable {
    var element: String
    var title: String?
    var url: String?

    /// The element without the outline's quoting, e.g. `Submit for approval (button)`.
    var label: String {
        guard let open = element.firstIndex(of: "\""), let close = element.lastIndex(of: "\""), open < close else { return element }
        let name = element[element.index(after: open)..<close]
        let role = element[..<open].trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? element : role.isEmpty ? String(name) : "\(name) (\(role))"
    }

    /// Where it is: the page's title and the site, as much as is known.
    var place: String? {
        let host = url.flatMap { URL(string: $0)?.host() }
        let parts = [title, host].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The agent's browser handed to the user: `requested` while the agent waits for them to take it,
/// `active` while they hold it. `reason` is what the agent wants done on the page; nil for a
/// hand-off the user began on their own.
nonisolated struct BrowserHandoff: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var status: String
    var reason: String?
    var conversationId: String?
    var runId: String?
    var toolCallId: String?
    var startedAt: String
    var takenAt: String?

    var isActive: Bool { status == "active" }
}

/// What the user does on the page while they hold the browser. Coordinates are pixels of the
/// picture the server sent, which are the page's own.
nonisolated enum BrowserInput: Hashable, Sendable {
    case tap(x: Double, y: Double)
    case scroll(x: Double, y: Double, dx: Double, dy: Double)
    /// `secret`: a password or the like; the server keeps it out of what the agent reads afterwards.
    case text(String, secret: Bool)
    case key(String)

    var body: [String: Any?] {
        switch self {
        case let .tap(x, y): return ["kind": "tap", "x": x, "y": y]
        case let .scroll(x, y, dx, dy): return ["kind": "scroll", "x": x, "y": y, "dx": dx, "dy": dy]
        case let .text(text, secret): return ["kind": "text", "text": text, "secret": secret]
        case .key(let key): return ["kind": "key", "key": key]
        }
    }
}

/// A picture of the page the user holds, where it is, and the text field that has the focus, if any.
nonisolated struct BrowserScreen: Hashable, Sendable {
    var image: Data
    var width: Double
    var height: Double
    var url: String
    var title: String
    var focus: Focus?

    /// A text field on the page with the focus: the app offers its keyboard for it.
    nonisolated struct Focus: Hashable, Sendable {
        /// A password or the like: typed hidden, and kept out of what the agent reads.
        var secret: Bool
        /// What the page calls the field (its label or placeholder); may be empty.
        var label: String
    }
}

/// One event of a run's stream. `seq` numbers events so a dropped connection can resume.
nonisolated struct RunEvent: Hashable, Sendable {
    var seq: Int
    var kind: Kind

    nonisolated enum Kind: Hashable, Sendable {
        case runStarted(runId: String, conversationId: String, model: String)
        case message(Message)
        case route(decision: String, tool: String?, confidence: Double?, reason: String?)
        case textDelta(String)
        case reasoningDelta(String)
        case toolCall(id: String, name: String, input: JSONValue)
        case toolResult(id: String, name: String, output: String, isError: Bool)
        /// The call is held until the user answers. `reason` is set when it is held for something
        /// other than the filter's own judgement (e.g. "filter-unavailable", or "flagged" by the
        /// model's provider, whose words are then in `explanation`).
        case toolApprovalRequested(id: String, name: String, input: JSONValue, risk: Double?, reason: String?, target: ApprovalTarget? = nil, review: SkillReview? = nil, explanation: String? = nil)
        case toolApprovalResolved(id: String, approved: Bool)
        /// The agent asks the user to take the browser over, and waits: `reason` is what to do there.
        case browserHandoffRequested(id: String, handoffId: String, reason: String)
        /// `outcome`: `done` (handed back), `declined`, or `unanswered`.
        case browserHandoffResolved(id: String, handoffId: String, outcome: String)
        case compactionStarted(contextTokens: Int)
        case compactionCompleted(summarizedMessages: Int, memoriesSaved: Int)
        case compactionFailed(error: String)
        case runCompleted(finishReason: String, steps: Int, usage: RunUsage)
        case runCancelled
        case runFailed(error: String)
        case unknown(type: String)
    }
}

extension RunEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case seq, type, runId, conversationId, model, message, decision, tool, confidence, reason
        case text, toolCallId, name, input, output, isError, contextTokens, summarizedMessages
        case memoriesSaved, error, finishReason, steps, usage, risk, approved, target, review
        case handoffId, outcome, explanation
    }

    nonisolated init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "run.started":
            kind = .runStarted(
                runId: try c.decode(String.self, forKey: .runId),
                conversationId: try c.decode(String.self, forKey: .conversationId),
                model: try c.decode(String.self, forKey: .model)
            )
        case "message":
            kind = .message(try c.decode(Message.self, forKey: .message))
        case "route":
            kind = .route(
                decision: try c.decode(String.self, forKey: .decision),
                tool: try c.decodeIfPresent(String.self, forKey: .tool),
                confidence: try c.decodeIfPresent(Double.self, forKey: .confidence),
                reason: try c.decodeIfPresent(String.self, forKey: .reason)
            )
        case "text.delta":
            kind = .textDelta(try c.decode(String.self, forKey: .text))
        case "reasoning.delta":
            kind = .reasoningDelta(try c.decode(String.self, forKey: .text))
        case "tool.call":
            kind = .toolCall(
                id: try c.decode(String.self, forKey: .toolCallId),
                name: try c.decode(String.self, forKey: .name),
                input: try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null
            )
        case "tool.result":
            kind = .toolResult(
                id: try c.decode(String.self, forKey: .toolCallId),
                name: try c.decode(String.self, forKey: .name),
                output: try c.decode(String.self, forKey: .output),
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            )
        case "tool.approval.requested":
            kind = .toolApprovalRequested(
                id: try c.decode(String.self, forKey: .toolCallId),
                name: try c.decode(String.self, forKey: .name),
                input: try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null,
                risk: try c.decodeIfPresent(Double.self, forKey: .risk),
                reason: try c.decodeIfPresent(String.self, forKey: .reason),
                // A shape this build does not know must not cost the user the approval itself.
                target: try? c.decodeIfPresent(ApprovalTarget.self, forKey: .target),
                review: try? c.decodeIfPresent(SkillReview.self, forKey: .review),
                explanation: try? c.decodeIfPresent(String.self, forKey: .explanation)
            )
        case "tool.approval.resolved":
            kind = .toolApprovalResolved(
                id: try c.decode(String.self, forKey: .toolCallId),
                approved: try c.decodeIfPresent(Bool.self, forKey: .approved) ?? false
            )
        case "browser.handoff.requested":
            kind = .browserHandoffRequested(
                id: try c.decode(String.self, forKey: .toolCallId),
                handoffId: try c.decodeIfPresent(String.self, forKey: .handoffId) ?? "",
                reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
            )
        case "browser.handoff.resolved":
            kind = .browserHandoffResolved(
                id: try c.decode(String.self, forKey: .toolCallId),
                handoffId: try c.decodeIfPresent(String.self, forKey: .handoffId) ?? "",
                outcome: try c.decodeIfPresent(String.self, forKey: .outcome) ?? "done"
            )
        case "compaction.started":
            kind = .compactionStarted(contextTokens: try c.decodeIfPresent(Int.self, forKey: .contextTokens) ?? 0)
        case "compaction.completed":
            kind = .compactionCompleted(
                summarizedMessages: try c.decodeIfPresent(Int.self, forKey: .summarizedMessages) ?? 0,
                memoriesSaved: try c.decodeIfPresent(Int.self, forKey: .memoriesSaved) ?? 0
            )
        case "compaction.failed":
            kind = .compactionFailed(error: try c.decodeIfPresent(String.self, forKey: .error) ?? "Compaction failed")
        case "run.completed":
            kind = .runCompleted(
                finishReason: try c.decodeIfPresent(String.self, forKey: .finishReason) ?? "stop",
                steps: try c.decodeIfPresent(Int.self, forKey: .steps) ?? 0,
                usage: try c.decodeIfPresent(RunUsage.self, forKey: .usage)
                    ?? RunUsage(inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0)
            )
        case "run.cancelled":
            kind = .runCancelled
        case "run.failed":
            kind = .runFailed(error: try c.decodeIfPresent(String.self, forKey: .error) ?? "Run failed")
        default:
            kind = .unknown(type: type)
        }
    }
}

/// The answer to registering this device for notifications.
nonisolated struct DeviceRegistration: Codable, Hashable, Sendable {
    var token: String
    var environment: String
    var pushEnabled: Bool
}

nonisolated struct ServerInfo: Codable, Hashable, Sendable {
    nonisolated struct ModelInfo: Codable, Hashable, Sendable, Identifiable {
        var spec: String
        var contextWindow: Int
        var isDefault: Bool
        var id: String { spec }
    }
    nonisolated struct ProviderInfo: Codable, Hashable, Sendable, Identifiable {
        var id: String
        var type: String
        var configured: Bool
    }
    nonisolated struct RouterInfo: Codable, Hashable, Sendable {
        var type: String
        var mode: String
    }
    nonisolated struct BrowserInfo: Codable, Hashable, Sendable {
        var enabled: Bool
        /// Whether the user can take the browser over from the app. Absent on older servers.
        var handoff: Bool? = nil
    }
    nonisolated struct SkillsInfo: Codable, Hashable, Sendable {
        var enabled: Bool
    }

    var name: String
    var version: String
    var defaultModel: String
    var models: [ModelInfo]
    var providers: [ProviderInfo]
    var router: RouterInfo
    var computer: String
    var memoryCount: Int
    /// Absent on servers from before the agent had a browser.
    var browser: BrowserInfo?
    var skills: SkillsInfo? = nil
    var quoting: FeatureInfo? = nil
    var interests: FeatureInfo? = nil
    var drive: DriveInfo? = nil
    var modelSettings: FeatureInfo? = nil
    var newChatDefaults: ChatModelDefaults? = nil
    /// The Home screen and its daily brief. Absent on older servers: no Home tab there.
    var home: HomeInfo? = nil
    /// Whether the server can send notifications. Absent on servers from before them.
    var push: FeatureInfo? = nil
    /// Which of the phone's records the server accepts. Absent on servers from before them.
    var phone: PhoneInfo? = nil
    /// Whether nobody has met this user yet (the one chat opens with a greeting), and whether the
    /// introduction that follows is going on. Absent on servers from before greetings.
    var greeting: GreetingInfo? = nil
    /// Whether the server can report the allowance its hosting service gives it (`/v1/usage`).
    var usage: FeatureInfo? = nil

    nonisolated struct FeatureInfo: Codable, Hashable, Sendable { var enabled: Bool }
    nonisolated struct GreetingInfo: Codable, Hashable, Sendable {
        var pending: Bool
        var introducing: Bool? = nil
    }
    nonisolated struct PhoneInfo: Codable, Hashable, Sendable {
        var enabled: Bool
        var sources: [String]
    }
    nonisolated struct HomeInfo: Codable, Hashable, Sendable {
        var enabled: Bool
        var brief: Bool
        var briefHour: Int
    }
    nonisolated struct DriveInfo: Codable, Hashable, Sendable {
        var enabled: Bool
        var maxFileBytes: Int
        var maxTextBytes: Int
    }
}

nonisolated struct DriveEntry: Codable, Hashable, Identifiable, Sendable {
    var path: String
    var name: String
    /// Unknown kinds remain visible but cannot be opened or modified.
    var kind: String
    var sizeBytes: Int64
    var modifiedAt: String
    var revision: String
    var mediaType: String
    var id: String { path }
    var isFolder: Bool { kind == "directory" }
    var isSupported: Bool { kind == "directory" || kind == "file" }
    var symbol: String { isFolder ? "folder" : mediaType.hasPrefix("image/") ? "photo" : "doc" }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: sizeBytes, countStyle: .file) }
}

nonisolated struct DrivePage: Decodable, Sendable {
    var path: String
    var entries: [DriveEntry]
    var nextOffset: Int?
}

nonisolated struct DriveText: Decodable, Sendable {
    var entry: DriveEntry
    var text: String
}

nonisolated enum DrivePath {
    static func isValid(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= 4096,
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0 == "\\" }) else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255
        }
    }
    static func joining(_ folder: String, _ name: String) -> String { folder.isEmpty ? name : "\(folder)/\(name)" }
    static func parent(_ path: String) -> String { path.split(separator: "/").dropLast().joined(separator: "/") }
}

/// A value in a widget's state: a stepper's number, a segmented choice, a toggle, a checklist's ticks.
nonisolated enum StateValue: Codable, Hashable, Sendable {
    case number(Double)
    case text(String)
    case bool(Bool)
    case list([Bool])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .text(s) }
        else { self = .list(try c.decode([Bool].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .number(let n): try c.encode(n)
        case .text(let s): try c.encode(s)
        case .bool(let b): try c.encode(b)
        case .list(let l): try c.encode(l)
        }
    }
}

extension StateValue {
    /// As JSONSerialization takes it.
    var plain: Any {
        switch self {
        case .number(let n): n
        case .text(let s): s
        case .bool(let b): b
        case .list(let l): l
        }
    }
}

/// What the user set in one interactive card of a reply.
nonisolated struct CardState: Decodable, Hashable, Sendable {
    var messageId: String
    var card: Int
    var state: [String: StateValue]
}

nonisolated struct CardStateList: Decodable, Sendable {
    var cards: [CardState]
}

nonisolated struct AgentSkill: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var description: String
    var path: String
    /// Shipped with Sunnie; such a skill is off until the user turns it on. Absent on older servers.
    var bundled: Bool? = nil
    var enabled: Bool? = nil
    var id: String { name }
    var isBundled: Bool { bundled ?? false }
    var isOn: Bool { enabled ?? true }

    /// The description's first sentence: what the skill is, without the "Use when…" meant for the agent.
    var summary: String {
        guard let end = description.range(of: ". ") else { return description }
        return String(description[..<end.lowerBound]) + "."
    }
}

nonisolated struct SkillCatalog: Codable, Sendable {
    var skills: [AgentSkill]
    var warnings: [String]
    var sources: [SkillSource]
}

nonisolated struct SkillSource: Codable, Hashable, Sendable, Identifiable {
    var repository: String
    var trustedAt: String
    var id: String { repository }
}

nonisolated struct CompactResult: Codable, Hashable, Sendable {
    var compacted: Bool
    var summarizedMessages: Int
    var memoriesSaved: Int
    var contextTokensBefore: Int
    var contextBudget: Int
}

nonisolated enum MemoryKind: String, Codable, CaseIterable, Sendable {
    case fact, preference, event, instruction, note
}

nonisolated struct Memory: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var kind: MemoryKind
    var content: String
    var source: String
    var conversationId: String?
    var recallCount: Int
    var lastRecalledAt: String?
    var createdAt: String
    var updatedAt: String
    /// Only present on search results.
    var score: Double?

    var updatedDate: Date? { ISO8601.parse(updatedAt) }
}

nonisolated struct MemoryPage: Codable, Sendable {
    var memories: [Memory]
    var total: Int
}

/// A saved sign-in the agent can fill into its browser. The server never sends the password or
/// the one-time-code secret back; it only says whether they are set.
nonisolated struct Login: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var site: String
    var username: String
    var hasPassword: Bool
    var hasTotp: Bool
    var createdAt: String
    var updatedAt: String
}

nonisolated struct CoreMemory: Codable, Hashable, Sendable {
    var blocks: [String: String]
    var blockLimit: Int

    static let blockNames = ["user", "persona"]
}

/// A JSON value of unknown shape — used for tool inputs, which are defined by each tool.
nonisolated indirect enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// A readable rendering: strings bare, everything else as compact JSON.
    var display: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .string(let s): return s
        case .array, .object: return compactJSON
        }
    }

    var compactJSON: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number: return display
        case .string(let s):
            let data = (try? JSONEncoder().encode(s)) ?? Data()
            return String(decoding: data, as: UTF8.self)
        case .array(let a): return "[" + a.map(\.compactJSON).joined(separator: ", ") + "]"
        case .object(let o):
            return "{" + o.keys.sorted().map { "\(JSONValue.string($0).compactJSON): \(o[$0]!.compactJSON)" }.joined(separator: ", ") + "}"
        }
    }
}

extension JSONValue: Codable {
    nonisolated init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a JSON value") }
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

nonisolated enum ISO8601 {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// The server writes `Date.toISOString()` (with milliseconds); accept both forms.
    static func parse(_ s: String) -> Date? {
        withFraction.date(from: s) ?? plain.date(from: s)
    }
}


nonisolated struct MessageQuote: Codable, Hashable, Identifiable, Sendable {
    var id = UUID().uuidString
    var kind: String
    var title: String
    var text: String

    static let maxCount = 8
    static let maxCharacters = 8_000
    static let maxTotalCharacters = 32_000
    var json: [String: String] { ["id": id, "kind": kind, "title": title, "text": text] }
}

nonisolated struct UserInterest: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var topic: String
    var status: String
    var lastCheckedAt: String?
    var createdAt: String
}

nonisolated struct InterestPreferences: Codable, Sendable {
    var paused: Bool
    var nextDigestAt: String?
}

nonisolated struct InterestList: Codable, Sendable {
    var paused: Bool
    var nextDigestAt: String?
    var enabled: Bool
    var interests: [UserInterest]
}

nonisolated struct ChatModelDefaults: Codable, Hashable, Sendable {
    var model: String
    var reasoning: String

    static let efforts = ["none", "minimal", "low", "medium", "high", "xhigh"]

    static func openRouterSpec(_ input: String) -> String? {
        let id = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !id.contains(where: { $0.isWhitespace }),
              !id.contains("://"), !id.hasPrefix("/"), !id.hasSuffix("/"), !id.contains("//") else { return nil }
        // A full Sunnie spec has a provider prefix before OpenRouter's author/model ID.
        let spec = id.hasPrefix("openrouter/") && id.split(separator: "/").count >= 3 ? id : "openrouter/" + id
        guard spec.count <= 300, spec.split(separator: "/").count >= 3 else { return nil }
        return spec
    }
}

// MARK: Home

/// A follow-up the agent keeps for itself (`GET /v1/tasks`); on Home, a reminder.
nonisolated struct AgentTask: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var content: String
    var status: String
    var note: String
    var dueAt: String?
    var conversationId: String?

    var dueDate: Date? { dueAt.flatMap(ISO8601.parse) }
}

/// What a tap on a widget, or on a line of its list, does.
nonisolated enum WidgetAction: Decodable, Hashable, Sendable {
    case openURL(URL)
    case openChat(String)
    /// Opens a new chat with this in the composer; the user sends it.
    case ask(String)
    /// A file or folder of the user's Drive, opened in the app.
    case openFile(String)
    /// Sends these words as the user's message in the card's chat, like a quick reply. Chat cards only.
    case reply(String)
    case copy(String)
    /// Offers an event to the calendar: title, start, end, place, note.
    case calendar(title: String, start: String, end: String?, place: String?, note: String?)
    case unknown

    private enum CodingKeys: String, CodingKey { case type, url, conversationId, prompt, path, text, title, start, end, place, note }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { self = .unknown; return }
        func string(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        switch string(.type) {
        case "open_url":
            // Only https, as the server accepts: a widget must not open another app's scheme.
            if let url = string(.url).flatMap(URL.init(string:)), url.scheme?.lowercased() == "https" { self = .openURL(url) } else { self = .unknown }
        case "open_chat": self = string(.conversationId).map(WidgetAction.openChat) ?? .unknown
        case "ask": self = string(.prompt).map(WidgetAction.ask) ?? .unknown
        case "open_file": self = string(.path).flatMap { DrivePath.isValid($0) ? WidgetAction.openFile($0) : nil } ?? .unknown
        case "reply": self = string(.text).map(WidgetAction.reply) ?? .unknown
        case "copy": self = string(.text).map(WidgetAction.copy) ?? .unknown
        case "calendar":
            if let title = string(.title), let start = string(.start) {
                self = .calendar(title: title, start: start, end: string(.end), place: string(.place), note: string(.note))
            } else { self = .unknown }
        default: self = .unknown
        }
    }
}

/// How a part of a widget is dressed. Everything is optional: a bare part looks like plain iOS.
nonisolated struct WidgetStyle: Hashable, Sendable {
    /// Text, icon and accent colour of the part and what it holds: a name or hex.
    var color: String?
    var background: String?
    var gradient: [String] = []
    var direction: String?
    var padding: Double?
    var corner: Double?
    var border: String?
    var opacity: Double?
    var align: String?
    /// In a row: take only the width it needs instead of an equal share.
    var fit: Bool?
    var height: Double?
    /// A Drive picture behind the part, under its background or gradient.
    var backgroundImage: String?

    var hasFill: Bool { background != nil || gradient.count >= 2 || backgroundImage != nil }
}

/// One part of a Home widget, mirroring `api/src/home/widgets.ts`. A type this app does not
/// know, or one it cannot read, becomes `.unknown` and is not drawn: the format only grows.
nonisolated struct WidgetNode: Decodable, Hashable, Sendable {
    nonisolated struct Label: Hashable, Sendable {
        var text: String
        var style: String?
        var size: Double?
        var weight: String?
        var design: String?
        var lines: Int?
    }
    nonisolated struct Stat: Hashable, Sendable {
        var value: String
        var label: String?
        var unit: String?
        var caption: String?
        var icon: String?
    }
    nonisolated struct Field: Decodable, Hashable, Sendable {
        var label: String
        var value: String
    }
    nonisolated struct Item: Decodable, Hashable, Sendable {
        var title: String
        var subtitle: String?
        var value: String?
        var icon: String?
        var action: WidgetAction?
    }
    /// A stepper or a slider: the number it sets in the widget's state.
    nonisolated struct Input: Hashable, Sendable {
        var bind: String
        var value: Double?
        var min: Double?
        var max: Double?
        var step: Double?
        var label: String?
        var unit: String?
    }
    nonisolated struct Option: Hashable, Sendable {
        var value: String
        var label: String
    }
    nonisolated struct CheckItem: Decodable, Hashable, Sendable {
        var title: String
        var detail: String?
        var time: String?
    }

    nonisolated enum Kind: Hashable, Sendable {
        case text(Label)
        case markdown(String)
        case stat(Stat)
        case fields([Field])
        case list([Item])
        case progress(value: Double, label: String?, caption: String?)
        case gauge(value: Double, label: String?, caption: String?, size: Double?)
        case chart(kind: String, values: [Double], labels: [String], caption: String?)
        case icon(name: String, size: Double?)
        case badge(text: String, icon: String?)
        /// What a tap does is the node's `action`; a button without one is not drawn.
        case button(text: String, icon: String?, variant: String?)
        /// A picture from the user's Drive; nothing is loaded from anywhere else.
        case image(path: String, fill: Bool)
        case file(path: String, title: String?, caption: String?)
        case countdown(to: Date, label: String?, style: String?)
        case divider
        case spacer
        case row([WidgetNode], valign: String?)
        case stack([WidgetNode])
        case layer([WidgetNode], anchor: String?)
        case grid([WidgetNode], columns: Int)
        // Inputs: each sets its `bind` in the widget's state, which formulas read.
        case stepper(Input)
        case slider(Input)
        case toggle(bind: String, value: Bool, label: String)
        case segmented(bind: String, options: [Option], value: String?)
        /// With times on its items it is drawn as a timeline.
        case checklist(bind: String, items: [CheckItem], caption: String?)
        case table(columns: [String], rows: [[String]], caption: String?)
        case unknown(String)
    }

    var kind: Kind
    var style = WidgetStyle()
    /// What a tap on the whole part does (containers), or on the button.
    var action: WidgetAction?
    var spacing: Double?
    /// A formula: the part is drawn only while it holds.
    var when: String?
    /// Names no input sets, with where they start (the outermost part's).
    var state: [String: StateValue] = [:]
    /// A progress or gauge value given as a formula, instead of its number.
    var amount: String?

    init(_ kind: Kind, style: WidgetStyle = WidgetStyle(), action: WidgetAction? = nil, spacing: Double? = nil) {
        self.kind = kind
        self.style = style
        self.action = action
        self.spacing = spacing
    }

    var children: [WidgetNode] {
        switch kind {
        case .row(let c, _), .stack(let c), .layer(let c, _), .grid(let c, _): return c
        default: return []
        }
    }

    /// Where the widget's state starts, as the server works it out: the outermost part's `state`,
    /// then each input's own value (or its minimum, off, its first choice, nothing ticked).
    var initialState: [String: StateValue] {
        var out = state
        func walk(_ node: WidgetNode) {
            switch node.kind {
            case .stepper(let i), .slider(let i):
                if out[i.bind] == nil { out[i.bind] = .number(i.value ?? i.min ?? 0) }
            case let .toggle(bind, value, _):
                if out[bind] == nil { out[bind] = .bool(value) }
            case let .segmented(bind, options, value):
                if out[bind] == nil, let first = value ?? options.first?.value { out[bind] = .text(first) }
            case let .checklist(bind, items, _):
                if out[bind] == nil { out[bind] = .list(items.map { _ in false }) }
            default: break
            }
            node.children.forEach(walk)
        }
        walk(self)
        return out
    }

    /// Whether anything in it can be changed by the user.
    var isInteractive: Bool {
        switch kind {
        case .stepper, .slider, .toggle, .segmented, .checklist: return true
        default: return children.contains { $0.isInteractive }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, text, style, tone, value, label, unit, caption, icon, items, kind, values, labels, name, children
        case place, condition, now, high, low, rain, summary
        case size, weight, design, lines, path, mode, title, to, valign, anchor, columns, action, spacing, variant
        case bind, min, max, step, options, rows, when, state, detail, time
        case color, background, gradient, direction, padding, corner, border, opacity, align, fit, height, backgroundImage
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { self.init(.unknown("")); return }
        func string(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        func number(_ key: CodingKeys) -> Double? { (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil }
        func children() -> [WidgetNode] { (try? c.decode([WidgetNode].self, forKey: .children)) ?? [] }
        let type = string(.type) ?? ""
        let action = (try? c.decodeIfPresent(WidgetAction.self, forKey: .action)) ?? nil
        let kind: Kind?
        switch type {
        case "text":
            kind = string(.text).map {
                .text(Label(text: $0, style: string(.style), size: number(.size), weight: string(.weight),
                            design: string(.design), lines: number(.lines).map(Int.init)))
            }
        case "markdown": kind = string(.text).map(Kind.markdown)
        case "stat":
            kind = string(.value).map { .stat(Stat(value: $0, label: string(.label), unit: string(.unit), caption: string(.caption), icon: string(.icon))) }
        case "fields": kind = (try? c.decode([Field].self, forKey: .items)).map(Kind.fields)
        case "list": kind = (try? c.decode([Item].self, forKey: .items)).map(Kind.list)
        // A value may be a formula ("{done / 8}"); it is worked out where the part is drawn.
        case "progress":
            kind = (number(.value) ?? (string(.value) != nil ? 0 : nil)).map { .progress(value: min(max($0, 0), 1), label: string(.label), caption: string(.caption)) }
        case "gauge":
            kind = (number(.value) ?? (string(.value) != nil ? 0 : nil)).map { .gauge(value: min(max($0, 0), 1), label: string(.label), caption: string(.caption), size: number(.size)) }
        case "chart":
            kind = (try? c.decode([Double].self, forKey: .values)).map {
                .chart(kind: string(.kind) ?? "line", values: $0, labels: (try? c.decode([String].self, forKey: .labels)) ?? [], caption: string(.caption))
            }
        case "icon": kind = string(.name).map { .icon(name: $0, size: number(.size)) }
        case "badge": kind = string(.text).map { .badge(text: $0, icon: string(.icon)) }
        case "button":
            kind = action.flatMap { $0 == .unknown ? nil : string(.text) }.map { .button(text: $0, icon: string(.icon), variant: string(.variant)) }
        case "image": kind = string(.path).flatMap { DrivePath.isValid($0) ? .image(path: $0, fill: string(.mode) != "fit") : nil }
        case "file": kind = string(.path).flatMap { DrivePath.isValid($0) ? .file(path: $0, title: string(.title), caption: string(.caption)) : nil }
        case "countdown": kind = string(.to).flatMap(ISO8601.parse).map { .countdown(to: $0, label: string(.label), style: string(.style)) }
        case "divider": kind = .divider
        case "spacer": kind = .spacer
        case "row": kind = .row(children(), valign: string(.valign))
        case "stack": kind = .stack(children())
        case "layer": kind = .layer(children(), anchor: string(.anchor))
        case "grid": kind = .grid(children(), columns: min(max(number(.columns).map(Int.init) ?? 2, 2), 4))
        case "stepper", "slider":
            if let bind = string(.bind) {
                let input = Input(bind: bind, value: number(.value), min: number(.min), max: number(.max), step: number(.step),
                                  label: string(.label), unit: string(.unit))
                kind = type == "stepper" ? .stepper(input) : (input.min != nil && input.max != nil && input.max! > input.min! ? .slider(input) : nil)
            } else { kind = nil }
        case "toggle":
            kind = string(.bind).map { .toggle(bind: $0, value: ((try? c.decodeIfPresent(Bool.self, forKey: .value)) ?? nil) ?? false, label: string(.label) ?? "") }
        case "segmented":
            let options = WidgetNode.options(c)
            kind = string(.bind).flatMap { options.count >= 2 ? .segmented(bind: $0, options: options, value: string(.value)) : nil }
        case "checklist":
            let items = (try? c.decode([CheckItem].self, forKey: .items)) ?? []
            kind = string(.bind).flatMap { items.isEmpty ? nil : .checklist(bind: $0, items: items, caption: string(.caption)) }
        case "table":
            let columns = (try? c.decode([String].self, forKey: .columns)) ?? []
            kind = columns.isEmpty ? nil : .table(columns: columns, rows: (try? c.decode([[String]].self, forKey: .rows)) ?? [], caption: string(.caption))
        default: kind = nil
        }
        var style = WidgetStyle()
        // `tone` is the first version's word for a text or icon colour.
        style.color = string(.color) ?? string(.tone)
        style.background = string(.background)
        style.gradient = (try? c.decode([String].self, forKey: .gradient)) ?? []
        style.direction = string(.direction)
        style.padding = number(.padding)
        style.corner = number(.corner)
        style.border = string(.border)
        style.opacity = number(.opacity)
        style.align = string(.align)
        style.fit = (try? c.decodeIfPresent(Bool.self, forKey: .fit)) ?? nil
        style.height = number(.height)
        style.backgroundImage = string(.backgroundImage).flatMap { DrivePath.isValid($0) ? $0 : nil }
        self.init(kind ?? .unknown(type), style: style, action: action, spacing: number(.spacing))
        when = string(.when)
        state = (try? c.decodeIfPresent([String: StateValue].self, forKey: .state)) ?? [:]
        if type == "progress" || type == "gauge" { amount = string(.value) }
    }

    /// A segmented part's choices: plain words, or `{ value, label }`.
    private static func options(_ c: KeyedDecodingContainer<CodingKeys>) -> [Option] {
        struct Raw: Decodable { var value: String; var label: String? }
        if let words = try? c.decode([String].self, forKey: .options) { return words.map { Option(value: $0, label: $0) } }
        guard var list = try? c.nestedUnkeyedContainer(forKey: .options) else { return [] }
        var out: [Option] = []
        while !list.isAtEnd {
            if let word = try? list.decode(String.self) { out.append(Option(value: word, label: word)) }
            else if let raw = try? list.decode(Raw.self) { out.append(Option(value: raw.value, label: raw.label ?? raw.value)) }
            else { _ = try? list.decode(JSONValue.self) }
        }
        return out
    }
}

/// One block of Home: something the agent or a program wrote. The app has no widgets of its own.
nonisolated struct HomeWidget: Decodable, Hashable, Identifiable, Sendable {
    var id: String
    var title: String
    var body: WidgetNode
    var action: WidgetAction?
    /// "agent" or "api".
    var source: String
    var hidden: Bool
    var expiresAt: String?
    var updatedAt: String
    /// How many of Home's four columns it spans; nil from a server before sizes, which is the full width.
    var columns: Int? = nil
    /// Sunnie is redesigning it for a width the user just picked.
    var resizing: Bool? = nil
    /// What the user set in its interactive parts; nil while untouched.
    var state: [String: StateValue]? = nil

    var isResizing: Bool { resizing == true }

    var updatedDate: Date? { ISO8601.parse(updatedAt) }

    /// Home is this many columns across.
    static let homeColumns = 4

    /// Its width on Home, 1 to 4 columns.
    var span: Int { min(max(columns ?? Self.homeColumns, 1), Self.homeColumns) }

    /// What to call it where it has to be named, as in menus. Its title is only a name: a widget
    /// draws a heading as part of its body, if it wants one.
    var name: String {
        title.isEmpty ? id.replacingOccurrences(of: "-", with: " ").capitalized : title
    }
}

/// Whether the Check-ins conversation holds anything the user has not seen.
nonisolated struct CheckInStatus: Codable, Hashable, Sendable {
    var conversationId: String?
    var latestSeq: Int?
    var latestAt: String?
    var running: Bool
}

nonisolated struct WidgetResizeStarted: Decodable, Sendable {
    var widget: HomeWidget
}

nonisolated struct HomeLayout: Decodable, Hashable, Sendable {
    var widgets: [HomeWidget]
}

nonisolated struct HomeFeed: Decodable, Hashable, Sendable {
    nonisolated struct Brief: Codable, Hashable, Sendable {
        var enabled: Bool
        var running: Bool
        var lastAt: String?
        var hour: Int
    }

    var timeZone: String
    var widgets: [HomeWidget]
    var checkIns: CheckInStatus
    var brief: Brief
}

// MARK: Phone data

/// A kind of record the user can choose to share.
nonisolated enum PhoneSource: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case health, calendar, reminders, location, contacts, places, music, photos

    var id: String { rawValue }

    /// What this device can share. A Mac has no Health data or music library, and it stays put:
    /// its visit log would replace the iPhone's on the server, which keeps one copy per source.
    static var onThisDevice: [PhoneSource] {
        #if os(macOS)
        [.calendar, .reminders, .location, .contacts, .photos]
        #else
        allCases
        #endif
    }

    var title: String {
        switch self {
        case .health: "Health"
        case .calendar: "Calendar"
        case .reminders: "Reminders"
        case .location: "Location"
        case .contacts: "Contacts"
        case .places: "Places"
        case .music: "Music"
        case .photos: "Photos"
        }
    }

    var symbol: String {
        switch self {
        case .health: "heart"
        case .calendar: "calendar"
        case .reminders: "checklist"
        case .location: "location"
        case .contacts: "person.crop.circle"
        case .places: "mappin.and.ellipse"
        case .music: "music.note"
        case .photos: "photo.on.rectangle"
        }
    }

    /// What is sent, in a line.
    var detail: String {
        switch self {
        case .health: "Everything you allow in Health for the last 90 days: activity, heart, sleep, body, nutrition, symptoms, cycle, state of mind and workouts."
        case .calendar: "Events from yesterday to a month ahead, from the calendars on \(DeviceName.this)."
        case .reminders: "Open items in the Reminders app."
        case .location: "The town you are in, not your exact position. Sent only while the app is open."
        case .contacts: "Names, numbers, emails, birthdays and relations, so it knows who people are."
        case .places: "The places you stay at and when, from iOS. Needs location access “Always”."
        case .music: "What you play most and lately from the music library on \(DeviceName.this)."
        case .photos: "When and where your photos and videos were taken over the past year. Not the pictures."
        }
    }
}

/// How the app names the device it runs on, in sentences about what it shares.
nonisolated enum DeviceName {
    #if os(macOS)
    static let this = "this Mac"
    static let kind = "Mac"
    #else
    static let this = "this iPhone"
    static let kind = "iPhone"
    #endif
}

/// One source's data as the server receives it.
nonisolated struct PhoneSnapshot<T: Encodable & Sendable>: Encodable, Sendable {
    var capturedAt: String
    var timeZone: String?
    var data: T
}

/// A source as the server holds it.
nonisolated struct PhoneSourceStatus: Decodable, Hashable, Sendable {
    var source: String
    var capturedAt: String
    var updatedAt: String
    var count: Int

    var capturedDate: Date? { ISO8601.parse(capturedAt) }
}

nonisolated struct PhoneSourceList: Decodable, Hashable, Sendable {
    var sources: [PhoneSourceStatus]
}

/// How much of its allowance this Sunnie has used, as its hosting service reports it: tokens, and
/// the share as a percentage the app shows. `resetsAt` is when the allowance starts again, if known.
nonisolated struct UsageInfo: Codable, Hashable, Sendable {
    var used: Int
    var limit: Int
    var percent: Double
    var resetsAt: String? = nil
}
