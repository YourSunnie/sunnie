import Foundation

/// A server the app has connected to, kept so switching back needs no typing. Its API key is in
/// the Keychain under its own account; only the address and the agent's name are in UserDefaults.
nonisolated struct SavedServer: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var baseURL: URL

    /// What tells two servers apart when both agents are called "Sunnie".
    var address: String {
        guard let host = baseURL.host() else { return baseURL.absoluteString }
        let port = baseURL.port.map { ":\($0)" } ?? ""
        return host + port + (baseURL.path().isEmpty || baseURL.path() == "/" ? "" : baseURL.path())
    }

    func matches(_ url: URL?) -> Bool {
        guard let url else { return false }
        return baseURL.absoluteString.lowercased() == url.absoluteString.lowercased()
    }
}

nonisolated enum SavedServers {
    private static let defaultsKey = "server.saved"

    /// The list after a successful connection. The same address is updated where it is; with
    /// `replacing`, the entry for that address takes the new one (the user edited the server they
    /// were on); otherwise the server is added at the end.
    static func remembering(_ list: [SavedServer], baseURL: URL, name: String, replacing previous: URL? = nil,
                            newID: () -> String = { UUID().uuidString }) -> (list: [SavedServer], server: SavedServer) {
        var list = list
        let index = list.firstIndex { $0.matches(baseURL) } ?? previous.flatMap { old in list.firstIndex { $0.matches(old) } }
        if let index {
            list[index].baseURL = baseURL
            list[index].name = name
            return (list, list[index])
        }
        let server = SavedServer(id: newID(), name: name, baseURL: baseURL)
        list.append(server)
        return (list, server)
    }

    static func load(defaults: UserDefaults = .standard) -> [SavedServer] {
        guard let data = defaults.data(forKey: defaultsKey) else { return [] }
        return (try? JSONDecoder().decode([SavedServer].self, from: data)) ?? []
    }

    static func save(_ list: [SavedServer], defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(list), forKey: defaultsKey)
    }

    static func apiKey(for server: SavedServer) -> String? {
        Keychain.read(account(server.id)).flatMap { $0.isEmpty ? nil : $0 }
    }

    static func storeKey(_ apiKey: String, for server: SavedServer) {
        Keychain.write(apiKey, account: account(server.id))
    }

    static func deleteKey(for server: SavedServer) {
        Keychain.delete(account(server.id))
    }

    private static func account(_ id: String) -> String { "server.\(id)" }
}
