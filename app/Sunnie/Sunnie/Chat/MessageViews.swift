import SwiftUI

/// A tool call the run is holding: what the row needs to ask the user about it.
struct ToolApproval {
    /// For a browser call: the element it acts on, which its input names only by a ref.
    var target: ApprovalTarget?
    /// For a skill install: what it is and why, in plain words, instead of a repository and a path.
    var review: SkillReview?
    /// When the model's provider flagged the call as something the user did not ask for: its words.
    var explanation: String?
    var isAnswering: Bool
    var answer: (Bool) -> Void
}

/// A browser hand-off the run is waiting for: what the row needs to offer the user.
struct ToolHandoff {
    /// What the agent wants done on the page, in its words.
    var reason: String
    var isAnswering: Bool
    var takeOver: () -> Void
    var decline: () -> Void
}

struct TimelineRow: View {
    let item: TimelineItem
    /// Set while this row's tool call waits for the user to allow or deny it.
    var approval: ToolApproval?
    /// Set while this row's call waits for the user to take the browser over.
    var handoff: ToolHandoff?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.chatBubbles) private var bubbles

    var body: some View {
        switch item {
        case let .user(_, text, pending, attachments, quotes):
            HStack {
                Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 16 : 48)
                VStack(alignment: .trailing, spacing: 5) {
                    if !quotes.isEmpty { MessageQuotesView(quotes: quotes) }
                    if !attachments.isEmpty { MessageAttachmentsView(files: attachments) }
                    if !text.isEmpty { SelectableQuoteText(text, color: .white, markdown: false)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.tint, in: PetalShape())
                        .foregroundStyle(.white)
                        .accessibilityHint(pending ? "Queued" : "")
                    }
                    if pending {
                        Label("Queued", systemImage: "clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                }
            }
        case let .checkIn(_, text):
            Label(text, systemImage: "clock.arrow.circlepath")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
        case let .assistantText(id, text, _, streaming):
            // A stored row is "<message id>-<part>": its cards are saved against that message.
            let messageId = id.hasPrefix("msg_") ? id.lastIndex(of: "-").map { String(id[..<$0]) } : nil
            if bubbles {
                HStack(spacing: 0) {
                    MarkdownView(text, streaming: streaming, messageId: messageId)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.systemGray6, in: PetalShape(tipLeading: true))
                    Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 16 : 48)
                }
            } else {
                MarkdownView(text, streaming: streaming, messageId: messageId)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case let .reasoning(_, text, streaming):
            ReasoningRow(text: text, streaming: streaming)
        case let .tool(_, _, name, input, output, isError):
            if let handoff {
                HandoffCard(handoff: handoff)
            } else {
                ToolRow(name: name, input: input, output: output, isError: isError, approval: approval)
            }
        case let .card(_, card):
            ChatCardView(card: card)
                .modifier(QuotableCard(quote: card.messageQuote))
        case let .notice(_, text, isError):
            Label(text, systemImage: isError ? "exclamationmark.triangle" : "info.circle")
                .font(.footnote)
                .foregroundStyle(isError ? .red : .secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 4)
        }
    }
}

/// A stretch of reasoning and tool calls, shown as one line until tapped.
struct StepsRow: View {
    let items: [TimelineItem]
    /// What the run is doing, when this is the stretch in progress.
    let activity: RunActivity?
    @Binding var expanded: Bool
    let approval: (TimelineItem) -> ToolApproval?
    var handoff: (TimelineItem) -> ToolHandoff? = { _ in nil }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// A held call is always shown: the user must see what they are allowing.
    private var isHolding: Bool { items.contains { approval($0) != nil || handoff($0) != nil } }
    private var isHandingOff: Bool { items.contains { handoff($0) != nil } }
    private var isOpen: Bool { expanded || isHolding }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                guard !isHolding else { return }
                withAnimation(reduceMotion ? nil : .snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    if activity != nil {
                        TurningStar(size: 13)
                            .accessibilityHidden(true)
                    } else {
                        CompassStar().fill(.petal).frame(width: 11, height: 11)
                            .accessibilityHidden(true)
                    }
                    Text(isHandingOff ? "Waiting for you in the browser…" : isHolding ? "Waiting for your approval…" : activity?.label ?? ChatRow.summary(of: items))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if isHolding {
                        Image(systemName: "hand.raised").foregroundStyle(.orange)
                            .accessibilityHidden(true)
                    } else {
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isOpen ? 90 : 0))
                            .accessibilityHidden(true)
                    }
                }
                .font(.footnote)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isHolding ? "Expanded, awaiting your answer" : isOpen ? "Expanded" : "Collapsed")
            .accessibilityHint(isHandingOff ? "Take the browser over below, or choose Not now" : isHolding ? "Review the action below and choose Allow or Deny" : isOpen ? "Hides the details" : "Shows the details")

            if isOpen {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(items) { item in
                        TimelineRow(item: item, approval: approval(item), handoff: handoff(item))
                    }
                }
                .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 19)
            }
        }
        .padding(.vertical, 2)
        .animation(reduceMotion ? nil : .default, value: activity)
    }
}

