import SwiftUI

/// The vault: sign-ins the agent can fill into its browser by name, without ever being shown
/// the password. Secrets are write-only here too — the server does not send them back.
struct LoginsView: View {
    let agentName: String
    @State private var model: LoginsModel
    @State private var editing: LoginEditorTarget?

    init(client: SunnieClient, agentName: String) {
        self.agentName = agentName
        _model = State(initialValue: LoginsModel(client: client))
    }

    var body: some View {
        List {
            if !model.logins.isEmpty {
                Section {
                    ForEach(model.logins) { login in
                        Button { editing = .existing(login) } label: { LoginRow(login: login) }
                            .buttonStyle(.plain)
                            .accessibilityHint("Edit login")
                    }
                    .onDelete { offsets in
                        let doomed = offsets.map { model.logins[$0] }
                        Task { for login in doomed { await model.delete(login) } }
                    }
                } footer: {
                    Text("\(agentName) uses each login only on its matching site. Passwords are never sent to the language model.")
                }
            }
        }
        .overlay {
            if model.logins.isEmpty {
                if model.isLoading {
                    ProgressView("Loading logins…")
                } else {
                    GeometryReader { geometry in
                        ScrollView {
                            GardenEmptyState(title: "Your sign-ins, ready to help", message: "Save a login for \(agentName) to use on its matching site.") {
                                Button("Add your first login", systemImage: "plus") { editing = .new }
                                    .buttonStyle(.borderedProminent)
                            }
                            .frame(minHeight: geometry.size.height)
                        }
                    }
                }
            }
        }
        .navigationTitle("Logins")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editing = .new } label: { Label("Add login", systemImage: "plus") }
                    .disabled(model.isLoading && model.logins.isEmpty)
            }
        }
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .sheet(item: $editing) { target in
            LoginEditor(model: model, target: target)
        }
        .alert("Something went wrong", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") {}
        } message: {
            Text(model.error ?? "")
        }
    }
}

nonisolated enum LoginEditorTarget: Identifiable, Hashable {
    case new
    case existing(Login)

    var id: String {
        switch self {
        case .new: return "new"
        case .existing(let login): return login.id
        }
    }
}

private struct LoginRow: View {
    let login: Login

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "key")
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(login.name).font(.headline)
                if login.name != login.site {
                    Text(login.site).font(.subheadline).foregroundStyle(.secondary)
                }
                if !login.username.isEmpty {
                    Text(login.username).font(.subheadline).foregroundStyle(.secondary)
                }
                if login.hasPassword || login.hasTotp {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { credentials }
                        VStack(alignment: .leading, spacing: 4) { credentials }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var credentials: some View {
        if login.hasPassword {
            Label("Password", systemImage: "key.fill").accessibilityLabel("Password saved")
        }
        if login.hasTotp {
            Label("Authenticator", systemImage: "clock.badge.checkmark").accessibilityLabel("One-time codes saved")
        }
    }
}

private struct LoginEditor: View {
    let model: LoginsModel
    let target: LoginEditorTarget
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var site = ""
    @State private var username = ""
    @State private var password = ""
    @State private var totpSecret = ""
    @State private var saving = false
    @State private var error: String?

    private var existing: Login? {
        if case .existing(let login) = target { return login } else { return nil }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        fieldLabel("Website")
                        TextField("Site, e.g. github.com", text: $site, prompt: Text("Site, e.g. github.com"))
                            .captionedField()
                            .urlTextEntry()
                            .accessibilityLabel("Website")
                            .accessibilityIdentifier("Site, e.g. github.com")
                    }
                    .padding(.vertical, 4)
                    VStack(alignment: .leading, spacing: 6) {
                        fieldLabel("Name")
                        TextField("Name (optional)", text: $name, prompt: Text("Name (optional)"))
                            .captionedField()
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Website")
                } footer: {
                    Text("This login can only be used on this site and its subdomains.")
                }
                .plainTextEntry()
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        fieldLabel("Username or email")
                        TextField("Username or email", text: $username, prompt: Text("Username or email"))
                            .captionedField()
                            .plainTextEntry()
                    }
                    .padding(.vertical, 4)
                    // These belong to the agent's vault, not to this app: declaring them one-time
                    // codes keeps iOS from offering to save them in Passwords.
                    VStack(alignment: .leading, spacing: 6) {
                        fieldLabel("Password")
                        SecureField(existing?.hasPassword == true ? "Password (unchanged)" : "Password", text: $password,
                                    prompt: Text(existing?.hasPassword == true ? "Password (unchanged)" : "Password"))
                            .captionedField()
                            .textContentType(.oneTimeCode)
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Sign-in")
                } footer: {
                    if existing?.hasPassword == true {
                        Text("Your saved password is never shown. Leave this blank to keep it.")
                    }
                }
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        fieldLabel("Setup key")
                        SecureField(existing?.hasTotp == true ? "Setup key (unchanged)" : "Authenticator setup key (optional)", text: $totpSecret,
                                    prompt: Text(existing?.hasTotp == true ? "Setup key (unchanged)" : "Authenticator setup key (optional)"))
                            .captionedField()
                            .textContentType(.oneTimeCode)
                            .plainTextEntry()
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Two-factor authentication")
                } footer: {
                    Text(existing?.hasTotp == true
                         ? "Leave this blank to keep the saved setup key."
                         : "Optional. Enter the setup key shown beside the site’s authenticator QR code to generate sign-in codes on your server.")
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
            }
            .disabled(saving)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(existing == nil ? "New login" : "Edit login")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            error = await model.save(existing, name: name, site: site, username: username, password: password, totpSecret: totpSecret)
                            saving = false
                            if error == nil { dismiss() }
                        }
                    }
                    .disabled(saving || site.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if saving {
                    ToolbarItem(placement: .principal) { ProgressView("Saving…") }
                }
            }
            .interactiveDismissDisabled(saving)
            .onAppear {
                if let existing {
                    name = existing.name
                    site = existing.site
                    username = existing.username
                }
            }
        }
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title).font(.caption).foregroundStyle(.secondary)
    }
}
