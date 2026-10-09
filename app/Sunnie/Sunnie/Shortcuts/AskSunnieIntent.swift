import AppIntents
import Foundation

/// "Ask Sunnie" in Shortcuts: sends a message as a new chat and, unless told not to, waits for the
/// answer and hands it back, so an automation ("when I arrive at the gym", "every evening") can
/// say it, show it or pass it on. The chat is an ordinary one: it shows in Chats, and anything the
/// run needs the user's OK for waits for them there.
struct AskSunnieIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Sunnie"
    static let description = IntentDescription("Sends a message to Sunnie as a new chat and gives back the answer.")
    static let openAppWhenRun = false

    @Parameter(title: "Message", inputOptions: String.IntentInputOptions(multiline: true))
    var message: String

    @Parameter(title: "Wait for the answer", default: true)
    var waitForAnswer: Bool

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Sunnie \(\.$message)") {
            \.$waitForAnswer
        }
    }

    /// How long a Shortcut is kept waiting; iOS ends intents that take much longer.
    private static let patience: Duration = .seconds(25)

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw AskSunnieError.empty }
        let settings = ServerSettings.load()
        guard settings.isConfigured, let url = settings.baseURL else { throw AskSunnieError.notConnected }
        let client = SunnieClient(baseURL: url, apiKey: settings.apiKey)

        let conversation = try await client.createConversation(title: ShortcutAnswer.title(for: text))
        var run = try await client.submitMessage(conversation.id, text: text, attachmentIds: [],
                                                 timezone: TimeZone.current.identifier, requestId: UUID().uuidString)
        guard waitForAnswer else { return .result(value: "", dialog: "Sent to Sunnie.") }

        let deadline = ContinuousClock.now + Self.patience
        while run.status == "running", ContinuousClock.now < deadline {
            if !(run.pendingApprovals ?? []).isEmpty {
                return .result(value: "", dialog: "Sunnie needs your OK to go on. Open the chat in the Sunnie app.")
            }
            try await Task.sleep(for: .seconds(1))
            run = try await client.getRun(run.id)
        }
        switch run.status {
        case "running":
            return .result(value: "", dialog: "Sunnie is still working on it. The answer will be in the chat.")
        case "completed":
            let messages = try await client.listMessages(conversation.id, limit: 30)
            let answer = ShortcutAnswer.reply(in: messages, run: run.id) ?? ""
            return .result(value: answer, dialog: IntentDialog(stringLiteral: ShortcutAnswer.spoken(answer)))
        default:
            throw AskSunnieError.failed(run.error ?? "the run \(run.status)")
        }
    }
}

nonisolated enum AskSunnieError: LocalizedError {
    case empty
    case notConnected
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .empty: "There is no message to send."
        case .notConnected: "Sunnie isn’t connected to a server. Open the app and connect first."
        case .failed(let why): "Sunnie couldn’t answer: \(why)."
        }
    }
}

/// Puts "Ask Sunnie" in Shortcuts and Siri without any setup.
struct SunnieShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskSunnieIntent(),
                    phrases: ["Ask \(.applicationName)", "Tell \(.applicationName)"],
                    shortTitle: "Ask Sunnie",
                    systemImageName: "bubble.left.and.text.bubble.right")
    }
}

/// What a Shortcut gets back. Pure, so it is unit-tested.
nonisolated enum ShortcutAnswer {
    /// The chat's name: the message's first line, shortened.
    static func title(for message: String) -> String {
        let line = message.split(whereSeparator: \.isNewline).first.map(String.init) ?? message
        return line.count > 60 ? String(line.prefix(59)) + "…" : line
    }

    /// The run's last reply with words in it.
    static func reply(in messages: [Message], run: String) -> String? {
        messages.last { $0.role == .assistant && $0.runId == run && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }?.text
    }

    /// The answer as Siri can say it: card blocks and Markdown marks left out, and kept short.
    static func spoken(_ answer: String, limit: Int = 400) -> String {
        var lines: [String] = []
        var inBlock = false
        for line in answer.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { inBlock.toggle(); continue }
            if inBlock { continue }
            let plain = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "")
                .replacingOccurrences(of: #"^\s*(#+|[-*]|\d+\.)\s+"#, with: "", options: .regularExpression)
            if !plain.trimmingCharacters(in: .whitespaces).isEmpty { lines.append(plain) }
        }
        let text = lines.joined(separator: " ")
        guard !text.isEmpty else { return "Done. The answer is in the chat." }
        return text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
    }
}
