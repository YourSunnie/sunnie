import Foundation

// What an assistant message is made of, once read: ordinary Markdown blocks, plus the fenced
// blocks the server's prompt teaches the agent to write for cards (`event`, `schedule`, `card`,
// `drive`, and `widget`: a Home widget body as JSON, drawn in the reply). Pure and nonisolated,
// so it is unit-tested and can run while text is still streaming: an unfinished block is read
// as far as it goes.

nonisolated enum MarkdownBlock: Hashable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list([MarkdownListItem])
    case quote(String)
    case code(language: String?, text: String)
    case table(header: [String], rows: [[String]])
    case rule
    /// A line that holds nothing but a link.
    case link(title: String, url: URL)
    case event(EventCard)
    case schedule(ScheduleCard)
    case card(InfoCard)
    case drive(DriveCard)
    /// A card the agent designed: the parts of a Home widget.
    case widget(WidgetNode)
    /// A `widget` block still being written: its JSON cannot be read until it is whole.
    case pendingCard
    /// Quick replies: answers the user can send with a tap. Not drawn in the message itself; the
    /// chat offers them under the last message (`Markdown.quickReplies`).
    case choices([String])
}

nonisolated struct DriveCard: Hashable, Sendable {
    var title: String
    var path: String
}

nonisolated struct MarkdownListItem: Hashable, Sendable {
    nonisolated enum Marker: Hashable, Sendable {
        case bullet
        case number(String)
        case todo(done: Bool)
    }

    var level: Int
    var marker: Marker
    var text: String
}

/// Something that happens at a set time.
nonisolated struct EventCard: Hashable, Sendable {
    var title: String
    var start: String?
    var end: String?
    var place: String?
    var note: String?

    var startTime: LocalTime? { start.flatMap { LocalTime($0) } }
    var endTime: LocalTime? { end.flatMap { LocalTime($0) } }
}

/// A day plan: entries in the order given, each with the time as the agent wrote it.
nonisolated struct ScheduleCard: Hashable, Sendable {
    nonisolated struct Entry: Hashable, Sendable {
        var time: String
        var what: String
        var detail: String?
    }

    var title: String?
    var entries: [Entry]
}

/// Something to pick or open: a title, a few labelled facts, perhaps a link.
nonisolated struct InfoCard: Hashable, Sendable {
    nonisolated struct Field: Hashable, Sendable {
        var label: String
        var value: String
    }

    var title: String
    var subtitle: String?
    var link: URL?
    var fields: [Field]

    var opensWhatsApp: Bool {
        link?.scheme?.lowercased() == "https" && link?.host()?.lowercased() == "wa.me"
    }
}

/// "YYYY-MM-DD HH:MM" (or just the date) as the agent writes it: wall-clock time where the user is.
nonisolated struct LocalTime: Hashable, Sendable {
    var date: Date
    var hasTime: Bool

    init?(_ text: String, calendar: Calendar = .current) {
        guard let m = text.firstMatch(of: /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/) else { return nil }
        var parts = DateComponents()
        parts.year = Int(m.1)
        parts.month = Int(m.2)
        parts.day = Int(m.3)
        parts.hour = m.4.flatMap { Int($0) } ?? 0
        parts.minute = m.5.flatMap { Int($0) } ?? 0
        guard let date = calendar.date(from: parts),
              calendar.component(.day, from: date) == parts.day,
              calendar.component(.month, from: date) == parts.month else { return nil }
        self.date = date
        hasTime = m.4 != nil
    }
}

