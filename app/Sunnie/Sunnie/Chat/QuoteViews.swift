import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

nonisolated struct QuoteAction: Sendable {
    let attach: @MainActor @Sendable (MessageQuote) -> Void

    @MainActor func callAsFunction(_ quote: MessageQuote) { attach(quote) }
}

/// Puts text in the chat's message box for the user to send: a card's "ask".
nonisolated struct DraftAction: Sendable {
    let write: @MainActor @Sendable (String) -> Void

    @MainActor func callAsFunction(_ text: String) { write(text) }
}

private struct DraftActionKey: EnvironmentKey {
    static let defaultValue: DraftAction? = nil
}

private struct QuoteActionKey: EnvironmentKey {
    static let defaultValue: QuoteAction? = nil
}

extension EnvironmentValues {
    var chatDraft: DraftAction? {
        get { self[DraftActionKey.self] }
        set { self[DraftActionKey.self] = newValue }
    }

    var quoteSelection: QuoteAction? {
        get { self[QuoteActionKey.self] }
        set { self[QuoteActionKey.self] = newValue }
    }
}

extension MessageQuote {
    static func cardTitle(_ title: String) -> String {
        var result = ""
        for scalar in title.unicodeScalars {
            guard result.utf16.count + (scalar.value > 0xFFFF ? 2 : 1) <= 200 else { break }
            result.unicodeScalars.append(scalar)
        }
        return result
    }

    static func selectedText(_ text: String) -> MessageQuote {
        MessageQuote(kind: "text", title: "Selected text", text: text)
    }

    var preview: String {
        if kind == "card" { return title }
        return String(text.replacingOccurrences(of: "\n", with: " ").prefix(180))
    }
}

extension MarkdownBlock {
    var messageQuote: MessageQuote? {
        func card(_ title: String, _ language: String, _ lines: [String]) -> MessageQuote {
            MessageQuote(kind: "card", title: MessageQuote.cardTitle(title),
                         text: "```\(language)\n\(lines.joined(separator: "\n"))\n```")
        }
        switch self {
        case .event(let value):
            return card(value.title, "event", ["title: \(value.title)"] + [
                value.start.map { "start: \($0)" }, value.end.map { "end: \($0)" },
                value.place.map { "place: \($0)" }, value.note.map { "note: \($0)" }
            ].compactMap { $0 })
        case .schedule(let value):
            return card(value.title ?? "Schedule", "schedule", (value.title.map { ["title: \($0)"] } ?? [])
                        + value.entries.map { [$0.time, $0.what, $0.detail].compactMap { $0 }.joined(separator: " | ") })
        case .card(let value):
            return card(value.title, "card", ["title: \(value.title)"]
                        + [value.subtitle.map { "subtitle: \($0)" }, value.link.map { "link: \($0.absoluteString)" }].compactMap { $0 }
                        + value.fields.map { "\($0.label): \($0.value)" })
        case .drive(let value):
            return card(value.title, "drive", ["title: \(value.title)", "path: \(value.path)"])
        case let .link(title, url):
            return MessageQuote(kind: "card", title: MessageQuote.cardTitle(title), text: "[\(title)](\(url.absoluteString))")
        case .widget(let node):
            // What it says, not how it is drawn, as a Home widget is quoted.
            let lines = WidgetText.lines(node)
            guard let first = lines.first else { return nil }
            return MessageQuote(kind: "card", title: MessageQuote.cardTitle(first),
                                text: WidgetText.clipped(lines.joined(separator: "\n"), to: MessageQuote.maxCharacters))
        default: return nil
        }
    }
}

extension ChatCard {
    var messageQuote: MessageQuote {
        switch self {
        case let .followUp(text, when, moved):
            let title = moved ? "Updated follow-up" : "Follow-up"
            return MessageQuote(kind: "card", title: title,
                                text: "**\(title)**\n\n\(text)" + (when.map { "\n\n\($0)" } ?? ""))
        case let .memory(text, about):
            let title = about == .persona ? "How Sunnie helps you" : "Remembered"
            return MessageQuote(kind: "card", title: title, text: "**\(title)**\n\n\(text)")
        }
    }
}

