import SwiftUI

/// The Memory tab, on a server without Drive. With Drive, `MemoryScreen` is a folder there.
struct MemoryView: View {
    let client: SunnieClient

    var body: some View {
        NavigationStack { MemoryScreen(client: client) }
    }
}

/// What the agent remembers: core memory and saved memories, to read, search, edit and add to.
struct MemoryScreen: View {
    @State private var model: MemoryModel
    @State private var editing: MemoryEditorTarget?
    @State private var hasLoaded = false
    @State private var completedQuery = ""

    init(client: SunnieClient) {
        _model = State(initialValue: MemoryModel(client: client))
    }

    var body: some View {
        List {
            if let core = model.core, model.query.isEmpty {
                Section {
                    ForEach(CoreMemory.blockNames, id: \.self) { block in
                        NavigationLink {
                            CoreBlockEditor(model: model, block: block, initial: core.blocks[block] ?? "", limit: core.blockLimit)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(block.capitalized, systemImage: block == "user" ? "person" : "sparkle")
                                    .font(.body.weight(.semibold))
                                Text(core.blocks[block]?.isEmpty == false ? core.blocks[block]! : (block == "user" ? "A little about you" : "How you like to work together"))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } header: {
                    Text("Core memory")
                } footer: {
                    Text("The essentials about you and how your assistant works with you.")
                }
            }
            Section {
                if model.memories.isEmpty {
                    emptyMemories
                }
                ForEach(model.memories) { memory in
                    Button { editing = .existing(memory) } label: {
                        MemoryRow(memory: memory)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens memory for editing")
                }
                .onDelete { offsets in
                    let doomed = offsets.map { model.memories[$0] }
                    Task { for m in doomed { await model.delete(m) } }
                }
            } header: {
                HStack {
                    Text(model.query.isEmpty ? "Saved memories" : "Results")
                    Spacer()
                    if hasLoaded, completedQuery == model.query {
                        Text(model.total, format: .number)
                            .monospacedDigit()
                    }
                }
            }
        }
        .groupedListStyle()
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Memory")
        .searchable(text: $model.query, prompt: "Search memories")
        .task(id: model.query) {
            let query = model.query
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await model.search()
            guard !Task.isCancelled else { return }
            completedQuery = query
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editing = .new } label: { Label("Add memory", systemImage: "plus") }
            }
        }
        .refreshable { await model.refresh() }
        .task {
            await model.refresh()
            hasLoaded = true
        }
        .sheet(item: $editing) { target in
            MemoryEditor(model: model, target: target)
        }
        .alert("Something went wrong", isPresented: Binding(get: { model.error != nil && editing == nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") {}
        } message: {
            Text(model.error ?? "")
        }
    }

    @ViewBuilder private var emptyMemories: some View {
        if !hasLoaded || model.isLoading || completedQuery != model.query {
            HStack {
                Spacer()
                ProgressView(model.query.isEmpty ? "Loading memories…" : "Searching…")
                Spacer()
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.vertical, 20)
        } else if !model.query.isEmpty {
            ContentUnavailableView.search(text: model.query)
                .listRowBackground(Color.clear)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Nothing saved yet")
                    .font(.headline)
                Text("Useful details from your conversations will appear here. You can add a memory anytime.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 12)
        }
    }
}

nonisolated enum MemoryEditorTarget: Identifiable, Hashable {
    case new
    case existing(Memory)

    var id: String {
        switch self {
        case .new: return "new"
        case .existing(let m): return m.id
        }
    }
}

private struct MemoryRow: View {
    let memory: Memory
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(memory.content)
                .font(.body)
                .foregroundStyle(.primary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 4)
            metadata
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var metadata: Text {
        let kind = Text(memory.kind.rawValue.capitalized).fontWeight(.medium)
        if let date = memory.updatedDate {
            return Text("\(kind) · \(Text(date, format: .relative(presentation: .named)))")
        }
        return kind
    }
}

private struct MemoryEditor: View {
    let model: MemoryModel
    let target: MemoryEditorTarget
    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var kind: MemoryKind = .fact
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Something worth remembering", text: $content, prompt: Text("Something worth remembering"), axis: .vertical)
                        .captionedField()
                        .lineLimit(6...14)
                        .accessibilityHint("A fact, preference, or detail for future conversations")
                } header: {
                    Text("Memory")
                } footer: {
                    Text("A fact, preference, or detail to remember for future conversations.")
                }
                Section {
                    Picker("Kind", selection: $kind) {
                        ForEach(MemoryKind.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                    }
                }
                if case .existing(let memory) = target {
                    Section("Details") {
                        LabeledContent("Source", value: memory.source.capitalized)
                        if let date = memory.updatedDate {
                            LabeledContent("Updated") {
                                Text(date, format: .dateTime.month(.abbreviated).day().year())
                            }
                        }
                        if memory.recallCount > 0 {
                            LabeledContent("Times recalled", value: memory.recallCount.formatted())
                        }
                    }
                    .font(.subheadline)
                }
            }
            .disabled(saving)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(isNew ? "New memory" : "Edit memory")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        saving = true
                        Task {
                            let existing: Memory? = { if case .existing(let m) = target { return m } else { return nil } }()
                            if await model.save(existing, content: content, kind: kind) {
                                dismiss()
                            } else {
                                error = model.error
                                model.error = nil
                            }
                            saving = false
                        }
                    } label: {
                        if saving {
                            ProgressView()
                        } else {
                            Text("Save")
                                .fontWeight(.semibold)
                        }
                    }
                    .accessibilityLabel(saving ? "Saving memory" : "Save")
                    .disabled(saving || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(saving)
            .alert("Could not save", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK") {}
            } message: {
                Text(error ?? "")
            }
            .onAppear {
                if case .existing(let m) = target {
                    content = m.content
                    kind = m.kind
                }
            }
        }
    }

    private var isNew: Bool { if case .new = target { return true } else { return false } }
}

private struct CoreBlockEditor: View {
    let model: MemoryModel
    let block: String
    let initial: String
    let limit: Int
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var error: String?
    @State private var saving = false
    @ScaledMetric(relativeTo: .body) private var editorHeight: CGFloat = 260