nonisolated enum Markdown {
    /// `streaming` says the text is still arriving, so a block left open at its end is unfinished
    /// rather than wrong.
    static func parse(_ text: String, streaming: Bool = false) -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        var paragraph: [String] = []
        var items: [MarkdownListItem] = []
        var indents: [Int] = []
        /// Whether the line before was part of the list, so an indented line continues its item.
        var inItem = false

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            let joined = paragraph.joined(separator: "\n")
            paragraph = []
            if let link = loneLink(joined) { out.append(.link(title: link.title, url: link.url)) }
            else { out.append(.paragraph(joined)) }
        }
        func flushList() {
            guard !items.isEmpty else { return }
            out.append(.list(items))
            items = []
            indents = []
        }
        func flush() {
            flushParagraph()
            flushList()
        }

        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            i += 1

            if trimmed.hasPrefix("```") {
                flush()
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces).lowercased()
                var body: [String] = []
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    body.append(lines[i])
                    i += 1
                }
                let closed = i < lines.count
                i += 1
                out.append(fenced(language: language, body: body, unfinished: streaming && !closed))
                inItem = false
                continue
            }
            if trimmed.isEmpty {
                // A blank line ends a paragraph but not a list: its next item may follow.
                flushParagraph()
                inItem = false
                continue
            }
            if let item = listItem(line, indents: &indents) {
                flushParagraph()
                items.append(item)
                inItem = true
                continue
            }
            if inItem, line.first == " " || line.first == "\t" {
                items[items.count - 1].text += " " + trimmed
                continue
            }
            inItem = false

            if let m = trimmed.firstMatch(of: /^(#{1,6})\s+(.*?)\s*#*$/) {
                flush()
                out.append(.heading(level: m.1.count, text: String(m.2)))
            } else if trimmed.wholeMatch(of: /(-\s*){3,}|(\*\s*){3,}|(_\s*){3,}/) != nil {
                flush()
                out.append(.rule)
            } else if trimmed.hasPrefix(">") {
                flush()
                var quoted = [unquote(trimmed)]
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quoted.append(unquote(lines[i].trimmingCharacters(in: .whitespaces)))
                    i += 1
                }
                out.append(.quote(quoted.joined(separator: "\n")))
            } else if trimmed.contains("|"), i < lines.count, isTableRule(lines[i]) {
                flush()
                let header = cells(trimmed)
                i += 1
                var rows: [[String]] = []
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    var row = cells(lines[i])
                    // Every row is as wide as the header, so the grid stays a grid.
                    row = Array(row.prefix(header.count)) + Array(repeating: "", count: max(0, header.count - row.count))
                    rows.append(row)
                    i += 1
                }
                out.append(.table(header: header, rows: rows))
            } else {
                flushList()
                paragraph.append(trimmed)
            }
        }
        flush()
        return out
    }

    // MARK: Blocks

    private static func unquote(_ line: String) -> String {
        var rest = line.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    private static func listItem(_ line: String, indents: inout [Int]) -> MarkdownListItem? {
        guard let m = line.firstMatch(of: /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.+)$/) else { return nil }
        let width = m.1.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        while let last = indents.last, last > width { indents.removeLast() }
        if indents.last.map({ $0 < width }) ?? true { indents.append(width) }
        let level = min(indents.count - 1, 4)

        var text = String(m.3)
        var marker: MarkdownListItem.Marker = m.2.first!.isNumber ? .number(String(m.2.dropLast())) : .bullet
        if let box = text.firstMatch(of: /^\[([ xX])\]\s+/) {
            marker = .todo(done: box.1 != " ")
            text = String(text[box.range.upperBound...])
        }
        return MarkdownListItem(level: level, marker: marker, text: text)
    }

    private static func isTableRule(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.contains("-") && t.contains("|") && t.wholeMatch(of: /\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?/) != nil
    }

    private static func cells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\\|", with: "\u{1}")
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map {
            $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\u{1}", with: "|")
        }
    }

    /// A paragraph that is one link and nothing else: `[title](url)`, `<url>` or the bare URL.
    static func loneLink(_ text: String) -> (title: String, url: URL)? {
        let t = text.trimmingCharacters(in: .whitespaces)
        if let m = t.wholeMatch(of: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/), let url = URL(string: String(m.2)) {
            return (String(m.1), url)
        }
        if let m = t.wholeMatch(of: /<?(https?:\/\/[^\s<>]+)>?/), let url = URL(string: String(m.1)) {
            return (url.host() ?? String(m.1), url)
        }
        return nil
    }

    // MARK: Cards

    private static func fenced(language: String, body: [String], unfinished: Bool = false) -> MarkdownBlock {
        let code = MarkdownBlock.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n"))
        switch language {
        case "event": return event(body).map(MarkdownBlock.event) ?? code
        case "schedule": return schedule(body).map(MarkdownBlock.schedule) ?? code
        case "card": return info(body).map(MarkdownBlock.card) ?? code
        case "drive":
            let f = fields(body)
            guard let title = value(f, "title"), let path = value(f, "path"), DrivePath.isValid(path) else { return code }
            return .drive(DriveCard(title: title, path: path))
        case "widget":
            let json = body.joined(separator: "\n")
            if let node = widget(json) { return .widget(node) }
            // Still arriving: draw what has come so far, its open brackets closed.
            if unfinished, let node = PartialJSON.complete(json).flatMap(widget), hasContent(node) { return .widget(node) }
            return unfinished ? .pendingCard : code
        case "choices":
            let answers = choices(body)
            return answers.isEmpty ? code : .choices(answers)
        default: return code
        }
    }

    /// "key: value" lines, in order. A line that is not one is added to the value before it.
    static func fields(_ lines: [String]) -> [InfoCard.Field] {
        var out: [InfoCard.Field] = []
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty else { continue }
            if let m = t.firstMatch(of: /^([A-Za-z][A-Za-z _-]{0,23}):\s*(.*)$/) {
                out.append(.init(label: String(m.1).trimmingCharacters(in: .whitespaces), value: String(m.2)))
            } else if !out.isEmpty {
                out[out.count - 1].value += (out[out.count - 1].value.isEmpty ? "" : " ") + t
            }
        }
        return out
    }

    private static func value(_ fields: [InfoCard.Field], _ names: String...) -> String? {
        fields.first { names.contains($0.label.lowercased()) && !$0.value.isEmpty }?.value
    }

    /// One answer per line, as the user would say it. A model may still write them as a list.
    static func choices(_ lines: [String]) -> [String] {
        var out: [String] = []
        for line in lines {
            var answer = line.trimmingCharacters(in: .whitespaces)
            if let marker = answer.firstMatch(of: /^(?:[-*+•]|\d{1,2}[.)])\s+/) { answer = String(answer[marker.range.upperBound...]) }
            answer = answer.trimmingCharacters(in: .whitespaces)
            guard !answer.isEmpty, answer.count <= 80, !out.contains(answer) else { continue }
            out.append(answer)
        }
        return Array(out.prefix(6))
    }

    /// The quick replies a finished message ends with, if any: its last `choices` block.
    static func quickReplies(_ text: String) -> [String] {
        for block in parse(text).reversed() { if case .choices(let answers) = block { return answers } }
        return []
    }

    /// A widget body the app can draw something of. The brief's headline and weather are Home's.
    /// Something to draw: a part that is not empty layout or unknown.
    private static func hasContent(_ node: WidgetNode) -> Bool {
        switch node.kind {
        case .unknown, .spacer, .divider: return false
        case .row, .stack, .layer, .grid: return node.children.contains(where: hasContent)
        default: return true
        }
    }

    static func widget(_ json: String) -> WidgetNode? {
        guard let node = try? JSONDecoder().decode(WidgetNode.self, from: Data(json.utf8)), node.drawsSomething else { return nil }
        return node
    }

    static func event(_ lines: [String]) -> EventCard? {
        let f = fields(lines)
        guard let title = value(f, "title", "name") else { return nil }
        return EventCard(
            title: title,
            start: value(f, "start", "when", "date", "time"),
            end: value(f, "end", "until"),
            place: value(f, "place", "where", "location"),
            note: value(f, "note", "notes")
        )
    }

    static func schedule(_ lines: [String]) -> ScheduleCard? {
        var title: String?
        var entries: [ScheduleCard.Entry] = []
        for line in lines {
            var t = line.trimmingCharacters(in: .whitespaces)
            if let bullet = t.firstMatch(of: /^[-*]\s+/) { t = String(t[bullet.range.upperBound...]) }
            guard !t.isEmpty else { continue }
            if t.contains("|") {
                let parts = cells(t)
                guard parts.count >= 2, !parts[1].isEmpty else { continue }
                let detail = parts.dropFirst(2).filter { !$0.isEmpty }.joined(separator: " · ")
                entries.append(.init(time: parts[0], what: parts[1], detail: detail.isEmpty ? nil : detail))
            } else if let m = t.firstMatch(of: /^(\d{1,2}[:.]\d{2}(?:\s?[AaPp][Mm])?)\s+(.+)$/) {
                entries.append(.init(time: String(m.1), what: String(m.2), detail: nil))
            } else if let m = t.firstMatch(of: /^(?i:title|name|day|date):\s*(.+)$/), title == nil {
                title = String(m.1)
            }
        }
        return entries.isEmpty ? nil : ScheduleCard(title: title, entries: entries)
    }

    static func info(_ lines: [String]) -> InfoCard? {
        let f = fields(lines)
        guard let title = value(f, "title", "name") else { return nil }
        let reserved: Set<String> = ["title", "name", "subtitle", "link", "url"]
        return InfoCard(
            title: title,
            subtitle: value(f, "subtitle"),
            link: value(f, "link", "url").flatMap { URL(string: $0) }.flatMap { $0.scheme?.hasPrefix("http") == true ? $0 : nil },
            fields: f.filter { !reserved.contains($0.label.lowercased()) && !$0.value.isEmpty }
                .map { .init(label: $0.label.replacingOccurrences(of: "_", with: " ").capitalized, value: $0.value) }
        )
    }

    // MARK: Inline

    nonisolated(unsafe) private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Bold, italics, code and links; a URL written out bare becomes a link too.
    static func inline(_ source: String) -> AttributedString {
        var text = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(source)
        let plain = String(text.characters)
        guard plain.contains("://") || plain.contains("www."), let detector = linkDetector else { return text }
        for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            guard let url = match.url, url.scheme?.hasPrefix("http") == true,
                  let range = Range(match.range, in: text),
                  text[range].runs.allSatisfy({ $0.link == nil }) else { continue }
            text[range].link = url
        }
        return text
    }
}

