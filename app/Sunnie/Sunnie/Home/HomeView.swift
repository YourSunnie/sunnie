import SwiftUI
import UniformTypeIdentifiers

nonisolated struct OpenedFile: Identifiable, Hashable {
    var path: String
    var id: String { path }
}

nonisolated enum HomeRoute: Hashable {
    case conversation(Conversation)
    /// A new chat with this in the composer, from a widget's "ask".
    case ask(String)
    /// A new chat with a widget quoted in the composer, from a swipe.
    case quote(MessageQuote)
}

/// The first screen: a grid of widgets, four columns across, drawn in the order the server sends
/// them. Sunnie and programs write them and the user arranges them, right here: long-press a
/// widget and drag it, or Edit Home to hide and remove. The app has none of its own, so what is here
/// is Sunnie's to decide. Plain grouped iOS, like Settings; the compass star marks only what Sunnie
/// said or is doing.
struct HomeView: View {
    let client: SunnieClient
    @Environment(AppModel.self) private var app
    @Environment(CheckInsModel.self) private var checkIns
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Set in the one-chat mode: asks and quotes go to the one chat instead of a new one.
    @Environment(OneChat.self) private var oneChat: OneChat?
    @State private var model: HomeModel
    @State private var path: [HomeRoute] = []
    /// The row whose conversation is being fetched, to show it is on its way.
    @State private var opening: String?
    /// Edit Home: every widget shows, hidden ones dimmed, with buttons to hide and remove.
    @State private var isArranging = false
    /// The widget being dragged to a new place.
    @State private var dragging: String?
    /// The widget the user asked to remove, waiting for them to confirm.
    @State private var removing: HomeWidget?
    @State private var gridWidth: CGFloat = 360
    /// The Drive file or folder a widget asked to open.
    @State private var file: OpenedFile?
    @Environment(\.openURL) private var openURL

