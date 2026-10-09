import Foundation
import Testing
@testable import Sunnie

struct NotificationTests {
    @Test func readsTheConversationBesideAps() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Flight to Tokyo", "body": "Found one for $842."]],
            "conversationId": "conv_1", "runId": "run_1", "kind": "reply",
        ]
        #expect(PushRoute.conversationId(from: userInfo) == "conv_1")
        #expect(PushRoute.conversationId(from: ["aps": [:]]) == nil)
        #expect(PushRoute.conversationId(from: ["conversationId": ""]) == nil)
    }

    @Test func tokenIsLowercaseHex() {
        #expect(PushRoute.token(Data([0x00, 0xAB, 0x10, 0xff])) == "00ab10ff")
    }

    @Test func noBannerForTheChatOnScreen() {
        #expect(!PushRoute.shouldShow(conversationId: "conv_1", visibleConversationId: "conv_1"))
        #expect(PushRoute.shouldShow(conversationId: "conv_1", visibleConversationId: "conv_2"))
        #expect(PushRoute.shouldShow(conversationId: "conv_1", visibleConversationId: nil))
        #expect(PushRoute.shouldShow(conversationId: nil, visibleConversationId: "conv_1"))
    }

    @Test func decodesRegistrationAndInfoFlag() throws {
        let registration = try JSONDecoder().decode(DeviceRegistration.self, from: Data(#"{"token":"00ab","environment":"sandbox","pushEnabled":false}"#.utf8))
        #expect(registration.pushEnabled == false)
        #expect(PushRoute.environment == "sandbox", "test builds are debug builds")
    }
}
