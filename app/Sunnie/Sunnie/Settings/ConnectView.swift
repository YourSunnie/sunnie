import SwiftUI

/// Credentials are checked before the app saves them or leaves this screen.
struct ConnectView: View {
    @Environment(AppModel.self) private var app
    @State private var urlText = ""
    @State private var apiKey = ""
    @State private var error: String?
    @State private var connecting = false
    @State private var scanning = false

    var body: some View {
        if app.flavor.isHosted {
            CodeConnectView()
        } else {
            serverForm
        }
    }

    private var serverForm: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        SunnieMark(size: 112)
                        Text("Sunnie")
                            .font(Garden.display)
                            .accessibilityAddTraits(.isHeader)
                        Text("A helping hand, always yours.")
                            .font(.headline)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Connect to your server to start a conversation with Sunnie.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: 320)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .listRowBackground(Color.clear)
                }
                if !app.servers.isEmpty {
                    SavedServersSection()
                        .disabled(connecting)
                }
                #if os(macOS)
                ConnectLinkSection(connecting: connecting) { link in connect(link: link) }
                #else
                if ScanCodeView.isSupported {
                    Section {
                        Button {
                            scanning = true
                        } label: {
                            Label("Scan code", systemImage: "qrcode.viewfinder")
                        }
                        .disabled(connecting)
                    } footer: {
                        Text("Were you sent a QR code? Scan it and Sunnie connects by itself.")
                    }
                }
                #endif
                ServerFields(urlText: $urlText, apiKey: $apiKey, title: app.servers.isEmpty ? "Connection" : "Another server")
                    .disabled(connecting)
                Section {
                    Button {
                        connect()
                    } label: {
                        HStack(spacing: 10) {
                            if connecting { ProgressView().tint(.white) }
                            Text(connecting ? "Connecting…" : "Connect")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 36)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("Connect")
                    .disabled(connecting || !canConnect)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } footer: {
                    if let error {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                    } else {
                        Label("Your API key is saved securely on this device.", systemImage: "lock")
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationBarHidden()
            #if os(iOS)
            .sheet(isPresented: $scanning) {
                ScanCodeView { link in connect(link: link) }
            }
            #endif
        }
    }

    private var canConnect: Bool {
        !urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func connect(link: URL) {
        connecting = true
        error = nil
        Task {
            do {
                try await app.connect(link: link)
            } catch {
                self.error = error.localizedDescription
            }
            connecting = false
        }
    }

    private func connect() {
        connecting = true
        error = nil
        Task {
            do {
                try await app.connect(urlText: urlText, apiKey: apiKey)
            } catch {
                self.error = error.localizedDescription
            }
            connecting = false
        }
    }
}

/// The hosted app's connect screen: the code from the hosted panel, scanned or typed. There is no
/// address or key to enter; the code is spent once for both (`ConnectLink`).
struct CodeConnectView: View {
    @Environment(AppModel.self) private var app
    @Environment(Notifications.self) private var notifications
    @State private var code = ""
    @State private var error: String?
    @State private var connecting = false
    @State private var scanning = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        SunnieMark(size: 112)
                        Text("Sunnie")
                            .font(Garden.display)
                            .accessibilityAddTraits(.isHeader)
                        Text("A helping hand, always yours.")
                            .font(.headline)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("To sign in, open your Sunnie panel and scan the code it shows, or type the code below.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: 320)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .listRowBackground(Color.clear)
                }
                #if os(macOS)
                ConnectLinkSection(connecting: connecting) { link in connect(link: link) }
                #else
                if ScanCodeView.isSupported {
                    Section {
                        Button {
                            scanning = true
                        } label: {
                            Label("Scan code", systemImage: "qrcode.viewfinder")
                        }
                        .disabled(connecting)
                    }
                }
                #endif
                Section {
                    TextField("Code", text: $code, prompt: Text("Code"))
                        .plainTextEntry()
                        .focused($codeFocused)
                        .submitLabel(.go)
                        .onSubmit { connectWithCode() }
                        .accessibilityIdentifier("Code")
                        .disabled(connecting)
                } header: {
                    Text("Or type the code")
                }
                Section {
                    Button {
                        connectWithCode()
                    } label: {
                        HStack(spacing: 10) {
                            if connecting { ProgressView().tint(.white) }
                            Text(connecting ? "Signing in…" : "Sign in")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 36)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("Sign in")
                    .disabled(connecting || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } footer: {
                    if let error {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                    } else {
                        Text("Each code works once. If one has expired, the panel gives you a new one.")
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationBarHidden()
            #if os(iOS)
            .sheet(isPresented: $scanning) {
                ScanCodeView { link in connect(link: link) }
            }
            #endif
        }
    }

    private func connectWithCode() {
        guard !connecting else { return }
        guard let link = ConnectLink.forCode(code, host: app.flavor.connectHost) else {
            error = "That code does not look right. Check it against your Sunnie panel, or scan it instead."
            return
        }
        codeFocused = false
        connect(link: link)
    }

    private func connect(link: URL) {
        connecting = true
        error = nil
        Task {
            do {
                try await app.connect(link: link, pushToken: notifications.deviceToken)
            } catch {
                self.error = error.localizedDescription
            }
            connecting = false
        }
    }
}

struct ServerFields: View {
    @Binding var urlText: String
    @Binding var apiKey: String
    var keyPlaceholder = "API key"
    var title = "Connection"
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case address, key }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Server address").font(.caption).foregroundStyle(.secondary)
                TextField("http://192.168.1.10:8787", text: $urlText, prompt: Text(verbatim: "http://192.168.1.10:8787"))
                    .captionedField()
                    .urlTextEntry()
                    .focused($focusedField, equals: .address)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .key }
                    .accessibilityLabel("Server address")
                    .accessibilityIdentifier("http://192.168.1.10:8787")
            }
            .padding(.vertical, 4)
            VStack(alignment: .leading, spacing: 6) {
                Text("API key").font(.caption).foregroundStyle(.secondary)
                SecureField(keyPlaceholder, text: $apiKey, prompt: Text(keyPlaceholder))
                    .captionedField()
                    .textContentType(.password)
                    .plainTextEntry()
                    .focused($focusedField, equals: .key)
                    .submitLabel(.done)
                    .onSubmit { focusedField = nil }
                    .accessibilityIdentifier(keyPlaceholder)
            }
            .padding(.vertical, 4)
        } header: {
            Text(title)
        } footer: {
            Text(keyPlaceholder == "API key"
                 ? "Use the address and API key from your Sunnie server."
                 : "Leave the API key blank to keep the saved key.")
        }
    }
}
