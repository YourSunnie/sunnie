import SwiftUI

/// Settings → Phone data (Device data on the Mac): what this device shares with the agent, one
/// switch per source.
struct PhoneDataView: View {
    let agentName: String
    /// The sources this server accepts.
    let supported: [String]
    @Environment(PhoneModel.self) private var phone

    var body: some View {
        Form {
            Section {} footer: {
                #if os(macOS)
                Text("Choose what this Mac shares with \(agentName). A copy goes to your server when you open Sunnie, and from time to time while it runs. \(agentName) reads it when a question needs it — your schedule, the people you know, the weather where you are. Health, Music and Places come from your iPhone.")
                    .font(.subheadline)
                #else
                Text("Choose what this iPhone shares with \(agentName). A copy goes to your server when you open the app, and from time to time while it is closed, when iOS allows. \(agentName) reads it when a question needs it — your schedule, your sleep, the weather where you are.")
                    .font(.subheadline)
                #endif
            }
            ForEach(PhoneSource.onThisDevice.filter { supported.contains($0.rawValue) }) { source in
                Section {
                    Toggle(isOn: Binding(
                        get: { phone.enabled.contains(source) },
                        set: { on in Task { await phone.setEnabled(source, on) } }
                    )) {
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(source.title)
                                Text(source.detail)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        } icon: {
                            Image(systemName: source.symbol)
                        }
                    }
                    .disabled(phone.busy.contains(source) || phone.asking.contains(source))
                    .padding(.vertical, 4)
                    status(source)
                } footer: {
                    if let error = phone.errors[source] {
                        Text(error).foregroundStyle(.red)
                    } else if source == .health, phone.enabled.contains(source) {
                        Text("What is sent follows what you allowed in Health, under Settings → Apps → Health → Data Access & Devices → Sunnie: types left off are not sent, and if you shared only the past 30 days, that is all \(agentName) sees.")
                    }
                }
            }
            if !phone.enabled.isEmpty {
                Section {
                    Button {
                        Task { await phone.sendAll() }
                    } label: {
                        HStack {
                            Text("Send now")
                            if !phone.busy.isEmpty { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(!phone.busy.isEmpty)
                } footer: {
                    Text("Your server keeps only the latest copy. Your model provider sees a part of it only when \(agentName) reads it to answer you. Turning a source off deletes its copy from your server.")
                }
            }
        }
        .navigationTitle(PhoneDataView.title)
        .inlineNavigationTitle()
        .task { await phone.refresh() }
    }

    /// "Phone data" on the iPhone; a Mac is not a phone.
    static var title: String {
        #if os(macOS)
        "Device data"
        #else
        "Phone data"
        #endif
    }

    @ViewBuilder
    private func status(_ source: PhoneSource) -> some View {
        if phone.asking.contains(source) {
            Text("Waiting for your answer…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if phone.busy.contains(source) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(phone.enabled.contains(source) ? "Sending…" : "Removing…")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        } else if let status = phone.statuses[source] {
            if phone.enabled.contains(source) {
                Text("Sent \(sentAgo(status)) · \(count(status, source))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                // A copy from before a reinstall, or from another device, that nothing updates now.
                HStack {
                    Text("A copy from \(sentAgo(status)) is still on your server.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Delete", role: .destructive) { Task { await phone.withdraw(source) } }
                        .buttonStyle(.borderless)
                        .font(.footnote)
                }
            }
        }
    }

    private func sentAgo(_ status: PhoneSourceStatus) -> String {
        guard let date = status.capturedDate else { return "earlier" }
        return date.formatted(.relative(presentation: .named))
    }

    private func count(_ status: PhoneSourceStatus, _ source: PhoneSource) -> String {
        switch source {
        case .health: "\(status.count) kinds of data"
        case .calendar: status.count == 1 ? "1 event" : "\(status.count) events"
        case .reminders: status.count == 1 ? "1 reminder" : "\(status.count) reminders"
        case .location: "your town"
        case .contacts: status.count == 1 ? "1 contact" : "\(status.count) contacts"
        case .places: status.count == 1 ? "1 stay" : "\(status.count) stays"
        case .music: "\(status.count) songs"
        case .photos: "\(status.count) photos and videos"
        }
    }
}
