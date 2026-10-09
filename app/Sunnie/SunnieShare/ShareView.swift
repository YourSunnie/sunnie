import SwiftUI

struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            Group {
                if model.needsConnection {
                    ContentUnavailableView("Connect Sunnie first", systemImage: "link", description:
                        Text("Open Sunnie and connect to your server, then share your files again."))
                } else {
                    Form {
                        Section("Send to") {
                            NavigationLink {
                                ShareDestinationView(model: model)
                            } label: {
                                Label(model.destinationTitle, systemImage: "bubble.left.and.bubble.right")
                            }
                            .disabled(!model.canEdit)
                        }
                        Section {
                            if model.isPreparing && model.items.isEmpty {
                                ProgressView("Preparing files…")
                            }
                            ForEach(model.items) { item in
                                fileRow(item)
                            }
                        } header: {
                            Text("Files")
                        } footer: {
                            Text(model.validationMessage ?? "Up to 8 files. 20 MB each, 40 MB total.")
                                .foregroundStyle(model.validationMessage == nil ? Color.secondary : Color.red)
                        }
                        Section("Message") {
                            TextField("Add a message (optional)", text: $model.note, axis: .vertical)
                                .lineLimit(3...6)
                                .disabled(!model.canEdit)
                        }
                        if model.isSending {
                            Section { ProgressView(model.sendStatus).font(.subheadline) }
                        }
                        if let error = model.error {
                            Section {
                                Label(error, systemImage: "exclamationmark.circle")
                                    .font(.subheadline)
                                    .foregroundStyle(.red)
                            } footer: {
                                if model.submissionStarted && !model.needsDeliveryReview {
                                    Text("We couldn’t confirm delivery. Retry to check and send if needed.")
                                }
                            }
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .navigationTitle("Share with Sunnie")
            .shareInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.cancel() }.disabled(model.isSending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.submissionStarted && model.error != nil ? "Retry" : "Send") {
                        Task { await model.send() }
                    }
                    .disabled(!model.canSend)
                }
            }
            .interactiveDismissDisabled(model.isSending)
            .task { await model.prepare() }
        }
    }

    private func fileRow(_ item: SharedItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.pending?.descriptor.symbol ?? "doc")
                .foregroundStyle(.tint)
                .frame(width: 24)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.filename).font(.subheadline.weight(.medium)).lineLimit(2)
                if item.isLoading {
                    ProgressView("Preparing…").font(.caption)
                } else if let error = item.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                    Button("Try again") { Task { await model.retry(item.id) } }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.borderless)
                        .disabled(!model.canEdit)
                } else if let pending = item.pending {
                    Text(pending.uploaded == nil ? pending.descriptor.sizeLabel : "Uploaded · \(pending.descriptor.sizeLabel)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { model.remove(item.id) } label: {
                Image(systemName: "minus.circle")
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Remove \(item.filename)")
            .disabled(!model.canEdit)
        }
    }
}

private struct ShareDestinationView: View {
    @Bindable var model: ShareModel
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var conversations: [Conversation] {
        model.conversations.filter { search.isEmpty || $0.displayTitle.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        List {
            Section {
                Button {
                    model.selectConversation(nil)
                    dismiss()
                } label: {
                    destinationRow("New conversation", symbol: "square.and.pencil", selected: model.selectedConversationId == nil)
                }
            }
            Section("Recent conversations") {
                if model.loadingConversations && model.conversations.isEmpty {
                    ProgressView("Loading conversations…")
                }
                ForEach(conversations) { conversation in
                    Button {
                        model.selectConversation(conversation.id)
                        dismiss()
                    } label: {
                        destinationRow(conversation.displayTitle, symbol: "bubble.left.and.bubble.right",
                                       selected: model.selectedConversationId == conversation.id)
                    }
                }
                if !model.loadingConversations && conversations.isEmpty && model.conversationError == nil {
                    Text(search.isEmpty ? "No conversations yet." : "No matching conversations.")
                        .foregroundStyle(.secondary)
                }
                if let error = model.conversationError {
                    Text(error).font(.subheadline).foregroundStyle(.red)
                    Button("Try again") { Task { await model.refreshConversations() } }
                }
            }
        }
        .navigationTitle("Choose a conversation")
        .shareInlineTitle()
        .searchable(text: $search, prompt: "Search recent conversations")
        .refreshable { await model.refreshConversations() }
    }

    private func destinationRow(_ title: String, symbol: String, selected: Bool) -> some View {
        HStack {
            Label(title, systemImage: symbol).foregroundStyle(.primary)
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(.tint) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private extension View {
    /// The extension does not build the app's Design files, so it has its own copy of this one.
    func shareInlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        frame(minWidth: 380, minHeight: 440)
        #endif
    }
}
