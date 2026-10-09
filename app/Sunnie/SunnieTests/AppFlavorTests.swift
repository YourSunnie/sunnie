import Foundation
import Testing
@testable import Sunnie

struct AppFlavorTests {
    @Test func hostedBuildReadsItsPanel() {
        let flavor = AppFlavor(info: ["SunnieFlavor": "hosted", "SunnieConnectHost": " panel.example.com "])
        #expect(flavor == AppFlavor(isHosted: true, connectHost: "panel.example.com"))
    }

    @Test(arguments: [
        [:],
        ["SunnieFlavor": "selfhosted", "SunnieConnectHost": ""],
        // An Info.plist whose build settings were not expanded.
        ["SunnieFlavor": "$(SUNNIE_FLAVOR)"],
        ["SunnieFlavor": ""],
    ] as [[String: String]])
    func anythingElseIsSelfHosted(info: [String: String]) {
        let flavor = AppFlavor(info: info)
        #expect(!flavor.isHosted)
        #expect(flavor.connectHost == nil)
    }
}
