import SwiftUI

/// An assistant message, drawn: Markdown blocks (headings, lists, quotes, tables, code) and the
/// cards the agent writes as fenced blocks. Everything sits in plain system type; a card is the
/// same quiet filled box a tool row uses.
struct MarkdownView: View {
    let text: String
    /// Draws only the first blocks, for a preview (Home's updates).
    var maxBlocks: Int?
    /// The text is still arriving: a card left open at its end waits instead of showing as code.
    var streaming = false
    /// The stored message this is, whose interactive cards keep what the user sets in them.
    var messageId: String?

    init(_ text: String, maxBlocks: Int? = nil, streaming: Bool = false, messageId: String? = nil) {
        self.text = text
        self.maxBlocks = maxBlocks
        self.streaming = streaming
        self.messageId = messageId
    }

    var body: some View {
        // Quick replies are offered under the chat's last message, not drawn in it.
        let blocks = Markdown.parse(text, streaming: streaming).filter { if case .choices = $0 { false } else { true } }
        // A card is known by its place among the message's widget blocks, as the server counts them.
        let cardIndex = blocks.reduce(into: [Int]()) { out, block in
            let isCard: Bool = { if case .widget = block { true } else if case .pendingCard = block { true } else { false } }()
            out.append((out.last ?? -1) + (isCard ? 1 : 0))
        }
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.prefix(maxBlocks ?? blocks.count).enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block, card: messageId.map { ($0, cardIndex[index]) })
            }
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    /// For a widget: its message and its place there.
    var card: (messageId: String, index: Int)?

    @Environment(\.chatCards) private var cards

    @ViewBuilder
    var body: some View {
        if let quote = block.messageQuote {
            contents.modifier(QuotableCard(quote: quote, pin: pin))
        } else { contents }
    }

    /// A widget card of a stored reply can go on Home.
    private var pin: (() async throws -> Void)? {
        guard case .widget = block, let card, let cards else { return nil }
        return { try await cards.pin(card.messageId, card.index) }
    }

    @ViewBuilder
    private var contents: some View {
        switch block {
        case let .heading(level, text):
            SelectableQuoteText(text, style: level <= 1 ? .title3 : level == 2 ? .headline : .subheadline, weight: .semibold)
                .padding(.top, 2)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            SelectableQuoteText(text)
        case .list(let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        marker(item.marker)
                        SelectableQuoteText(item.text)
                    }
                    .padding(.leading, CGFloat(item.level) * 18)
                }
            }
        case .quote(let text):
            SelectableQuoteText(text, color: .secondaryLabel)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(width: 3)
                }
        case let .code(_, text):
            ScrollView(.horizontal, showsIndicators: false) {
                SelectableQuoteText(text, style: .footnote, markdown: false, monospaced: true)
                    .padding(10)
            }
            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case let .table(header, rows):
            TableView(header: header, rows: rows)
        case .rule:
            Divider()
        case let .link(title, url):
            LinkCardView(title: title, url: url)
        case .event(let event):
            EventCardView(event: event)
        case .schedule(let schedule):
            ScheduleCardView(schedule: schedule)
        case .card(let card):
            InfoCardView(card: card)
        case .drive(let card):
            DriveCardView(card: card)
        case .widget(let node):
            WidgetCardView(node: node, card: card)
        case .pendingCard:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Drawing a card…").font(.footnote).foregroundStyle(.secondary)
            }
            .cardBox()
        case .choices:
            EmptyView()
        }
    }

    @ViewBuilder
    private func marker(_ marker: MarkdownListItem.Marker) -> some View {
        switch marker {
        case .bullet:
            Text("•").foregroundStyle(.secondary)
        case .number(let n):
            Text("\(n).").monospacedDigit().foregroundStyle(.secondary)
        case .todo(let done):
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.footnote)
                .foregroundStyle(done ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                .accessibilityLabel(done ? "Done" : "Not done")
        }
    }
}

private struct CardBox: ViewModifier {
    var padding: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private extension View {
    func cardBox(padding: CGFloat = 12) -> some View { modifier(CardBox(padding: padding)) }
}

private struct TableView: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        self.cell(cell, bold: true)
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in self.cell(cell) }
                    }
                    if index < rows.count - 1 { Divider().opacity(0.5) }
                }
            }
            .padding(12)
        }
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func cell(_ text: String, bold: Bool = false) -> some View {
        SelectableQuoteText(text, style: .footnote, weight: bold ? .semibold : nil)
            .frame(minWidth: 100, idealWidth: 160, maxWidth: 240)
    }
}

