import QuickLook
import SwiftUI

// How a widget's parts are drawn. A bare part is plain iOS, like the rest of the app; colour,
// backgrounds and layout come only from what the widget itself asks for.

extension Color {
    /// A widget colour: one of the names the server accepts, or hex. Unknown is nil.
    init?(widget name: String?) {
        guard let name = name?.lowercased() else { return nil }
        switch name {
        case "primary": self = .primary
        case "secondary": self = .secondary
        case "tertiary": self = Color.tertiaryLabel
        case "accent": self = .accentColor
        case "petal": self = Color("Petal")
        case "white": self = .white
        case "black": self = .black
        case "gray": self = .gray
        case "red": self = .red
        case "orange": self = .orange
        case "yellow": self = .yellow
        case "green": self = .green
        case "mint": self = .mint
        case "teal": self = .teal
        case "cyan": self = .cyan
        case "blue": self = .blue
        case "indigo": self = .indigo
        case "purple": self = .purple
        case "pink": self = .pink
        case "brown": self = .brown
        default:
            guard let c = WidgetRGBA(hex: name) else { return nil }
            self = Color(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: c.alpha)
        }
    }
}

/// A part's background: its picture at the back, then its gradient if it has one, else its colour,
/// so a see-through gradient over a picture keeps the text on it readable.
struct WidgetFill: View {
    let style: WidgetStyle

    var body: some View {
        ZStack {
            if let picture = style.backgroundImage {
                DriveImage(path: picture, fill: true)
            }
            let colors = style.gradient.compactMap { Color(widget: $0) }
            if colors.count >= 2 {
                LinearGradient(colors: colors, startPoint: start, endPoint: end)
            } else if let color = Color(widget: style.background) {
                color
            }
        }
    }

    private var start: UnitPoint { style.direction == "right" ? .leading : style.direction == "diagonal" ? .topLeading : .top }
    private var end: UnitPoint { style.direction == "right" ? .trailing : style.direction == "diagonal" ? .bottomTrailing : .bottom }
}

/// Padding, width, background, corners, border, opacity and colour, in that order.
private struct WidgetStyling: ViewModifier {
    let style: WidgetStyle
    /// Whether the part keeps to its own width (in a row) instead of taking what is offered.
    let fits: Bool
    /// The card draws a root's background, so it reaches the card's edges.
    let isRoot: Bool
    /// A tile in a grid grows to the height of its row, so backgrounds line up.
    let stretches: Bool

    func body(content: Content) -> some View {
        let drawsFill = style.hasFill && !isRoot
        let radius = style.corner ?? (drawsFill || style.border != nil ? 12 : 0)
        let shape = RoundedRectangle(cornerRadius: isRoot ? 0 : radius, style: .continuous)
        colored(
            content
                .frame(height: style.height.map { CGFloat($0) })
                // A root's padding is the card's own inset, which the card around it sets.
                .padding(isRoot ? 0 : CGFloat(style.padding ?? (drawsFill ? 16 : 0)))
                .frame(maxWidth: fits ? nil : .infinity, maxHeight: stretches ? .infinity : nil, alignment: alignment)
                .multilineTextAlignment(style.align == "center" ? .center : style.align == "trailing" ? .trailing : .leading)
                .background { if drawsFill { WidgetFill(style: style) } }
                .clipShape(shape)
                .overlay { if !isRoot, let border = Color(widget: style.border) { shape.strokeBorder(border, lineWidth: 1) } }
                .opacity(style.opacity ?? 1)
        )
    }

    private var alignment: Alignment {
        let horizontal: HorizontalAlignment = style.align == "center" ? .center : style.align == "trailing" ? .trailing : .leading
        return Alignment(horizontal: horizontal, vertical: stretches ? .top : .center)
    }

    /// A colour is inherited: children that say nothing take it, and "secondary" becomes a shade of it.
    @ViewBuilder
    private func colored(_ view: some View) -> some View {
        if let color = Color(widget: style.color) {
            view.foregroundStyle(color).tint(color)
        } else {
            view
        }
    }
}

