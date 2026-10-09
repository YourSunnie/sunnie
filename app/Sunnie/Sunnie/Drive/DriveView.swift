import SwiftUI
import Observation
import QuickLook
#if os(macOS)
import QuickLookUI
#endif
import UniformTypeIdentifiers

@Observable
final class DriveModel {
    let client: SunnieClient
    let path: String
    var entries: [DriveEntry] = []
    var nextOffset: Int?
    var isLoading = false
    var hasLoaded = false
    var error: String?

    init(client: SunnieClient, path: String) { self.client = client; self.path = path }

    func load(more: Bool = false) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await client.listDrive(path, offset: more ? (nextOffset ?? 0) : 0)
            if more {
                let known = Set(entries.map(\.path))
                entries += page.entries.filter { !known.contains($0.path) }
            } else { entries = page.entries }
            nextOffset = page.nextOffset
            hasLoaded = true
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct DriveView: View {
    let client: SunnieClient
    var body: some View {
        NavigationStack { DriveFolderView(client: client, path: "") }
    }
}

private struct DriveNameTarget: Identifiable {
    var title: String
    var name: String
    var entry: DriveEntry?
    var folder = false
    var id: String { title + (entry?.path ?? "") }
}

struct DriveFolderView: View {
    @State private var model: DriveModel
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var naming: DriveNameTarget?
    @State private var moving: DriveEntry?
    @State private var deleting: DriveEntry?
    @State private var importing = false
    @State private var busy = false

    init(client: SunnieClient, path: String) {
        _model = State(initialValue: DriveModel(client: client, path: path))
    }

    var body: some View {
        List {
            if let error = model.error {
                Section {
                    Text(error).foregroundStyle(.secondary)
                    Button("Refresh") { Task { await model.load() } }
                }
            }
            // Memory is not stored in Drive; it is shown as a folder of its own at the top.
            if model.path.isEmpty {
                NavigationLink { MemoryScreen(client: model.client) } label: {
                    MemoryFolderRow(agentName: app.agentName, count: app.info?.memoryCount)
                }
                .disabled(busy)
            }
            if !model.hasLoaded && model.isLoading {
                ProgressView("Loading Drive…")
            } else if model.hasLoaded && model.entries.isEmpty {
                ContentUnavailableView("This folder is empty", systemImage: "folder", description: Text("Add a file, create a folder, or ask Sunnie to make something here."))
            }
            ForEach(model.entries) { entry in
                NavigationLink {
                    if entry.isFolder { DriveFolderView(client: model.client, path: entry.path) }
                    else { DriveFileView(client: model.client, initial: entry) }
                } label: { DriveRow(entry: entry) }
                .disabled(!entry.isSupported || busy)
                .contextMenu {
                    if entry.isSupported {
                        Button("Rename", systemImage: "pencil") { naming = .init(title: "Rename", name: entry.name, entry: entry) }
                        Button("Move", systemImage: "folder") { moving = entry }
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = entry }
                    }
                }
                .swipeActions(allowsFullSwipe: false) {
                    if entry.isSupported {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = entry }
                        Button("Rename", systemImage: "pencil") { naming = .init(title: "Rename", name: entry.name, entry: entry) }.tint(.accentColor)
                    }
                }
            }
            if model.nextOffset != nil {
                Button("Load more") { Task { await model.load(more: true) } }.disabled(model.isLoading)
            }
            if busy { ProgressView("Updating Drive…") }
        }
        .navigationTitle(model.path.isEmpty ? "Drive" : String(model.path.split(separator: "/").last ?? "Drive"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("New folder", systemImage: "folder.badge.plus") { naming = .init(title: "New folder", name: "", folder: true) }
                    Button("New text file", systemImage: "doc.badge.plus") { naming = .init(title: "New text file", name: "Untitled.txt") }
                    Button("Upload files", systemImage: "square.and.arrow.up") { importing = true }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.load() } }
                } label: { Image(systemName: "plus").frame(minWidth: 44, minHeight: 44) }
                .accessibilityLabel("Drive actions")
                .disabled(busy)
            }
        }
        .task { await model.load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.load() } }
        }
        .refreshable { await model.load() }
        .sheet(item: $naming) { target in
            DriveNameSheet(title: target.title, initial: target.name) { name in
                let path = DrivePath.joining(model.path, name)
                if let entry = target.entry { try await model.client.moveDriveEntry(entry, to: path) }
                else if target.folder { _ = try await model.client.createDriveFolder(path) }
                else { _ = try await model.client.createDriveFile(path) }
                await model.load()
            }
        }
        .sheet(item: $moving) { entry in
            DriveMoveSheet(client: model.client, entry: entry) { folder in
                try await model.client.moveDriveEntry(entry, to: DrivePath.joining(folder, entry.name))
                await model.load()
            }
        }
        .confirmationDialog("Delete \(deleting?.name ?? "item")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let entry = deleting else { return }
                deleting = nil
                Task {
                    busy = true
                    defer { busy = false }
                    do { try await model.client.deleteDriveEntry(entry); await model.load() }
                    catch { model.error = error.localizedDescription }
                }
            }
        } message: {
            Text("This permanently deletes the item and any contents from Drive. Original chat attachments are kept.")
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            Task {
                busy = true
                defer { busy = false }
                do {
                    for url in try result.get() {
                        let file = try PendingAttachment.importFile(url: url, makePreview: false, allowEmpty: true)
                        defer { file.removeLocalFile() }
                        _ = try await model.client.uploadDriveFile(file, folder: model.path)
                    }
                    await model.load()
                } catch {
                    let message = error.localizedDescription
                    await model.load()
                    model.error = message
                }
            }
        }
    }
}

