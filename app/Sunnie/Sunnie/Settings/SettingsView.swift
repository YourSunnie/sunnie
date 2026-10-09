import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(Notifications.self) private var notifications
    @State private var urlText = ""
    @State private var apiKey = ""
    @State private var status: String?
    @State private var statusIsError = false
    @State private var saving = false
    @State private var confirmDisconnect = false
    @State private var addingServer = false
    @AppStorage(OneChat.settingKey) private var single = true

    /// The App Store app for the hosted service: no models, servers or server details to tune.
    private var hosted: Bool { app.flavor.isHosted }

    var body: some View {
        NavigationStack {
            Form {
                if let info = app.info {
                    if hosted {
                        Section {
                            Label {
                                Text(info.name).font(.headline)
                            } icon: {
                                SunnieMark(size: 28)
                            }
                            .padding(.vertical, 4)
                        }
                    } else {
                        Section("Your Sunnie") {
                            Label {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(info.name).font(.headline)
                                    Text(app.settings.baseURL?.host() ?? "Your server")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "server.rack")
                                    .foregroundStyle(.tint)
                            }
                            .padding(.vertical, 4)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Model for new chats").font(.subheadline)
                                Text(info.newChatDefaults?.model ?? info.defaultModel)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                if let client = app.client, app.info?.usage?.enabled == true {
                    UsageSection(client: client)
                }
                // One chat is how the hosted app always works; a self-hosted server can still list them.
                if !hosted {
                    Section {
                        Toggle(isOn: $single) {
                            Label("One chat", systemImage: "bubble.left.and.text.bubble.right")
                        }
                    } footer: {
                        Text("Talk with \(app.agentName) in a single ongoing chat, in message bubbles, as you would with a person. Turn it off to see every conversation on your server as a list.")
                    }
                }
                if !hosted, let client = app.client, app.info?.modelSettings?.enabled == true {
                    Section {
                        NavigationLink {
                            ModelDefaultsView(client: client)
                        } label: {
                            Label("Model for new chats", systemImage: "cpu")
                        }
                    }
                }
                if let client = app.client, app.info?.browser?.enabled == true {
                    Section {
                        NavigationLink {
                            LoginsView(client: client, agentName: app.agentName)
                        } label: {
                            Label("Logins", systemImage: "key")
                        }
                    } footer: {
                        Text("Manage the sign-ins \(app.agentName) can use for you.")
                    }
                }
                if let client = app.client, app.info?.skills?.enabled == true {
                    Section {
                        NavigationLink {
                            SkillsView(client: client, agentName: app.agentName)
                        } label: {
                            Label("Skills", systemImage: "books.vertical")
                        }
                    }
                }
                if let phone = app.info?.phone, phone.enabled {
                    Section {
                        NavigationLink {
                            PhoneDataView(agentName: app.agentName, supported: phone.sources)
                        } label: {
                            Label("Phone data", systemImage: "iphone")
                        }
                    } footer: {
                        Text("Share Health, your calendar, contacts, places, photos and more with \(app.agentName).")
                    }
                }
                if let push = app.info?.push {
                    NotificationsSection(serverCanSend: push.enabled, agentName: app.agentName, hosted: hosted)
                }
                if let client = app.client, app.info?.interests != nil {
                    Section {
                        NavigationLink {
                            InterestsView(client: client, agentName: app.agentName)
                        } label: { Label("Interests & updates", systemImage: "sparkle.magnifyingglass") }
                    }
                }
                if let error = app.infoError {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.subheadline)
                            .foregroundStyle(.red)
                        Button("Try again") { Task { await app.refreshInfo() } }
                    }
                }
                if !hosted {
                    serverSections
                }
                Section {
                    Button(hosted ? "Sign out" : "Disconnect", role: .destructive) { confirmDisconnect = true }
                } footer: {
                    Text(hosted
                         ? "Sunnie \(appVersion)"
                         : "Sunnie \(appVersion) · Use HTTPS for a server reachable from the internet.")
                }
            }
            .navigationTitle("Settings")
            .scrollDismissesKeyboard(.interactively)
            .onAppear {
                urlText = app.settings.baseURL?.absoluteString ?? ""
                apiKey = ""
            }
            .refreshable { await app.refreshInfo() }
            .sheet(isPresented: $addingServer) { AddServerView() }
            .confirmationDialog(hosted ? "Sign out of Sunnie?" : "Disconnect from this server?",
                                isPresented: $confirmDisconnect, titleVisibility: .visible) {
                Button(hosted ? "Sign out" : "Disconnect", role: .destructive) { app.disconnect(pushToken: notifications.deviceToken) }
            } message: {
                Text(hosted
                     ? "Your chats, files and what \(app.agentName) remembers stay with \(app.agentName). To sign in again, use a new code from your Sunnie panel."
                     : "This server and its API key are removed from this device. Conversations and memories stay on the server.")
            }
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    /// What a self-hosted server's owner tunes: which server, its address and key, and its details.
    @ViewBuilder
    private var serverSections: some View {
        SavedServersSection(onAdd: { addingServer = true })
        // The stored key is never shown again; leaving the field empty keeps it.
        ServerFields(urlText: $urlText, apiKey: $apiKey, keyPlaceholder: "API key (unchanged)", title: "This server")
            .disabled(saving)
        Section {
            Button {
                save()
            } label: {
                HStack {
                    Text(saving ? "Connecting…" : "Save and test")
                    if saving { Spacer(); ProgressView() }
                }
            }
            .accessibilityIdentifier("Save and test")
            .disabled(saving || !changed)
        } footer: {
            if let status {
                Label(status, systemImage: statusIsError ? "exclamationmark.circle" : "checkmark.circle")
                    .foregroundStyle(statusIsError ? Color.red : Color.secondary)
            }
        }
        if let info = app.info {
            Section("Advanced") {
                DisclosureGroup("Server details") {
                    LabeledContent("Version", value: info.version)
                    LabeledContent("Tool router", value: "\(info.router.type) (\(info.router.mode))")
                    LabeledContent("Browser", value: info.browser?.enabled == true ? "On" : "Off")
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Computer")
                        Text(info.computer)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                DisclosureGroup("Models") {
                    ForEach(info.models) { model in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.spec).font(.subheadline)
                            if model.contextWindow > 0 {
                                Text("\(model.contextWindow.formatted()) tokens")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                DisclosureGroup("Providers") {
                    ForEach(info.providers) { provider in
                        LabeledContent(provider.id) {
                            Label(provider.configured ? "Configured" : "Not configured",
                                  systemImage: provider.configured ? "checkmark.circle.fill" : "circle")
                                .font(.caption)
                                .foregroundStyle(provider.configured ? Color.accentColor : Color.secondary)
                        }
                    }
                }
            }
        }
    }

    private var changed: Bool {
        urlText != (app.settings.baseURL?.absoluteString ?? "") || !apiKey.isEmpty
    }

    private func save() {
        saving = true
        status = nil
        statusIsError = false
        Task {
            do {
                let key = apiKey.isEmpty ? app.settings.apiKey : apiKey
                let info = try await app.connect(urlText: urlText, apiKey: key, pushToken: notifications.deviceToken, editing: true)
                status = "Connected to \(info.name) \(info.version)."
                urlText = app.settings.baseURL?.absoluteString ?? urlText
                apiKey = ""
            } catch {
                status = error.localizedDescription
                statusIsError = true
            }
            saving = false
        }
    }
}

/// Whether notifications reach this device, and the one action that changes it.
private struct NotificationsSection: View {
    let serverCanSend: Bool
    let agentName: String
    var hosted = false
    @Environment(Notifications.self) private var notifications
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            if !serverCanSend {
                LabeledContent("Notifications", value: "Not available")
            } else if notifications.isAllowed {
                LabeledContent("Notifications", value: "On")
            } else if notifications.status == .denied {
                LabeledContent("Notifications", value: "Off")
                Button(PlatformOpen.notificationSettingsTitle) {
                    if let url = PlatformOpen.notificationSettingsURL { openURL(url) }
                }
            } else {
                Button("Turn on notifications") { Task { await notifications.requestPermissionIfNeeded() } }
            }
        } footer: {
            Text(serverCanSend
                 ? "\(agentName) lets you know when it needs your OK, finishes a task, or has news from a check-in."
                 : hosted ? "Notifications are not available yet." : "Your server is not set up to send notifications yet.")
        }
    }
}

/// How much of this month's allowance is used, as the hosting service reports it: a bar and a
/// percentage, nothing more (the user asked for no detail here).
private struct UsageSection: View {
    let client: SunnieClient
    @State private var usage: UsageInfo?
    @State private var failed = false

    var body: some View {
        Section {
            if let usage {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: min(usage.percent, 100), total: 100)
                        .tint(usage.percent >= 100 ? .red : usage.percent >= 80 ? .orange : .accentColor)
                    HStack {
                        Text("\(Int(usage.percent.rounded()))% used")
                            .font(.subheadline)
                        Spacer()
                        if let renews = renewal(usage.resetsAt) {
                            Text("Renews \(renews)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(Int(usage.percent.rounded())) percent of this month's allowance used")
            } else if failed {
                Text("Usage could not be loaded right now.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).accessibilityHidden(true)
                    Text("Loading…").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("This month")
        }
        .task(id: ObjectIdentifier(client)) {
            failed = false
            do {
                usage = try await client.usage()
            } catch {
                failed = usage == nil
            }
        }
    }

    private func renewal(_ iso: String?) -> String? {
        guard let iso, let date = ISO8601DateFormatter().date(from: iso) ?? ISO8601DateFormatter.withFractionalSeconds.date(from: iso) else { return nil }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
