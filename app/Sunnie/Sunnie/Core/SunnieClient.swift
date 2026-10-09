import Foundation
import CryptoKit
import UniformTypeIdentifiers

nonisolated enum APIError: Error, LocalizedError, Equatable, Sendable {
    /// The server answered with an error body: `{ error: { code, message } }`.
    case http(status: Int, code: String, message: String)
    case network(String)
    case decoding(String)
    case invalidURL

    var errorDescription: String? {
        switch self {
        case let .http(status, code, message):
            return message.isEmpty ? "\(code) (\(status))" : message
        case .network(let s): return s
        case .decoding(let s): return "Unexpected response: \(s)"
        case .invalidURL: return "The server URL is not valid."
        }
    }

    var status: Int? {
        if case .http(let status, _, _) = self { return status }
        return nil
    }
}

/// Talks to one Sunnie server. One method per route, with a bounded cache for opened Drive files.
final class SunnieClient {
    let baseURL: URL
    private let apiKey: String
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let driveCache: DriveFileCache
    private var openingDrive: [String: Task<OpenedDriveFile, Error>] = [:]

    init(baseURL: URL, apiKey: String) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        driveCache = DriveFileCache(server: baseURL, credential: apiKey)
        let config = URLSessionConfiguration.default
        // Streams idle between the server's 15 s pings; the default 60 s request timeout is fine.
        config.timeoutIntervalForResource = 60 * 60
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    // MARK: Instance

    func info() async throws -> ServerInfo {
        try await request("GET", "/v1/info")
    }

    func modelDefaults() async throws -> ChatModelDefaults {
        try await request("GET", "/v1/settings/model")
    }

    /// The allowance the hosting service gives this Sunnie, and how much of it is used.
    func usage() async throws -> UsageInfo {
        try await request("GET", "/v1/usage")
    }

    func saveModelDefaults(_ defaults: ChatModelDefaults) async throws -> ChatModelDefaults {
        try await request("PATCH", "/v1/settings/model", body: ["model": defaults.model, "reasoning": defaults.reasoning])
    }

    func clearDriveCache() {
        for pending in openingDrive.values { pending.cancel() }
        driveCache.clear()
    }

    func listCardStates(_ conversationId: String) async throws -> [CardState] {
        let list: CardStateList = try await request("GET", "/v1/conversations/\(conversationId)/cards")
        return list.cards
    }

    func saveCardState(messageId: String, card: Int, state: [String: StateValue]) async throws {
        let _: CardState = try await request("PUT", "/v1/messages/\(messageId)/cards/\(card)", body: ["state": state.mapValues(\.plain)])
    }

    /// A reply's card, as it stands, put on Home.
    func pinCard(messageId: String, card: Int) async throws -> HomeWidget {
        try await request("POST", "/v1/home/widgets/from-card", body: ["messageId": messageId, "card": card])
    }

    func saveWidgetState(_ id: String, state: [String: StateValue]) async throws -> HomeWidget {
        try await request("PUT", "/v1/home/widgets/\(id)/state", body: ["state": state.mapValues(\.plain)])
    }

    func listSkills() async throws -> SkillCatalog {
        try await request("GET", "/v1/skills")
    }

    func setSkillEnabled(_ name: String, enabled: Bool) async throws -> AgentSkill {
        try await request("PATCH", "/v1/skills/\(name)", body: ["enabled": enabled])
    }

    func revokeSkillSource(_ repository: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/skills/sources", query: [URLQueryItem(name: "repository", value: repository)])
    }

    func listInterests() async throws -> InterestList {
        try await request("GET", "/v1/interests")
    }

    func pauseInterestUpdates(_ paused: Bool) async throws -> InterestPreferences {
        try await request("PATCH", "/v1/interests/settings", body: ["paused": paused])
    }

    func setInterestStatus(_ id: String, status: String) async throws -> UserInterest {
        try await request("PATCH", "/v1/interests/\(id)", body: ["status": status])
    }

    // MARK: Home

