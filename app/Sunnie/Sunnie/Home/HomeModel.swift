import Foundation
import Observation

/// The Home screen: loads the feed, asks the agent for a fresh brief, arranges and removes widgets.
/// Arranging happens on Home itself: a widget is dragged to its new place, and saved when dropped.
@Observable
final class HomeModel {
    private let client: SunnieClient
    private(set) var feed: HomeFeed?
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var isRequestingBrief = false
    @ObservationIgnored private var stateSaves: [String: Task<Void, Never>] = [:]
    var error: String?
    /// A short, non-error answer to the user's request, such as why a refresh did not start.
    var notice: String?
    /// Set while a widget is being dragged: a refresh then leaves the order the user is making alone.
    private(set) var dragStartedAt: Date?
    /// Whether the drag moved anything that is not saved yet.
    private var orderChanged = false

    init(client: SunnieClient) {
        self.client = client
    }

    /// What Home draws, in order. A widget written for a newer app is left out.
    var widgets: [HomeWidget] { arrangeable.filter { !$0.hidden } }
    /// Everything that can be arranged, hidden widgets included.
    var arrangeable: [HomeWidget] {
        feed?.widgets.filter { if case .unknown = $0.body.kind { false } else { true } } ?? []
    }
    var isBriefRunning: Bool { feed?.brief.running == true }
    var canRequestBrief: Bool { feed?.brief.enabled == true && !isBriefRunning && !isRequestingBrief }

    /// Nothing to show: the screen invites a first brief instead. Everything on Home is Sunnie's
    /// (or a program's) to put there; the app adds nothing of its own.
    var isEmpty: Bool { feed != nil && widgets.isEmpty }

    func refresh(checkIns: CheckInsModel? = nil) async {
        if let started = dragStartedAt {
            // A drag that never landed (dropped outside Home) still moved things: keep what the user did.
            // A long press let go without moving moved nothing, and is just forgotten.
            guard Date.now.timeIntervalSince(started) > 20 || !orderChanged else { return }
            if orderChanged { await saveOrder() } else { dragStartedAt = nil }
        }
        isLoading = true
        defer { isLoading = false; hasLoaded = true }
        do {
            let fresh = try await client.home(timezone: TimeZone.current.identifier)
            // Unchanged, nothing is drawn again; changed, each widget keeps its view and only what
            // it shows moves (the views are keyed by widget id).
            if fresh != feed { feed = fresh }
            error = nil
            await checkIns?.update(fresh.checkIns)
        } catch {
            if feed == nil { self.error = error.localizedDescription }
        }
    }

    func requestBrief(checkIns: CheckInsModel? = nil) async {
        guard canRequestBrief else { return }
        isRequestingBrief = true
        defer { isRequestingBrief = false }
        do {
            try await client.requestBrief(timezone: TimeZone.current.identifier)
        } catch let refused as APIError where refused.status == 409 {
            notice = refused.localizedDescription
        } catch {
            self.error = error.localizedDescription
            return
        }
        await refresh(checkIns: checkIns)
    }

    func remove(_ widget: HomeWidget) async {
        feed?.widgets.removeAll { $0.id == widget.id }
        do {
            try await client.removeWidget(widget.id)
        } catch let gone as APIError where gone.status == 404 {
            // Already gone: it expired or the agent removed it.
        } catch {
            self.error = error.localizedDescription
            await refresh()
        }
    }

    func beginDrag() {
        dragStartedAt = .now
    }

    /// Puts `id` where `target` is, on screen only; `saveOrder` keeps it.
    func move(_ id: String, onto target: String) {
        guard var widgets = feed?.widgets else { return }
        let order = HomeGrid.move(id, onto: target, in: widgets.map(\.id))
        guard order != widgets.map(\.id) else { return }
        widgets.sort { (order.firstIndex(of: $0.id) ?? 0) < (order.firstIndex(of: $1.id) ?? 0) }
        feed?.widgets = widgets
        orderChanged = true
    }

    /// Keeps what the user set in a widget's interactive parts, after a moment's pause.
    func saveState(_ id: String, _ state: [String: StateValue]) {
        if let index = feed?.widgets.firstIndex(where: { $0.id == id }) { feed?.widgets[index].state = state }
        stateSaves[id]?.cancel()
        stateSaves[id] = Task { [client] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            _ = try? await client.saveWidgetState(id, state: state)
        }
    }

    /// Saves the order on screen, and what is hidden.
    func saveOrder() async {
        dragStartedAt = nil
        orderChanged = false
        guard let widgets = feed?.widgets else { return }
        do {
            try await client.setHomeLayout(order: widgets.map(\.id), hidden: widgets.filter(\.hidden).map(\.id))
        } catch {
            self.error = error.localizedDescription
            await refresh()
        }
    }

    /// Whether Sunnie is redesigning any widget for a new width: Home looks again soon.
    var isResizing: Bool { feed?.widgets.contains(where: \.isResizing) == true }

    /// Picks a new width: shown at once, with the widget marked as resizing while Sunnie redesigns it.
    func resize(_ widget: HomeWidget, columns: Int) async {
        guard let index = feed?.widgets.firstIndex(where: { $0.id == widget.id }), widget.span != columns else { return }
        let previous = feed?.widgets[index]
        feed?.widgets[index].columns = columns
        feed?.widgets[index].resizing = true
        do {
            let resized = try await client.resizeWidget(widget.id, columns: columns, timezone: TimeZone.current.identifier)
            if let at = feed?.widgets.firstIndex(where: { $0.id == widget.id }) { feed?.widgets[at] = resized }
        } catch {
            if let previous, let at = feed?.widgets.firstIndex(where: { $0.id == widget.id }) { feed?.widgets[at] = previous }
            if let refused = error as? APIError, refused.status == 409 { notice = refused.localizedDescription } else { self.error = error.localizedDescription }
        }
    }

    func setHidden(_ widget: HomeWidget, _ hidden: Bool) async {
        guard let index = feed?.widgets.firstIndex(where: { $0.id == widget.id }) else { return }
        feed?.widgets[index].hidden = hidden
        await saveOrder()
    }

    func conversation(_ id: String) async -> Conversation? {
        do {
            return try await client.getConversation(id)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }
}
