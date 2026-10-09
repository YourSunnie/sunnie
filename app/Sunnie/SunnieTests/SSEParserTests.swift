import Testing
@testable import Sunnie

struct SSEParserTests {
    @Test func parsesEventsWithIdNameAndData() {
        var parser = SSEParser()
        let events = parser.feed(Array("id: 1\nevent: run.started\ndata: {\"a\":1}\n\nid: 2\nevent: text.delta\ndata: {\"b\":2}\n\n".utf8))
        #expect(events == [
            SSEEvent(event: "run.started", data: "{\"a\":1}", id: "1"),
            SSEEvent(event: "text.delta", data: "{\"b\":2}", id: "2"),
        ])
    }

    @Test func handlesChunkBoundariesAnywhere() {
        var parser = SSEParser()
        let text = "event: message\ndata: {\"x\":\"héllo\"}\n\n"
        let bytes = Array(text.utf8)
        var events: [SSEEvent] = []
        for byte in bytes { events += parser.feed([byte]) }
        #expect(events == [SSEEvent(event: "message", data: "{\"x\":\"héllo\"}", id: nil)])
    }

    @Test func dropsPingCommentsAndJoinsMultiLineData() {
        var parser = SSEParser()
        let events = parser.feed(Array(": ping\n\ndata: line one\ndata: line two\n\n: ping\n".utf8))
        #expect(events == [SSEEvent(event: nil, data: "line one\nline two", id: nil)])
        #expect(parser.flush() == nil)
    }

    @Test func toleratesCRLFAndMissingTrailingBlankLine() {
        var parser = SSEParser()
        var events = parser.feed(Array("event: run.completed\r\ndata: {}\r\n".utf8))
        #expect(events.isEmpty)
        if let last = parser.flush() { events.append(last) }
        #expect(events == [SSEEvent(event: "run.completed", data: "{}", id: nil)])
    }
}