    func home(timezone: String) async throws -> HomeFeed {
        try await request("GET", "/v1/home", query: [URLQueryItem(name: "timezone", value: timezone)])
    }

    func checkIns() async throws -> CheckInStatus {
        try await request("GET", "/v1/check-ins")
    }

    /// Asks the agent to refresh Home now (a model run); 409 while one is going or just ran.
    func requestBrief(timezone: String) async throws {
        let _: Empty = try await request("POST", "/v1/home/brief", body: ["timezone": timezone])
    }

    /// Picks a new width for a widget: it applies at once, and Sunnie redesigns the widget for it
    /// (the widget is `resizing` until she is done). 409 while she is busy with Home.
    func resizeWidget(_ id: String, columns: Int, timezone: String) async throws -> HomeWidget {
        let started: WidgetResizeStarted = try await request("POST", "/v1/home/widgets/\(id)/resize", body: ["columns": columns, "timezone": timezone])
        return started.widget
    }

    func removeWidget(_ id: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/home/widgets/\(id)")
    }

    /// Saves the user's arrangement: every id top to bottom, and the full set of hidden ones.
    func setHomeLayout(order: [String], hidden: [String]) async throws {
        let _: HomeLayout = try await request("PUT", "/v1/home/layout", body: ["order": order, "hidden": hidden])
    }

    // MARK: Drive

    func listDrive(_ path: String = "", offset: Int = 0) async throws -> DrivePage {
        try await request("GET", "/v1/drive/entries", query: [URLQueryItem(name: "path", value: path), URLQueryItem(name: "offset", value: String(offset))])
    }

    func driveEntry(_ path: String) async throws -> DriveEntry {
        try await request("GET", "/v1/drive/entry", query: [URLQueryItem(name: "path", value: path)])
    }

    func driveText(_ path: String) async throws -> DriveText {
        try await request("GET", "/v1/drive/text", query: [URLQueryItem(name: "path", value: path)])
    }

    func saveDriveText(_ entry: DriveEntry, text: String) async throws -> DriveEntry {
        try await request("PUT", "/v1/drive/text", body: ["path": entry.path, "revision": entry.revision, "text": text])
    }

    func createDriveFolder(_ path: String) async throws -> DriveEntry {
        try await request("POST", "/v1/drive/folders", body: ["path": path])
    }

    func createDriveFile(_ path: String) async throws -> DriveEntry {
        var upload = makeRequest("POST", "/v1/drive/content", query: [URLQueryItem(name: "path", value: path)])
        upload.httpBody = Data()
        upload.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(upload)
        return try decoder.decode(DriveEntry.self, from: data)
    }

    func uploadDriveFile(_ file: PendingAttachment, folder: String) async throws -> DriveEntry {
        var upload = makeRequest("POST", "/v1/drive/content", query: [URLQueryItem(name: "path", value: DrivePath.joining(folder, file.filename))])
        upload.setValue(file.mediaType, forHTTPHeaderField: "Content-Type")
        upload.timeoutInterval = 120
        let (data, response) = try await session.upload(for: upload, fromFile: file.fileURL)
        try Self.check(response as! HTTPURLResponse, body: data)
        return try decoder.decode(DriveEntry.self, from: data)
    }

    func moveDriveEntry(_ entry: DriveEntry, to destination: String) async throws {
        let _: DriveMove = try await request("PATCH", "/v1/drive/entry", body: ["path": entry.path, "destination": destination, "revision": entry.revision])
    }

    func deleteDriveEntry(_ entry: DriveEntry) async throws {
        let _: Empty = try await request("DELETE", "/v1/drive/entry", query: [URLQueryItem(name: "path", value: entry.path), URLQueryItem(name: "revision", value: entry.revision)])
    }