/// One part of a widget, and whatever it holds.
struct WidgetNodeView: View {
    let node: WidgetNode
    var isRoot = false
    /// A picture inside a layer fills the layer instead of having a height of its own.
    var inLayer = false
    var inGrid = false
    /// The colour this part takes from the parts around it, when it names none.
    var inherited: String?
    let perform: (WidgetAction) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.widgetValues) private var values

    var body: some View {
        if let when = node.when, !Formula.holds(when, values.state) {
            EmptyView()
        } else if case .spacer = node.kind {
            Spacer(minLength: 0)
        } else if case .unknown = node.kind {
            EmptyView()
        } else if let action = node.action, action != .unknown, !isButton {
            Button { act(action) } label: { styled.contentShape(Rectangle()) }
                .buttonStyle(.plain)
        } else {
            styled
        }
    }

    private var isButton: Bool {
        if case .button = node.kind { true } else { false }
    }

    private var styled: some View {
        var style = node.style
        // These draw their own background, height or colour.
        switch node.kind {
        case .badge: style.background = nil; style.gradient = []; style.backgroundImage = nil
        case .button: style.background = nil; style.gradient = []; style.backgroundImage = nil; style.color = nil; style.corner = nil
        case .chart, .image: style.height = nil
        default: break
        }
        return content.modifier(WidgetStyling(style: style, fits: fits, isRoot: isRoot, stretches: inGrid))
    }

    /// Small things keep to their own size in a row unless told otherwise.
    private var fits: Bool {
        if let fit = node.style.fit { return fit }
        switch node.kind {
        case .icon, .badge, .gauge: return true
        default: return false
        }
    }

    @ViewBuilder
    private var content: some View {
        switch node.kind {
        case .text(let label):
            Text(show(label.text))
                .font(Self.font(label))
                .foregroundStyle(node.style.color == nil && (label.style == "caption" || label.style == "footnote") ? AnyShapeStyle(.secondary) : AnyShapeStyle(.foreground))
                .lineLimit(label.lines)
                .fixedSize(horizontal: false, vertical: true)
        case .markdown(let text):
            MarkdownView(show(text))
        case .stat(let stat):
            StatView(stat: WidgetNode.Stat(value: show(stat.value), label: stat.label.map(show), unit: stat.unit.map(show),
                                           caption: stat.caption.map(show), icon: stat.icon))
        case .fields(let fields):
            VStack(spacing: 8) {
                ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                    LabeledContent(show(field.label), value: show(field.value))
                        .font(.subheadline)
                        .contentTransition(.numericText())
                }
            }
        case .list(let items):
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    if index > 0 { Divider() }
                    ItemRow(item: WidgetNode.Item(title: show(item.title), subtitle: item.subtitle.map(show), value: item.value.map(show),
                                                  icon: item.icon, action: item.action), perform: act)
                }
            }
        case let .progress(fixed, label, caption):
            let value = node.amount.map { Formula.amount($0, values.state) } ?? fixed
            VStack(alignment: .leading, spacing: 6) {
                ProgressView(value: value) {
                    if let label { Text(show(label)).font(.subheadline) }
                }
                .animation(.easeOut(duration: 0.25), value: value)
                if let caption { Text(show(caption)).font(.caption).foregroundStyle(.secondary) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue(value.formatted(.percent.precision(.fractionLength(0))))
        case let .gauge(fixed, label, caption, size):
            let value = node.amount.map { Formula.amount($0, values.state) } ?? fixed
            GaugeView(value: value, label: label.map(show), caption: caption.map(show), size: CGFloat(size ?? 64))
                .animation(.easeOut(duration: 0.25), value: value)
        case let .chart(kind, series, labels, caption):
            ChartView(kind: kind, values: series, labels: labels.map(show), caption: caption.map(show), height: CGFloat(node.style.height ?? 56))
        case let .icon(name, size):
            if PlatformImage.hasSymbol(name) {
                Image(systemName: name)
                    .font(size.map { .system(size: CGFloat($0)) } ?? .title2)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
        case let .badge(text, icon):
            HStack(spacing: 4) {
                if let icon, PlatformImage.hasSymbol(icon) { Image(systemName: icon) }
                Text(show(text))
            }
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(node.style.background == nil ? AnyShapeStyle(.tint) : AnyShapeStyle(.foreground))
            .background {
                if let background = Color(widget: node.style.background) { Capsule().fill(background) } else { Capsule().fill(.tint.opacity(0.15)) }
            }
        case let .button(text, icon, variant):
            WidgetButton(text: show(text), icon: icon, variant: variant ?? "filled",
                         color: Color(widget: node.style.color ?? inherited) ?? .accentColor,
                         corner: CGFloat(node.style.corner ?? 12), align: node.style.align,
                         hint: node.action.map(Self.hint) ?? "") {
                if let action = node.action { act(action) }
            }
        case let .image(path, fill):
            // A picture is always there to be looked at: a tap opens it full size unless the part acts.
            DriveImage(path: path, fill: fill, opensFullSize: node.action == nil)
                .frame(height: inLayer && node.style.height == nil ? nil : CGFloat(node.style.height ?? 140))
                .frame(maxHeight: inLayer ? .infinity : nil)
                .clipped()
        case let .file(path, title, caption):
            Button { perform(.openFile(path)) } label: {
                HStack(spacing: 12) {
                    Image(systemName: Self.fileSymbol(path))
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .frame(width: 28)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title.map(show) ?? path.split(separator: "/").last.map(String.init) ?? path)
                            .lineLimit(2)
                        Text(caption.map(show) ?? "Drive · \(path)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.forward")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens this item in Drive")
        case let .countdown(to, label, style):
            VStack(alignment: .leading, spacing: 2) {
                Text(to, style: .relative)
                    .font(Self.font(.init(text: "", style: style ?? "title3", weight: "semibold")))
                    .monospacedDigit()
                if let label { Text(show(label)).font(.caption).foregroundStyle(.secondary) }
            }
            .accessibilityElement(children: .combine)
        case .divider:
            Divider()
        case .stepper(let input):
            StepperPart(input: input, label: input.label.map(show), unit: input.unit.map(show))
        case .slider(let input):
            SliderPart(input: input, label: input.label.map(show), unit: input.unit.map(show))
        case let .toggle(bind, _, label):
            Toggle(show(label), isOn: Binding(
                get: { if case .bool(let on) = values.state[bind] { on } else { false } },
                set: { values.set?(bind, .bool($0)) }
            ))
            .disabled(values.set == nil)
        case let .segmented(bind, options, _):
            Picker("", selection: Binding(
                get: { if case .text(let v) = values.state[bind] { v } else { options.first?.value ?? "" } },
                set: { values.set?(bind, .text($0)) }
            )) {
                ForEach(options, id: \.value) { option in Text(show(option.label)).tag(option.value) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(values.set == nil)
        case let .checklist(bind, items, caption):
            ChecklistPart(bind: bind, items: items.map { .init(title: show($0.title), detail: $0.detail.map(show), time: $0.time.map(show)) },
                          caption: caption.map(show))
        case let .table(columns, rows, caption):
            TablePart(columns: columns.map(show), rows: rows.map { $0.map(show) }, caption: caption.map(show))
        case let .row(children, valign):
            // Side by side does not fit the largest type sizes: there the parts go one under the other.
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: spacing(12)) { parts(children) }
            } else {
                HStack(alignment: Self.vertical(valign), spacing: spacing(16)) { parts(children) }
            }
        case .stack(let children):
            VStack(alignment: .leading, spacing: spacing(10)) { parts(children) }
        case let .layer(children, anchor):
            ZStack(alignment: Self.anchor(anchor)) { parts(children, inLayer: true) }
        case let .grid(children, columns):
            let count = dynamicTypeSize.isAccessibilitySize ? 1 : columns
            VStack(spacing: spacing(12)) {
                ForEach(Array(stride(from: 0, to: children.count, by: count)), id: \.self) { start in
                    HStack(alignment: .top, spacing: spacing(12)) {
                        ForEach(start..<(start + count), id: \.self) { index in
                            if index < children.count {
                                WidgetNodeView(node: children[index], inGrid: true, inherited: passedOn, perform: perform)
                            } else {
                                Color.clear.frame(maxWidth: .infinity, maxHeight: 0)
                            }
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        case .spacer, .unknown:
            EmptyView()
        }
    }

    private func spacing(_ standard: CGFloat) -> CGFloat { node.spacing.map { CGFloat($0) } ?? standard }

    /// Text as the widget shows it now: each `{formula}` worked out from its state.
    private func show(_ text: String) -> String { Formula.interpolate(text, values.state) }

    /// An action as it stands now: a prompt's formulas worked out.
    private func act(_ action: WidgetAction) { perform(action.resolved(values.state)) }

    private func parts(_ children: [WidgetNode], inLayer: Bool = false) -> some View {
        ForEach(Array(children.enumerated()), id: \.offset) { _, child in
            WidgetNodeView(node: child, inLayer: inLayer, inherited: passedOn, perform: perform)
        }
    }

    private var passedOn: String? { node.style.color ?? inherited }

    /// What a button does, for VoiceOver.
    nonisolated static func hint(_ action: WidgetAction) -> String {
        switch action {
        case .openURL(let url): return "Opens \(url.host() ?? "a web page")"
        case .openChat: return "Opens a chat"
        case .ask: return "Starts a message for you to send"
        case .openFile(let path): return "Opens \(path.split(separator: "/").last.map(String.init) ?? path) in Drive"
        case .reply: return "Sends this as your reply"
        case .copy: return "Copies it"
        case .calendar: return "Adds it to your calendar"
        case .unknown: return ""
        }
    }

    static func font(_ label: WidgetNode.Label) -> Font {
        let weight: Font.Weight? = switch label.weight {
        case "light": .light
        case "regular": .regular
        case "medium": .medium
        case "semibold": .semibold
        case "bold": .bold
        case "heavy": .heavy
        default: nil
        }
        let design: Font.Design = switch label.design {
        case "rounded": .rounded
        // Serif is not used on Home, even in a widget written before the server dropped it.
        case "monospaced": .monospaced
        default: .default
        }
        if let size = label.size {
            return .system(size: CGFloat(size), weight: weight ?? .regular, design: design)
        }
        let (style, standard): (Font.TextStyle, Font.Weight) = switch label.style {
        case "largeTitle": (.largeTitle, .bold)
        case "title": (.title2, .semibold)
        case "title2": (.title2, .regular)
        case "title3": (.title3, .regular)
        case "headline": (.headline, .semibold)
        case "subheadline": (.subheadline, .regular)
        case "callout": (.callout, .regular)
        case "footnote", "caption": (.footnote, .regular)
        default: (.body, .regular)
        }
        return .system(style, design: design, weight: weight ?? standard)
    }

    static func vertical(_ name: String?) -> VerticalAlignment {
        switch name {
        case "center": return .center
        case "bottom": return .bottom
        case "baseline": return .firstTextBaseline
        default: return .top
        }
    }

    static func anchor(_ name: String?) -> Alignment {
        switch name {
        case "topLeading": return .topLeading
        case "top": return .top
        case "topTrailing": return .topTrailing
        case "leading": return .leading
        case "trailing": return .trailing
        case "bottomLeading": return .bottomLeading
        case "bottom": return .bottom
        case "bottomTrailing": return .bottomTrailing
        default: return .center
        }
    }

    static func fileSymbol(_ path: String) -> String {
        guard let name = path.split(separator: "/").last, name.contains(".") else { return "folder" }
        switch name.split(separator: ".").last?.lowercased() {
        case "pdf": return "doc.richtext"
        case "png", "jpg", "jpeg", "heic", "gif", "webp": return "photo"
        case "md", "txt": return "doc.text"
        case "csv", "xlsx", "numbers": return "tablecells"
        default: return "doc"
        }
    }
}

/// A button in a widget. Filled, tinted or plain, at least 44 points tall (Apple's smallest
/// comfortable target), in the colour it is given; text on a filled one is white or black,
/// whichever reads on the fill.
private struct WidgetButton: View {
    let text: String
    let icon: String?
    let variant: String
    let color: Color
    let corner: CGFloat
    let align: String?
    let hint: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon, PlatformImage.hasSymbol(icon) {
                    Image(systemName: icon).accessibilityHidden(true)
                }
                Text(text).lineLimit(1).minimumScaleFactor(0.8)
            }
            .font(.body.weight(.semibold))
            .padding(.horizontal, variant == "plain" ? 0 : 16)
            .padding(.vertical, 10)
            .frame(maxWidth: variant == "plain" ? nil : .infinity, minHeight: 44)
        }
        .buttonStyle(WidgetButtonStyle(variant: variant, color: color, corner: corner))
        .frame(maxWidth: .infinity, alignment: align == "center" ? .center : align == "trailing" ? .trailing : .leading)
        .accessibilityHint(hint)
    }
}

private struct WidgetButtonStyle: ButtonStyle {
    let variant: String
    let color: Color
    let corner: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: corner, style: .continuous)
        configuration.label
            .foregroundStyle(variant == "filled" ? color.readableText : color)
            .background {
                switch variant {
                case "filled": shape.fill(color)
                case "tinted": shape.fill(color.opacity(0.15))
                default: EmptyView()
                }
            }
            .contentShape(shape)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

private extension Color {
    /// White or black, whichever reads on this colour.
    var readableText: Color {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        #if canImport(UIKit)
        let resolved = UIColor(self).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        guard resolved.getRed(&r, green: &g, blue: &b, alpha: &a) else { return .white }
        #else
        guard let resolved = NSColor(self).usingColorSpace(.sRGB) else { return .white }
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        #endif
        return WidgetRGBA.prefersDarkText(red: r, green: g, blue: b) ? .black : .white
    }
}

/// A picture from the user's Drive, through the same revision-checked cache as opening a file.
private struct DriveImage: View {
    let path: String
    let fill: Bool
    /// Whether a tap shows the picture full size (every picture that is not a background does).
    var opensFullSize = false
    @Environment(AppModel.self) private var app
    @State private var image: PlatformImage?
    @State private var fileURL: URL?
    @State private var previewURL: URL?
    @State private var failed = false

    var body: some View {
        Color.systemGray6
            .quickLookPreview($previewURL)
            .onTapGesture { if opensFullSize, let fileURL { previewURL = fileURL } }
            .accessibilityAddTraits(opensFullSize ? .isButton : [])
            .accessibilityHint(opensFullSize ? "Shows the picture full size" : "")
            .overlay {
                if let image {
                    Image(platformImage: image)
                        .resizable()
                        .aspectRatio(contentMode: fill ? .fill : .fit)
                } else {
                    Image(systemName: failed ? "photo.badge.exclamationmark" : "photo")
                        .foregroundStyle(.tertiary)
                }
            }
            .clipped()
            .accessibilityHidden(!opensFullSize)
            .accessibilityLabel(opensFullSize ? "Picture" : "")
            .task(id: path) {
                guard let client = app.client else { return }
                do {
                    let url = try await client.openDriveFile(path).url
                    fileURL = url
                    // Home needs a screen's worth of pixels, not the camera's.
                    #if canImport(UIKit)
                    let full = UIImage(contentsOfFile: url.path)
                    image = await full?.byPreparingThumbnail(ofSize: CGSize(width: 1200, height: 1200).fitting(full?.size)) ?? full
                    #else
                    image = PlatformImage.thumbnail(of: url, maxPixelSize: 1200)
                    #endif
                    failed = image == nil
                } catch {
                    failed = true
                }
            }
    }
}

private extension CGSize {
    /// This size, shrunk to the proportions of `other` so a thumbnail is not stretched.
    func fitting(_ other: CGSize?) -> CGSize {
        guard let other, other.width > 0, other.height > 0 else { return self }
        let scale = min(width / other.width, height / other.height, 1)
        return CGSize(width: other.width * scale, height: other.height * scale)
    }
}

private struct GaugeView: View {
    let value: Double
    let label: String?
    let caption: String?
    let size: CGFloat

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                // Inset by half the line, so the ring stays inside its frame.
                Circle().inset(by: size * 0.06).stroke(.tint.opacity(0.18), lineWidth: size * 0.12)
                Circle()
                    .inset(by: size * 0.06)
                    .trim(from: 0, to: value)
                    .stroke(.tint, style: StrokeStyle(lineWidth: size * 0.12, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                if let label {
                    Text(label)
                        .font(.system(size: size * 0.24, weight: .semibold))
                        .monospacedDigit()
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                        .padding(size * 0.18)
                }
            }
            .frame(width: size, height: size)
            if let caption { Text(caption).font(.caption).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(caption ?? label ?? "Gauge")
        .accessibilityValue(value.formatted(.percent.precision(.fractionLength(0))))
    }
}

private struct StatView: View {
    let stat: WidgetNode.Stat

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let label = stat.label {
                HStack(spacing: 5) {
                    if let icon = stat.icon, PlatformImage.hasSymbol(icon) {
                        Image(systemName: icon).foregroundStyle(.tint)
                    }
                    Text(label)
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(stat.value)
                    .font(.system(.title, weight: .semibold))
                    .monospacedDigit()
                    // New data rolls in place: a refresh changes the number, not the widget.
                    .contentTransition(.numericText())
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                if let unit = stat.unit {
                    Text(unit).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if let caption = stat.caption {
                Text(caption).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ItemRow: View {
    let item: WidgetNode.Item
    let perform: (WidgetAction) -> Void

    var body: some View {
        if let action = item.action, action != .unknown {
            Button { perform(action) } label: { content(chevron: true) }
                .buttonStyle(.plain)
        } else {
            content(chevron: false)
        }
    }

    private func content(chevron: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if let icon = item.icon, PlatformImage.hasSymbol(icon) {
                Image(systemName: icon)
                    .foregroundStyle(.tint)
                    .frame(width: 22)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).lineLimit(3)
                if let subtitle = item.subtitle {
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let value = item.value {
                Text(value).font(.subheadline).monospacedDigit().foregroundStyle(.secondary)
            }
            if chevron {
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
        .multilineTextAlignment(.leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A small line, area or bar chart of a series, without axes: the shape of it at a glance.
private struct ChartView: View {
    let kind: String
    let values: [Double]
    let labels: [String]
    let caption: String?
    let height: CGFloat

    var body: some View {
        let bars = kind == "bar"
        let heights = WidgetChart.heights(values, fromZero: bars)
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if bars {
                    GeometryReader { geo in
                        HStack(alignment: .bottom, spacing: heights.count > 24 ? 1 : 4) {
                            ForEach(Array(heights.enumerated()), id: \.offset) { _, bar in
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(.tint)
                                    .frame(height: max(2, geo.size.height * bar))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                } else {
                    ZStack {
                        if kind == "area" {
                            LineShape(heights: heights, closed: true).fill(.tint.opacity(0.18))
                        }
                        LineShape(heights: heights, closed: false)
                            .stroke(.tint, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    }
                    .padding(.vertical, 2)
                }
            }
            .frame(height: height)
            // Labels only when there is one for each value and room to read them.
            if labels.count == values.count, labels.count <= 8 {
                HStack(spacing: 4) {
                    ForEach(Array(labels.enumerated()), id: \.offset) { _, label in
                        Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).frame(maxWidth: .infinity)
                    }
                }
            }
            if let caption { Text(caption).font(.caption).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(caption ?? "Chart")
        .accessibilityValue(spoken)
    }

    /// The series in words: where it starts, where it ends, and its range.
    private var spoken: String {
        guard let first = values.first, let last = values.last, let low = values.min(), let high = values.max() else { return "" }
        let f = { (v: Double) in v.formatted(.number.precision(.fractionLength(0...1))) }
        return "From \(f(first)) to \(f(last)), between \(f(low)) and \(f(high))"
    }
}

private struct LineShape: Shape {
    let heights: [Double]
    /// Closed down to the baseline, for an area.
    let closed: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard heights.count > 1 else { return path }
        for (index, height) in heights.enumerated() {
            let point = CGPoint(x: rect.minX + rect.width * CGFloat(index) / CGFloat(heights.count - 1),
                                y: rect.maxY - rect.height * CGFloat(height))
            if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        if closed {
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.closeSubpath()
        }
        return path
    }
}

/// The row under a widget that says what a tap does, and does it.
struct WidgetActionRow: View {
    let action: WidgetAction
    let agentName: String
    let isOpening: Bool
    let perform: (WidgetAction) -> Void

    var body: some View {
        switch action {
        case .openURL(let url):
            button(url.host() ?? "Open link", symbol: "arrow.up.right.square")
        case .openChat:
            button("Open the chat", symbol: "bubble.left")
        case .ask(let prompt):
            button("Ask \(agentName): \(prompt)", symbol: "square.and.pencil")
        case .openFile(let path):
            button("Open \(path.split(separator: "/").last.map(String.init) ?? path)", symbol: WidgetNodeView.fileSymbol(path))
        case .copy:
            button("Copy", symbol: "doc.on.doc")
        case .calendar(let title, _, _, _, _):
            button("Add \(title) to Calendar", symbol: "calendar.badge.plus")
        case .reply, .unknown:
            EmptyView()
        }
    }

    private func button(_ title: String, symbol: String) -> some View {
        Button { perform(action) } label: {
            HStack {
                Label(title, systemImage: symbol)
                    .font(.subheadline)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if isOpening { ProgressView().controlSize(.small) }
            }
        }
    }
}

// MARK: Interactive parts

/// A widget's state as its parts see it: the values now, and how an input changes one (nil where
/// nothing may be changed, such as a preview).
nonisolated struct WidgetValues: Sendable {
    var state: [String: StateValue] = [:]
    var set: (@MainActor @Sendable (String, StateValue) -> Void)?
}

private struct WidgetValuesKey: EnvironmentKey {
    static let defaultValue = WidgetValues()
}

extension EnvironmentValues {
    var widgetValues: WidgetValues {
        get { self[WidgetValuesKey.self] }
        set { self[WidgetValuesKey.self] = newValue }
    }
}

/// Owns a widget's state: where it starts, what was saved, and every change the user makes, which
/// it passes on (`changed`) to be kept.
struct WidgetStateHost<Content: View>: View {
    let node: WidgetNode
    /// What was saved for this widget, laid over where it starts.
    var saved: [String: StateValue]?
    var changed: ((([String: StateValue]) -> Void))?
    @ViewBuilder let content: () -> Content
    @State private var edits: [String: StateValue] = [:]

    var body: some View {
        let state = node.initialState.merging(saved ?? [:]) { _, new in new }.merging(edits) { _, new in new }
        content()
            .environment(\.widgetValues, WidgetValues(state: state, set: { name, value in
                var next = edits
                next[name] = value
                withAnimation(.snappy(duration: 0.25)) { edits = next }
                changed?(state.merging(next) { _, new in new })
            }))
    }
}

private struct StepperPart: View {
    let input: WidgetNode.Input
    let label: String?
    let unit: String?
    @Environment(\.widgetValues) private var values

    private var current: Double { if case .number(let n) = values.state[input.bind] { n } else { input.value ?? input.min ?? 0 } }
    private var step: Double { input.step ?? 1 }

    var body: some View {
        HStack(spacing: 12) {
            if let label { Text(label) }
            Spacer(minLength: 8)
            HStack(spacing: 0) {
                button("minus", by: -step, enabled: input.min.map { current - step >= $0 - 1e-9 } ?? true)
                Text(Formula.display(.number(current)) + (unit.map { " \($0)" } ?? ""))
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: current))
                    .frame(minWidth: 56)
                button("plus", by: step, enabled: input.max.map { current + step <= $0 + 1e-9 } ?? true)
            }
            .background(.fill.tertiary, in: Capsule())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label ?? input.bind)
        .accessibilityValue(Formula.display(.number(current)) + (unit.map { " \($0)" } ?? ""))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: change(step)
            case .decrement: change(-step)
            @unknown default: break
            }
        }
    }

    private func button(_ symbol: String, by delta: Double, enabled: Bool) -> some View {
        Button { change(delta) } label: {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(enabled ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
        .disabled(!enabled || values.set == nil)
    }

    private func change(_ delta: Double) {
        var next = Formula.round(current + delta, 6)
        if let min = input.min { next = Swift.max(next, min) }
        if let max = input.max { next = Swift.min(next, max) }
        values.set?(input.bind, .number(next))
    }
}

private struct SliderPart: View {
    let input: WidgetNode.Input
    let label: String?
    let unit: String?
    @Environment(\.widgetValues) private var values

    var body: some View {
        let low = input.min ?? 0, high = input.max ?? 1
        let current = { if case .number(let n) = values.state[input.bind] { n } else { input.value ?? low } }()
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if let label { Text(label) }
                Spacer()
                Text(Formula.display(.number(current)) + (unit.map { " \($0)" } ?? ""))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: current))
            }
            Slider(value: Binding(get: { current }, set: { values.set?(input.bind, .number(Formula.round($0, 6))) }),
                   in: low...high, step: input.step ?? Swift.max((high - low) / 100, 0.01))
                .disabled(values.set == nil)
                .accessibilityLabel(label ?? input.bind)
        }
    }
}

/// Things to tick off; with times, a timeline: a line down the left with a dot per step.
private struct ChecklistPart: View {
    let bind: String
    let items: [WidgetNode.CheckItem]
    let caption: String?
    @Environment(\.widgetValues) private var values

    private var ticks: [Bool] {
        if case .list(let list) = values.state[bind], list.count == items.count { list } else { items.map { _ in false } }
    }

    var body: some View {
        let timeline = items.contains { $0.time != nil }
        let ticks = ticks
        VStack(alignment: .leading, spacing: 0) {
            if let caption {
                HStack {
                    Text(caption).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Text("\(ticks.filter { $0 }.count) of \(items.count)")
                        .font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
                .padding(.bottom, 8)
            }
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                Button { toggle(index) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: ticks[index] ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(ticks[index] ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                            .symbolEffect(.bounce, value: ticks[index])
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            if let time = item.time {
                                Text(time).font(.caption.weight(.semibold)).monospacedDigit().foregroundStyle(.tint)
                            }
                            Text(item.title)
                                .strikethrough(ticks[index] && !timeline)
                                .foregroundStyle(ticks[index] ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                            if let detail = item.detail {
                                Text(detail).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, index < items.count - 1 ? 14 : 0)
                    }
                    // A timeline's line runs from this step's dot down to the next.
                    .overlay(alignment: .topLeading) {
                        if timeline, index < items.count - 1 {
                            Rectangle()
                                .fill(ticks[index] ? AnyShapeStyle(.tint.opacity(0.5)) : AnyShapeStyle(.quaternary))
                                .frame(width: 2)
                                .frame(maxHeight: .infinity)
                                .padding(.top, 28)
                                .padding(.bottom, 2)
                                .padding(.leading, 11)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(values.set == nil)
                .accessibilityAddTraits(ticks[index] ? .isSelected : [])
                .accessibilityHint(ticks[index] ? "Marks it not done" : "Marks it done")
            }
        }
    }

    private func toggle(_ index: Int) {
        var next = ticks
        next[index].toggle()
        values.set?(bind, .list(next))
    }
}

private struct TablePart: View {
    let columns: [String]
    let rows: [[String]]
    let caption: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                        Text(column).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(columns.indices), id: \.self) { i in
                            Text(i < row.count ? row[i] : "")
                                .font(.subheadline)
                                .monospacedDigit()
                                .contentTransition(.numericText())
                        }
                    }
                }
            }
            if let caption { Text(caption).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
