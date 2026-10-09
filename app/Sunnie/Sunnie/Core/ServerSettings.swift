import Foundation

/// The app keeps its URL in UserDefaults and shares a credential snapshot through the Keychain.
nonisolated struct ServerSettings: Equatable, Sendable {
    var baseURL: URL?
    var apiKey: String

    var isConfigured: Bool { baseURL != nil && !apiKey.isEmpty }

    private static let urlKey = "server.baseURL"
    private static let keyAccount = "apiKey"
    private static let sharedAccount = "shareConnection"

    private nonisolated struct SharedConnection: Codable {
        var baseURL: URL
        var apiKey: String
    }

    static func load(defaults: UserDefaults = .standard) -> ServerSettings {
        let url = defaults.string(forKey: urlKey).flatMap(URL.init(string:))
        let settings = ServerSettings(baseURL: url, apiKey: Keychain.read(keyAccount) ?? "")
        // Existing installations gain sharing the first time the updated app opens.
        settings.shareConnection()
        return settings
    }

    static func loadShared() -> ServerSettings {
        guard let value = Keychain.read(sharedAccount),
              let shared = try? JSONDecoder().decode(SharedConnection.self, from: Data(value.utf8)),
              let url = normalize(shared.baseURL.absoluteString), !shared.apiKey.isEmpty else {
            return ServerSettings(baseURL: nil, apiKey: "")
        }
        return ServerSettings(baseURL: url, apiKey: shared.apiKey)
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(baseURL?.absoluteString, forKey: Self.urlKey)
        if apiKey.isEmpty { Keychain.delete(Self.keyAccount) } else { Keychain.write(apiKey, account: Self.keyAccount) }
        shareConnection()
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: urlKey)
        Keychain.delete(keyAccount)
        Keychain.delete(sharedAccount)
    }

    private func shareConnection() {
        guard let baseURL, !apiKey.isEmpty else {
            Keychain.delete(Self.sharedAccount)
            return
        }
        let shared = SharedConnection(baseURL: baseURL, apiKey: apiKey)
        if let data = try? JSONEncoder().encode(shared) {
            Keychain.write(String(decoding: data, as: UTF8.self), account: Self.sharedAccount)
        }
    }

    /// Accepts what people type: a bare host, a host:port, with or without a scheme or trailing slash.
    static func normalize(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host() != nil else { return nil }
        return url
    }
}