private struct LinkCardView: View {
    let title: String
    let url: URL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Link(destination: url) {
            HStack(spacing: 10) {
                Image(systemName: "link")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                        .multilineTextAlignment(.leading)
                    Text(Self.address(url))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 44)
            .cardBox(padding: 10)
        }
        // A link tints its whole label; here only the arrow says "this opens something".
        .buttonStyle(.plain)
        .accessibilityHint("Opens the link")
    }

    nonisolated static func address(_ url: URL) -> String {
        let host = (url.host() ?? url.absoluteString).replacingOccurrences(of: "www.", with: "", options: .anchored)
        let path = url.path()
        return path.count > 1 ? host + path : host
    }
}

private struct EventCardView: View {
    let event: EventCard
    @State private var file: URL?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if let start = event.startTime, !dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 0) {
                    Text(start.date.formatted(.dateTime.month(.abbreviated)).uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tint)
                    Text(start.date.formatted(.dateTime.day()))
                        .font(.title2.weight(.semibold))
                        .monospacedDigit()
                }
                .frame(minWidth: 40)
                .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(Markdown.inline(event.title))
                    .font(.subheadline.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                if let when = Self.when(event) {
                    Label(when, systemImage: "clock")
                        .foregroundStyle(.secondary)
                }
                if let place = event.place {
                    if let maps = Self.maps(place) {
                        Link(destination: maps) {
                            Label(place, systemImage: "mappin.and.ellipse")
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .accessibilityHint("Opens the location in Maps")
                    } else {
                        Label(place, systemImage: "mappin.and.ellipse").foregroundStyle(.secondary)
                    }
                }
                if let note = event.note {
                    Text(Markdown.inline(note)).foregroundStyle(.secondary)
                }
                if let file {
                    ShareLink(item: file) {
                        Label("Share as calendar event", systemImage: "calendar.badge.plus")
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                }
            }
            .font(.footnote)
            .labelStyle(TightLabel())
        }
        .cardBox()
        .task(id: event) { file = Self.write(event) }
    }

    /// "Saturday 14 March, 19:00 – 21:00"; what the agent wrote, when it is not a time we can read.
    nonisolated static func when(_ event: EventCard) -> String? {
        guard let start = event.startTime else {
            return [event.start, event.end].compactMap { $0 }.joined(separator: " – ").nilIfEmpty
        }
        var text = start.date.formatted(.dateTime.weekday(.wide).day().month(.wide))
        guard start.hasTime else {
            if let end = event.endTime, end.date > start.date {
                text += " – " + end.date.formatted(.dateTime.weekday(.wide).day().month(.wide))
            }
            return text
        }
        text += ", " + start.date.formatted(date: .omitted, time: .shortened)
        if let end = event.endTime, end.date > start.date {
            let sameDay = Calendar.current.isDate(end.date, inSameDayAs: start.date)
            text += " – " + (sameDay
                ? end.date.formatted(date: .omitted, time: .shortened)
                : end.date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute()))
        }
        return text
    }

    nonisolated static func maps(_ place: String) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [URLQueryItem(name: "q", value: place)]
        return components?.url
    }

    /// The event as a calendar file to hand to the share sheet. Nil when its time cannot be read.
    private static func write(_ event: EventCard) -> URL? {
        let uid = "sunnie-\(abs(event.hashValue))"
        guard let ics = event.ics(uid: uid) else { return nil }
        let name = event.title.components(separatedBy: CharacterSet.alphanumerics.union(.whitespaces).inverted).joined()
            .trimmingCharacters(in: .whitespaces).prefix(40)
        let folder = FileManager.default.temporaryDirectory.appending(path: "events/\(uid)")
        let url = folder.appending(path: "\(name.isEmpty ? "Event" : String(name)).ics")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try ics.write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            return nil
        }
    }
}