    func openDriveFile(_ path: String) async throws -> OpenedDriveFile {
        if let pending = openingDrive[path] { return try await pending.value }
        let pending = Task { () async throws -> OpenedDriveFile in
            // Metadata is small and always refreshed; a folder listing can already be stale.
            let entry = try await driveEntry(path)
            try Task.checkCancellation()
            guard entry.kind == "file" else { throw APIError.network("This item is no longer a file. Open its folder again.") }
            guard entry.sizeBytes <= PendingAttachment.maxFileBytes else {
                throw APIError.network("This file is too large to open here (20 MB maximum). Ask Sunnie for a smaller copy.")
            }
            if let url = driveCache.cached(entry) { return OpenedDriveFile(entry: entry, url: url) }
            let request = makeRequest("GET", "/v1/drive/content", query: [
                URLQueryItem(name: "path", value: entry.path), URLQueryItem(name: "revision", value: entry.revision)
            ])
            let (data, response) = try await perform(request)
            let revision: String
            if let received = response.value(forHTTPHeaderField: "X-Drive-Revision") { revision = received }
            else { revision = try await driveEntry(path).revision }
            guard revision == entry.revision else {
                throw APIError.network("This file changed while opening. Try opening it again.")
            }
            try Task.checkCancellation()
            return OpenedDriveFile(entry: entry, url: try driveCache.store(data, entry: entry))
        }
        openingDrive[path] = pending
        defer { openingDrive[path] = nil }
        return try await pending.value
    }

    func downloadDriveFile(_ entry: DriveEntry) async throws -> URL {
        try await openDriveFile(entry.path).url
    }

    private nonisolated struct DriveMove: Decodable { var path: String }

    // MARK: Conversations

    func listConversations(limit: Int = 50, before: String? = nil) async throws -> [Conversation] {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        let page: ConversationList = try await request("GET", "/v1/conversations", query: query)
        return page.conversations
    }

    func createConversation(title: String? = nil, model: String? = nil) async throws -> Conversation {
        try await request("POST", "/v1/conversations", body: ["title": title, "model": model])
    }

    /// Starts a new user's first chat, in which Sunnie speaks first. `409` once the server has met them.
    func startGreeting(timezone: String) async throws -> Conversation {
        let started: GreetingStarted = try await request("POST", "/v1/greeting", body: ["timezone": timezone])
        return started.conversation
    }

    /// Ends the introduction early: the user would rather look around.
    func finishIntroduction() async throws {
        let _: Empty = try await request("POST", "/v1/greeting/done")
    }

    func getConversation(_ id: String) async throws -> Conversation {
        try await request("GET", "/v1/conversations/\(id)")
    }

    /// Only the given fields change. Pass `.some(nil)` to clear one (e.g. back to the default model).
    func updateConversation(_ id: String, title: String?? = nil, model: String?? = nil) async throws -> Conversation {
        var body: [String: Any?] = [:]
        if let title { body["title"] = title }
        if let model { body["model"] = model }
        return try await request("PATCH", "/v1/conversations/\(id)", body: body)
    }

    func deleteConversation(_ id: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/conversations/\(id)")
    }

    /// `hideQuiet` leaves out check-ins that came to nothing (servers without Home ignore it).
    func listMessages(_ conversationId: String, beforeSeq: Int? = nil, afterSeq: Int? = nil, limit: Int = 60, hideQuiet: Bool = false) async throws -> [Message] {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if hideQuiet { query.append(URLQueryItem(name: "quiet", value: "hide")) }
        if let beforeSeq { query.append(URLQueryItem(name: "before_seq", value: String(beforeSeq))) }
        if let afterSeq { query.append(URLQueryItem(name: "after_seq", value: String(afterSeq))) }
        let page: MessageList = try await request("GET", "/v1/conversations/\(conversationId)/messages", query: query)
        return page.messages
    }

    func compact(_ conversationId: String) async throws -> CompactResult {
        try await request("POST", "/v1/conversations/\(conversationId)/compact", body: [:])
    }

    // MARK: Runs