extension WidgetNode {
    /// Whether anything of this part would show in a reply: an unknown type, or a box holding
    /// only such parts, would be an empty card.
    nonisolated var drawsSomething: Bool {
        switch kind {
        case .unknown, .spacer, .divider: return false
        case .row(let children, _), .stack(let children), .layer(let children, _), .grid(let children, _):
            return children.contains(where: \.drawsSomething)
        default: return true
        }
    }
}

extension EventCard {
    /// The event as an iCalendar file, in floating local time: it means the same clock time
    /// wherever it is opened, which is how the agent wrote it.
    func ics(uid: String, now: Date = .now, calendar: Calendar = .current) -> String? {
        guard let start = startTime else { return nil }
        func stamp(_ date: Date, time: Bool) -> String {
            let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            let day = String(format: "%04d%02d%02d", c.year!, c.month!, c.day!)
            return time ? day + String(format: "T%02d%02d00", c.hour!, c.minute!) : day
        }
        func escaped(_ s: String) -> String {
            s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: ";", with: "\\;")
                .replacingOccurrences(of: ",", with: "\\,").replacingOccurrences(of: "\n", with: "\\n")
        }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let n = utc.dateComponents([.year, .month, .day, .hour, .minute, .second], from: now)
        let dtstamp = String(format: "%04d%02d%02dT%02d%02d%02dZ", n.year!, n.month!, n.day!, n.hour!, n.minute!, n.second!)