/// The Memory folder: looks like a folder, opens what the agent remembers.
private struct MemoryFolderRow: View {
    let agentName: String
    let count: Int?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "brain")
                .foregroundStyle(.tint)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Memory").foregroundStyle(.primary)
                Text(count.map { "What \(agentName) remembers · \($0 == 1 ? "1 memory" : "\($0) memories")" } ?? "What \(agentName) remembers")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct DriveRow: View {
    let entry: DriveEntry
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: entry.isSupported ? entry.symbol : "exclamationmark.triangle")
                .foregroundStyle(.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.name).foregroundStyle(.primary)
                if !entry.isSupported { Text("Links and special files can’t be opened").font(.caption).foregroundStyle(.secondary) }
                else {
                    HStack {
                        if !entry.isFolder { Text(entry.sizeLabel) }
                        if let date = ISO8601.parse(entry.modifiedAt) { Text(date, style: .date) }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct DriveNameSheet: View {
    let title: String
    let save: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var busy = false
    @State private var error: String?

    init(title: String, initial: String, save: @escaping (String) async throws -> Void) {
        self.title = title; self.save = save
        _name = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name).plainTextEntry()
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Saving…" : "Save") {
                        Task {
                            busy = true
                            defer { busy = false }
                            do { try await save(name); dismiss() }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(busy || !DrivePath.isValid(name) || name.contains("/"))
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }
}

private struct DriveMoveSheet: View {
    let client: SunnieClient
    let entry: DriveEntry
    let move: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            DriveDestinationView(client: client, path: "", entry: entry) { path in
                try await move(path)
                dismiss()
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct DriveDestinationView: View {
    let entry: DriveEntry
    let move: (String) async throws -> Void
    @State private var model: DriveModel
    @State private var busy = false

    init(client: SunnieClient, path: String, entry: DriveEntry, move: @escaping (String) async throws -> Void) {
        self.entry = entry; self.move = move
        _model = State(initialValue: DriveModel(client: client, path: path))
    }

    var body: some View {
        List {
            Section {
                Text("Move \(entry.name) to \(model.path.isEmpty ? "Drive" : model.path)").font(.subheadline)
                Button(busy ? "Moving…" : "Move here") {
                    Task {
                        busy = true
                        defer { busy = false }
                        do { try await move(model.path) }
                        catch { model.error = error.localizedDescription }
                    }
                }.disabled(busy || model.path == DrivePath.parent(entry.path))
            }
            if let error = model.error {
                Text(error).foregroundStyle(.secondary)
                Button("Refresh") { Task { await model.load() } }
            }
            ForEach(model.entries.filter { $0.isFolder && $0.path != entry.path && !$0.path.hasPrefix(entry.path + "/") }) { folder in
                NavigationLink {
                    DriveDestinationView(client: model.client, path: folder.path, entry: entry, move: move)
                } label: { Label(folder.name, systemImage: "folder") }
            }
            if model.isLoading { ProgressView() }
            if model.nextOffset != nil {
                Button("Load more folders") { Task { await model.load(more: true) } }.disabled(model.isLoading)
            }
        }
        .navigationTitle(model.path.isEmpty ? "Drive" : String(model.path.split(separator: "/").last ?? "Drive"))
        .task { await model.load() }
        .interactiveDismissDisabled(busy)
        .disabled(busy)
    }
}

struct DriveItemView: View {
    let client: SunnieClient
    let path: String
    @State private var entry: DriveEntry?
    @State private var error: String?

    var body: some View {
        Group {
            if let entry {
                if entry.isFolder { DriveFolderView(client: client, path: entry.path) }
                else { DriveFileView(client: client, initial: entry) }
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn’t open item", systemImage: "doc.questionmark")
                } description: { Text(error) } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else { ProgressView("Opening Drive…") }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        do { entry = try await client.driveEntry(path); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct DriveFileView: View {
    let client: SunnieClient
    @Environment(\.scenePhase) private var scenePhase
    @State private var entry: DriveEntry
    @State private var opened: OpenedDriveFile?
    @State private var text: String?
    @State private var editing = false
    @State private var busy = false
    @State private var error: String?

    init(client: SunnieClient, initial: DriveEntry) {
        self.client = client
        _entry = State(initialValue: initial)
    }

    var body: some View {
        Group {
            if let error {
                ContentUnavailableView {
                    Label("Couldn’t open file", systemImage: "doc.questionmark")
                } description: { Text(error) } actions: {
                    Button("Try again") { Task { await open() } }
                }
            } else if let opened {
                if let text {
                    ScrollView {
                        Text(text.isEmpty ? "Empty file" : text)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(text.isEmpty ? .secondary : .primary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                    }
                } else if DrivePreview.canPreview(opened.url) {
                    DrivePreview(url: opened.url).id(opened.url)
                } else {
                    ContentUnavailableView {
                        Label(entry.name, systemImage: entry.symbol)
                    } description: {
                        Text("Open this file in another app, or save it to Files.")
                    } actions: {
                        ShareLink(item: opened.url) { Label("Open in… or Save to Files", systemImage: "square.and.arrow.up") }
                    }
                }
            } else { ProgressView("Opening file…") }
        }
        .navigationTitle(entry.name)
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if text != nil {
                    Button("Edit", systemImage: "square.and.pencil") { editing = true }.disabled(busy)
                }
                if let opened, error == nil {
                    #if os(macOS)
                    Button("Open in Default App", systemImage: "arrow.up.forward.app") { PlatformOpen.inDefaultApp(opened.url) }
                    #endif
                    ShareLink(item: opened.url) { Label("Share or save", systemImage: "square.and.arrow.up") }
                }
            }
        }
        .task { await open() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && !editing { Task { await open() } }
        }
        .sheet(isPresented: $editing) {
            DriveTextEditor(client: client, path: entry.path) { saved in
                entry = saved
                opened = nil
                text = nil
                Task { await open() }
            }
        }
    }

    private func open() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let file = try await client.openDriveFile(entry.path)
            try Task.checkCancellation()
            entry = file.entry
            opened = file
            text = file.editableText
        } catch is CancellationError {
            return
        } catch {
            opened = nil
            text = nil
            self.error = error.localizedDescription
        }
    }
}

#if os(iOS)
private struct DrivePreview: UIViewControllerRepresentable {
    let url: URL

    static func canPreview(_ url: URL) -> Bool { QLPreviewController.canPreview(url as NSURL) }

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { url as NSURL }
    }
}
#else
/// Quick Look's own view, as Finder shows a file with the space bar.
private struct DrivePreview: NSViewRepresentable {
    let url: URL

    /// Quick Look on the Mac draws every file, at worst as its icon and details.
    static func canPreview(_ url: URL) -> Bool { true }

    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .normal) ?? QLPreviewView()
        view.autostarts = true
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: QLPreviewView, context: Context) {
        if (view.previewItem as? NSURL) as URL? != url { view.previewItem = url as NSURL }
    }

    static func dismantleNSView(_ view: QLPreviewView, coordinator: ()) {
        view.close()
    }
}
#endif

private struct DriveTextEditor: View {
    let client: SunnieClient
    let path: String
    let onSave: (DriveEntry) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var original: DriveText?
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var discard = false
    private var changed: Bool { original.map { $0.text != text } ?? false }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let error { Text(error).font(.callout).foregroundStyle(.red).padding() }
                if original != nil {
                    TextEditor(text: $text)
                        .font(.system(.body, design: .monospaced))
                        .plainTextEntry()
                        .accessibilityLabel("File contents")
                        .disabled(busy)
                } else if error == nil { ProgressView("Loading text…") }
                else { Button("Try again") { Task { await load() } } }
            }
            .navigationTitle(original?.entry.name ?? "Edit text")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if changed { discard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(original == nil || busy || !changed || text.utf8.count > 256 * 1024)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if text.utf8.count > 256 * 1024 { Text("Text exceeds the 256 KiB editing limit.").font(.caption).foregroundStyle(.red).padding() }
            }
            .interactiveDismissDisabled(changed || busy)
            .confirmationDialog("Discard your changes?", isPresented: $discard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do { let loaded = try await client.driveText(path); original = loaded; text = loaded.text; error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard let original else { return }
        busy = true
        defer { busy = false }
        do { onSave(try await client.saveDriveText(original.entry, text: text)); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}

struct DriveCardView: View {
    let card: DriveCard
    @Environment(AppModel.self) private var app
    @State private var opening = false

    var body: some View {
        Button { opening = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "doc.on.doc").foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                    Text("Drive · \(card.path)").font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(app.info?.drive?.enabled != true)
        .accessibilityHint("Opens this item in Drive")
        .sheet(isPresented: $opening) {
            if let client = app.client {
                NavigationStack {
                    DriveItemView(client: client, path: card.path)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { opening = false } } }
                }
            }
        }
    }
}
