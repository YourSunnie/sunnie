import Foundation

/// One server-sent event: the `event:` name, the joined `data:` lines and the `id:` if any.
nonisolated struct SSEEvent: Equatable, Sendable {
    var event: String?
    var data: String
    var id: String?
}

/// Incremental parser for `text/event-stream` bodies, fed raw bytes as they arrive.
/// Comment lines (the server's `: ping`) are dropped; blank lines dispatch an event.
nonisolated struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var event: String?
    private var data: [String] = []
    private var id: String?

    mutating func feed(_ bytes: some Sequence<UInt8>) -> [SSEEvent] {
        var out: [SSEEvent] = []
        for byte in bytes {
            if byte == UInt8(ascii: "\n") {
                if let e = endLine() { out.append(e) }
            } else if byte != UInt8(ascii: "\r") {
                line.append(byte)
            }
        }
        return out
    }

    /// Dispatches a trailing event that was not terminated by a blank line.
    mutating func flush() -> SSEEvent? {
        var out = endLine()
        if out == nil, !data.isEmpty { out = dispatch() }
        return out
    }

    private mutating func endLine() -> SSEEvent? {
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty { return data.isEmpty && event == nil ? nil : dispatch() }
        let text = String(decoding: line, as: UTF8.self)
        if text.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        case "id": id = String(value)
        default: break
        }
        return nil
    }

    private mutating func dispatch() -> SSEEvent {
        let e = SSEEvent(event: event, data: data.joined(separator: "\n"), id: id)
        event = nil
        data = []
        return e
    }
}