        var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sunnie//EN", "BEGIN:VEVENT", "UID:\(uid)", "DTSTAMP:\(dtstamp)"]
        if start.hasTime {
            let end = endTime.flatMap { $0.date > start.date ? $0.date : nil } ?? start.date.addingTimeInterval(3600)
            lines += ["DTSTART:\(stamp(start.date, time: true))", "DTEND:\(stamp(end, time: true))"]
        } else {
            let last = endTime.flatMap { $0.date > start.date ? $0.date : nil } ?? start.date
            let dayAfter = calendar.date(byAdding: .day, value: 1, to: last) ?? last
            lines += ["DTSTART;VALUE=DATE:\(stamp(start.date, time: false))", "DTEND;VALUE=DATE:\(stamp(dayAfter, time: false))"]
        }
        lines.append("SUMMARY:\(escaped(title))")
        if let place { lines.append("LOCATION:\(escaped(place))") }
        if let note { lines.append("DESCRIPTION:\(escaped(note))") }
        lines += ["END:VEVENT", "END:VCALENDAR"]
        return lines.joined(separator: "\r\n") + "\r\n"
    }
}

/// JSON cut off mid-way, as a reply streams in, made whole: the half-written value at its end is
/// dropped and every open string, array and object closed, so what has arrived can be drawn.
nonisolated enum PartialJSON {
    static func complete(_ text: String) -> String? {
        var stack: [Character] = []
        var inString = false
        var escaped = false
        /// The last `{ [ , :` seen: whether what comes next is a key or a value.
        var last: Character?
        /// Where the text can be cut and still be whole once closed: right after a finished value.
        var safe: String.Index?
        var stackAtSafe: [Character] = []
        var valueStart = true
        func isValueNow() -> Bool { last == ":" || (stack.last == "]" && (last == "[" || last == ",")) }
        func markSafe(_ at: String.Index) { safe = at; stackAtSafe = stack }
        var index = text.startIndex
        while index < text.endIndex {
            let ch = text[index]
            let next = text.index(after: index)
            if inString {
                if escaped { escaped = false }
                else if ch == "\\" { escaped = true }
                else if ch == "\"" {
                    inString = false
                    if valueStart { markSafe(next) }
                }
            } else {
                switch ch {
                case "\"":
                    inString = true
                    valueStart = isValueNow()
                case "{", "[":
                    stack.append(ch == "{" ? "}" : "]")
                    last = ch
                case "}", "]":
                    guard !stack.isEmpty else { return nil }
                    stack.removeLast()
                    markSafe(next)
                    last = nil
                case ",", ":":
                    last = ch
                default:
                    // The end of a number, true, false or null.
                    if !ch.isWhitespace, isValueNow(), next < text.endIndex, ",}] \n\t\r".contains(text[next]) { markSafe(next) }
                }
            }
            index = next
        }
        if stack.isEmpty && !inString { return text }
        guard let safe else { return nil }
        return text[..<safe].trimmingCharacters(in: .whitespacesAndNewlines) + String(stackAtSafe.reversed())
    }
}
