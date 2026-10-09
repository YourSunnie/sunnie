import SwiftUI

/// The servers this device has connected to; tapping one switches to it with its saved key.
struct SavedServersSection: View {
    var onAdd: (() -> Void)?
    @Environment(AppModel.self) private var app
    @Environment(Notifications.self) private var notifications
    @State private var switching: String?
    @State private var error: String?

    var body: some View {
        Section {
            ForEach(app.servers) { server in
                let current = isCurrent(server)
                Button {
                    switchTo(server)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(server.name)
                            Text(server.address)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if switching == server.id {
                            ProgressView()
                        } else if current {
                            Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                        }
                    }
                }
                // A row reads as a choice, not a link: plain text, the tint only on the checkmark.
                .tint(.primary)
                .accessibilityIdentifier("Server \(server.address)")
                .accessibilityAddTraits(current ? .isSelected : [])
                .swipeActions {
                    if !current {
                        Button("Remove", role: .destructive) { app.forget(server) }
                    }
                }
            }
            if let onAdd {
                Button(action: onAdd) { Label("Add server", systemImage: "plus") }
            }
        } header: {
            Text(onAdd == nil ? "Saved servers" : "Servers")
        } footer: {
            if let error {
                Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
            } else if onAdd == nil {
                Text("Tap a server to connect. Swipe to remove one.")
            } else if app.servers.count > 1 {
                Text("Tap a server to switch to it. Swipe to remove one.")
            }
        }
    }

    private func isCurrent(_ server: SavedServer) -> Bool {
        app.client != nil && server.matches(app.settings.baseURL)
    }

    private func switchTo(_ server: SavedServer) {
        guard switching == nil, !isCurrent(server) else { return }
        switching = server.id
        error = nil
        Task {
            do {
                try await app.switchTo(server, pushToken: notifications.deviceToken)
            } catch {
                self.error = "\(server.name) (\(server.address)): \(error.localizedDescription)"
            }
            switching = nil
        }
    }
}

/// Connects to a server that is not saved yet; it joins the list and becomes the current one.
struct AddServerView: View {
    @Environment(AppModel.self) private var app
    @Environment(Notifications.self) private var notifications
    @Environment(\.dismiss) private var dismiss
    @State private var urlText = ""
    @State private var apiKey = ""
    @State private var error: String?
    @State private var connecting = false

    var body: some View {
        NavigationStack {
            Form {
                ServerFields(urlText: $urlText, apiKey: $apiKey)
                    .disabled(connecting)
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Add server")
            .inlineNavigationTitle()
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if connecting {
                        ProgressView()
                    } else {
                        Button("Connect") { connect() }
                            .disabled(!canConnect)
                    }
                }
            }
        }
    }

    private var canConnect: Bool {
        !urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func connect() {
        connecting = true
        error = nil
        Task {
            do {
                try await app.connect(urlText: urlText, apiKey: apiKey, pushToken: notifications.deviceToken)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            connecting = false
        }
    }
}
