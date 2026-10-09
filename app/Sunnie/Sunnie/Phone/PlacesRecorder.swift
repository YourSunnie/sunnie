import CoreLocation
import Foundation

/// Keeps the places the phone stays at, from iOS's visit monitoring. iOS hands visits over when it
/// notices them, relaunching the app in the background if need be, so monitoring is started again
/// at every launch while Places is shared. Stays are kept on the phone (30 days) and sent whole,
/// like any other source; turning Places off stops monitoring and forgets them.
final class PlacesRecorder: NSObject, CLLocationManagerDelegate {
    static let shared = PlacesRecorder()
    private static let logKey = "phone.places.log"

    private let manager = CLLocationManager()
    private var isMonitoring = false

    override init() {
        super.init()
        manager.delegate = self
    }

    /// Asks for location "Always", which visits need, and waits (a minute at most) for the answer
    /// when nothing was decided yet. A "While Using" answer still records visits while the app is open.
    func requestAccess() async throws {
        #if os(iOS)
        let canAsk = manager.authorizationStatus == .notDetermined || manager.authorizationStatus == .authorizedWhenInUse
        #else
        let canAsk = manager.authorizationStatus == .notDetermined
        #endif
        if canAsk {
            manager.requestAlwaysAuthorization()
        }
        for _ in 0..<120 where manager.authorizationStatus == .notDetermined {
            try await Task.sleep(for: .milliseconds(500))
        }
        switch manager.authorizationStatus {
        case .denied, .restricted: throw PhoneReadError.denied("your location")
        default: break
        }
    }

    func start() {
        guard !isMonitoring, CLLocationManager.authorizationStatus() != .denied else { return }
        isMonitoring = true
        manager.startMonitoringVisits()
    }

    func stop() {
        manager.stopMonitoringVisits()
        isMonitoring = false
        UserDefaults.standard.removeObject(forKey: Self.logKey)
    }

    /// The stays kept so far, newest first, with names looked up for a few that have none.
    func read(lookups: Int = 20) async -> PlacesData {
        var named: [Date: String] = [:]
        for visit in Self.loadLog() where visit.place == nil && named.count < lookups {
            named[visit.arrival] = await PlaceNamer.spot(latitude: visit.latitude, longitude: visit.longitude) ?? ""
        }
        // A visit may have come in while names were looked up: name the log as it is now.
        let log = Self.loadLog().map { visit in
            var visit = visit
            if visit.place == nil, let name = named[visit.arrival], !name.isEmpty { visit.place = name }
            return visit
        }
        Self.saveLog(log)
        return PlaceLog.data(log)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        // iOS uses distant dates for an arrival it did not see and a stay that has not ended.
        guard visit.arrivalDate != .distantPast else { return }
        let record = VisitRecord(
            arrival: visit.arrivalDate,
            departure: visit.departureDate == .distantFuture ? nil : visit.departureDate,
            latitude: visit.coordinate.latitude,
            longitude: visit.coordinate.longitude)
        Task { @MainActor in Self.saveLog(PlaceLog.adding(record, to: Self.loadLog())) }
    }

    private static func loadLog() -> [VisitRecord] {
        guard let data = UserDefaults.standard.data(forKey: logKey) else { return [] }
        return (try? JSONDecoder().decode([VisitRecord].self, from: data)) ?? []
    }

    private static func saveLog(_ log: [VisitRecord]) {
        if let data = try? JSONEncoder().encode(log) { UserDefaults.standard.set(data, forKey: logKey) }
    }
}
