import Foundation

/// What a connect link gives once: where the server is and the key for it.
nonisolated struct ConnectGrant: Decodable, Equatable, Sendable {
    let serverUrl: String
    let apiKey: String
    var name: String?
}

/// A one-time link from whoever hosts the server, shared as a QR code or tapped as
/// `sunnie://connect?link=…`. It carries no key: the app exchanges it, once, for a `ConnectGrant`.
nonisolated enum ConnectLink {
    /// The address to claim, from a scanned code or an opened link; nil for anything else.
    /// Only `…/c/<code>` is accepted, so a stray QR code never makes the app call its address.
    static func parse(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        if url.scheme?.lowercased() == "sunnie" {
            guard url.host()?.lowercased() == "connect",
                  let link = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "link" })?.value,
                  let inner = URL(string: link), inner.scheme?.lowercased() != "sunnie" else { return nil }
            return parse(inner.absoluteString)
        }
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host() != nil else { return nil }
        let parts = url.pathComponents
        guard parts.count >= 2, parts[parts.count - 2] == "c", !parts[parts.count - 1].isEmpty else { return nil }
        return url
    }

    /// The link for what the user typed on the connect screen: a whole link (pasted), or the code
    /// a hosted panel shows beside its QR code, which stands for `https://<host>/c/<code>`.
    /// Spaces are dropped, since people copy codes in groups; anything else outside letters,
    /// digits, `-` and `_` is refused rather than sent.
    static func forCode(_ text: String, host: String?) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let link = parse(trimmed) { return link }
        let code = trimmed.filter { !$0.isWhitespace }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard let host, !host.isEmpty, !code.isEmpty,
              code.unicodeScalars.allSatisfy({ $0.isASCII && allowed.contains($0) }) else { return nil }
        return parse("https://\(host)/c/\(code)")
    }

    /// Spends the link. A link that was used before, or has expired, answers with the host's own words.
    static func claim(_ link: URL, session: URLSession = .shared) async throws -> ConnectGrant {
        var request = URLRequest(url: link)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw APIError.http(status: status, code: "connect_link", message: refusal(data) ?? "This code could not be used. Ask for a new one.")
        }
        return try grant(from: data)
    }

    static func grant(from data: Data) throws -> ConnectGrant {
        do {
            return try JSONDecoder().decode(ConnectGrant.self, from: data)
        } catch {
            throw APIError.decoding("connect link")
        }
    }

    static func refusal(_ data: Data) -> String? {
        struct Body: Decodable { let message: String }
        return (try? JSONDecoder().decode(Body.self, from: data))?.message
    }
}
