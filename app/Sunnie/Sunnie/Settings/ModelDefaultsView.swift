import SwiftUI

struct ModelDefaultsView: View {
    let client: SunnieClient
    @Environment(AppModel.self) private var app
    @State private var modelID = ""
    @State private var reasoning = "low"
    @State private var original: ChatModelDefaults?
    @State private var saving = false
    @State private var error: String?
    @State private var saved = false

    private var selection: ChatModelDefaults? {
        guard let model = ChatModelDefaults.openRouterSpec(modelID) else { return nil }
        return ChatModelDefaults(model: model, reasoning: reasoning)
    }

    var body: some View {
        Form {
            Section {
                TextField("OpenRouter model ID", text: $modelID, prompt: Text("OpenRouter model ID"), axis: .vertical)
                    .captionedField()
                    .plainTextEntry()
                    .accessibilityLabel("OpenRouter model ID")
                Picker("Reasoning effort", selection: $reasoning) {
                    ForEach(ChatModelDefaults.efforts, id: \.self) { effort in
                        Text(effort == "xhigh" ? "Extra high" : effort.capitalized).tag(effort)
                    }
                }
            } footer: {
                Text("Paste the author/model ID from OpenRouter. These settings apply to new chats. Existing chats keep their settings. Available reasoning levels depend on the model.")
            }
            .disabled(original == nil || saving)
            Section {
                Button(saving ? "Saving…" : "Save default") { Task { await save() } }
                    .disabled(original == nil || saving || selection == nil || selection == original)
                if saved { Label("Saved for new chats", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
                if let error { Text(error).foregroundStyle(.red) }
                if original == nil {
                    if error == nil { ProgressView("Loading settings…") }
                    else { Button("Try again") { Task { await load() } } }
                }
            }
        }
        .navigationTitle("Model for new chats")
        .inlineNavigationTitle()
        .scrollDismissesKeyboard(.interactively)
        .task { await load() }
        .onChange(of: modelID) { _, _ in saved = false }
        .onChange(of: reasoning) { _, _ in saved = false }
    }

    private func load() async {
        do {
            let value = try await client.modelDefaults()
            original = value
            modelID = value.model.hasPrefix("openrouter/") ? String(value.model.dropFirst("openrouter/".count)) : ""
            reasoning = value.reasoning
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard let selection else { return }
        saving = true
        defer { saving = false }
        do {
            original = try await client.saveModelDefaults(selection)
            error = nil
            saved = true
            await app.refreshInfo()
        } catch { self.error = error.localizedDescription }
    }
}
