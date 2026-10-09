import Foundation
import Testing
@testable import Sunnie

struct ConnectLinkTests {
    @Test func scannedCodeIsItsOwnLink() {
        #expect(ConnectLink.parse(" https://panel.example.com/c/AbC123\n")?.absoluteString == "https://panel.example.com/c/AbC123")
    }

    @Test func openedAppLinkCarriesTheLink() {
        let opened = "sunnie://connect?link=https%3A%2F%2Fpanel.example.com%2Fc%2FAbC123"
        #expect(ConnectLink.parse(opened)?.absoluteString == "https://panel.example.com/c/AbC123")
    }

    @Test(arguments: [
        "",
        "hello",
        "https://example.com/",
        "https://example.com/menu.pdf",
        "https://example.com/c/",
        "ftp://example.com/c/AbC123",
        "sunnie://connect",
        "sunnie://other?link=https%3A%2F%2Fpanel.example.com%2Fc%2FAbC123",
        "sunnie://connect?link=https%3A%2F%2Fexample.com%2Fanything",
        "sunnie://connect?link=sunnie%3A%2F%2Fconnect",
        "WIFI:S:Cafe;T:WPA;P:secret;;",
    ])
    func otherCodesAreNotLinks(text: String) {
        #expect(ConnectLink.parse(text) == nil)
    }

    @Test func typedCodeIsClaimedAtThePanel() {
        #expect(ConnectLink.forCode(" AbC123 ", host: "panel.example.com")?.absoluteString == "https://panel.example.com/c/AbC123")
        #expect(ConnectLink.forCode("ABCD EFGH", host: "panel.example.com")?.absoluteString == "https://panel.example.com/c/ABCDEFGH")
        #expect(ConnectLink.forCode("abcd-efgh_1", host: "panel.example.com:8443")?.absoluteString == "https://panel.example.com:8443/c/abcd-efgh_1")
    }

    @Test func pastedLinkIsUsedAsItIs() {
        #expect(ConnectLink.forCode("https://other.example.com/c/AbC123", host: "panel.example.com")?.absoluteString == "https://other.example.com/c/AbC123")
        #expect(ConnectLink.forCode("https://other.example.com/c/AbC123", host: nil)?.absoluteString == "https://other.example.com/c/AbC123")
    }

    @Test(arguments: ["", "   ", "abc/def", "abc?x=1", "../c/abc", "café", "https://example.com/menu.pdf"])
    func otherTextIsNotACode(text: String) {
        #expect(ConnectLink.forCode(text, host: "panel.example.com") == nil)
    }

    @Test func codeNeedsAPanel() {
        #expect(ConnectLink.forCode("AbC123", host: nil) == nil)
        #expect(ConnectLink.forCode("AbC123", host: "") == nil)
    }

    @Test func grantDecodesServerAndKey() throws {
        let data = Data(#"{"serverUrl":"https://maya.example.com","apiKey":"k","name":"Maya","later":1}"#.utf8)
        #expect(try ConnectLink.grant(from: data) == ConnectGrant(serverUrl: "https://maya.example.com", apiKey: "k", name: "Maya"))
    }

    @Test func grantWithoutAKeyIsRefused() {
        #expect(throws: APIError.decoding("connect link")) {
            try ConnectLink.grant(from: Data(#"{"serverUrl":"https://maya.example.com"}"#.utf8))
        }
    }

    @Test func refusalUsesTheHostsWords() {
        #expect(ConnectLink.refusal(Data(#"{"message":"This code was already used."}"#.utf8)) == "This code was already used.")
        #expect(ConnectLink.refusal(Data("<html>".utf8)) == nil)
    }
}
