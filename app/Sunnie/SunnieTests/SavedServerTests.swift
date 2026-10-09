import Foundation
import Testing
@testable import Sunnie

struct SavedServerTests {
    private let home = URL(string: "http://192.168.1.10:8787")!
    private let vps = URL(string: "https://sunnie.example.com")!
    private var ids: () -> String {
        var next = 0
        return { next += 1; return "id\(next)" }
    }

    @Test func newServersAreAddedInOrder() {
        let newID = ids
        let first = SavedServers.remembering([], baseURL: home, name: "Sunnie", newID: newID)
        let second = SavedServers.remembering(first.list, baseURL: vps, name: "Sol", newID: newID)
        #expect(second.list.map(\.id) == ["id1", "id2"])
        #expect(second.server == SavedServer(id: "id2", name: "Sol", baseURL: vps))
    }

    @Test func sameAddressUpdatesTheEntryInsteadOfAddingOne() {
        let newID = ids
        let list = SavedServers.remembering([], baseURL: home, name: "Sunnie", newID: newID).list
        let again = SavedServers.remembering(list, baseURL: URL(string: "HTTP://192.168.1.10:8787")!, name: "Renamed", newID: newID)
        #expect(again.list.count == 1)
        #expect(again.server.id == "id1")
        #expect(again.server.name == "Renamed")
    }

    @Test func editingTheCurrentServerMovesItsEntry() {
        let newID = ids
        var list = SavedServers.remembering([], baseURL: home, name: "Sunnie", newID: newID).list
        list = SavedServers.remembering(list, baseURL: vps, name: "Sol", newID: newID).list
        let moved = URL(string: "http://192.168.1.20:8787")!
        let edited = SavedServers.remembering(list, baseURL: moved, name: "Sunnie", replacing: home, newID: newID)
        #expect(edited.list.map(\.id) == ["id1", "id2"])
        #expect(edited.list[0].baseURL == moved)
    }

    @Test func editingToAnAddressAlreadySavedKeepsOneEntryPerAddress() {
        let newID = ids
        var list = SavedServers.remembering([], baseURL: home, name: "Sunnie", newID: newID).list
        list = SavedServers.remembering(list, baseURL: vps, name: "Sol", newID: newID).list
        let edited = SavedServers.remembering(list, baseURL: vps, name: "Sol", replacing: home, newID: newID)
        #expect(edited.server.id == "id2")
        #expect(Set(edited.list.map(\.baseURL.absoluteString)).count == edited.list.count)
    }

    @Test func addressShowsHostPortAndPath() {
        #expect(SavedServer(id: "a", name: "S", baseURL: home).address == "192.168.1.10:8787")
        #expect(SavedServer(id: "b", name: "S", baseURL: vps).address == "sunnie.example.com")
        #expect(SavedServer(id: "c", name: "S", baseURL: URL(string: "https://example.com/sunnie")!).address == "example.com/sunnie")
    }

    @Test func listSurvivesARoundTripThroughDefaults() throws {
        let defaults = try #require(UserDefaults(suiteName: "SavedServerTests"))
        defer { defaults.removePersistentDomain(forName: "SavedServerTests") }
        let list = [SavedServer(id: "a", name: "Sunnie", baseURL: home), SavedServer(id: "b", name: "Sol", baseURL: vps)]
        SavedServers.save(list, defaults: defaults)
        #expect(SavedServers.load(defaults: defaults) == list)
    }
}