    /// Sends a message and streams the run it starts. Dropping the stream does not stop the run.
    /// `requestId` names this send: repeating it attaches to the run the first one started.
    func sendMessage(_ conversationId: String, text: String, model: String? = nil, timezone: String?, requestId: String? = nil, attachmentIds: [String] = [], quotes: [MessageQuote] = []) -> AsyncThrowingStream<RunEvent, Error> {
        var body: [String: Any?] = ["text": text, "stream": true]
        body["attachmentIds"] = attachmentIds
        body["quotes"] = quotes.map(\.json)
        if let requestId { body["requestId"] = requestId }
        if let model { body["model"] = model }
        if let timezone { body["timezone"] = timezone }
        return stream(makeRequest("POST", "/v1/conversations/\(conversationId)/messages", body: body))
    }

    /// Re-attaches to a run, replaying everything after `after`.
    func runEvents(_ runId: String, after: Int) -> AsyncThrowingStream<RunEvent, Error> {
        stream(makeRequest("GET", "/v1/runs/\(runId)/events", query: [URLQueryItem(name: "after", value: String(after))]))
    }

    /// Hands a run that is at work another message; it joins between two of its steps.
    /// Fails with 409 once the run is over.
    func steer(runId: String, text: String, timezone: String?, requestId: String, attachmentIds: [String] = [], quotes: [MessageQuote] = []) async throws -> RunDto {
        try await request("POST", "/v1/runs/\(runId)/messages", body: ["text": text, "timezone": timezone, "requestId": requestId, "attachmentIds": attachmentIds, "quotes": quotes.map(\.json)])
    }

    /// An extension can finish once the server durably accepts the message.
    func submitMessage(_ conversationId: String, text: String, attachmentIds: [String], timezone: String?, requestId: String) async throws -> RunDto {
        let accepted: AcceptedRun = try await request("POST", "/v1/conversations/\(conversationId)/messages", body: [
            "text": text, "attachmentIds": attachmentIds, "timezone": timezone, "requestId": requestId,
            "stream": false, "wait": false,
        ])
        return accepted.run
    }

    func uploadAttachment(_ pending: PendingAttachment) async throws -> Attachment {
        var request = makeRequest("POST", "/v1/attachments")
        request.setValue(pending.mediaType, forHTTPHeaderField: "Content-Type")
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        request.setValue(pending.filename.addingPercentEncoding(withAllowedCharacters: unreserved), forHTTPHeaderField: "X-Filename")
        request.setValue(pending.id, forHTTPHeaderField: "X-Request-ID")
        request.timeoutInterval = 120
        let (data, response) = try await session.upload(for: request, fromFile: pending.fileURL)
        try Self.check(response as! HTTPURLResponse, body: data)
        let attachment = try decoder.decode(Attachment.self, from: data)
        if let preview = pending.previewURL {
            var renditionRequest = makeRequest("PUT", "/v1/attachments/\(attachment.id)/preview")
            renditionRequest.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            renditionRequest.timeoutInterval = 120
            let (result, response) = try await session.upload(for: renditionRequest, fromFile: preview)
            try Self.check(response as! HTTPURLResponse, body: result)
        }
        return attachment
    }

    func downloadAttachment(_ attachment: Attachment) async throws -> URL {
        let request = makeRequest("GET", "/v1/attachments/\(attachment.id)/content")
        return try await downloadFile(request, filename: attachment.filename, mediaType: attachment.mediaType)
    }

    func getRun(_ id: String) async throws -> RunDto {
        try await request("GET", "/v1/runs/\(id)")
    }

    func cancelRun(_ id: String) async throws -> RunDto {
        try await request("POST", "/v1/runs/\(id)/cancel", body: [:])
    }

    /// Tells the server where to send notifications. Registering again is harmless.
    func registerDevice(token: String, environment: String) async throws -> DeviceRegistration {
        try await request("POST", "/v1/devices", body: ["token": token, "environment": environment])
    }

    func unregisterDevice(token: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/devices/\(token)")
    }

    /// Allows or denies a tool call the run is holding for confirmation.
    func resolveApproval(runId: String, toolCallId: String, approved: Bool) async throws -> RunDto {
        try await request("POST", "/v1/runs/\(runId)/approvals/\(toolCallId)", body: ["approved": approved])
    }

    // MARK: Browser hand-off

