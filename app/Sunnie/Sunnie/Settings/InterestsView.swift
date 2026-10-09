import SwiftUI

struct InterestsView: View {
    let client: SunnieClient
    let agentName: String
    @State private var list: InterestList?
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        List {
            Section {
                Text("\(agentName) remembers the things you clearly enjoy. During check-ins, it decides when there’s something worthwhile to share and stays quiet otherwise.")
                    .foregroundStyle(.secondary)
            }
            if let list {
                Section {
                    Toggle("Pause all interest updates", isOn: Binding(
                        get: { self.list?.paused ?? false },
                        set: { value in Task { await pause(value) } }
                    ))
                    .disabled(saving)
                    if !list.enabled {
                        Label("Check-ins are disabled on this Sunnie.", systemImage: "pause.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Pausing stops discovery updates. Your memories and requested reminders stay available. These checks use your configured model and count toward its usage.")
                }
                Section {
                    if list.interests.isEmpty {
                        Text("No interests yet. Tell \(agentName) about a game, hobby, or topic you enjoy.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(list.interests) { interest in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(interest.topic).font(.headline)
                            Text(interest.status == "active" ? list.paused ? "Paused with all updates" : "Following" : "Updates stopped")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Button(interest.status == "active" ? "Stop sharing this topic" : "Resume sharing") {
                                Task { await change(interest) }
                            }
                            .frame(minHeight: 44)
                            .disabled(saving)
                            .accessibilityLabel(interest.status == "active" ? "Stop sharing \(interest.topic)" : "Resume sharing \(interest.topic)")
                        }
                        .padding(.vertical, 4)
                    }
                } header: {
                    Text("Your interests")
                } footer: {
                    Text("You can also quote a find and ask Sunnie to stop sharing that topic. Mentioning that you like it again won’t restart updates; ask to resume when you want them back.")
                }
            } else if error == nil {
                ProgressView("Loading interests…")
            }
            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Try again") { Task { await refresh() } }
                }
            }
        }
        .navigationTitle("Interests & updates")
        .task { await refresh() }
        .refreshable { await refresh() }
    }

    private func refresh() async {
        do { list = try await client.listInterests(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func pause(_ paused: Bool) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let result = try await client.pauseInterestUpdates(paused)
            list?.paused = result.paused
            list?.nextDigestAt = result.nextDigestAt
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func change(_ interest: UserInterest) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let updated = try await client.setInterestStatus(interest.id, status: interest.status == "active" ? "muted" : "active")
            if let index = list?.interests.firstIndex(where: { $0.id == interest.id }) { list?.interests[index] = updated }
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
