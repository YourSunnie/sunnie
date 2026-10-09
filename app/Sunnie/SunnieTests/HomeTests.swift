import Foundation
import Testing
@testable import Sunnie

struct HomeTests {
    private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func message(_ id: String, seq: Int, run: String, role: Message.Role, text: String = "", origin: String? = nil) -> Message {
        Message(id: id, conversationId: "conv_h", seq: seq, role: role, text: text, origin: origin,
                parts: text.isEmpty ? [] : [.text(text)], model: nil, runId: run, createdAt: "2026-10-04T00:00:00.000Z")
    }

    @Test func aWidgetIsReadWithItsPartsAndWhatATapDoes() throws {
        let widget: HomeWidget = try decode(#"""
        {"id":"steps","title":"Steps","source":"api","hidden":false,"expiresAt":null,"createdAt":"2026-10-04T00:00:00.000Z","updatedAt":"2026-10-04T00:02:00.000Z",
         "action":{"type":"ask","prompt":"How was my week?"},
         "body":{"type":"stack","children":[
           {"type":"row","children":[{"type":"stat","value":"8,412","label":"Today","unit":"steps"},{"type":"progress","value":1.4,"label":"Goal"}]},
           {"type":"chart","kind":"bar","values":[3,5,8],"labels":["M","T","W"]},
           {"type":"list","items":[{"title":"Run","value":"5 km","action":{"type":"open_url","url":"https://example.com/run"}},{"title":"Bad","action":{"type":"open_url","url":"tel:123"}}]},
           {"type":"hologram","depth":3},
           {"type":"stat"}]}}
        """#)
        #expect(widget.action == .ask("How was my week?"))
        #expect(widget.name == "Steps" && widget.updatedDate != nil)
        guard case .stack(let parts) = widget.body.kind else { Issue.record("not a stack"); return }
        guard case .row(let cells, _) = parts[0].kind else { Issue.record("not a row"); return }
        #expect(cells[0].kind == .stat(.init(value: "8,412", label: "Today", unit: "steps", caption: nil, icon: nil)))
        #expect(cells[1].kind == .progress(value: 1, label: "Goal", caption: nil))
        #expect(parts[1].kind == .chart(kind: "bar", values: [3, 5, 8], labels: ["M", "T", "W"], caption: nil))
        guard case .list(let items) = parts[2].kind else { Issue.record("not a list"); return }
        #expect(items[0].action == .openURL(URL(string: "https://example.com/run")!))
        #expect(items[1].action == .unknown, "only https links open")
        #expect(parts[3].kind == .unknown("hologram"), "a part from a newer server is skipped, not an error")
        #expect(parts[4].kind == .unknown("stat"), "so is one that lacks what it needs")
    }

    @Test func aWidgetCarriesItsStyleLayoutAndDriveFiles() throws {
        let body: WidgetNode = try decode(#"""
        {"type":"stack","gradient":["#0B3D91","#1F6FEB"],"direction":"diagonal","color":"white","padding":16,"spacing":12,"children":[
          {"type":"text","text":"CGK","size":40,"weight":"heavy","design":"rounded","align":"trailing","tone":"accent"},
          {"type":"grid","columns":9,"children":[{"type":"gauge","value":0.4,"label":"40%","size":64},{"type":"badge","text":"On time","background":"green"}]},
          {"type":"layer","anchor":"bottomLeading","corner":12,"height":80,"action":{"type":"open_file","path":"Trips/ticket.pdf"},"children":[
            {"type":"image","path":"Trips/map.png"},{"type":"image","path":"../secret.png"}]},
          {"type":"countdown","to":"2026-10-12T00:15:00.000Z","label":"until boarding"},
          {"type":"file","path":"Trips/ticket.pdf","title":"Travel ticket"},
          {"type":"spacer"}]}
        """#)
        #expect(body.style.hasFill && body.style.gradient.count == 2 && body.style.color == "white")
        #expect(body.style.padding == 16 && body.spacing == 12)
        guard case .stack(let parts) = body.kind else { Issue.record("not a stack"); return }
        #expect(parts[0].kind == .text(.init(text: "CGK", style: nil, size: 40, weight: "heavy", design: "rounded", lines: nil)))
        #expect(parts[0].style.align == "trailing" && parts[0].style.color == "accent", "the old tone is a colour")
        guard case .grid(let tiles, let columns) = parts[1].kind else { Issue.record("not a grid"); return }
        #expect(columns == 4, "columns stay within what fits a phone")
        #expect(tiles[0].kind == .gauge(value: 0.4, label: "40%", caption: nil, size: 64))
        #expect(tiles[1].kind == .badge(text: "On time", icon: nil) && tiles[1].style.background == "green")
        guard case .layer(let layers, let anchor) = parts[2].kind else { Issue.record("not a layer"); return }
        #expect(anchor == "bottomLeading" && parts[2].action == .openFile("Trips/ticket.pdf") && parts[2].style.height == 80)
        #expect(layers[0].kind == .image(path: "Trips/map.png", fill: true))
        #expect(layers[1].kind == .unknown("image"), "a path that leaves Drive is not drawn")
        guard case .countdown(let to, let label, _) = parts[3].kind else { Issue.record("not a countdown"); return }
        #expect(to == ISO8601.parse("2026-10-12T00:15:00.000Z") && label == "until boarding")
        #expect(parts[4].kind == .file(path: "Trips/ticket.pdf", title: "Travel ticket", caption: nil))
        #expect(parts[5].kind == .spacer)
    }

    @Test func aWidgetCanHaveButtonsAndAPictureBehindIt() throws {
        let body: WidgetNode = try decode(#"""
        {"type":"stack","backgroundImage":"Uploads/att_1/rome.jpg","gradient":["#00000000","#000000B3"],"color":"white","children":[
          {"type":"button","text":"Open ticket","icon":"ticket","action":{"type":"open_file","path":"Trips/ticket.pdf"}},
          {"type":"button","text":"Hotel","variant":"tinted","action":{"type":"open_url","url":"https://example.com/hotel"}},
          {"type":"button","text":"Nothing to do"},
          {"type":"button","text":"Call","action":{"type":"open_url","url":"tel:123"}},
          {"type":"stack","backgroundImage":"../outside.jpg","children":[{"type":"divider"}]}]}
        """#)
        #expect(body.style.backgroundImage == "Uploads/att_1/rome.jpg" && body.style.hasFill)
        guard case .stack(let parts) = body.kind else { Issue.record("not a stack"); return }
        #expect(parts[0].kind == .button(text: "Open ticket", icon: "ticket", variant: nil) && parts[0].action == .openFile("Trips/ticket.pdf"))
        #expect(parts[1].kind == .button(text: "Hotel", icon: nil, variant: "tinted"))
        #expect(parts[2].kind == .unknown("button"), "a button that does nothing is not drawn")
        #expect(parts[3].kind == .unknown("button"), "nor one whose only action is not allowed")
        #expect(parts[4].style.backgroundImage == nil && !parts[4].style.hasFill, "a picture outside Drive is not drawn")
    }

    @Test func buttonTextIsWhiteExceptOnLightFills() {
        #expect(!WidgetRGBA.prefersDarkText(red: 0.2, green: 0.55, blue: 0.25), "leaf green")
        #expect(!WidgetRGBA.prefersDarkText(red: 0, green: 0.48, blue: 1), "blue")
        #expect(WidgetRGBA.prefersDarkText(red: 1, green: 1, blue: 1), "white")
        #expect(WidgetRGBA.prefersDarkText(red: 1, green: 0.8, blue: 0), "yellow")
    }

    @Test func hexColoursAreRead() {
        #expect(WidgetRGBA(hex: "#ff0000") == WidgetRGBA(hex: "#f00"))
        let c = WidgetRGBA(hex: "#0b3d9180")
        #expect(c?.red == 11.0 / 255 && c?.blue == 145.0 / 255 && c?.alpha == 128.0 / 255)
        #expect(WidgetRGBA(hex: "#ff0000")?.alpha == 1)
        #expect(WidgetRGBA(hex: "red") == nil && WidgetRGBA(hex: "#12") == nil && WidgetRGBA(hex: "#gggggg") == nil)
    }

    @Test func retiredTypesAreSkipped() throws {
        let widgets: [HomeWidget] = try decode(#"""
        [{"id":"headline","title":"","source":"agent","hidden":false,"expiresAt":"2026-10-05T00:00:00.000Z","updatedAt":"2026-10-04T00:02:00.000Z","action":null,"body":{"type":"headline","text":"Rain after three."}},
         {"id":"weather","title":"Jakarta","source":"agent","hidden":false,"expiresAt":"2026-10-05T00:00:00.000Z","updatedAt":"2026-10-04T00:02:00.000Z","action":null,"body":{"type":"weather","place":"Jakarta"}},
         {"id":"upnext","title":"Up next","source":"builtin","hidden":false,"expiresAt":null,"updatedAt":"2026-10-04T00:00:00.000Z","action":null,"body":{"type":"upnext"}},
         {"id":"my-notes","title":"","source":"agent","hidden":false,"expiresAt":null,"updatedAt":"2026-10-04T00:00:00.000Z","action":null,"body":{"type":"markdown","text":"Hi"}}]
        """#)
        #expect(widgets[0].body.kind == .unknown("headline") && widgets[1].body.kind == .unknown("weather"),
                "the brief's old headline and weather are not drawn, even from an older server")
        #expect(widgets[2].body.kind == .unknown("upnext"), "the app draws nothing of its own")
        #expect(widgets[3].name == "My Notes")
    }

    @Test func chartHeightsCompareHonestly() {
        #expect(WidgetChart.heights([5, 10], fromZero: true) == [0.5, 1])
        #expect(WidgetChart.heights([5, 10], fromZero: false) == [0, 1])
        #expect(WidgetChart.heights([-5, 5], fromZero: true) == [0, 1], "bars with a negative value span the range")
        #expect(WidgetChart.heights([4, 4, 4], fromZero: false) == [0.5, 0.5, 0.5])
        #expect(WidgetChart.heights([0, 0], fromZero: true) == [0.5, 0.5])
        #expect(WidgetChart.heights([], fromZero: true).isEmpty)
    }

    @Test func theGreetingFollowsTheClock() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let at = { (hour: Int) in ISO8601.parse(String(format: "2026-10-04T%02d:30:00.000Z", hour))! }
        #expect(HomeGreeting.text(at: at(7), calendar: calendar) == "Good morning")
        #expect(HomeGreeting.text(at: at(13), calendar: calendar) == "Good afternoon")
        #expect(HomeGreeting.text(at: at(19), calendar: calendar) == "Good evening")
        #expect(HomeGreeting.text(at: at(2), calendar: calendar) == "Hello")
    }

    @Test func aCheckInThatCameToNothingIsNotDrawn() {
        var t = ChatTimeline()
        t.insert([
            message("q1", seq: 1, run: "run_quiet", role: .user, text: "Exploring your interests: F1", origin: "heartbeat"),
            message("q2", seq: 2, run: "run_quiet", role: .assistant, origin: "heartbeat"),
            message("n1", seq: 3, run: "run_none", role: .user, text: "Check-in on a follow-up:\n- Plants", origin: "heartbeat"),
            message("n2", seq: 4, run: "run_none", role: .assistant, text: "Let me look."),
            message("n3", seq: 5, run: "run_none", role: .assistant, text: "Nothing to report."),
            message("f1", seq: 6, run: "run_found", role: .user, text: "Exploring your interests: Rust", origin: "heartbeat"),
            message("f2", seq: 7, run: "run_found", role: .assistant, text: "Rust 2.0 is out.", origin: "heartbeat"),
            message("j1", seq: 8, run: "run_joined", role: .user, text: "Exploring your interests: Go", origin: "heartbeat"),
            message("j2", seq: 9, run: "run_joined", role: .user, text: "And Zig?"),
        ])
        #expect(t.items.map(\.id) == ["f1", "f2-0", "j1", "j2"])
        #expect(ChatTimeline.quietRuns(in: t.messages, running: "run_quiet") == ["run_none"])
    }

    @Test func theCheckInsDotShowsOnlyForSomethingUnseen() throws {
        #expect(CheckInsModel.isNew(latest: 7, seen: 3))
        #expect(!CheckInsModel.isNew(latest: 7, seen: 7))
        #expect(!CheckInsModel.isNew(latest: nil, seen: 0))
        let json = #"{"timeZone":"Asia/Jakarta","widgets":[],"checkIns":{"conversationId":"c","latestSeq":4,"latestAt":"2026-10-04T00:00:00.000Z","running":false},"brief":{"enabled":true,"running":false,"lastAt":null,"hour":6}}"#
        let feed = try JSONDecoder().decode(HomeFeed.self, from: Data(json.utf8))
        #expect(feed.checkIns.latestSeq == 4)
    }

    @Test func aSwipedWidgetIsQuotedAsWhatItSaysWithItsId() throws {
        let widget: HomeWidget = try decode(#"""
        {"id":"steps","title":"Steps","source":"api","hidden":false,"expiresAt":null,"updatedAt":"2026-10-05T07:00:00.000Z",
         "body":{"type":"stack","children":[
           {"type":"row","children":[{"type":"icon","name":"figure.walk"},{"type":"stat","value":"8,412","label":"Today","unit":"steps","caption":"Above average"},{"type":"gauge","value":0.84,"label":"84%","caption":"of 10,000"}]},
           {"type":"progress","value":0.84,"label":"Goal"},
           {"type":"chart","kind":"bar","values":[3,5.5,8],"labels":["M","T"]},
           {"type":"fields","items":[{"label":"Distance","value":"6.1 km"}]},
           {"type":"list","items":[{"title":"Run","subtitle":"Morning","value":"5 km"}]},
           {"type":"divider"},
           {"type":"button","text":"Open","action":{"type":"ask","prompt":"hi"}},
           {"type":"hologram"}]}}
        """#)
        let quote = widget.messageQuote
        #expect(quote.kind == "card", "the server takes text and card quotes; a widget is a card")
        #expect(quote.title == "Home · Steps")
        #expect(quote.text == """
        Home widget “Steps” (id: steps, updated 2026-10-05T07:00:00.000Z)

        Today: 8,412 steps — Above average
        84% — of 10,000
        Goal: 84%
        Chart (bar): M 3, T 5.5, 8
        Distance: 6.1 km
        - Run — Morning — 5 km
        """)
    }

    @Test func aLongWidgetIsClippedToWhatTheServerAccepts() throws {
        let long = String(repeating: "🌻 sunflower ", count: 1_000)
        let widget: HomeWidget = try decode(#"{"id":"w","title":"Notes","source":"api","hidden":false,"expiresAt":null,"updatedAt":"2026-10-05T07:00:00.000Z","body":{"type":"markdown","text":"\#(long)"}}"#)
        let text = widget.messageQuote.text
        #expect(text.utf16.count <= MessageQuote.maxCharacters)
        #expect(text.hasSuffix("…"))
    }

    @Test func homeIsFourColumnsFilledLeftToRight() throws {
        let spans = [1, 1, 2, 3, 2, 4, 1, 9, 0, 2, 2]
        let lines = HomeGrid.lines(Array(spans.indices)) { spans[$0] }
        #expect(lines == [[0, 1, 2], [3], [4], [5], [6], [7], [8, 9], [10]], "one that does not fit the rest of a line starts the next; spans are clamped to 1–4")
        #expect(HomeGrid.lines([Int]()) { $0 }.isEmpty)
        #expect(HomeGrid.columnWidth(in: 360) == 81)
        #expect(HomeGrid.width(span: 2, in: 360) == 174 && HomeGrid.width(span: 4, in: 360) == 360)
        #expect([1, 2, 3, 4].map { HomeGrid.span($0, accessibility: true) } == [2, 2, 4, 4], "the largest text sizes need room")
        #expect(HomeGrid.move("a", onto: "c", in: ["a", "b", "c"]) == ["b", "c", "a"], "dragged down, it goes after")
        #expect(HomeGrid.move("c", onto: "a", in: ["a", "b", "c"]) == ["c", "a", "b"], "dragged up, it goes before")
        #expect(HomeGrid.move("a", onto: "x", in: ["a", "b"]) == ["a", "b"])
    }

    @Test func aWidgetSaysHowWideItIs() throws {
        let json = { (extra: String, body: String) in #"""
        {"id":"w","title":"","source":"agent","hidden":false,"expiresAt":null,"updatedAt":"2026-10-06T00:00:00.000Z",\#(extra)
         "body":\#(body)}
        """# }
        let small: HomeWidget = try decode(json(#""columns":1,"#, #"{"type":"gauge","key":"mood","value":0.5}"#))
        #expect(small.span == 1, "a part's key is the server's, and the app reads past it")
        guard case .gauge = small.body.kind else { Issue.record("not a gauge"); return }
        let old: HomeWidget = try decode(json("", #"{"type":"text","text":"Hi"}"#))
        #expect(old.columns == nil && old.span == 4, "a server before sizes means the full width")
    }
}