    /// The hand-off going on, if any: the agent's request, or one the user began.
    func browserHandoff() async throws -> BrowserHandoff? {
        let answer: HandoffAnswer = try await request("GET", "/v1/browser/handoff")
        return answer.handoff
    }

    /// Takes the browser: the agent's pending request becomes active, or a hand-off of the user's own begins.
    func takeBrowser() async throws -> BrowserHandoff {
        let answer: HandoffAnswer = try await request("POST", "/v1/browser/handoff", body: [:])
        guard let handoff = answer.handoff else { throw APIError.decoding("no hand-off") }
        return handoff
    }

    /// The page as the user holds it, laid out for `viewport` (the size it is shown at, in points)
    /// when that is given. `409` when they do not hold it.
    func browserScreen(viewport: CGSize? = nil) async throws -> BrowserScreen {
        let query = viewport.map { [
            URLQueryItem(name: "width", value: String(Int($0.width.rounded()))),
            URLQueryItem(name: "height", value: String(Int($0.height.rounded()))),
        ] } ?? []
        return try await screen(makeRequest("GET", "/v1/browser/handoff/screen", query: query))
    }

    /// The user's touch or typing on the page; answers with the page afterwards.
    func browserInput(_ input: BrowserInput) async throws -> BrowserScreen {
        try await screen(makeRequest("POST", "/v1/browser/handoff/input", body: input.body))
    }

    /// Hands the browser back (`done`), or declines to take it (`declined`).
    func endBrowserHandoff(outcome: String = "done", note: String? = nil) async throws {
        let _: Empty = try await request("POST", "/v1/browser/handoff/end", body: ["outcome": outcome, "note": note])
    }

    private func screen(_ request: URLRequest) async throws -> BrowserScreen {
        var request = request
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        let (data, response) = try await perform(request)
        let header = { (name: String) -> String in response.value(forHTTPHeaderField: name) ?? "" }
        let focused = response.value(forHTTPHeaderField: "X-Focus-Secret") != nil
        return BrowserScreen(
            image: data,
            width: Double(header("X-Screen-Width")) ?? 0,
            height: Double(header("X-Screen-Height")) ?? 0,
            url: header("X-Page-Url").removingPercentEncoding ?? "",
            title: header("X-Page-Title").removingPercentEncoding ?? "",
            focus: focused ? .init(secret: header("X-Focus-Secret") == "1", label: header("X-Focus-Label").removingPercentEncoding ?? "") : nil
        )
    }

    // MARK: Phone data

    func phoneSources() async throws -> PhoneSourceList {
        try await request("GET", "/v1/phone")
    }

    /// Replaces the server's copy of one source with this snapshot.
    @discardableResult
    func sendPhoneData<T: Encodable>(_ source: PhoneSource, _ snapshot: PhoneSnapshot<T>) async throws -> PhoneSourceStatus {
        let data = try JSONEncoder().encode(snapshot)
        let object = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return try await request("PUT", "/v1/phone/\(source.rawValue)", body: object)
    }

    /// Deletes the server's copy of one source.
    func removePhoneData(_ source: PhoneSource) async throws {
        let _: Empty = try await request("DELETE", "/v1/phone/\(source.rawValue)")
    }

    // MARK: Memory

