#if os(macOS)
import XCTest

/// The Mac app against a running server, as `SmokeUITests` drives the iOS one: the same server
/// (the scripted fake provider, every tool call held), the same flows, reached the Mac's way —
/// the sidebar, the menu bar and the keyboard. Opt-in: skipped unless the test runner has
/// SUNNIE_LIVE_URL and SUNNIE_LIVE_KEY (pass them as TEST_RUNNER_SUNNIE_LIVE_URL=… to xcodebuild).
/// SUNNIE_SHOTS names a directory to save screenshots of the window into.
final class MacSmokeUITests: XCTestCase {
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
        app.activate()
        connectIfNeeded(url: url, key: key)
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Kept in the test result too: the runner may not be allowed to write to `shots`.
    private func shoot(_ name: String) {
        let shot = app.windows.firstMatch.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "mac-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let shots else { return }
        try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        try? shot.pngRepresentation.write(to: shots.appendingPathComponent("mac-\(name).png"))
    }

    /// Anything showing `text`, whatever AppKit made of it (a label, a text view's value, a row).
    private func shown(_ text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@ OR value == %@ OR title == %@", text, text, text)).firstMatch
    }

    private func shown(containing text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
    }

    /// Clicks until the element has keyboard focus (the first click can only bring the window
    /// forward), then types.
    private func type(_ text: String, into element: XCUIElement) {
        for _ in 0..<3 {
            element.click()
            if element.waitForFocus(timeout: 1) { break }
        }
        app.typeText(text)
    }

    /// A row of the sidebar, by its title.
    private func sidebar(_ title: String) -> XCUIElement {
        app.outlines.firstMatch.staticTexts[title]
    }

    private func connectIfNeeded(url: String, key: String) {
        let urlField = app.textFields["http://192.168.1.10:8787"]
        guard urlField.waitForExistence(timeout: 5) else { return }
        shoot("01-connect")
        type(url, into: urlField)
        type(key, into: app.secureTextFields["API key"])
        app.buttons.matching(identifier: "Connect").firstMatch.click()
        XCTAssertTrue(sidebar("Settings").waitForExistence(timeout: 10), "connect should land in the sidebar window")
    }

    func testChatMemoryAndSettingsFlows() throws {
        // Home is selected first; on a server with nothing yet it invites the first brief.
        if sidebar("Home").waitForExistence(timeout: 5) {
            XCTAssertTrue(shown("Your day, at a glance").waitForExistence(timeout: 10), "an empty Home explains itself")
            shoot("02-home-empty")
        }

        // ⌘N: a fresh chat, created on the first send. Return sends.
        app.typeKey("n", modifierFlags: .command)
        let composer = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "⌘N opens a new chat with the composer")
        shoot("03-empty-chat")
        type("run: echo sunshine", into: composer)
        app.typeKey(.return, modifierFlags: [])

        // The fake model calls the shell tool; the server holds the call until it is allowed.
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 20), "a held tool call should ask for approval")
        XCTAssertTrue(shown("echo sunshine").exists, "the held call shows what it would run")
        shoot("04-approval")
        app.buttons["Allow"].click()

        // Allowed, it runs, and the model reports the result.
        XCTAssertTrue(shown(containing: "Tool said: sunshine").waitForExistence(timeout: 20), "tool call round trip should render")
        XCTAssertTrue(shown("Ran a command").exists, "the tool call folds into one line")
        shoot("05-after-tool-turn")
        shown("Ran a command").click()
        XCTAssertTrue(shown("Shell").waitForExistence(timeout: 3), "clicking the line shows the tool row")
        shoot("06-tool-expanded")
        shown("Ran a command").click()

        // The created chat joined the sidebar, still on the same screen.
        XCTAssertTrue(app.outlines.firstMatch.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "echo sunshine")).firstMatch
            .waitForExistence(timeout: 10) || app.outlines.firstMatch.cells.count > 3, "the new conversation is listed")

        // A denied call does not run; the model is told so.
        type("run: echo nope", into: composer)
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.buttons["Deny"].waitForExistence(timeout: 20))
        app.buttons["Deny"].click()
        XCTAssertTrue(shown(containing: "The user declined this action").waitForExistence(timeout: 20), "a denied call is reported, not run")
        XCTAssertFalse(app.buttons["Allow"].exists)
        shoot("07-denied")

        // A stalled answer can be stopped from the composer.
        type("slow", into: composer)
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 10))
        XCTAssertTrue(shown(containing: "Thinking").waitForExistence(timeout: 10), "streamed text appears before the stop")
        shoot("08-streaming")
        app.buttons["Stop"].click()
        XCTAssertTrue(shown(containing: "Stopped.").waitForExistence(timeout: 10))
        shoot("09-stopped")

        // Conversation options: rename.
        let options = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND (elementType == %d OR elementType == %d)",
                                                                           "Conversation options",
                                                                           XCUIElement.ElementType.menuButton.rawValue,
                                                                           XCUIElement.ElementType.popUpButton.rawValue)).firstMatch
        XCTAssertTrue(options.waitForExistence(timeout: 5))
        options.click()
        app.menuItems["Rename"].click()
        let title = app.textFields["Title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        type("Smoke test", into: title)
        app.buttons["Save"].click()
        XCTAssertTrue(sidebar("Smoke test").waitForExistence(timeout: 40), "the renamed chat shows in the sidebar")
        shoot("10-renamed")

        // Leaving and coming back shows persisted history, not a blank screen.
        sidebar("Settings").click()
        XCTAssertTrue(shown("Model for new chats").waitForExistence(timeout: 5), "Settings shows what the server said about itself")
        shoot("11-settings")
        sidebar("Smoke test").click()
        XCTAssertTrue(shown(containing: "Tool said: sunshine").waitForExistence(timeout: 10))

        // Memory lives in Drive as a folder of its own: add one, see it listed.
        sidebar("Drive").click()
        let memoryFolder = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Memory'")).firstMatch
        XCTAssertTrue(memoryFolder.waitForExistence(timeout: 10))
        shoot("12-drive")
        memoryFolder.click()
        let add = app.buttons["Add memory"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.click()
        let content = app.textViews.firstMatch.waitForExistence(timeout: 3) ? app.textViews.firstMatch : app.textFields["Something worth remembering"]
        XCTAssertTrue(content.waitForExistence(timeout: 5))
        type("Likes strong coffee", into: content)
        shoot("13-memory-editor")
        app.buttons["Save"].click()
        XCTAssertTrue(shown(containing: "Likes strong coffee").waitForExistence(timeout: 10))
        shoot("14-memory")

        // ⌘, opens Settings in the window; Logins: save one, see it listed without its password.
        app.typeKey(",", modifierFlags: .command)
        let logins = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Logins'")).firstMatch
        XCTAssertTrue(logins.waitForExistence(timeout: 5), "⌘, shows Settings")
        logins.click()
        app.buttons["Add login"].click()
        let site = app.textFields["Site, e.g. github.com"]
        XCTAssertTrue(site.waitForExistence(timeout: 5))
        type("smoke.example", into: site)
        type("adit", into: app.textFields["Username or email"])
        type("hunter2-pass", into: app.secureTextFields["Password"])
        shoot("15-login-editor")
        app.buttons["Save"].click()
        XCTAssertTrue(shown("smoke.example").waitForExistence(timeout: 10))
        XCTAssertFalse(shown("hunter2-pass").exists)
        shoot("16-logins")
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
