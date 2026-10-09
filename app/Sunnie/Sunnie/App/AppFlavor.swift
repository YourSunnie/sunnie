import Foundation

/// Which app this build is, chosen by the `SUNNIE_FLAVOR` build setting (Signing.xcconfig) and read
/// from Info.plist. `selfhosted`, the default, connects to any server with an address and a key and
/// shows what a server's owner tunes (models, servers, server details). `hosted` is the App Store
/// build for people on the hosted service: they connect with a code from its panel, the service
/// picks the models, and Settings keeps to what a person decides. Both are the same code and the
/// same API; only what the screens offer differs.
nonisolated struct AppFlavor: Equatable, Sendable {
    var isHosted: Bool
    /// The hosted panel's host (`SUNNIE_CONNECT_HOST`): a typed code is claimed at
    /// `https://<host>/c/<code>`, the link its QR code holds. Nil when the build sets none.
    var connectHost: String?

    static let current = AppFlavor(info: Bundle.main.infoDictionary ?? [:])

    init(isHosted: Bool, connectHost: String? = nil) {
        self.isHosted = isHosted
        self.connectHost = connectHost
    }

    init(info: [String: Any]) {
        let flavor = (info["SunnieFlavor"] as? String)?.trimmingCharacters(in: .whitespaces).lowercased()
        let host = (info["SunnieConnectHost"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        self.init(isHosted: flavor == "hosted", connectHost: host.isEmpty ? nil : host)
    }
}