/// Swipe right to quote. The gesture shares recognition with the vertical scroll around it, so
/// only a deliberate rightward movement counts; `offset` is how far the finger has pulled, for
/// the caller to move what it likes. A tick is felt when letting go would quote.
struct QuoteSwipe: ViewModifier {
    @Binding var offset: CGFloat
    let perform: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var armed = false

    static let threshold: CGFloat = 65

    private static func isRightward(_ value: DragGesture.Value) -> Bool {
        value.translation.width > abs(value.translation.height) * 1.5
    }

    func body(content: Content) -> some View {
        content
            .simultaneousGesture(DragGesture(minimumDistance: 24)
                .onChanged { value in
                    guard Self.isRightward(value) else { return }
                    offset = min(80, max(0, value.translation.width))
                    armed = offset >= Self.threshold
                }
                .onEnded { value in
                    if value.translation.width >= Self.threshold && Self.isRightward(value) { perform() }
                    armed = false
                    withAnimation(reduceMotion ? nil : .snappy) { offset = 0 }
                })
            .sensoryFeedback(.selection, trigger: armed) { _, now in now }
    }
}

/// The quote bubble that shows in the space a swipe opens.
struct QuoteSwipeMark: View {
    let offset: CGFloat
    /// White on a tinted circle, for a ground that may be any colour (a widget's).
    var badge = false

    var body: some View {
        Group {
            if badge {
                Image(systemName: "quote.bubble.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(.tint, in: Circle())
            } else {
                Image(systemName: "quote.bubble").foregroundStyle(.tint)
            }
        }
        .opacity(min(1, offset / 55))
        .scaleEffect(offset >= QuoteSwipe.threshold ? 1.15 : 1)
        .animation(.snappy, value: offset >= QuoteSwipe.threshold)
        .accessibilityHidden(true)
    }
}

/// A card in a reply: swipe right, or use the menu or accessibility action, to quote it.
struct QuotableCard: ViewModifier {
    let quote: MessageQuote
    /// Puts the card on Home, for a widget card of a stored reply.
    var pin: (() async throws -> Void)?
    @Environment(\.quoteSelection) private var attach
    @State private var offset: CGFloat = 0
    @State private var selecting = false
    @State private var pinned: String?

    func body(content: Content) -> some View {
        if let attach {
            content
                .offset(x: offset)
                .background(alignment: .leading) { QuoteSwipeMark(offset: offset) }
                .modifier(QuoteSwipe(offset: $offset) { attach(quote) })
                .contextMenu {
                    Button { attach(quote) } label: { Label("Quote card", systemImage: "quote.bubble") }
                    Button { selecting = true } label: { Label("Select text…", systemImage: "text.cursor") }
                    if pin != nil {
                        Button { addToHome() } label: { Label("Add to Home", systemImage: "rectangle.stack.badge.plus") }
                    }
                }
                .accessibilityAction(named: "Quote card") { attach(quote) }
                .overlay(alignment: .topTrailing) {
                    if let pinned {
                        Label(pinned, systemImage: pinned == "Added to Home" ? "checkmark.circle.fill" : "exclamationmark.triangle")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(.regularMaterial, in: Capsule())
                            .padding(8)
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }
                }
                .sheet(isPresented: $selecting) {
                    NavigationStack {
                        ScrollView {
                            SelectableQuoteText(quote.text, markdown: false)
                                .padding(20)
                        }
                        .navigationTitle("Select text to quote")
                        .inlineNavigationTitle()
                        .toolbar { Button("Done") { selecting = false } }
                    }
                    .environment(\.quoteSelection, QuoteAction { excerpt in selecting = false; attach(excerpt) })
                }
        } else { content }
    }