    init(client: SunnieClient) {
        self.client = client
        _model = State(initialValue: HomeModel(client: client))
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if model.isEmpty && !model.isBriefRunning && !isArranging {
                        emptyState
                    } else {
                        grid
                    }
                    if isArranging {
                        Text("Drag a widget to move it. To add one, ask \(app.agentName) in a chat, for example “put my step count on Home”.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                .frame(maxWidth: 960)
                .frame(maxWidth: .infinity)
            }
            .background(Color.groupedBackground)
            .navigationTitle(isArranging ? "Edit Home" : HomeGreeting.text())
            .toolbar { toolbar }
            .refreshable { await model.refresh(checkIns: checkIns) }
            .navigationDestination(for: HomeRoute.self) { route in
                switch route {
                case .conversation(let conversation): ChatView(client: client, conversation: conversation)
                case .ask(let prompt): ChatView(client: client, conversation: nil, draft: prompt)
                case .quote(let quote): ChatView(client: client, conversation: nil, quotes: [quote])
                }
            }
            .overlay {
                if !model.hasLoaded {
                    ProgressView("Loading…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else if model.feed == nil, let error = model.error {
                    ContentUnavailableView {
                        Label("Home is not available", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { Task { await model.refresh(checkIns: checkIns) } }
                    }
                }
            }
            .confirmationDialog(
                "Remove \(removing?.name ?? "this widget") from Home?",
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                titleVisibility: .visible,
                presenting: removing
            ) { widget in
                Button("Remove", role: .destructive) { Task { await model.remove(widget) } }
            } message: { _ in
                Text("\(app.agentName) can put it back if you ask.")
            }
            .sheet(item: $file) { opened in
                NavigationStack {
                    DriveItemView(client: client, path: opened.path)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { file = nil } } }
                }
            }
            .onAppear { Task { await model.refresh(checkIns: checkIns) } }
            // While Sunnie prepares Home, look again every few seconds so it fills in by itself.
            .task(id: model.isBriefRunning) {
                while model.isBriefRunning, !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled else { return }
                    await model.refresh(checkIns: checkIns)
                }
            }
            // A resize takes Sunnie a few seconds: look often, so the new design shows as soon as it is there.
            .task(id: model.isResizing) {
                while model.isResizing, !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    guard !Task.isCancelled else { return }
                    await model.refresh(checkIns: checkIns)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.refresh(checkIns: checkIns) } }
            }
            .onChange(of: model.arrangeable.isEmpty) { _, empty in
                if empty { isArranging = false }
            }
            .alert("Something went wrong", isPresented: Binding(get: { model.error != nil && model.feed != nil }, set: { if !$0 { model.error = nil } })) {
                Button("OK") {}
            } message: {
                Text(model.error ?? "")
            }
            .alert("Not right now", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
                Button("OK") {}
            } message: {
                Text(model.notice ?? "")
            }
        }
    }

    // MARK: Sections

    /// Today's date, on the screen's own background.
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            if model.isBriefRunning {
                HStack(spacing: 8) {
                    TurningStar(size: 14)
                    Text("\(app.agentName) is getting your Home ready…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 4)
    }

    /// Nothing on Home yet: what goes here is the user's to ask for. The daily brief only keeps
    /// widgets current and leaves a note now and then, so there is no button to start one.
    private var emptyState: some View {
        GardenEmptyState(
            title: "Your Home, your way",
            message: "Ask \(app.agentName) in a chat to put something here, for example “put my step count on Home” or “a small countdown to my trip”.",
            markSize: 88
        ) {
            EmptyView()
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    /// The widgets, four columns across. Each keeps its view while its data changes, and a drag
    /// moves it among the others as it goes; the order is saved when it is dropped.
    private var grid: some View {
        let shown = isArranging ? model.arrangeable : model.widgets
        let column = CGFloat(HomeGrid.columnWidth(in: Double(gridWidth)))
        return HomeGridLayout {
            ForEach(shown) { widget in
                cell(for: widget, column: column)
                    .layoutValue(key: WidgetSpan.self, value: HomeGrid.span(widget.span, accessibility: dynamicTypeSize.isAccessibilitySize))
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { gridWidth = $0 }
        .animation(reduceMotion ? nil : .snappy, value: shown.map(\.id))
        .animation(reduceMotion ? nil : .snappy, value: isArranging)
        // A drop between widgets lands too.
        .onDrop(of: [.text], delegate: WidgetDrop(target: nil, model: model, dragging: $dragging))
    }

    private func cell(for widget: HomeWidget, column: CGFloat) -> some View {
        HomeWidgetCard(widget: widget, column: column, agentName: app.agentName, isOpening: opening == widget.id,
                       saveState: { model.saveState(widget.id, $0) }) {
            perform($0, row: widget.id)
        }
        .modifier(WidgetArranging(
            widget: widget,
            isArranging: isArranging,
            agentName: app.agentName,
            ask: app.info?.quoting?.enabled == true ? { ask(about: widget) } : nil,
            edit: { isArranging = true },
            hide: { hidden in Task { await model.setHidden(widget, hidden) } },
            resize: { columns in Task { await model.resize(widget, columns: columns) } },
            remove: { removing = widget }
        ))
        .onDrag {
            dragging = widget.id
            model.beginDrag()
            return NSItemProvider(object: widget.id as NSString)
        }
        .onDrop(of: [.text], delegate: WidgetDrop(target: widget.id, model: model, dragging: $dragging))
    }

    private func ask(about widget: HomeWidget) {
        let quote = widget.messageQuote
        if let oneChat { oneChat.hand(ChatHandoff(quote: quote)) } else { path.append(.quote(quote)) }
    }

    private func perform(_ action: WidgetAction, row: String) {
        guard !isArranging else { return }
        switch action {
        case .openURL(let url): openURL(url)
        case .openChat(let id): open(id, row: row)
        case .ask(let prompt):
            if let oneChat { oneChat.hand(ChatHandoff(draft: prompt)) } else { path.append(.ask(prompt)) }
        case .openFile(let path): file = OpenedFile(path: path)
        case .copy(let text): Clipboard.copy(text)
        case .calendar(let title, let start, _, _, _):
            // Home has no sheet of its own for it: the event goes to a chat, where the card can add it.
            let prompt = "Add \(title) at \(start) to my calendar"
            if let oneChat { oneChat.hand(ChatHandoff(draft: prompt)) } else { path.append(.ask(prompt)) }
        // A reply belongs to a chat card; the server keeps it off Home.
        case .reply, .unknown: break
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if isArranging {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { isArranging = false }
            }
        } else {
            if let conversation = checkIns.conversation {
                ToolbarItem(placement: .trailingBar) {
                    CheckInsButton(hasNew: checkIns.hasNew) { path.append(.conversation(conversation)) }
                }
            }
            if model.feed != nil {
                ToolbarItem(placement: .trailingBar) {
                    Menu {
                        if !model.arrangeable.isEmpty {
                            Button("Edit Home", systemImage: "square.grid.2x2") { isArranging = true }
                        }
                        if model.feed?.brief.enabled == true {
                            Button {
                                Task { await model.requestBrief(checkIns: checkIns) }
                            } label: {
                                Label("Refresh with \(app.agentName)", systemImage: "sun.horizon")
                            }
                            .disabled(!model.canRequestBrief)
                        }
                    } label: {
                        Label("Home options", systemImage: "ellipsis")
                    }
                }
            }
        }
    }

    private func open(_ conversationId: String?, row: String) {
        guard let conversationId, opening == nil else { return }
        if let conversation = checkIns.conversation, conversation.id == conversationId {
            path.append(.conversation(conversation))
            return
        }
        opening = row
        Task {
            defer { opening = nil }
            if let conversation = await model.conversation(conversationId) { path.append(.conversation(conversation)) }
        }
    }
}

// MARK: Grid

/// How many of Home's columns a widget spans.
private struct WidgetSpan: LayoutValueKey {
    static let defaultValue = HomeGrid.columns
}

/// Home's grid: widgets left to right in order, a line at a time (`HomeGrid.lines`). Widgets on a
/// line share its height, so their cards line up.
struct HomeGridLayout: Layout {
    var spacing = CGFloat(HomeGrid.spacing)

    private struct Line {
        var items: [(index: Int, width: CGFloat)]
        var height: CGFloat
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 360
        let lines = arrange(width: width, subviews: subviews)
        let height = lines.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(lines.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for item in line.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: item.width, height: line.height))
                x += item.width + spacing
            }
            y += line.height + spacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Line] {
        HomeGrid.lines(Array(subviews.indices)) { subviews[$0][WidgetSpan.self] }.map { line in
            let items = line.map { index in
                (index: index, width: CGFloat(HomeGrid.width(span: subviews[index][WidgetSpan.self], in: Double(width))))
            }
            let height = items.map { subviews[$0.index].sizeThatFits(ProposedViewSize(width: $0.width, height: nil)).height }.max() ?? 0
            return Line(items: items, height: height)
        }
    }
}

/// One widget as a card on Home: its title, its parts, and what a tap on it does. A background on
/// the body itself is the card's, so it reaches the card's edges.
struct HomeWidgetCard: View {
    let widget: HomeWidget
    /// The width of one column: a card is never shorter, so small widgets are square tiles.
    let column: CGFloat
    let agentName: String
    let isOpening: Bool
    var saveState: (([String: StateValue]) -> Void)?
    let perform: (WidgetAction) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let style = widget.body.style
        let shape = RoundedRectangle(cornerRadius: CGFloat(style.corner ?? 22), style: .continuous)
        let action = widget.action.flatMap { $0 == .unknown ? nil : $0 }
        // A full-width widget says what a tap does on a line of its own; a smaller one is tapped whole.
        let actionLine = action != nil && widget.span == HomeGrid.columns
        // The title is only the widget's name: whether it shows a heading is up to its own design.
        VStack(alignment: .leading, spacing: 8) {
            content
            if actionLine, let action {
                Spacer(minLength: 0)
                Divider()
                WidgetActionRow(action: action, agentName: agentName, isOpening: isOpening, perform: perform)
            }
        }
        .padding(CGFloat(style.padding ?? (widget.span == 1 ? 12 : 16)))
        .frame(maxWidth: .infinity, minHeight: column, maxHeight: .infinity, alignment: .topLeading)
        .background { if style.hasFill { WidgetFill(style: style) } else { Color.groupedCard } }
        .overlay {
            if widget.isResizing {
                WidgetResizing()
                    .transition(.opacity)
            }
        }
        .clipShape(shape)
        .overlay { if let border = Color(widget: style.border) { shape.strokeBorder(border, lineWidth: 1) } }
        .contentShape(shape)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(widget.name)
        .accessibilityValue(widget.isResizing ? "\(agentName) is resizing it" : "")
        .onTapGesture { if !actionLine, let action { perform(action) } }
        .accessibilityActions {
            if !actionLine, let action {
                Button(WidgetNodeView.hint(action)) { perform(action) }
            }
        }
        // New data changes what the card shows in place; its design stays put.
        .animation(reduceMotion ? nil : .smooth, value: widget.body)
        .animation(reduceMotion ? nil : .smooth, value: widget.isResizing)
    }

    private var content: some View {
        WidgetStateHost(node: widget.body, saved: widget.state, changed: saveState) {
            WidgetNodeView(node: widget.body, isRoot: true, perform: perform)
        }
    }
}

/// Where a dragged widget goes: onto another, which it takes the place of as it passes, or
/// between them. Dropping it saves the order.
private struct WidgetDrop: DropDelegate {
    let target: String?
    let model: HomeModel
    @Binding var dragging: String?

    func dropEntered(info: DropInfo) {
        guard let dragging, let target, dragging != target else { return }
        model.move(dragging, onto: target)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        guard dragging != nil else { return false }
        dragging = nil
        Task { await model.saveOrder() }
        return true
    }
}

// MARK: Rows

/// What a widget offers besides its own taps. On Home: swipe right to talk about it with Sunnie
/// (the widget goes into the composer as a quote), and the long-press menu, which also edits Home
/// and removes it; removing has no swipe (the user found the trailing delete swipe ugly). In Edit
/// Home: a button to remove it and one to hide or show it, and its own taps are off.
struct WidgetArranging: ViewModifier {
    let widget: HomeWidget
    let isArranging: Bool
    let agentName: String
    /// Nil when the server does not take quotes.
    let ask: (() -> Void)?
    let edit: () -> Void
    let hide: (Bool) -> Void
    /// Picks a new width; Sunnie then redesigns the widget for it.
    let resize: (Int) -> Void
    let remove: () -> Void
    @State private var offset: CGFloat = 0

    private static let sizes: [(columns: Int, name: String)] = [
        (1, "Small"), (2, "Medium"), (3, "Large"), (4, "Full width"),
    ]

    func body(content: Content) -> some View {
        if isArranging {
            content
                .overlay {
                    // Taps on the widget's own buttons wait until editing is done.
                    Color.white.opacity(0.001)
                }
                .opacity(widget.hidden ? 0.4 : 1)
                .scaleEffect(0.97)
                .overlay(alignment: .topLeading) {
                    control("minus", label: "Remove \(widget.name)", tint: .gray, action: remove)
                }
                .overlay(alignment: .topTrailing) {
                    // A hidden widget's button stands out: it is the way back.
                    control(widget.hidden ? "eye.slash" : "eye", label: widget.hidden ? "Show \(widget.name)" : "Hide \(widget.name)",
                            tint: widget.hidden ? .accentColor : .gray) { hide(!widget.hidden) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityValue(widget.hidden ? "Hidden" : "")
        } else {
            Group {
                if let ask {
                    content
                        .offset(x: offset)
                        .overlay(alignment: .leading) { QuoteSwipeMark(offset: offset, badge: true) }
                        .modifier(QuoteSwipe(offset: $offset, perform: ask))
                        .accessibilityAction(named: "Ask \(agentName) about this") { ask() }
                } else {
                    content
                }
            }
            .contextMenu {
                if let ask {
                    Button("Ask \(agentName) about this", systemImage: "quote.bubble", action: ask)
                }
                if !widget.isResizing {
                    Menu {
                        ForEach(Self.sizes, id: \.columns) { size in
                            Button {
                                resize(size.columns)
                            } label: {
                                if size.columns == widget.span {
                                    Label(size.name, systemImage: "checkmark")
                                } else {
                                    Text(size.name)
                                }
                            }
                            .disabled(size.columns == widget.span)
                        }
                    } label: {
                        Label("Resize", systemImage: "arrow.up.left.and.arrow.down.right")
                    }
                }
                Button("Edit Home", systemImage: "square.grid.2x2", action: edit)
                Button("Hide", systemImage: "eye.slash") { hide(true) }
                Button("Remove from Home", systemImage: "xmark", role: .destructive, action: remove)
            }
            .accessibilityAction(named: "Remove from Home", remove)
        }
    }

    private func control(_ symbol: String, label: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(tint, in: Circle())
                .overlay { Circle().strokeBorder(.white, lineWidth: 2) }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Inside the widget's own corner: the gap belongs to the next one, which is drawn on top.
        .offset(x: symbol == "minus" ? -4 : 4, y: -4)
        .accessibilityLabel(label)
    }
}

/// Over a widget while Sunnie redesigns it for a new width: a slowly moving mesh of the app's
/// colours that covers it whole, with nothing written on it. Still when the user asks for less motion.
struct WidgetResizing: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            MeshGradient(width: 3, height: 3, points: Self.points(at: reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate),
                         colors: Self.colors)
        }
        .accessibilityHidden(true)
    }

    /// Opaque, light and soft — rose, lavender, sky and peach around a warm cream — so it reads as
    /// something being made, not as content; the old design must not show through.
    private static let colors: [Color] = {
        func hex(_ value: UInt32) -> Color {
            Color(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
        }
        return [hex(0xF9B8D4), hex(0xE3BDF5), hex(0xC4BCFF),
                hex(0xFFC6BE), hex(0xFFF5EC), hex(0xAFCBFF),
                hex(0xFFD2AE), hex(0xFFE3C9), hex(0xA6DBFF)]
    }()

    /// The corners stay put and the edges slide along them; the middle wanders, so the colours drift.
    static func points(at t: Double) -> [SIMD2<Float>] {
        func wave(_ speed: Double, _ phase: Double, _ amount: Double) -> Float { Float(sin(t * speed + phase) * amount) }
        return [
            [0, 0], [0.5 + wave(0.9, 0, 0.2), 0], [1, 0],
            [0, 0.5 + wave(1.1, 1, 0.2)], [0.5 + wave(1.3, 2, 0.15), 0.5 + wave(1.0, 3, 0.15)], [1, 0.5 + wave(0.8, 4, 0.2)],
            [0, 1], [0.5 + wave(1.2, 5, 0.2), 1], [1, 1],
        ]
    }
}

/// A small dot in the tint, as Mail marks what is unread.
struct NewDot: View {
    var body: some View {
        Circle().fill(Color.accentColor).frame(width: 9, height: 9)
    }
}

/// The toolbar's way into Check-ins, with a dot when something new is there.
struct CheckInsButton: View {
    let hasNew: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            Image(systemName: "clock.arrow.circlepath")
                .overlay(alignment: .topTrailing) {
                    if hasNew { NewDot().offset(x: 5, y: -4) }
                }
        }
        .accessibilityLabel("Check-ins")
        .accessibilityValue(hasNew ? "New updates" : "")
    }
}
