import Foundation
import Observation

/// What this iPhone shares with the server: which sources the user turned on (remembered per
/// server), sending them when the app comes to the front, and withdrawing one that is turned off.
@Observable
final class PhoneModel {
    private let client: SunnieClient
    private let defaults: UserDefaults
    private let key: String
    private(set) var enabled: Set<PhoneSource>
    /// What the server holds, by source, including copies from before a reinstall.
    private(set) var statuses: [PhoneSource: PhoneSourceStatus] = [:]
    /// Sources being read, sent, asked for or withdrawn right now.
    private(set) var busy: Set<PhoneSource> = []
    /// Sources waiting for the user's answer to iOS's permission prompt.
    private(set) var asking: Set<PhoneSource> = []
    var errors: [PhoneSource: String] = [:]
    private var lastSent: [PhoneSource: Date]

    init(client: SunnieClient, defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
        key = "phone.\(client.baseURL.absoluteString)"
        enabled = Set((defaults.stringArray(forKey: "\(key).sources") ?? []).compactMap(PhoneSource.init(rawValue:)))
        let sent = defaults.dictionary(forKey: "\(key).sent") as? [String: Date] ?? [:]
        lastSent = Dictionary(uniqueKeysWithValues: sent.compactMap { k, v in PhoneSource(rawValue: k).map { ($0, v) } })
    }

    /// Turning a source on asks iOS for permission and sends it; turning it off deletes the server's copy.
    func setEnabled(_ source: PhoneSource, _ on: Bool) async {
        errors[source] = nil
        if on {
            asking.insert(source)
            do {
                try await requestAccess(source)
            } catch {
                asking.remove(source)
                errors[source] = error.localizedDescription
                return
            }
            asking.remove(source)
            enabled.insert(source)
            saveEnabled()
            await send(source)
            PhoneBackground.watchHealthIfShared()
            PhoneBackground.schedule()
        } else {
            enabled.remove(source)
            lastSent[source] = nil
            if source == .places { PlacesRecorder.shared.stop() }
            saveEnabled()
            saveSent(source, nil)
            await withdraw(source)
        }
    }

    /// Deletes what the server holds for a source, as when it is turned off.
    func withdraw(_ source: PhoneSource) async {
        busy.insert(source)
        defer { busy.remove(source) }
        do {
            try await client.removePhoneData(source)
            statuses[source] = nil
        } catch {
            errors[source] = error.localizedDescription
        }
    }

    /// Sends each source that is on and has not been sent recently. `supported`: the server's list.
    func sendDue(supported: [String]) async {
        // Another model (a background launch) may have sent since this one was made.
        let sent = defaults.dictionary(forKey: "\(key).sent") as? [String: Date] ?? [:]
        for source in PhoneSource.allCases where enabled.contains(source) && supported.contains(source.rawValue) {
            let last = [lastSent[source], sent[source.rawValue]].compactMap { $0 }.max()
            if PhoneSchedule.isDue(source, lastSent: last) { await send(source) }
        }
    }

    func sendAll() async {
        for source in PhoneSource.allCases where enabled.contains(source) { await send(source) }
    }

    func refresh() async {
        guard let list = try? await client.phoneSources() else { return }
        statuses = Dictionary(list.sources.compactMap { s in PhoneSource(rawValue: s.source).map { ($0, s) } }, uniquingKeysWith: { a, _ in a })
    }

    private func send(_ source: PhoneSource) async {
        guard !busy.contains(source) else { return }
        busy.insert(source)
        defer { busy.remove(source) }
        let capturedAt = Date.now.ISO8601Format()
        let zone = TimeZone.current.identifier
        do {
            let status: PhoneSourceStatus
            switch source {
            case .health:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: try await HealthReader.read()))
            case .calendar:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: try CalendarReader.read()))
            case .reminders:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: try await RemindersReader.read()))
            case .location:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: try await LocationReader.read()))
            case .contacts:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: try await ContactsReader.read()))
            case .places:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: await PlacesRecorder.shared.read()))
            case .music:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: try await MusicReader.read()))
            case .photos:
                status = try await client.sendPhoneData(source, PhoneSnapshot(capturedAt: capturedAt, timeZone: zone, data: try await PhotosReader.read()))
            }
            statuses[source] = status
            lastSent[source] = .now
            errors[source] = nil
            saveSent(source, .now)
        } catch {
            errors[source] = error.localizedDescription
        }
    }

    private func requestAccess(_ source: PhoneSource) async throws {
        switch source {
        case .health: try await HealthReader.requestAccess()
        case .calendar: try await CalendarReader.requestAccess()
        case .reminders: try await RemindersReader.requestAccess()
        // Asked for by the first read, which is the only way Core Location prompts now.
        case .location: break
        case .contacts: try await ContactsReader.requestAccess()
        case .places:
            try await PlacesRecorder.shared.requestAccess()
            PlacesRecorder.shared.start()
        case .music: try await MusicReader.requestAccess()
        case .photos: try await PhotosReader.requestAccess()
        }
    }

    private func saveEnabled() {
        defaults.set(enabled.map(\.rawValue).sorted(), forKey: "\(key).sources")
    }

    /// Merged into what is stored, not written whole: a background launch has a model of its
    /// own, and neither may undo what the other recorded.
    private func saveSent(_ source: PhoneSource, _ date: Date?) {
        var sent = defaults.dictionary(forKey: "\(key).sent") as? [String: Date] ?? [:]
        sent[source.rawValue] = date
        defaults.set(sent, forKey: "\(key).sent")
    }
}