private struct ScheduleCardView: View {
    let schedule: ScheduleCard
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title = schedule.title {
                Text(Markdown.inline(title)).font(.subheadline.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
            }
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(schedule.entries.enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 4) {
                            time(entry)
                            details(entry)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            } else {
                Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 10) {
                    ForEach(Array(schedule.entries.enumerated()), id: \.offset) { _, entry in
                        GridRow(alignment: .firstTextBaseline) {
                            time(entry).gridColumnAlignment(.leading)
                            details(entry)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .cardBox()
    }

    private func time(_ entry: ScheduleCard.Entry) -> some View {
        Text(entry.time)
            .font(.footnote.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(.tint)
    }

    private func details(_ entry: ScheduleCard.Entry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Markdown.inline(entry.what)).font(.subheadline)
            if let detail = entry.detail {
                Text(Markdown.inline(detail)).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}

private struct InfoCardView: View {
    let card: InfoCard
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(Markdown.inline(card.title)).font(.subheadline.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                if let subtitle = card.subtitle {
                    Text(Markdown.inline(subtitle)).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !card.fields.isEmpty {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(card.fields.enumerated()), id: \.offset) { _, field in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(field.label).foregroundStyle(.secondary)
                                fieldValue(field)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .font(.footnote)
                } else {
                    Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 6) {
                        ForEach(Array(card.fields.enumerated()), id: \.offset) { _, field in
                            GridRow(alignment: .firstTextBaseline) {
                                Text(field.label).foregroundStyle(.secondary).gridColumnAlignment(.leading)
                                fieldValue(field)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .font(.footnote)
                }
            }
            if let link = card.link {
                Link(destination: link) {
                    Label(card.opensWhatsApp ? "Open in WhatsApp" : LinkCardView.address(link), systemImage: "arrow.up.right")
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .font(.footnote)
                .labelStyle(TightLabel())
            }
        }
        .cardBox()
    }

    private func fieldValue(_ field: InfoCard.Field) -> Text {
        if card.opensWhatsApp && field.label.lowercased() == "message" {
            // Preserve the draft's literal punctuation, including WhatsApp's formatting markers.
            Text(field.value)
        } else {
            Text(Markdown.inline(field.value))
        }
    }
}

/// A card the agent designed from a Home widget's parts. Bare, it is the quiet box every card
/// uses; colour, gradient or a picture come only from what the card itself asks for. A tap does
/// no more than a widget's: open a link or a Drive item, or put text in the message box.
private struct EventSheetItem: Identifiable {
    let event: EventCard
    var id: Int { event.hashValue }
}

private struct WidgetCardView: View {
    let node: WidgetNode
    var card: (messageId: String, index: Int)?
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @Environment(\.chatDraft) private var draft
    @Environment(\.chatCards) private var cards
    @Environment(\.chatSend) private var send
    @State private var file: OpenedFile?
    @State private var event: EventCard?

    var body: some View {
        let style = node.style
        let shape = RoundedRectangle(cornerRadius: CGFloat(style.corner ?? 12), style: .continuous)
        // What the user sets is kept against the stored message; while it streams it is only local.
        WidgetStateHost(node: node, saved: card.flatMap { cards?.state($0.messageId, $0.index) }, changed: card.map { card in
            { state in cards?.save(card.messageId, card.index, state) }
        }) {
            // As on Home, the root's background is the card's own, so it reaches the edges.
            WidgetNodeView(node: node, isRoot: true, perform: perform)
        }
            .padding(CGFloat(style.padding ?? (style.hasFill ? 16 : 12)))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if style.hasFill { WidgetFill(style: style) } else { Rectangle().fill(.fill.quaternary) }
            }
            .clipShape(shape)
            .overlay { if let border = Color(widget: style.border) { shape.strokeBorder(border, lineWidth: 1) } }
            .sheet(item: Binding(get: { event.map(EventSheetItem.init) }, set: { event = $0?.event })) { item in
                NavigationStack {
                    ScrollView { EventCardView(event: item.event).padding() }
                        .navigationTitle("Add to Calendar")
                        .inlineNavigationTitle()
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { event = nil } } }
                }
                .presentationDetents([.medium])
            }
            .sheet(item: $file) { file in
                if let client = app.client {
                    NavigationStack {
                        DriveItemView(client: client, path: file.path)
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { self.file = nil } } }
                    }
                }
            }
    }

    private func perform(_ action: WidgetAction) {
        switch action {
        case .openURL(let url): openURL(url)
        case .ask(let prompt): draft?(prompt)
        case .reply(let text): send?(text)
        case .copy(let text): Clipboard.copy(text)
        case .calendar: event = action.event
        case .openFile(let path): if app.info?.drive?.enabled == true { file = OpenedFile(path: path) }
        // Another chat is somewhere Home can go; a reply stays in its own.
        case .openChat, .unknown: break
        }
    }
}

/// Something the agent did that the user should see without opening the steps: a follow-up it
/// set for itself, a thing it wrote to memory.
struct ChatCardView: View {
    let card: ChatCard
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon)
                .font(.footnote)
                .foregroundStyle(.tint)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(text)
                    .font(.footnote)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 5)
            }
        }
        .cardBox(padding: 10)
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch card {
        case .followUp: return "bell"
        case .memory: return "brain"
        }
    }

    private var text: String {
        switch card {
        case .followUp(let text, _, _), .memory(let text, _): return text
        }
    }

    private var label: String {
        switch card {
        case let .followUp(_, when, moved):
            let head = moved ? "Follow-up moved" : "Will follow up"
            return when.map { "\(head) · \($0)" } ?? head
        case .memory(_, let about):
            switch about {
            case .archive: return "Remembered"
            case .user: return "Noted about you"
            case .persona: return "Noted for how it works with you"
            }
        }
    }
}

/// A label whose icon sits close to its text and takes the text's colour.
private struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            configuration.icon
            configuration.title
        }
    }
}

extension String {
    nonisolated var nilIfEmpty: String? { isEmpty ? nil : self }
}