    private func addToHome() {
        guard let pin else { return }
        Task {
            let done: String
            do { try await pin(); done = "Added to Home" } catch { done = "Could not add it" }
            withAnimation { pinned = done }
            try? await Task.sleep(for: .seconds(2))
            withAnimation { pinned = nil }
        }
    }
}

struct DraftQuotesView: View {
    let quotes: [MessageQuote]
    var disabled = false
    let remove: (String) -> Void
    @State private var preview: MessageQuote?
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 44

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: 4) {
                ForEach(quotes) { quote in
                    HStack(spacing: 4) {
                        Button { preview = quote } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "quote.opening").foregroundStyle(.tint)
                                Text(quote.preview).font(.subheadline).lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(minHeight: rowHeight)
                        }
                        .accessibilityLabel("Preview quote: \(quote.title)")
                        Button { remove(quote.id) } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                .frame(width: 44, height: 44)
                        }
                        .disabled(disabled)
                        .accessibilityLabel("Remove quote: \(quote.title)")
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 12))
                }
            }
        }
        .frame(height: CGFloat(min(quotes.count, 3)) * (rowHeight + 4) - 4)
        .scrollBounceBehavior(.basedOnSize)
        .sheet(item: $preview) { quote in
            NavigationStack {
                ScrollView {
                    quoteContent(quote).padding(20)
                }
                .navigationTitle("Quoted material")
                .inlineNavigationTitle()
                .toolbar { Button("Done") { preview = nil } }
            }
            .environment(\.quoteSelection, nil)
        }
    }
}

struct MessageQuotesView: View {
    let quotes: [MessageQuote]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(quotes) { quote in
                DisclosureGroup {
                    quoteContent(quote).padding(.top, 6)
                } label: {
                    Label(quote.preview, systemImage: "quote.opening")
                        .font(.subheadline)
                        .lineLimit(3)
                        .frame(minHeight: 44)
                }
                .padding(.horizontal, 12)
                .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

@ViewBuilder
private func quoteContent(_ quote: MessageQuote) -> some View {
    if quote.kind == "card" { MarkdownView(quote.text) }
    else { SelectableQuoteText(quote.text, markdown: false) }
}

/// The attributed string both platforms' text views show: Markdown's inline styles in `font`.
private func quoteAttributedText(_ text: String, markdown: Bool, font: PlatformFont, color: PlatformColor) -> NSAttributedString {
    let source = markdown ? Markdown.inline(text) : AttributedString(text)
    let attributed = NSMutableAttributedString(string: "")
    for run in source.runs {
        var traits = font.fontDescriptor.symbolicTraits
        #if canImport(UIKit)
        if run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true { traits.insert(.traitBold) }
        if run.inlinePresentationIntent?.contains(.emphasized) == true { traits.insert(.traitItalic) }
        let runFont = font.fontDescriptor.withSymbolicTraits(traits).map { UIFont(descriptor: $0, size: font.pointSize) } ?? font
        #else
        if run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true { traits.insert(.bold) }
        if run.inlinePresentationIntent?.contains(.emphasized) == true { traits.insert(.italic) }
        let runFont = NSFont(descriptor: font.fontDescriptor.withSymbolicTraits(traits), size: font.pointSize) ?? font
        #endif
        var attributes: [NSAttributedString.Key: Any] = [.font: runFont, .foregroundColor: color]
        if let link = run.link { attributes[.link] = link }
        if run.inlinePresentationIntent?.contains(.code) == true {
            attributes[.font] = PlatformFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular)
        }
        if run.inlinePresentationIntent?.contains(.strikethrough) == true { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        attributed.append(NSAttributedString(string: String(source[run.range].characters), attributes: attributes))
    }
    return attributed
}

#if canImport(UIKit)
/// SwiftUI's Text selection does not expose the selected range. A native text view supplies
/// the exact UTF-16 range to the edit menu while preserving links and inline formatting.
struct SelectableQuoteText: UIViewRepresentable {
    let text: String
    var style: UIFont.TextStyle = .body
    var weight: UIFont.Weight?
    var color: UIColor = .label
    var markdown = true
    var monospaced = false
    @Environment(\.quoteSelection) private var attach
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(_ text: String, style: UIFont.TextStyle = .body, weight: UIFont.Weight? = nil,
         color: UIColor = .label, markdown: Bool = true, monospaced: Bool = false) {
        self.text = text; self.style = style; self.weight = weight; self.color = color; self.markdown = markdown
        self.monospaced = monospaced
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.attach = attach
        // Read Dynamic Type so SwiftUI updates this representable when it changes.
        _ = dynamicTypeSize
        let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: view.traitCollection)
        let font = monospaced ? UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: weight ?? .regular)
            : weight.map { UIFont.systemFont(ofSize: base.pointSize, weight: $0) } ?? base
        let attributed = quoteAttributedText(text, markdown: markdown, font: font, color: color)
        if view.attributedText != attributed { view.attributedText = attributed }
        view.linkTextAttributes = [.foregroundColor: view.tintColor as Any]
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        // A horizontal code scroller proposes no width; retain the text's natural size there.
        guard let width = proposal.width else {
            let size = uiView.attributedText.size()
            return CGSize(width: ceil(size.width), height: ceil(size.height))
        }
        // An HStack asks with zero to learn how far each child can shrink. Wrapped text can go
        // to nothing; answering with the one-line width made it look rigid, so a list item's
        // text got an even split with its bullet: half the row.
        guard width > 0 else { return CGSize(width: 0, height: ceil(uiView.attributedText.size().height)) }
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var attach: QuoteAction?

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange,
                      suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let attach, range.length > 0,
                  NSMaxRange(range) <= (textView.text as NSString).length else { return nil }
            let selected = (textView.text as NSString).substring(with: range)
            let quote = UIAction(title: "Quote", image: UIImage(systemName: "quote.bubble")) { _ in
                textView.selectedRange = NSRange(location: 0, length: 0)
                textView.resignFirstResponder()
                attach(.selectedText(selected))
            }
            return UIMenu(children: [quote] + suggestedActions)
        }
    }
}
#else
/// The Mac's selectable text: AppKit's text view, whose context menu gains "Quote" for the
/// selected range, with links and inline formatting kept.
struct SelectableQuoteText: NSViewRepresentable {
    let text: String
    var style: NSFont.TextStyle = .body
    var weight: NSFont.Weight?
    var color: NSColor = .label
    var markdown = true
    var monospaced = false
    @Environment(\.quoteSelection) private var attach

