import SwiftUI
import ImageIO
import QuickLook
import CoreTransferable
import UniformTypeIdentifiers

nonisolated struct PickedPhoto: Transferable {
    let file: PendingAttachment

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            PickedPhoto(file: try PendingAttachment.importFile(url: received.file))
        }
    }
}

struct DraftAttachmentsView: View {
    let files: [PendingAttachment]
    let disabled: Bool
    let remove: (String) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(files) { file in
                    HStack(spacing: 8) {
                        Image(systemName: file.descriptor.symbol)
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.filename).font(.subheadline).lineLimit(1)
                            Text(file.descriptor.sizeLabel).font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: 150, alignment: .leading)
                        Button { remove(file.id) } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                                .frame(width: 44, height: 44)
                        }
                        .disabled(disabled)
                        .accessibilityLabel("Remove \(file.filename)")
                    }
                    .padding(.leading, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 14))
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

struct MessageAttachmentsView: View {
    let files: [Attachment]

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(files) { file in
                AttachmentView(attachment: file)
            }
        }
    }
}

private struct AttachmentView: View {
    let attachment: Attachment
    @Environment(AppModel.self) private var app
    @State private var localURL: URL?
    @State private var previewURL: URL?
    @State private var thumbnail: PlatformImage?
    @State private var isLoading = false
    @State private var error: String?
    @State private var openingDrive = false

    var body: some View {
        Button {
            Task {
                await download()
                previewURL = localURL
            }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                if let thumbnail {
                    Image(platformImage: thumbnail)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 240)
                        .frame(maxWidth: .infinity)
                }
                HStack(spacing: 10) {
                    Image(systemName: attachment.symbol).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(attachment.filename).font(.subheadline).lineLimit(2)
                        Text(attachment.sizeLabel).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    if isLoading { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(.secondary) }
                }
                .padding(12)
                .frame(minHeight: 52)
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: 300)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 14))
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel("\(attachment.filename), \(attachment.sizeLabel)")
        .accessibilityHint("Opens the original attachment")
        .quickLookPreview($previewURL)
        .contextMenu {
            if let path = attachment.drivePath, DrivePath.isValid(path), app.info?.drive?.enabled == true {
                Button("Open editable copy in Drive", systemImage: "folder") { openingDrive = true }
            }
        }
        .sheet(isPresented: $openingDrive) {
            if let path = attachment.drivePath, let client = app.client {
                NavigationStack {
                    DriveItemView(client: client, path: path)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { openingDrive = false } } }
                }
            }
        }
        .task(id: attachment.id) {
            if attachment.isImage { await download(showError: false) }
        }
        .alert("Couldn’t open attachment", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") {}
        } message: { Text(error ?? "") }
    }

    private func download(showError: Bool = true) async {
        guard localURL == nil, !isLoading, let client = app.client else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let url = try await client.downloadAttachment(attachment)
            localURL = url
            if attachment.isImage,
               let source = CGImageSourceCreateWithURL(url as CFURL, nil),
               let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                   kCGImageSourceCreateThumbnailFromImageAlways: true,
                   kCGImageSourceCreateThumbnailWithTransform: true,
                   kCGImageSourceThumbnailMaxPixelSize: 900,
               ] as CFDictionary) {
                thumbnail = PlatformImage.from(cgImage: cg)
            }
        } catch {
            if showError { self.error = error.localizedDescription }
        }
    }
}
