import Foundation

// What the Home screen shows, worked out from the server's feed. Pure, so it is unit-tested
// without a server or a view.

/// A widget as quoted material: what it says, in plain lines, so the user can talk about it.
/// A `card` quote, which the server already accepts; the id lets Sunnie update the widget.
extension HomeWidget {
    var messageQuote: MessageQuote {
        let lines = WidgetText.lines(body)
        var text = "Home widget “\(name)” (id: \(id), updated \(updatedAt))"
        if !lines.isEmpty { text += "\n\n" + lines.joined(separator: "\n") }
        return MessageQuote(kind: "card", title: MessageQuote.cardTitle("Home · \(name)"),
                            text: WidgetText.clipped(text, to: MessageQuote.maxCharacters))
    }
}

nonisolated enum WidgetText {
    /// The words and numbers of a widget, a line each, as it shows them with `state` (where it
    /// starts, when not given); decoration and buttons are left out.
    static func lines(_ node: WidgetNode, state: [String: StateValue]? = nil) -> [String] {
        let state = state ?? node.initialState
        if let when = node.when, !Formula.holds(when, state) { return [] }
        return parts(node, state).map { Formula.interpolate($0, state) }
    }

    private static func parts(_ node: WidgetNode, _ state: [String: StateValue]) -> [String] {
        switch node.kind {
        case .text(let label): return [label.text]
        case .markdown(let text): return [text]
        case .stat(let stat):
            let value = [stat.value, stat.unit].compactMap { $0 }.joined(separator: " ")
            return [[stat.label.map { "\($0): \(value)" } ?? value, stat.caption].compactMap { $0 }.joined(separator: " — ")]
        case .fields(let fields): return fields.map { "\($0.label): \($0.value)" }
        case .list(let items):
            return items.map { item in
                "- " + [item.title, item.subtitle, item.value].compactMap { $0 }.joined(separator: " — ")
            }
        case let .progress(fixed, label, caption):
            let share = percent(node.amount.map { Formula.amount($0, state) } ?? fixed)
            return [[label.map { "\($0): \(share)" } ?? share, caption].compactMap { $0 }.joined(separator: " — ")]
        case let .gauge(fixed, label, caption, _):
            // A gauge's label sits in its middle, and is often the share itself.
            let share = percent(node.amount.map { Formula.amount($0, state) } ?? fixed)
            let text = label.map { $0 == share ? share : "\($0) (\(share))" } ?? share
            return [[text, caption].compactMap { $0 }.joined(separator: " — ")]
        case let .chart(kind, values, labels, caption):
            let points = values.enumerated().map { index, value in
                index < labels.count ? "\(labels[index]) \(number(value))" : number(value)
            }
            return ["Chart (\(kind)): " + points.joined(separator: ", ")] + (caption.map { [$0] } ?? [])
        case .badge(let text, _): return [text]
        case .image(let path, _): return ["Picture: \(path)"]
        case let .file(path, title, caption):
            return ["File: " + [title, path, caption].compactMap { $0 }.joined(separator: " — ")]
        case let .countdown(to, label, _):
            let when = to.formatted(.iso8601)
            return [label.map { "\($0): \(when)" } ?? "Until \(when)"]
        case .row(let children, _), .stack(let children), .layer(let children, _), .grid(let children, _):
            return children.flatMap { lines($0, state: state) }
        case .stepper(let input), .slider(let input):
            let value = state[input.bind].map(Self.describe) ?? ""
            return [[input.label.map { "\($0): \(value)" } ?? value, input.unit].compactMap { $0 }.joined(separator: " ")]
        case let .toggle(bind, _, label):
            return ["\(label): \(state[bind] == .bool(true) ? "on" : "off")"]
        case let .segmented(bind, options, _):
            let chosen = state[bind].map(Self.describe)
            return ["Showing: " + (options.first { $0.value == chosen }?.label ?? chosen ?? "")]
        case let .checklist(bind, items, caption):
            let ticks: [Bool] = { if case .list(let l) = state[bind] { l } else { [] } }()
            return (caption.map { [$0] } ?? []) + items.enumerated().map { i, item in
                (i < ticks.count && ticks[i] ? "[x] " : "[ ] ") + [item.time, item.title, item.detail].compactMap { $0 }.joined(separator: " — ")
            }
        case let .table(columns, rows, caption):
            return [columns.joined(separator: " | ")] + rows.map { $0.joined(separator: " | ") } + (caption.map { [$0] } ?? [])
        case .icon, .button, .divider, .spacer, .unknown: return []
        }
    }

    static func percent(_ share: Double) -> String { "\(Int((share * 100).rounded()))%" }

    private static func describe(_ value: StateValue) -> String {
        switch value {
        case .number(let n): return Formula.display(.number(n))
        case .text(let s): return s
        case .bool(let b): return b ? "on" : "off"
        case .list(let l): return "\(l.filter { $0 }.count) of \(l.count)"
        }
    }

    static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    /// At most `limit` UTF-16 units, as the server counts, ending in an ellipsis when cut.
    static func clipped(_ text: String, to limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var result = ""
        var count = 0
        for character in text {
            count += character.utf16.count
            guard count <= limit - 1 else { break }
            result.append(character)
        }
        return result + "…"
    }
}

