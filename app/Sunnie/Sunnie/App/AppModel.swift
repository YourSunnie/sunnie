import Foundation
import Observation

/// Root state: which server the app talks to, and what that server said about itself.
@Observable
final class AppModel {
    /// The self-hosted app or the App Store app for the hosted service (AppFlavor.swift).
    let flavor: AppFlavor
    private(set) var settings: ServerSettings
    private(set) var client: SunnieClient?
    private(set) var info: ServerInfo?
    private(set) var infoError: String?
    /// Every server that worked, so the user can switch without typing the address and key again.
    private(set) var servers: [SavedServer]

    init(settings: ServerSettings = .load(), flavor: AppFlavor = .current) {
        self.flavor = flavor
        self.settings = settings
        servers = SavedServers.load()
        if settings.isConfigured, let url = settings.baseURL {
            client = SunnieClient(baseURL: url, apiKey: settings.apiKey)
            // Installations from before the list keep the server they were on.
            if !servers.contains(where: { $0.matches(url) }) { remember(url, name: "Sunnie", apiKey: settings.apiKey) }
        }
    }

    var isConfigured: Bool { client != nil }
    var agentName: String { info?.name ?? "Sunnie" }
    /// A new user is being greeted or introduced: the app shows only the chat until it is over.
    var isIntroducing: Bool { info?.greeting.map { $0.pending || $0.introducing == true } ?? false }
    var currentServer: SavedServer? { servers.first { $0.matches(settings.baseURL) } }

    /// Tries the credentials against `/v1/info`; only a working pair is saved.
    /// `pushToken`: this device's notification token, removed from the server being left.
    /// `editing`: the address replaces the current server's in the saved list instead of adding one.
    @discardableResult
    func connect(urlText: String, apiKey: String, pushToken: String? = nil, editing: Bool = false) async throws -> ServerInfo {
        guard let url = ServerSettings.normalize(urlText) else { throw APIError.invalidURL }
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = SunnieClient(baseURL: url, apiKey: key)
        let info = try await candidate.info()
        remember(url, name: info.name, apiKey: key, replacing: editing ? settings.baseURL : nil)
        settings = ServerSettings(baseURL: url, apiKey: key)
        settings.save()
        client?.clearDriveCache()
        if let old = client, old.baseURL != url { forget(pushToken, on: old) }
        client = candidate
        self.info = info
        infoError = nil
        return info
    }

    /// Spends a one-time connect link (a scanned code or an opened `sunnie://connect` link) and
    /// connects to the server it names.
    @discardableResult
    func connect(link: URL, pushToken: String? = nil) async throws -> ServerInfo {
        let grant = try await ConnectLink.claim(link)
        // The link is spent now: a server that is slow to answer must not cost the user a new one.
        var attempt = 0
        while true {
            do {
                return try await connect(urlText: grant.serverUrl, apiKey: grant.apiKey, pushToken: pushToken)
            } catch APIError.network where attempt < 2 {
                attempt += 1
                try await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Switches to a saved server; its key is checked against the server first, like a typed one.
    @discardableResult
    func switchTo(_ server: SavedServer, pushToken: String? = nil) async throws -> ServerInfo {
        guard let key = SavedServers.apiKey(for: server) else { throw SavedServerError.missingKey }
        return try await connect(urlText: server.baseURL.absoluteString, apiKey: key, pushToken: pushToken)
    }

    /// Removes a saved server that is not the current one, with its key.
    func forget(_ server: SavedServer) {
        guard !server.matches(settings.baseURL) else { return }
        SavedServers.deleteKey(for: server)
        servers.removeAll { $0.id == server.id }
        SavedServers.save(servers)
    }

    func refreshInfo() async {
        guard let client else { return }
        do {
            let info = try await client.info()
            self.info = info
            if let url = settings.baseURL, currentServer?.name != info.name {
                remember(url, name: info.name, apiKey: settings.apiKey)
            }
            infoError = nil
        } catch {
            infoError = error.localizedDescription
        }
    }

    /// Leaves the current server and removes it, with its key, from the saved list.
    func disconnect(pushToken: String? = nil) {
        if let client { forget(pushToken, on: client) }
        client?.clearDriveCache()
        if let current = currentServer {
            SavedServers.deleteKey(for: current)
            servers.removeAll { $0.id == current.id }
            SavedServers.save(servers)
        }
        ServerSettings.clear()
        settings = ServerSettings(baseURL: nil, apiKey: "")
        client = nil
        info = nil
        infoError = nil
    }

    private func remember(_ url: URL, name: String, apiKey: String, replacing previous: URL? = nil) {
        let result = SavedServers.remembering(servers, baseURL: url, name: name, replacing: previous)
        servers = result.list
        SavedServers.save(servers)
        SavedServers.storeKey(apiKey, for: result.server)
    }

    /// A server the app no longer talks to must stop sending this device notifications.
    private func forget(_ pushToken: String?, on client: SunnieClient) {
        guard let pushToken else { return }
        Task { try? await client.unregisterDevice(token: pushToken) }
    }
}

nonisolated enum SavedServerError: Error, LocalizedError {
    case missingKey

    var errorDescription: String? {
        "The API key for this server is no longer on this device. Add the server again."
    }
}
