import Foundation
import Observation

@Observable
final class LoginsModel {
    private let client: SunnieClient
    private(set) var logins: [Login] = []
    private(set) var isLoading = false
    var error: String?

    init(client: SunnieClient) {
        self.client = client
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            logins = try await client.listLogins()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Returns an error message, or nil when saved. An empty password or code secret on an
    /// existing login means "keep what is stored".
    func save(_ existing: Login?, name: String, site: String, username: String, password: String, totpSecret: String) async -> String? {
        do {
            if let existing {
                let updated = try await client.updateLogin(
                    existing.id, name: name, site: site, username: username,
                    password: password.isEmpty ? nil : password,
                    totpSecret: totpSecret.isEmpty ? nil : totpSecret
                )
                if let i = logins.firstIndex(where: { $0.id == updated.id }) { logins[i] = updated }
            } else {
                logins.append(try await client.createLogin(name: name, site: site, username: username, password: password, totpSecret: totpSecret))
            }
            logins.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func delete(_ login: Login) async {
        do {
            try await client.deleteLogin(login.id)
            logins.removeAll { $0.id == login.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