/// A chart widget's numbers, made ready to draw.
nonisolated enum WidgetChart {
    /// Each value as a share of the height, 0 at the smallest and 1 at the largest. Bars start
    /// from zero when no value is negative, so their heights compare honestly; a flat series
    /// sits in the middle.
    static func heights(_ values: [Double], fromZero: Bool) -> [Double] {
        let finite = values.filter(\.isFinite)
        guard let low = finite.min(), let high = finite.max() else { return [] }
        let floor = fromZero && low >= 0 ? 0 : low
        guard high > floor else { return values.map { _ in 0.5 } }
        return values.map { $0.isFinite ? ($0 - floor) / (high - floor) : 0 }
    }
}

/// A widget colour that is not one of the system's names: hex, as the server accepts it.
nonisolated struct WidgetRGBA: Hashable, Sendable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double

    /// "#RGB", "#RRGGBB" or "#RRGGBBAA"; anything else is nil.
    init?(hex: String) {
        guard hex.hasPrefix("#") else { return nil }
        var digits = Array(hex.dropFirst())
        if digits.count == 3 { digits = digits.flatMap { [$0, $0] } }
        guard digits.count == 6 || digits.count == 8, let value = UInt64(String(digits), radix: 16) else { return nil }
        let rgba = digits.count == 6 ? (value << 8) | 0xFF : value
        red = Double((rgba >> 24) & 0xFF) / 255
        green = Double((rgba >> 16) & 0xFF) / 255
        blue = Double((rgba >> 8) & 0xFF) / 255
        alpha = Double(rgba & 0xFF) / 255
    }

    /// Whether black text reads better than white on this colour (components 0 to 1). Leans to
    /// white, as iOS does on its own coloured buttons: only light fills such as white, yellow
    /// or a pale tint take black.
    static func prefersDarkText(red: Double, green: Double, blue: Double) -> Bool {
        func linear(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue) > 0.5
    }
}

/// Home's grid: four columns across, filled left to right in order. Pure, so it is unit-tested.
nonisolated enum HomeGrid {
    static let columns = HomeWidget.homeColumns
    static let spacing: Double = 12

    /// Lines of the grid: each item spans `span(item)` columns (clamped to 1–4), and one that does
    /// not fit what is left of a line starts the next. Items keep their order.
    static func lines<T>(_ items: [T], span: (T) -> Int) -> [[T]] {
        var lines: [[T]] = []
        var used = columns
        for item in items {
            let width = min(max(span(item), 1), columns)
            if used + width > columns {
                lines.append([item])
                used = width
            } else {
                lines[lines.count - 1].append(item)
                used += width
            }
        }
        return lines
    }

    /// The width of a column in `total` points.
    static func columnWidth(in total: Double) -> Double {
        max(0, (total - spacing * Double(columns - 1)) / Double(columns))
    }

    /// The width of something `span` columns wide, the gaps it covers included.
    static func width(span: Int, in total: Double) -> Double {
        let span = Double(min(max(span, 1), columns))
        return columnWidth(in: total) * span + spacing * (span - 1)
    }

    /// At the largest text sizes a small widget cannot hold its words: there, one or two columns
    /// become half the width and three become the full width.
    static func span(_ span: Int, accessibility: Bool) -> Int {
        guard accessibility else { return span }
        return span <= 2 ? 2 : columns
    }

    /// `ids` with `moving` put where `target` is: after it when it came from above, else before.
    static func move(_ moving: String, onto target: String, in ids: [String]) -> [String] {
        guard moving != target, let from = ids.firstIndex(of: moving), let to = ids.firstIndex(of: target) else { return ids }
        var result = ids
        result.remove(at: from)
        result.insert(moving, at: to)
        return result
    }
}

nonisolated enum HomeGreeting {
    static func text(at date: Date = .now, calendar: Calendar = .current) -> String {
        switch calendar.component(.hour, from: date) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Hello"
        }
    }
}