private struct ReasoningRow: View {
    let text: String
    let streaming: Bool
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .padding(.top, 4)
        } label: {
            HStack(spacing: 7) {
                CompassStar().fill(.petal).frame(width: 11, height: 11)
                    .accessibilityHidden(true)
                Text(streaming ? "Reasoning…" : "Reasoning")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 44)
        }
    }
}

private struct ToolRow: View {
    let name: String
    let input: JSONValue
    let output: String?
    let isError: Bool
    var approval: ToolApproval?
    @State private var expanded = false
    @State private var showsDetails = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(AppModel.self) private var app: AppModel?

    /// A call waiting for approval is always open: the user must see what they are allowing.
    private var isExpanded: Binding<Bool> {
        Binding(get: { expanded || approval != nil }, set: { expanded = $0 })
    }

    /// The call's arguments, as the server received them.
    @ViewBuilder
    private var fieldsView: some View {
        if case .object(let fields) = input, !fields.isEmpty {
            ForEach(fields.keys.sorted(), id: \.self) { key in
                VStack(alignment: .leading, spacing: 2) {
                    Text(key).font(.caption).foregroundStyle(.secondary)
                    Text(fields[key]!.display)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        } else if input != .null {
            Text(input.display).font(.system(.footnote, design: .monospaced))
        }
    }

    var body: some View {
        DisclosureGroup(isExpanded: isExpanded) {
            VStack(alignment: .leading, spacing: 6) {
                if let review = approval?.review {
                    SkillReviewView(review: review)
                    // The repository and path are for whoever runs the server; the hosted app keeps to plain words.
                    if app?.flavor.isHosted != true {
                        DisclosureGroup("Technical details", isExpanded: $showsDetails) { fieldsView }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    fieldsView
                }
                if let output {
                    Divider()
                    Text(output.isEmpty ? "(no output)" : output)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(isError ? .red : .secondary)
                        .textSelection(.enabled)
                        .lineLimit(60)
                }
                if let approval {
                    Divider()
                    if let target = approval.target {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Self.verb(for: name)).font(.caption).foregroundStyle(.secondary)
                            Text(target.label).font(.footnote.weight(.medium)).textSelection(.enabled)
                            if let place = target.place {
                                Text(place).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if let explanation = approval.explanation {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Flagged as something you may not have asked for", systemImage: "exclamationmark.triangle.fill")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.orange)
                            Text(explanation)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    Text(approval.review != nil
                         ? "Allow adds this skill. Anything it does that acts for you still asks you first."
                         : name == "skill_install"
                         ? "Allowing this installation also trusts the repository for future skill installs. Skills still use the usual action approvals."
                         : "Needs your approval before it runs.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    let layout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(spacing: 10))
                        : AnyLayout(HStackLayout(spacing: 10))
                    layout {
                        Button(role: .destructive) { approval.answer(false) } label: {
                            Text("Deny").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        Button { approval.answer(true) } label: {
                            Text("Allow").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .controlSize(.regular)
                    .disabled(approval.isAnswering)
                    if approval.isAnswering {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small).accessibilityHidden(true)
                            Text("Sending your choice…")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding(.top, 4)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: Self.icon(for: name))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Self.title(for: name))
                        .font(.footnote.weight(.medium))
                        .accessibilityValue(approval != nil ? "Awaiting approval" : output == nil ? "In progress" : isError ? "Failed" : "Completed")
                    if let summary = Self.summary(name: name, input: input) {
                        Text(summary)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    }
                }
                Spacer()
                if approval != nil {
                    Image(systemName: "hand.raised")
                        .foregroundStyle(.orange)
                        .font(.footnote)
                        .accessibilityHidden(true)
                } else if output == nil {
                    ProgressView().controlSize(.mini).accessibilityHidden(true)
                } else {
                    Image(systemName: isError ? "xmark.circle" : "checkmark.circle")
                        .foregroundStyle(isError ? .red : .green)
                        .font(.footnote)
                        .accessibilityHidden(true)
                }
            }
            // A disclosure label is tinted like a button; keep it in plain text colours.
            .foregroundStyle(.primary)
            .frame(minHeight: 44)
        }
        .padding(10)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    nonisolated static func icon(for name: String) -> String {
        switch name {
        case "bash", "shell": return "terminal"
        case "read_file": return "doc.text"
        case "write_file", "edit_file": return "square.and.pencil"
        case "web_fetch": return "globe"
        case "browser_fill_login": return "key"
        case "browser_handoff": return "hand.tap"
        case "browser_screenshot": return "camera.viewfinder"
        case _ where name.hasPrefix("browser_"): return "safari"
        case "memory_save", "memory_update", "memory_delete", "memory_search": return "brain"
        case "core_memory_append", "core_memory_replace": return "person.text.rectangle"
        case "conversation_search": return "magnifyingglass"
        case "delegate", "helper_message": return "person.2"
        case _ where name.hasPrefix("skill_"): return "books.vertical"
        default: return "wrench.and.screwdriver"
        }
    }

    /// What a held browser call does to its element, as a caption above the element's name.
    nonisolated static func verb(for name: String) -> String {
        switch name {
        case "browser_click": return "Clicks"
        case "browser_type": return "Types into"
        case "browser_fill_login": return "Fills your saved login into"
        case "browser_upload": return "Uploads files to"
        case "browser_key": return "Presses the key on"
        default: return "Acts on"
        }
    }

    nonisolated static func title(for name: String) -> String {
        name == "browser_handoff" ? "Your turn in the browser" : name.replacingOccurrences(of: "_", with: " ").capitalized
    }

    /// The one argument worth showing collapsed, per tool.
    nonisolated static func summary(name: String, input: JSONValue) -> String? {
        if name == "delegate", case .array(let tasks)? = input["tasks"] {
            return tasks.count == 1 ? "1 task" : "\(tasks.count) tasks"
        }
        // A skill is described by why it was chosen, in plain words, before where it comes from.
        if name == "skill_install", let why = input["why"]?.stringValue, !why.isEmpty { return why }
        for key in ["repository", "name", "command", "path", "url", "query", "content", "login", "text", "old_text", "key", "action", "ref", "message", "reason"] {
            if let value = input[key]?.stringValue, !value.isEmpty {
                return value.split(separator: "\n").first.map(String.init)
            }
        }
        return nil
    }
}

/// The agent asked the user to take the browser over: what for, in plain words, and the way in.
/// Drawn in place of the tool row while the request waits; afterwards the row shows as usual.
private struct HandoffCard: View {
    let handoff: ToolHandoff
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(AppModel.self) private var app: AppModel?

    private var name: String { app?.agentName ?? "Sunnie" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "hand.tap.fill")
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 36, height: 36)
                    .background(.tint.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(name) needs you in the browser")
                        .font(.subheadline.weight(.semibold))
                    Text(handoff.reason)
                        .font(.subheadline)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("You will see the page as it is and can tap, scroll and type on it. \(name) carries on from where you leave it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(spacing: 10))
                : AnyLayout(HStackLayout(spacing: 10))
            layout {
                Button { handoff.decline() } label: {
                    Text("Not now").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                Button { handoff.takeOver() } label: {
                    Label("Open the page", systemImage: "arrow.up.forward.app")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.regular)
            .disabled(handoff.isAnswering)
            if handoff.isAnswering {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).accessibilityHidden(true)
                    Text("One moment…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(name) needs you in the browser: \(handoff.reason)")
    }
}

/// A skill about to be added, in plain words: what it is, why it was picked, what it helps with and
/// what it can reach, with a warning first when the server's check found something.
private struct SkillReviewView: View {
    let review: SkillReview

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if review.caution {
                Label(review.checked ? "Take a look before you allow this" : "This skill could not be checked",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            MarkdownView(review.summary)
                .font(.subheadline)
        }
    }
}
