import Foundation
import Testing
@testable import Sunnie

struct AttachmentTests {
    private let file = Attachment(id: "att_one", filename: "Notes.pdf", mediaType: "application/pdf", sizeBytes: 42, createdAt: "2026-10-03T00:00:00Z")

    @Test func attachmentOnlySteerWaitsForItsOwnFile() {
        var timeline = ChatTimeline()
        timeline.beginSteer(id: "queued", text: "", attachments: [file])
        let unrelated = Message(id: "first", conversationId: "c", seq: 1, role: .user, text: "Hello", parts: [], createdAt: "")
        timeline.apply(RunEvent(seq: 1, kind: .message(unrelated)))
        #expect(timeline.steers.count == 1)
        var stored = Message(id: "second", conversationId: "c", seq: 2, role: .user, text: "", parts: [], createdAt: "")
        stored.attachments = [file]
        timeline.apply(RunEvent(seq: 2, kind: .message(stored)))
        #expect(timeline.steers.isEmpty)
        #expect(timeline.items.contains(.user(id: "second", text: "", pending: false, attachments: [file])))
    }

    @Test func cancelledSteerReturnsItsAttachments() {
        var timeline = ChatTimeline()
        timeline.beginSteer(id: "queued", text: "Read this", attachments: [file])
        timeline.apply(RunEvent(seq: 1, kind: .runCancelled))
        #expect(timeline.takeUnsentSteers() == ["Read this"])
        #expect(timeline.takeUnsentAttachments() == [file])
        #expect(timeline.takeUnsentAttachments().isEmpty)
    }

    @Test func historyCatchUpAcknowledgesQueuedAttachment() {
        var timeline = ChatTimeline()
        timeline.beginSteer(id: "queued", text: "Read this", attachments: [file])
        var stored = Message(id: "stored", conversationId: "c", seq: 1, role: .user, text: "Read this", parts: [], createdAt: "")
        stored.attachments = [file]
        timeline.insert([stored])
        #expect(timeline.steers.isEmpty)
        #expect(timeline.items.count == 1)
    }

    @Test func oldMessagesDecodeWithoutAttachments() throws {
        let data = Data(#"{"id":"m","conversationId":"c","seq":1,"role":"user","text":"Hello","parts":[],"createdAt":""}"#.utf8)
        #expect(try JSONDecoder().decode(Message.self, from: data).attachments == nil)
    }

    @Test func importOwnsItsCopyAndKeepsOriginalBytes() throws {
        let content = Data("Some notes".utf8)
        let original = try PendingAttachment.importData(content, filename: "../Notes.txt", mediaType: "text/plain")
        defer { original.removeLocalFile() }
        let imported = try PendingAttachment.importFile(url: original.fileURL)
        defer { imported.removeLocalFile() }
        #expect(imported.filename == "Notes.txt")
        #expect(imported.fileURL != original.fileURL)
        #expect(try Data(contentsOf: imported.fileURL) == content)
    }

    @Test func downloadedBytesHaveIndependentFilesAndKeepTheirNames() throws {
        var bytes = Data("%PDF-1.7\n".utf8)
        bytes.append(contentsOf: [0, 128, 255])
        let first = try PendingAttachment.importData(bytes, filename: "Menu Melati 2026.pdf", mediaType: "application/pdf", makePreview: false, allowEmpty: true)
        defer { first.removeLocalFile() }
        let second = try PendingAttachment.importData(Data("updated".utf8), filename: first.filename, mediaType: first.mediaType, makePreview: false, allowEmpty: true)
        defer { second.removeLocalFile() }
        #expect(first.fileURL.lastPathComponent == "Menu Melati 2026.pdf")
        #expect(first.fileURL != second.fileURL)
        #expect(first.previewURL == nil)
        #expect(try Data(contentsOf: first.fileURL) == bytes)
        #expect(try Data(contentsOf: second.fileURL) == Data("updated".utf8))
    }

    @Test func emptyDownloadsAreAllowedOnlyWhenRequested() throws {
        let empty = try PendingAttachment.importData(Data(), filename: "Notes.txt", mediaType: "text/plain", makePreview: false, allowEmpty: true)
        defer { empty.removeLocalFile() }
        #expect(empty.sizeBytes == 0)
        #expect(try Data(contentsOf: empty.fileURL).isEmpty)
        #expect(throws: AttachmentError.self) {
            try PendingAttachment.importData(Data(), filename: "Notes.txt", mediaType: "text/plain", makePreview: false)
        }
    }

    @Test func downloadedBytesStillRespectTheFileLimit() {
        #expect(throws: AttachmentError.self) {
            try PendingAttachment.importData(Data(repeating: 0, count: PendingAttachment.maxFileBytes + 1),
                                             filename: "Large.pdf", mediaType: "application/pdf", makePreview: false, allowEmpty: true)
        }
    }
}
