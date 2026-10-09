#if os(iOS)
import BackgroundTasks
#endif
import Foundation

/// Keeps what the phone shares from going stale while the app is closed. iOS decides when: an
/// app refresh now and then for everything but the town, and HealthKit waking the app (at most
/// hourly) when new Health data is saved. Location is sent only while the app is in use, which is
/// what the user allowed for it; Places has its own "Always" permission and its own log. A
/// background launch has no views, so the model is built from the saved settings each time; what
/// was sent when is shared through UserDefaults.
enum PhoneBackground {
    static let refreshTask = "com.yoursunnie.Sunnie.phone-refresh"
    /// What may be read without the app on screen: everything but the town, which needs the app in use.
    static let backgroundSources: [String] = PhoneSource.allCases.filter { $0 != .location }.map(\.rawValue)

    private static var watchingHealth = false

    /// The model for the server the app is connected to, if any.
    static func model() -> PhoneModel? {
        let settings = ServerSettings.load()
        guard settings.isConfigured, let url = settings.baseURL else { return nil }
        return PhoneModel(client: SunnieClient(baseURL: url, apiKey: settings.apiKey))
    }

    /// Asks iOS for the next refresh. Asking again replaces the earlier request. A Mac app is not
    /// suspended in the background, so there it sends on a timer instead (`keepSending`).
    static func schedule() {
        #if os(iOS)
        guard let model = model(), !model.enabled.isEmpty else { return }
        let request = BGAppRefreshTaskRequest(identifier: refreshTask)
        request.earliestBeginDate = .now.addingTimeInterval(PhoneSchedule.interval(for: .calendar))
        try? BGTaskScheduler.shared.submit(request)
        #endif
    }

    #if os(macOS)
    /// While Sunnie runs on the Mac, what is due is sent every quarter of an hour, window open or
    /// not; each source still goes no more often than `PhoneSchedule` allows.
    static func keepSending(_ phone: PhoneModel, supported: [String]) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(15 * 60))
            guard !Task.isCancelled else { return }
            await phone.sendDue(supported: supported)
        }
    }
    #endif

    /// The app refresh: send what is due, then ask for the next one.
    static func refresh() async {
        schedule()
        await model()?.sendDue(supported: backgroundSources)
    }

    /// Starts what must be running at every launch for what is shared: HealthKit's wake-ups and
    /// the visit log.
    static func resume() {
        watchHealthIfShared()
        if model()?.enabled.contains(.places) == true { PlacesRecorder.shared.start() }
    }

    /// Starts HealthKit's wake-ups when Health is shared. Called at every launch, because iOS
    /// delivers them only to observers set up again after the app is started.
    static func watchHealthIfShared() {
        guard !watchingHealth, model()?.enabled.contains(.health) == true else { return }
        watchingHealth = true
        HealthReader.watch {
            await model()?.sendDue(supported: [PhoneSource.health.rawValue])
        }
    }
}
