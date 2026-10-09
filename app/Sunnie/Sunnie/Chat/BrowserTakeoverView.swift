import SwiftUI

/// The agent's browser in the user's hands, used the way a browser is used: tap to click, drag to
/// scroll, pinch to zoom, and the keyboard comes up by itself when a text field on the page has
/// the focus (hidden entry for a password). Done hands the page back. Opened from a hand-off
/// request in the chat (a CAPTCHA, a sign-in) or from the chat menu.
struct BrowserTakeoverView: View {
    let client: SunnieClient
    let handoff: BrowserHandoff
    let agentName: String
    /// The hand-off is over — handed back here, or ended elsewhere — and the sheet goes.
    let onEnd: () -> Void

    @State private var screen: BrowserScreen?
    /// Where the page is shown, in points: the browser lays the page out for it, as a phone's own would.
    @State private var area: CGSize = .zero
    @State private var image: PlatformImage?
    @State private var reason: String?
    /// 1 is the page fitted to the screen; pinching goes up to `maxZoom`.
    @State private var zoom: CGFloat = 1
    @State private var pinchStart: CGFloat?
    /// A drag in progress, as the part of it not yet sent to the page.
    @State private var dragSent: CGSize = .zero
    @State private var pendingScroll: CGSize = .zero
    @State private var scrollOrigin: CGPoint = .zero
    /// What the user typed into the page's field from here, and the part of it the page has.
    @State private var typed = ""
    @State private var onPage = ""
    @State private var fieldKey: String?
    @State private var typingTask: Task<Void, Never>?
    @State private var sending = false
    @State private var ending = false
    @State private var lastInput: Date = .distantPast
    @State private var showsHint = true
    @State private var error: String?
    @FocusState private var keyboard: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private static let maxZoom: CGFloat = 4
    /// Pictures come every second; faster for a while after the user did something, when a page loads.
    private static let calmRefresh: Duration = .seconds(1)
    private static let busyRefresh: Duration = .milliseconds(350)
    private static let busyFor: TimeInterval = 5
    /// Every so many pictures, the hand-off itself is checked: the agent may have joined with a request.
    private static let checkEvery = 4

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                page(in: geometry.size)
                    .onAppear { area = geometry.size }
                    .onChange(of: geometry.size) { _, size in area = size }
            }
                .background(Color.systemGray6)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let reason { reasonBanner(reason) }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if let focus = screen?.focus { typingBar(focus) }
                }
                .overlay(alignment: .bottom) {
                    if showsHint, screen?.focus == nil, image != nil { hint }
                }
                .overlay(alignment: .bottomTrailing) {
                    if image != nil, screen?.focus == nil { zoomPill }
                }
                .navigationTitle(title)
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await end() } } label: {
                            if ending { ProgressView().controlSize(.small) } else { Text("Done").fontWeight(.semibold) }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(ending)
                        .accessibilityLabel("Done, hand the page back to \(agentName)")
                    }
                }
                .task { await follow() }
                .task {
                    try? await Task.sleep(for: .seconds(5))
                    withAnimation { showsHint = false }
                }
                .alert("Something went wrong", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                    Button("OK") {}
                } message: {
                    Text(error ?? "")
                }
        }
        .macSheetFrame(width: 1000, height: 820)
        // Handing back is explicit: swiping the sheet away would leave the agent waiting.
        .interactiveDismissDisabled()
        .onAppear { reason = handoff.reason }
    }

    private var title: String {
        guard let screen, !screen.url.isEmpty, let host = URL(string: screen.url)?.host() else { return "\(agentName)'s browser" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    // MARK: The page

    @ViewBuilder
    private func page(in size: CGSize) -> some View {
        if let image, let screen, screen.width > 0, screen.height > 0, size.width > 0, size.height > 0 {
            let fit = min(size.width / screen.width, size.height / screen.height)
            let scale = fit * zoom
            let fitted = zoom <= 1.001
            ScrollView([.horizontal, .vertical], showsIndicators: false) {
                Image(platformImage: image)
                    .resizable()
                    .frame(width: screen.width * scale, height: screen.height * scale)
                    .clipShape(RoundedRectangle(cornerRadius: fitted ? 10 : 0, style: .continuous))
                    .shadow(color: .black.opacity(fitted ? 0.08 : 0), radius: 8, y: 2)
                    .contentShape(Rectangle())
                    .onTapGesture { location in
                        showsHint = false
                        Task { await send(.tap(x: location.x / scale, y: location.y / scale)) }
                    }
                    .accessibilityLabel("The page \(screen.title)")
                    .accessibilityHint("Tap where you would tap on the page")
                    .frame(minWidth: size.width, minHeight: size.height)
            }
            // Fitted, a drag scrolls the page itself; zoomed in, it pans the picture.
            .scrollDisabled(fitted)
            .scrollBounceBehavior(.basedOnSize)
            .simultaneousGesture(pinch)
            .gesture(fitted ? scrollDrag(scale: scale) : nil)
        } else {
            VStack(spacing: 12) {
                ProgressView()
                Text("Opening \(agentName)'s browser…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var pinch: some Gesture {
        MagnifyGesture(minimumScaleDelta: 0.02)
            .onChanged { value in
                showsHint = false
                let start = pinchStart ?? zoom
                pinchStart = start
                zoom = min(Self.maxZoom, max(1, start * value.magnification))
            }
            .onEnded { _ in pinchStart = nil }
    }

    /// Dragging the fitted page scrolls the page under it, as it would on the phone's own browser.
    private func scrollDrag(scale: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                showsHint = false
                if dragSent == .zero { scrollOrigin = CGPoint(x: value.startLocation.x / scale, y: value.startLocation.y / scale) }
                let delta = CGSize(width: value.translation.width - dragSent.width, height: value.translation.height - dragSent.height)
                dragSent = value.translation
                pendingScroll.width -= delta.width / scale
                pendingScroll.height -= delta.height / scale
                Task { await flushScroll() }
            }
            .onEnded { _ in
                dragSent = .zero
                Task { await flushScroll() }
            }
    }

    private func flushScroll() async {
        guard !sending, pendingScroll != .zero else { return }
        let delta = pendingScroll
        pendingScroll = .zero
        await send(.scroll(x: scrollOrigin.x, y: scrollOrigin.y, dx: delta.width, dy: delta.height))
        // What was dragged while that was on its way.
        if pendingScroll != .zero { await flushScroll() }
    }

    // MARK: Around the page

    private func reasonBanner(_ reason: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "hand.tap.fill")
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(agentName) needs you here")
                    .font(.footnote.weight(.semibold))
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .accessibilityElement(children: .combine)
    }

    private var hint: some View {
        Text("Tap to click · Drag to scroll · Pinch to zoom")
            .font(.caption)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.regularMaterial, in: Capsule())
            .padding(.bottom, 14)
            .transition(.opacity)
            .accessibilityHidden(true)
    }

    private var zoomPill: some View {
        Button {
            withAnimation(.snappy) { zoom = zoom > 1.001 ? 1 : 2.5 }
        } label: {
            Image(systemName: zoom > 1.001 ? "arrow.down.right.and.arrow.up.left" : "plus.magnifyingglass")
                .font(.body)
                .frame(width: 40, height: 40)
                .background(.regularMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .padding(12)
        .accessibilityLabel(zoom > 1.001 ? "Fit the page to the screen" : "Zoom in")
    }

    /// The keyboard for the page's field. What is typed here goes onto the page as it is typed.
    private func typingBar(_ focus: BrowserScreen.Focus) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: focus.secret ? "lock.fill" : "character.cursor.ibeam")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text(focus.secret
                     ? "\(focus.label.isEmpty ? "Password" : focus.label) · hidden from \(agentName)"
                     : (focus.label.isEmpty ? "Typing into the page" : focus.label))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 8) {
                Group {
                    if focus.secret {
                        SecureField("Type here", text: $typed)
                    } else {
                        TextField("Type here", text: $typed)
                    }
                }
                .plainTextEntry()
                .textFieldStyle(.roundedBorder)
                .focused($keyboard)
                .submitLabel(.go)
                .onSubmit { Task { await flushTyping(); await send(.key("Enter")) } }
                .onChange(of: typed) { _, _ in scheduleTyping() }
                Button { Task { await flushTyping(); await send(.key("Tab")) } } label: {
                    Text("Next").frame(minHeight: 32)
                }
                .buttonStyle(.bordered)
                .accessibilityHint("Moves to the next field on the page")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .onAppear { keyboard = true }
        .onChange(of: fieldKey) { _, _ in keyboard = true }
    }

    // MARK: Talking to the page

    /// Pictures the page again and again, and notices when the hand-off ends elsewhere (the run
    /// was stopped, or it was handed back from another device).
    private func follow() async {
        var tick = 0
        while !Task.isCancelled {
            if !sending {
                if tick % Self.checkEvery == 0 {
                    guard await stillHeld() else { return }
                }
                let viewport = area.width > 0 && area.height > 0 ? area : nil
                guard await picture({ try await client.browserScreen(viewport: viewport) }) else { return }
            }
            tick += 1
            let busy = Date().timeIntervalSince(lastInput) < Self.busyFor
            try? await Task.sleep(for: busy ? Self.busyRefresh : Self.calmRefresh)
        }
    }

    /// False once the hand-off is over.
    private func stillHeld() async -> Bool {
        do {
            guard let current = try await client.browserHandoff(), current.isActive else {
                onEnd()
                return false
            }
            reason = current.reason
            return true
        } catch {
            // A missed check is nothing; the next picture says more.
            return true
        }
    }

    /// Takes a picture of the page; false once the hand-off is over.
    private func picture(_ fetch: () async throws -> BrowserScreen) async -> Bool {
        do {
            let fresh = try await fetch()
            screen = fresh
            image = PlatformImage(data: fresh.image)
            noticeFocus(fresh.focus)
            return true
        } catch let error as APIError where error.status == 409 || error.status == 404 {
            onEnd()
            return false
        } catch {
            // A picture that did not arrive is tried again; only something the user did is reported.
            return true
        }
    }

    /// A different field, or none, means what was typed so far belongs to the one before.
    private func noticeFocus(_ focus: BrowserScreen.Focus?) {
        let key = focus.map { "\($0.secret)|\($0.label)" }
        guard key != fieldKey else { return }
        fieldKey = key
        typed = ""
        onPage = ""
    }

    private func send(_ input: BrowserInput) async {
        guard !sending else { return }
        sending = true
        lastInput = Date()
        defer { sending = false }
        do {
            let fresh = try await client.browserInput(input)
            screen = fresh
            image = PlatformImage(data: fresh.image)
            noticeFocus(fresh.focus)
        } catch let error as APIError where error.status == 409 || error.status == 404 {
            onEnd()
        } catch is CancellationError {
            // The sheet went away under the request.
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Typing reaches the page a moment after the keys, in one piece rather than one request a key.
    /// Only the wait is cancellable: a key pressed while a request is on its way must not cut it off.
    private func scheduleTyping() {
        typingTask?.cancel()
        typingTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            Task { await flushTyping() }
        }
    }

    /// Sends what the page does not have yet. Anything deleted is handled by replacing the field's
    /// text whole (select all, type again), so the page ends up with exactly what is shown here.
    private func flushTyping() async {
        typingTask?.cancel()
        while sending { try? await Task.sleep(for: .milliseconds(50)) }
        guard !Task.isCancelled else { return }
        guard typed != onPage, let focus = screen?.focus else { return }
        let text = typed
        if text.hasPrefix(onPage) {
            await send(.text(String(text.dropFirst(onPage.count)), secret: focus.secret))
        } else {
            await send(.key("ControlOrMeta+A"))
            await send(text.isEmpty ? .key("Backspace") : .text(text, secret: focus.secret))
        }
        onPage = text
        // The page may have been given more while that was on its way.
        if typed != onPage { await flushTyping() }
    }

    private func end() async {
        ending = true
        await flushTyping()
        do {
            try await client.endBrowserHandoff(outcome: "done")
        } catch let error as APIError where error.status == 404 {
            // Already over.
        } catch {
            self.error = error.localizedDescription
            ending = false
            return
        }
        onEnd()
    }
}