    init(_ text: String, style: NSFont.TextStyle = .body, weight: NSFont.Weight? = nil,
         color: NSColor = .label, markdown: Bool = true, monospaced: Bool = false) {
        self.text = text; self.style = style; self.weight = weight; self.color = color; self.markdown = markdown
        self.monospaced = monospaced
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSTextView {
        // TextKit 1, so the size of the laid-out text can be asked for directly.
        let view = NSTextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {
        context.coordinator.attach = attach
        let base = NSFont.preferredFont(forTextStyle: style)
        let font = monospaced ? NSFont.monospacedSystemFont(ofSize: base.pointSize, weight: weight ?? .regular)
            : weight.map { NSFont.systemFont(ofSize: base.pointSize, weight: $0) } ?? base
        let attributed = quoteAttributedText(text, markdown: markdown, font: font, color: color)
        if view.attributedString() != attributed { view.textStorage?.setAttributedString(attributed) }
        view.linkTextAttributes = [.foregroundColor: NSColor(named: "AccentColor") ?? .linkColor,
                                   .cursor: NSCursor.pointingHand]
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? {
        let text = nsView.attributedString()
        // A horizontal code scroller proposes no width; retain the text's natural size there.
        guard let width = proposal.width, width.isFinite else {
            let size = text.size()
            return CGSize(width: ceil(size.width), height: ceil(size.height))
        }
        // As on iOS: asked with zero, wrapped text can shrink to nothing.
        guard width > 0 else { return CGSize(width: 0, height: ceil(text.size().height)) }
        let bounds = text.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                       options: [.usesLineFragmentOrigin, .usesFontLeading])
        return CGSize(width: width, height: ceil(bounds.height))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var attach: QuoteAction?
        private var selected = ""
        private weak var textView: NSTextView?

        func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
            let range = view.selectedRange()
            guard attach != nil, range.length > 0, NSMaxRange(range) <= (view.string as NSString).length else { return menu }
            selected = (view.string as NSString).substring(with: range)
            textView = view
            let item = NSMenuItem(title: "Quote", action: #selector(quote), keyEquivalent: "")
            item.target = self
            item.image = NSImage(systemSymbolName: "quote.bubble", accessibilityDescription: nil)
            menu.insertItem(item, at: 0)
            menu.insertItem(.separator(), at: 1)
            return menu
        }

        @objc private func quote() {
            textView?.setSelectedRange(NSRange(location: 0, length: 0))
            attach?(.selectedText(selected))
        }
    }
}
#endif