    func listMemories(query: String? = nil, limit: Int = 100, offset: Int = 0) async throws -> MemoryPage {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        else { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        return try await request("GET", "/v1/memories", query: items)
    }

    func createMemory(content: String, kind: MemoryKind) async throws -> Memory {
        try await request("POST", "/v1/memories", body: ["content": content, "kind": kind.rawValue])
    }

    func updateMemory(_ id: String, content: String, kind: MemoryKind) async throws -> Memory {
        try await request("PATCH", "/v1/memories/\(id)", body: ["content": content, "kind": kind.rawValue])
    }

    func deleteMemory(_ id: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/memories/\(id)")
    }

    func coreMemory() async throws -> CoreMemory {
        try await request("GET", "/v1/core-memory")
    }

    func setCoreMemory(block: String, content: String) async throws -> String {
        let result: CoreBlockDto = try await request("PUT", "/v1/core-memory/\(block)", body: ["content": content])
        return result.content
    }

    // MARK: Logins

    func listLogins() async throws -> [Login] {
        let page: LoginList = try await request("GET", "/v1/logins")
        return page.logins
    }

    func createLogin(name: String, site: String, username: String, password: String, totpSecret: String) async throws -> Login {
        try await request("POST", "/v1/logins", body: ["name": name, "site": site, "username": username, "password": password, "totpSecret": totpSecret])
    }

    /// `nil` for the password or the one-time-code secret leaves the stored one as it is.
    func updateLogin(_ id: String, name: String, site: String, username: String, password: String?, totpSecret: String?) async throws -> Login {
        try await request("PATCH", "/v1/logins/\(id)", body: ["name": name, "site": site, "username": username, "password": password, "totpSecret": totpSecret])
    }

    func deleteLogin(_ id: String) async throws {
        let _: Empty = try await request("DELETE", "/v1/logins/\(id)")
    }

    // MARK: Plumbing

    private nonisolated struct ConversationList: Decodable { var conversations: [Conversation] }
    private nonisolated struct AcceptedRun: Decodable { var run: RunDto }
    private nonisolated struct MessageList: Decodable { var messages: [Message] }
    private nonisolated struct LoginList: Decodable { var logins: [Login] }
    private nonisolated struct CoreBlockDto: Decodable { var block: String; var content: String }
    private nonisolated struct ErrorBody: Decodable {
        nonisolated struct Inner: Decodable { var code: String; var message: String }
        var error: Inner
    }
    private nonisolated struct Empty: Decodable {}
    private nonisolated struct GreetingStarted: Decodable { var conversation: Conversation }
    private nonisolated struct HandoffAnswer: Decodable { var handoff: BrowserHandoff? }

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any?]? = nil) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = (components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path) + path
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let object = body.compactMapValues { $0 }
            request.httpBody = try? JSONSerialization.data(withJSONObject: object)
        }
        return request
    }

    private func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any?]? = nil) async throws -> T {
        let (data, response) = try await perform(makeRequest(method, path, query: query, body: body))
        if data.isEmpty || response.statusCode == 204, let empty = Empty() as? T { return empty }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        let http = response as! HTTPURLResponse
        try Self.check(http, body: data)
        return (data, http)
    }

    private func downloadFile(_ request: URLRequest, filename: String, mediaType: String, allowEmpty: Bool = false) async throws -> URL {
        // These endpoints cap files at 20 MiB. Save the bytes into our own file instead of
        // importing a CFNetwork temporary URL, which can fail with a sandbox permission error.
        let (data, _) = try await perform(request)
        try Task.checkCancellation()
        return try PendingAttachment.importData(data, filename: filename, mediaType: mediaType,
                                                makePreview: false, allowEmpty: allowEmpty).fileURL
    }

    private static func check(_ response: HTTPURLResponse, body: Data) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        if let parsed = try? JSONDecoder().decode(ErrorBody.self, from: body) {
            throw APIError.http(status: response.statusCode, code: parsed.error.code, message: parsed.error.message)
        }
        throw APIError.http(status: response.statusCode, code: "http_\(response.statusCode)", message: HTTPURLResponse.localizedString(forStatusCode: response.statusCode))
    }

    private func stream(_ request: URLRequest) -> AsyncThrowingStream<RunEvent, Error> {
        var request = request
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    let http = response as! HTTPURLResponse
                    if !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await byte in bytes { body.append(byte) }
                        try Self.check(http, body: body)
                    }
                    var parser = SSEParser()
                    let decoder = JSONDecoder()
                    var chunk: [UInt8] = []
                    chunk.reserveCapacity(1024)
                    for try await byte in bytes {
                        chunk.append(byte)
                        // Parse on line ends so a long delta is not split into many tiny updates.
                        if byte == UInt8(ascii: "\n") {
                            for event in parser.feed(chunk) {
                                if let decoded = Self.decodeEvent(event, decoder) { continuation.yield(decoded) }
                            }
                            chunk.removeAll(keepingCapacity: true)
                        }
                        try Task.checkCancellation()
                    }
                    for event in parser.feed(chunk) + [parser.flush()].compactMap({ $0 }) {
                        if let decoded = Self.decodeEvent(event, decoder) { continuation.yield(decoded) }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch let error as APIError {
                    continuation.finish(throwing: error)
                } catch {
                    continuation.finish(throwing: APIError.network(error.localizedDescription))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private nonisolated static func decodeEvent(_ event: SSEEvent, _ decoder: JSONDecoder) -> RunEvent? {
        guard !event.data.isEmpty else { return nil }
        var decoded = try? decoder.decode(RunEvent.self, from: Data(event.data.utf8))
        if decoded?.seq == 0, let id = event.id, let seq = Int(id) { decoded?.seq = seq }
        return decoded
    }
}

nonisolated struct OpenedDriveFile: Sendable {
    let entry: DriveEntry
    let url: URL

    var editableText: String? {
        let type = UTType(filenameExtension: url.pathExtension)
        let isText = entry.mediaType.hasPrefix("text/") || type?.conforms(to: .text) == true
            || ["application/json", "application/xml", "application/javascript", "application/yaml"].contains(entry.mediaType)
        let unknown = entry.mediaType == "application/octet-stream" && (type == nil || type?.isDynamic == true)
        guard isText || unknown, entry.sizeBytes <= 256 * 1024,
              let data = try? Data(contentsOf: url), !data.contains(where: { $0 < 32 && $0 != 9 && $0 != 10 && $0 != 13 }) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Revision-addressed copies, isolated by server and credentials. iOS may evict them too.
final class DriveFileCache {
    private let root: URL
    private let maximumBytes: Int
    private let maximumAge: TimeInterval = 7 * 24 * 60 * 60

    init(server: URL, credential: String, directory: URL? = nil, maximumBytes: Int = 100 * 1024 * 1024) {
        let caches = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        root = caches.appendingPathComponent("DriveFiles", isDirectory: true)
            .appendingPathComponent(Self.digest(server.absoluteString + "\n" + credential), isDirectory: true)
        self.maximumBytes = maximumBytes
        prune()
    }

    func cached(_ entry: DriveEntry) -> URL? {
        let url = location(entry)
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
              values.isRegularFile == true, Int64(values.fileSize ?? -1) == entry.sizeBytes else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.deletingLastPathComponent().path)
        prune(keeping: url.deletingLastPathComponent())
        return url
    }

    func store(_ data: Data, entry: DriveEntry) throws -> URL {
        guard data.count <= PendingAttachment.maxFileBytes, Int64(data.count) == entry.sizeBytes else {
            throw APIError.network("The file transfer was incomplete or too large. Try opening it again.")
        }
        let url = location(entry)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        prune(keeping: url.deletingLastPathComponent())
        return url
    }

    func clear() { try? FileManager.default.removeItem(at: root) }

    private func location(_ entry: DriveEntry) -> URL {
        // The API already validates names; retain a final local boundary as well.
        let name = (entry.name as NSString).lastPathComponent
        let safe = name.isEmpty || name == "." || name == ".." ? "File" : name
        return root.appendingPathComponent(Self.digest(entry.path + "\n" + entry.revision), isDirectory: true)
            .appendingPathComponent(safe)
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func prune(keeping: URL? = nil) {
        let fm = FileManager.default
        guard let folders = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let items = folders.map { folder -> (url: URL, date: Date, size: Int) in
            let date = (try? folder.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            let files = (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])) ?? []
            let size = files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) }
            return (folder, date, size)
        }.sorted { $0.date < $1.date }
        var total = items.reduce(0) { $0 + $1.size }
        for item in items where item.url != keeping {
            if total > maximumBytes || Date().timeIntervalSince(item.date) > maximumAge {
                do { try fm.removeItem(at: item.url); total -= item.size } catch { continue }
            }
        }
    }
}
