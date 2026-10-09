import Foundation
import UniformTypeIdentifiers
import ImageIO

nonisolated struct Attachment: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var filename: String
    var mediaType: String
    var sizeBytes: Int
    var createdAt: String
    var drivePath: String? = nil

    var isImage: Bool { mediaType.hasPrefix("image/") }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file) }
    var symbol: String { isImage ? "photo" : mediaType == "application/pdf" ? "doc.richtext" : "doc" }
}

/// Owns a copy: Files and share providers may revoke their URL when their callback ends.
nonisolated struct PendingAttachment: Identifiable, Hashable, Sendable {
    static let maxFileBytes = 20 * 1024 * 1024
    static let maxTotalBytes = 40 * 1024 * 1024
    static let maxCount = 8

    var id: String
    var fileURL: URL
    var filename: String
    var mediaType: String
    var sizeBytes: Int
    var uploaded: Attachment?
    /// A bounded visual rendition for formats such as HEIC; the original remains untouched.
    var previewURL: URL? = nil

    var descriptor: Attachment {
        uploaded ?? Attachment(id: id, filename: filename, mediaType: mediaType, sizeBytes: sizeBytes, createdAt: "")
    }

    static func importFile(url: URL, suggestedName: String? = nil, makePreview: Bool = true, allowEmpty: Bool = false) throws -> PendingAttachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
        guard values.isRegularFile == true else { throw AttachmentError.message("Choose a file, rather than a folder.") }
        let size = values.fileSize ?? 0
        try validateSize(size, allowEmpty: allowEmpty)
        var name = safeName(suggestedName ?? url.lastPathComponent)
        if (name as NSString).pathExtension.isEmpty, let ext = values.contentType?.preferredFilenameExtension {
            name += "." + ext
        }
        let type = UTType(filenameExtension: (name as NSString).pathExtension) ?? values.contentType
        let destination = try destinationURL(filename: name)
        do {
            try FileManager.default.copyItem(at: url, to: destination)
            let copiedSize = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            try validateSize(copiedSize, allowEmpty: allowEmpty)
            return try prepared(fileURL: destination, filename: name,
                                mediaType: type?.preferredMIMEType ?? "application/octet-stream", sizeBytes: copiedSize, makePreview: makePreview)
        } catch {
            try? FileManager.default.removeItem(at: destination.deletingLastPathComponent())
            throw error
        }
    }

    static func importData(_ data: Data, filename: String, mediaType: String, makePreview: Bool = true, allowEmpty: Bool = false) throws -> PendingAttachment {
        try validateSize(data.count, allowEmpty: allowEmpty)
        let name = safeName(filename)
        let destination = try destinationURL(filename: name)
        do {
            try data.write(to: destination, options: .atomic)
            return try prepared(fileURL: destination, filename: name, mediaType: mediaType, sizeBytes: data.count, makePreview: makePreview)
        } catch {
            try? FileManager.default.removeItem(at: destination.deletingLastPathComponent())
            throw error
        }
    }

    func removeLocalFile() {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    static func validate(_ files: [PendingAttachment]) throws {
        guard files.count <= maxCount else { throw AttachmentError.message("Attach up to 8 files in one message.") }
        guard files.reduce(0, { $0 + $1.sizeBytes }) <= maxTotalBytes else {
            throw AttachmentError.message("Keep the total attachments under 40 MB per message.")
        }
    }

    static func safeName(_ filename: String) -> String {
        let name = filename.components(separatedBy: CharacterSet(charactersIn: "/\\")).last ?? "File"
        let clean = name.components(separatedBy: .controlCharacters).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty || clean == "." || clean == ".." ? "File" : String(clean.prefix(180))
    }

    private static func validateSize(_ size: Int, allowEmpty: Bool = false) throws {
        guard size > 0 || allowEmpty else { throw AttachmentError.message("This file is empty.") }
        guard size <= maxFileBytes else { throw AttachmentError.message("Each attachment must be 20 MB or smaller.") }
    }

    private static func prepared(fileURL: URL, filename: String, mediaType: String, sizeBytes: Int, makePreview: Bool = true) throws -> PendingAttachment {
        var file = PendingAttachment(id: UUID().uuidString, fileURL: fileURL, filename: filename,
                                     mediaType: mediaType, sizeBytes: sizeBytes)
        guard mediaType.hasPrefix("image/"),
              let source = CGImageSourceCreateWithURL(fileURL as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return file }
        if let identifier = CGImageSourceGetType(source), let type = UTType(identifier as String), let actual = type.preferredMIMEType {
            file.mediaType = actual
        }
        guard makePreview, !["image/jpeg", "image/png", "image/webp", "image/gif"].contains(file.mediaType) else { return file }
        // Share extensions have a smaller memory budget than the containing app.
        for size in [2048, 1280] {
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: size,
                kCGImageSourceShouldCacheImmediately: false,
            ] as CFDictionary) else { continue }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { continue }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
            guard CGImageDestinationFinalize(destination), data.length <= 5 * 1024 * 1024 else { continue }
            let url = fileURL.deletingLastPathComponent().appendingPathComponent("visual-\(UUID().uuidString).jpg")
            try (data as Data).write(to: url, options: .atomic)
            file.previewURL = url
            return file
        }
        throw AttachmentError.message("This image couldn’t be prepared for Sunnie. Try exporting it as JPEG or PNG.")
    }

    private static func destinationURL(filename: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SunnieAttachments", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(filename)
    }
}

nonisolated enum AttachmentError: Error, LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { text } else { nil } }
}
