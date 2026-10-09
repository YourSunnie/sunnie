import Foundation
import Testing
@testable import Sunnie

private final class BundleToken {}

struct FormulaTests {
    /// The same cases the server runs (api/test/formula.test.ts): the app shows what the server checked.
    @Test func showsTheSameValuesAsTheServer() throws {
        struct Cases: Decodable {
            var state: [String: StateValue]
            var interpolate: [[String]]
            var invalid: [String]
        }
        let url = try #require(Bundle(for: BundleToken.self).url(forResource: "FormulaCases", withExtension: "json"))
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: url))
        for pair in cases.interpolate {
            #expect(Formula.interpolate(pair[0], cases.state) == pair[1], "\(pair[0])")
        }
        for source in cases.invalid {
            #expect(throws: Formula.Problem.self, "\(source)") { try Formula.parse(source) }
        }
    }

    @Test func readsInteractivePartsAndWhereTheyStart() throws {
        let json = #"""
        {"type":"stack","state":{"rate":0.2},"children":[
          {"type":"stepper","bind":"people","value":5,"min":2,"max":16,"label":"People"},
          {"type":"slider","bind":"years","min":1,"max":40,"label":"Years"},
          {"type":"toggle","bind":"metric","value":true,"label":"Metric"},
          {"type":"segmented","bind":"tab","options":["Shopping",{"value":"timeline","label":"Timeline"}]},
          {"type":"checklist","bind":"done","items":[{"time":"13:30","title":"Start roasting"},{"title":"Serve"}]},
          {"type":"table","columns":["Item","Qty"],"rows":[["Lamb","{people * 0.4} kg"]]},
          {"type":"progress","value":"{done / 2}","when":"tab == 'timeline'"},
          {"type":"slider","bind":"bad","min":5,"max":1}]}
        """#
        let node = try JSONDecoder().decode(WidgetNode.self, from: Data(json.utf8))
        #expect(node.isInteractive)
        #expect(node.initialState == ["rate": .number(0.2), "people": .number(5), "years": .number(1), "metric": .bool(true),
                                      "tab": .text("Shopping"), "done": .list([false, false])])
        let progress = node.children[6]
        #expect(progress.when == "tab == 'timeline'")
        #expect(progress.amount == "{done / 2}")
        #expect(Formula.amount(progress.amount!, ["done": .list([true, false])]) == 0.5)
        #expect(!Formula.holds(progress.when!, node.initialState))
        if case .unknown = node.children[7].kind {} else { Issue.record("a slider whose max is below its min is not drawn") }
        // What a quote of it says, with its values worked out.
        let lines = WidgetText.lines(node)
        #expect(lines.contains("People: 5"))
        #expect(lines.contains("Lamb | 2 kg"))
        #expect(lines.contains("[ ] 13:30 — Start roasting"))
        #expect(!lines.contains { $0.hasPrefix("50%") || $0 == "0%" }, "hidden while its tab is not chosen")
    }

    @Test func drawsAStreamingWidgetFromWhatHasArrived() throws {
        let full = #"{"type":"stack","children":[{"type":"text","text":"Hello"},{"type":"stat","value":"5","label":"People"}]}"#
        #expect(PartialJSON.complete(full) == full)
        let cut = String(full.prefix(full.count - 30))
        let completed = try #require(PartialJSON.complete(cut))
        let node = try JSONDecoder().decode(WidgetNode.self, from: Data(completed.utf8))
        #expect(node.children.count >= 1)
        if case .text(let label) = node.children[0].kind { #expect(label.text == "Hello") } else { Issue.record("the first part arrived") }
        for i in stride(from: 1, to: full.count, by: 3) {
            if let text = PartialJSON.complete(String(full.prefix(i))) {
                #expect((try? JSONSerialization.jsonObject(with: Data(text.utf8))) != nil, "\(text)")
            }
        }
        // A reply still streaming draws the card's finished parts rather than a placeholder.
        let blocks = Markdown.parse("Here:\n\n```widget\n\(cut)", streaming: true)
        #expect(blocks.contains { if case .widget = $0 { true } else { false } })
    }
}