    init(model: MemoryModel, block: String, initial: String, limit: Int) {
        self.model = model
        self.block = block
        self.initial = initial
        self.limit = limit
        _content = State(initialValue: initial)
    }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $content)
                    .font(.body)
                    .frame(minHeight: editorHeight)
                    .accessibilityLabel("\(block.capitalized) memory")
            } header: {
                Text(block == "user" ? "About you" : "Working together")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(content.count.formatted()) / \(limit.formatted()) characters")
                        .monospacedDigit()
                        .foregroundStyle(content.count > limit ? .red : .secondary)
                    if content.count > limit {
                        Text("Remove \((content.count - limit).formatted()) characters to save.")
                            .foregroundStyle(.red)
                    } else {
                        Text(block == "user" ? "The things that help your assistant understand you." : "How your assistant should communicate and work with you.")
                    }
                }
            }
            Section {
                Text("Changes apply in a new conversation or when an existing conversation refreshes its memory.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
        }
        .disabled(saving)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(block.capitalized)
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    saving = true
                    Task {
                        error = await model.saveCore(block: block, content: content)
                        saving = false
                        if error == nil { dismiss() }
                    }
                } label: {
                    if saving {
                        ProgressView()
                    } else {
                        Text("Save")
                            .fontWeight(.semibold)
                    }
                }
                .accessibilityLabel(saving ? "Saving memory" : "Save")
                .disabled(saving || content == initial || content.count > limit)
            }
        }
        .alert("Could not save", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") {}
        } message: {
            Text(error ?? "")
        }
    }
}
