import Foundation
import Testing
@testable import Sunnie

struct DriveTests {
    @Test func driveCardsKeepPathsAndQuotes() throws {
        let text = "```drive\ntitle: Travel notes\npath: Trips/Résumé & plans.md\n```"
        let block = try #require(Markdown.parse(text).first)
        guard case .drive(let card) = block else { Issue.record("Expected Drive card"); return }
        #expect(card.path == "Trips/Résumé & plans.md")
        let quote = try #require(block.messageQuote)
        #expect(quote.kind == "card")
        #expect(quote.text == text)
    }

    @Test func invalidDriveCardsFallBackToCode() {
        for path in ["../private", "/etc/passwd", "Trips/../private", "a//b", "./notes", "", "a\\b", "a\u{0}b"] {
            let blocks = Markdown.parse("```drive\ntitle: File\npath: \(path)\n```")
            guard let block = blocks.first, case .code = block else { Issue.record("Invalid path became a card: \(path)"); continue }
        }
        #expect(DrivePath.isValid("日本語/notes #1?.md"))
        #expect(!DrivePath.isValid(String(repeating: "é", count: 128)))
        #expect(DrivePath.parent("notes.md") == "")
        #expect(DrivePath.joining("Trips", "notes.md") == "Trips/notes.md")
    }

    @Test func driveEntriesPreserveUnknownKinds() throws {
        let json = #"{"path":"something","name":"something","kind":"future","sizeBytes":0,"modifiedAt":"2026-10-03T00:00:00Z","revision":"abc","mediaType":"application/octet-stream"}"#
        let entry = try JSONDecoder().decode(DriveEntry.self, from: Data(json.utf8))
        #expect(!entry.isSupported)
        #expect(entry.path == "something")
    }

    @Test func oldAttachmentsStillDecodeWithoutDrive() throws {
        let json = #"{"id":"att_old","filename":"notes.txt","mediaType":"text/plain","sizeBytes":5,"createdAt":"2026-10-03T00:00:00Z"}"#
        #expect(try JSONDecoder().decode(Attachment.self, from: Data(json.utf8)).drivePath == nil)
    }
}

@MainActor
struct DriveCacheTests {
    private func entry(_ revision: String = "first", name: String = "notes.txt", size: Int64 = 5) -> DriveEntry {
        DriveEntry(path: name, name: name, kind: "file", sizeBytes: size,
                   modifiedAt: "2026-10-03T00:00:00Z", revision: revision, mediaType: "text/plain")
    }

    @Test func cachedCopiesAreScopedAndReplacedByRevision() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = URL(string: "https://example.com")!
        let cache = DriveFileCache(server: server, credential: "first", directory: root)
        let file = entry()
        let url = try cache.store(Data("hello".utf8), entry: file)
        #expect(try Data(contentsOf: url) == Data("hello".utf8))
        #expect(cache.cached(file) == url)
        #expect(cache.cached(entry("changed")) == nil)
        #expect(DriveFileCache(server: server, credential: "first", directory: root).cached(file) == url)
        #expect(DriveFileCache(server: server, credential: "other", directory: root).cached(file) == nil)
        #expect(DriveFileCache(server: URL(string: "https://other.example.com")!, credential: "first", directory: root).cached(file) == nil)
        cache.clear()
        #expect(cache.cached(file) == nil)
    }

    @Test func previewDetectionDoesNotTreatAnASCIIPDFAsText() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = DriveFileCache(server: URL(string: "https://example.com")!, credential: "key", directory: root)
        let bytes = Data("%PDF-1.4".utf8)
        var pdf = entry(name: "document.pdf", size: Int64(bytes.count))
        pdf.mediaType = "application/pdf"
        let url = try cache.store(bytes, entry: pdf)
        #expect(OpenedDriveFile(entry: pdf, url: url).editableText == nil)
    }

    @Test func cacheBoundsStorageAndPreservesEmptyFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = DriveFileCache(server: URL(string: "https://example.com")!, credential: "key", directory: root, maximumBytes: 5)
        let first = entry(name: "first.txt")
        _ = try cache.store(Data("hello".utf8), entry: first)
        let second = entry(name: "second.txt")
        let url = try cache.store(Data("world".utf8), entry: second)
        #expect(cache.cached(first) == nil)
        #expect(cache.cached(second) == url)
        let empty = entry(name: "empty.txt", size: 0)
        let emptyURL = try cache.store(Data(), entry: empty)
        #expect(OpenedDriveFile(entry: empty, url: emptyURL).editableText == "")
        #expect(throws: APIError.self) { try cache.store(Data("short".utf8), entry: entry(size: 6)) }
    }
}

struct ModelDefaultsTests {
    @Test func pastedOpenRouterIDsBecomeSpecsWithoutDoublingThePrefix() {
        #expect(ChatModelDefaults.openRouterSpec(" vendor/model \n") == "openrouter/vendor/model")
        #expect(ChatModelDefaults.openRouterSpec("openrouter/vendor/model") == "openrouter/vendor/model")
        #expect(ChatModelDefaults.openRouterSpec("vendor/model:free") == "openrouter/vendor/model:free")
        for invalid in ["", "model", "vendor/ model", "vendor/", "https://openrouter.ai/models/vendor/model", "vendor//model"] {
            #expect(ChatModelDefaults.openRouterSpec(invalid) == nil)
        }
    }
}
