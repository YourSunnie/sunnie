#if os(iOS)
import XCTest

/// Drives the real app against a running server. Opt-in: skipped unless the test runner has
/// SUNNIE_LIVE_URL and SUNNIE_LIVE_KEY (pass them as TEST_RUNNER_SUNNIE_LIVE_URL=… to xcodebuild).
/// SUNNIE_SHOTS names a directory to save screenshots into.
///
/// The server's model must be the scripted fake provider from api/test/fake-provider.ts, so
/// "run: <cmd>" makes it call the shell tool and "slow" makes it stall until cancelled. It must
/// also hold every tool call for approval: point the risk filter at a Jev that does not answer
/// (`router: { baseURL: "http://127.0.0.1:9/v1", apiKey: "none" }`, `approvals: { type: "jev" }`).
final class SmokeUITests: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let url = env["SUNNIE_LIVE_URL"], let key = env["SUNNIE_LIVE_KEY"] else {
            throw XCTSkip("Set SUNNIE_LIVE_URL and SUNNIE_LIVE_KEY to run the live smoke test")
        }
        shots = env["SUNNIE_SHOTS"].map { URL(fileURLWithPath: $0) }
        app = XCUIApplication()
        // The test walks the list of conversations, which one chat (the default) replaces.
        app.launchArguments += ["-chat.single", "NO"]
        app.launch()
        connectIfNeeded(url: url, key: key)
    }

    private func shoot(_ name: String) {
        guard let shots else { return }
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        try? png.write(to: shots.appendingPathComponent("\(name).png"))
    }

    /// Taps until the element has keyboard focus (the first tap can land mid-transition), then types.
    private func type(_ text: String, into element: XCUIElement) {
        for _ in 0..<3 {
            element.tap()
            if element.waitForFocus(timeout: 1) { break }
        }
        app.typeText(text)
    }

    private func connectIfNeeded(url: String, key: String) {
        let urlField = app.textFields["http://192.168.1.10:8787"]
        guard urlField.waitForExistence(timeout: 5) else { return }
        shoot("01-connect")
        type(url, into: urlField)
        type(key, into: app.secureTextFields["API key"])
        app.buttons["Connect"].tap()
        dismissSavePasswordPrompt()
        XCTAssertTrue(app.tabBars.buttons["Chats"].waitForExistence(timeout: 10), "connect should land on the Chats tab")
    }

    /// iOS offers to keep a just-typed secret in Passwords; the sheet covers the app until answered.
    private func dismissSavePasswordPrompt() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let candidates = [app.buttons["Not Now"], springboard.buttons["Not Now"]]
        // The sheet can take a few seconds to appear, from either process; poll both together.
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            if let candidate = candidates.first(where: { $0.exists }) {
                candidate.tap()
                // It fades out over the app; a tap made before it is gone is swallowed.
                _ = candidate.waitForNonExistence(timeout: 5)
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
    }

    func testChatMemoryAndSettingsFlows() throws {
        // Home is the first tab; on a server with nothing yet it invites the first brief.
        if app.tabBars.buttons["Home"].waitForExistence(timeout: 5) {
            XCTAssertTrue(app.staticTexts["Your day, at a glance"].waitForExistence(timeout: 10), "an empty Home explains itself")
            shoot("01b-home-empty")
            app.tabBars.buttons["Chats"].tap()
        }

        // A fresh chat, created on the first send.
        // Retried: the "Save Password?" sheet can still be fading out and swallow the first tap.
        let composer = app.textFields["Message"]
        for _ in 0..<3 where !composer.exists {
            app.buttons["New conversation"].firstMatch.tap()
            _ = composer.waitForExistence(timeout: 3)
        }
        shoot("02-empty-chat")
        XCTAssertTrue(composer.exists)
        type("run: echo sunshine", into: composer)
        app.buttons["Send"].tap()

        // The fake model calls the shell tool; the server holds the call until it is allowed.
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 20), "a held tool call should ask for approval")
        XCTAssertTrue(app.staticTexts["echo sunshine"].exists, "the held call shows what it would run")
        shoot("03-approval")
        app.buttons["Allow"].tap()

        // Allowed, it runs, and the model reports the result.
        XCTAssertTrue(app.staticTexts["Tool said: sunshine"].waitForExistence(timeout: 20), "tool call round trip should render")
        XCTAssertTrue(app.staticTexts["Ran a command"].exists, "the tool call folds into one line")
        XCTAssertFalse(app.staticTexts["Shell"].exists, "tool details stay hidden until asked for")
        shoot("03b-after-tool-turn")
        app.staticTexts["Ran a command"].tap()
        XCTAssertTrue(app.staticTexts["Shell"].waitForExistence(timeout: 3), "tapping the line shows the tool row")
        XCTAssertTrue(app.staticTexts["echo sunshine"].exists, "the tool row shows the command")
        shoot("04-tool-expanded")
        app.staticTexts["Ran a command"].tap()

        // A denied call does not run; the model is told so.
        type("run: echo nope", into: composer)
        app.buttons["Send"].tap()
        XCTAssertTrue(app.buttons["Deny"].waitForExistence(timeout: 20))
        app.buttons["Deny"].tap()
        let declined = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "The user declined this action")).firstMatch
        XCTAssertTrue(declined.waitForExistence(timeout: 20), "a denied call is reported, not run")
        XCTAssertFalse(app.buttons["Allow"].exists)
        shoot("04b-denied")

        // A stalled answer can be stopped from the composer.
        type("slow", into: composer)
        app.buttons["Send"].tap()
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Thinking"].waitForExistence(timeout: 10), "streamed text appears before the stop")
        shoot("05-streaming")
        app.buttons["Stop"].tap()
        XCTAssertTrue(app.staticTexts["Stopped."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5))
        shoot("06-stopped")

        // Conversation options: rename.
        app.buttons["Conversation options"].tap()
        app.buttons["Rename"].tap()
        let title = app.textFields["Title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        type("Smoke test", into: title)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.navigationBars["Smoke test"].waitForExistence(timeout: 5))

        // Back to the list: the conversation is there with its title.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["Smoke test"].waitForExistence(timeout: 5))
        shoot("07-list")

        // Reopening shows persisted history, not a blank screen.
        app.staticTexts["Smoke test"].tap()
        XCTAssertTrue(app.staticTexts["Tool said: sunshine"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Memory lives in Drive as a folder of its own: add one, see it listed, edit it.
        app.tabBars.buttons["Drive"].tap()
        let memoryFolder = app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Memory'")).firstMatch
        XCTAssertTrue(memoryFolder.waitForExistence(timeout: 10))
        memoryFolder.tap()
        app.buttons["Add memory"].tap()
        let content = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields["Something worth remembering"]
        XCTAssertTrue(content.waitForExistence(timeout: 5))
        type("Likes strong coffee", into: content)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Likes strong coffee"].waitForExistence(timeout: 10))
        shoot("08-memory")
        app.staticTexts["Likes strong coffee"].tap()
        XCTAssertTrue(app.navigationBars["Edit memory"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()

        // Core memory editor opens with the block's limit shown.
        app.staticTexts["User"].tap()
        XCTAssertTrue(app.navigationBars["User"].waitForExistence(timeout: 5))
        shoot("09-core-memory")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Settings shows what the server said about itself.
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Default model"].waitForExistence(timeout: 5))
        shoot("10-settings")

        // Logins: save one, see it listed without its password, reopen it.
        app.buttons["Logins"].tap()
        app.buttons["Add login"].tap()
        let site = app.textFields["Site, e.g. github.com"]
        XCTAssertTrue(site.waitForExistence(timeout: 5))
        type("smoke.example", into: site)
        type("adit", into: app.textFields["Username or email"])
        type("hunter2-pass", into: app.secureTextFields["Password"])
        shoot("11-login-editor")
        app.buttons["Save"].tap()
        dismissSavePasswordPrompt()
        XCTAssertTrue(app.staticTexts["smoke.example"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["hunter2-pass"].exists)
        shoot("12-logins")
        app.staticTexts["smoke.example"].tap()
        XCTAssertTrue(app.navigationBars["Edit login"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["Password (unchanged)"].exists, "a saved password is never shown again")
        app.buttons["Cancel"].tap()
    }

    /// Needs a second server: SUNNIE_LIVE_URL2 and SUNNIE_LIVE_KEY2. Ends where it started: on the
    /// first server, which is the only one saved.
    func testSwitchingBetweenSavedServers() throws {
        let env = ProcessInfo.processInfo.environment
        guard let first = env["SUNNIE_LIVE_URL"], let firstKey = env["SUNNIE_LIVE_KEY"],
              let second = env["SUNNIE_LIVE_URL2"], let secondKey = env["SUNNIE_LIVE_KEY2"] else {
            throw XCTSkip("Set SUNNIE_LIVE_URL2 and SUNNIE_LIVE_KEY2 to a second server to test switching")
        }
        let firstRow = app.buttons["Server \(address(first))"]
        let secondRow = app.buttons["Server \(address(second))"]

        openSettings()
        shoot("20-servers")
        try addServer(second, key: secondKey)

        // Connecting switched to it: the tabs start over, and Settings marks it as current.
        openSettings()
        scrollTo(secondRow)
        XCTAssertTrue(secondRow.isSelected)
        XCTAssertFalse(firstRow.isSelected)
        shoot("22-on-second")

        firstRow.tap()
        XCTAssertTrue(firstRow.waitForNonExistence(timeout: 10), "switching starts the tabs over")
        openSettings()
        scrollTo(firstRow)
        XCTAssertTrue(firstRow.isSelected, "switching back needs no typing")
        shoot("23-back-on-first")

        // Disconnecting removes the current server; the connect screen offers the ones left.
        let disconnect = app.buttons["Disconnect"]
        scrollTo(disconnect)
        disconnect.tap()
        let confirm = app.buttons.matching(identifier: "Disconnect")
        XCTAssertTrue(confirm.element(boundBy: 1).waitForExistence(timeout: 5), "the confirmation offers its own Disconnect")
        confirm.allElementsBoundByIndex.last { $0.isHittable }?.tap()
        XCTAssertTrue(secondRow.waitForExistence(timeout: 10))
        XCTAssertFalse(firstRow.exists)
        shoot("24-connect-with-saved")
        secondRow.tap()
        openSettings()
        scrollTo(secondRow)
        XCTAssertTrue(secondRow.isSelected)

        try addServer(first, key: firstKey)
        openSettings()
        scrollTo(secondRow)
        XCTAssertTrue(firstRow.isSelected)
        secondRow.swipeLeft()
        app.buttons["Remove"].tap()
        XCTAssertTrue(secondRow.waitForNonExistence(timeout: 5))
        XCTAssertTrue(firstRow.exists, "the current server cannot be removed by a swipe")
    }

    private func addServer(_ url: String, key: String) throws {
        let add = app.buttons["Add server"]
        scrollTo(add)
        add.tap()
        XCTAssertTrue(app.navigationBars["Add server"].waitForExistence(timeout: 5))
        let urlField = app.textFields.matching(identifier: "http://192.168.1.10:8787").allElementsBoundByIndex.first { $0.isHittable }
        type(url, into: try XCTUnwrap(urlField))
        type(key, into: app.secureTextFields["API key"])
        shoot("21-add-server")
        app.navigationBars["Add server"].buttons["Connect"].tap()
        dismissSavePasswordPrompt()
        XCTAssertTrue(app.navigationBars["Add server"].waitForNonExistence(timeout: 10), "a working server closes the sheet")
    }

    private func address(_ text: String) -> String {
        let url = URL(string: text.contains("://") ? text : "http://" + text)!
        return url.host()! + (url.port.map { ":\($0)" } ?? "")
    }

    /// Short drags without momentum, so a row in the middle of a long form is not scrolled past.
    private func scrollTo(_ element: XCUIElement) {
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        for _ in 0..<20 where !(element.exists && element.isHittable) {
            bottom.press(forDuration: 0.1, thenDragTo: top)
        }
        XCTAssertTrue(element.isHittable, "\(element) should be on screen")
    }

    /// The tabs are rebuilt after a switch, and a tap made while that settles is lost.
    private func openSettings() {
        for _ in 0..<5 where !app.navigationBars["Settings"].exists {
            app.tabBars.buttons["Settings"].tap()
            _ = app.navigationBars["Settings"].waitForExistence(timeout: 2)
        }
        XCTAssertTrue(app.navigationBars["Settings"].exists)
    }
}

private extension XCUIElement {
    func waitForFocus(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (value(forKey: "hasKeyboardFocus") as? Bool) == true { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return false
    }
}
#endif
