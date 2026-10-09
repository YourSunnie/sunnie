import SwiftUI

struct SkillsView: View {
    let client: SunnieClient
    let agentName: String
    @State private var catalog: SkillCatalog?
    @State private var error: String?
    @State private var switching: Set<String> = []

    /// How the skills shipped with Sunnie are named on screen; any other keeps its own name.
    private static let titles = ["markdown": "Markdown", "docs": "Docs", "slides": "Slides", "excel": "Excel", "pdf": "PDF", "latex": "LaTeX"]

    var body: some View {
        List {
            Section {
                Text("Skills give \(agentName) reusable instructions for a task. Ask in chat to create a skill or install one from a repository.")
                    .foregroundStyle(.secondary)
            }
            if let catalog {
                let included = catalog.skills.filter(\.isBundled)
                if !included.isEmpty {
                    Section {
                        ForEach(included) { skill in
                            Toggle(isOn: Binding(
                                get: { skill.isOn },
                                set: { value in Task { await setEnabled(skill, value) } }
                            )) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(Self.titles[skill.name] ?? skill.name).font(.headline)
                                    Text(skill.summary).font(.subheadline).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 4)
                            }
                            .disabled(switching.contains(skill.name))
                        }
                    } header: {
                        Text("Included with \(agentName)")
                    } footer: {
                        Text("These come with \(agentName) and are off until you turn them on. When one is on, \(agentName) follows it for that kind of task.")
                    }
                }
                Section("Installed skills") {
                    let installed = catalog.skills.filter { !$0.isBundled }
                    if installed.isEmpty {
                        Text("No skills installed yet.").foregroundStyle(.secondary)
                    }
                    ForEach(installed) { skill in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(skill.name).font(.headline)
                            Text(skill.description).font(.subheadline).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
                if !catalog.sources.isEmpty {
                    Section {
                        ForEach(catalog.sources) { source in
                            Text(source.repository)
                                .font(.subheadline)
                                .textSelection(.enabled)
                                .swipeActions {
                                    Button("Stop trusting", role: .destructive) {
                                        Task { await revoke(source) }
                                    }
                                }
                        }
                    } header: {
                        Text("Trusted repositories")
                    } footer: {
                        Text("\(agentName) asks before trusting a new repository. Stop trusting one to require approval for future installs; installed skills stay available.")
                    }
                }
                if !catalog.warnings.isEmpty {
                    Section("Could not load") {
                        ForEach(catalog.warnings, id: \.self) { warning in
                            Text(warning).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            } else if error == nil {
                ProgressView("Loading skills…")
            }
            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Try again") { Task { await refresh() } }
                }
            }
        }
        .navigationTitle("Skills")
        .task { await refresh() }
        .refreshable { await refresh() }
    }

    private func refresh() async {
        do {
            catalog = try await client.listSkills()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setEnabled(_ skill: AgentSkill, _ enabled: Bool) async {
        guard let index = catalog?.skills.firstIndex(where: { $0.name == skill.name }) else { return }
        switching.insert(skill.name)
        defer { switching.remove(skill.name) }
        catalog?.skills[index].enabled = enabled
        do {
            let saved = try await client.setSkillEnabled(skill.name, enabled: enabled)
            catalog?.skills[index].enabled = saved.enabled
            error = nil
        } catch {
            catalog?.skills[index].enabled = !enabled
            self.error = error.localizedDescription
        }
    }

    private func revoke(_ source: SkillSource) async {
        do {
            try await client.revokeSkillSource(source.repository)
            await refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
