import SwiftUI

nonisolated enum ChatRoute: Hashable {
    case existing(Conversation)
    /// A fresh chat; the id keeps each "new" push distinct in the navigation path.
    case new(UUID)
}

struct ConversationListView: View {
    let client: SunnieClient
    @Environment(AppModel.self) private var app
    @Environment(CheckInsModel.self) private var checkIns
    @Environment(Notifications.self) private var notifications
    @State private var model: ConversationsModel
    @State private var path: [ChatRoute] = []

    init(client: SunnieClient) {
        self.client = client
        _model = State(initialValue: ConversationsModel(client: client))
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if conversations.isEmpty, model.hasLoaded {
                    GeometryReader { geometry in
                        ScrollView {
                            GardenEmptyState(
                                title: "No conversations yet",
                                message: "Make a plan, ask a question, or hand something over to \(app.agentName)."
                            ) {
                                Button("New conversation") { path.append(.new(UUID())) }
                                    .buttonStyle(.borderedProminent)
                                    .controlSize(.large)
                            }
                            .padding(.vertical, 32)
                            .frame(minHeight: geometry.size.height)
                        }
                    }
                } else {
                    List {
                        ForEach(conversations) { conversation in
                            NavigationLink(value: ChatRoute.existing(conversation)) {
                                ConversationRow(conversation: conversation)
                            }
                            .accessibilityHint("Opens conversation")
                        }
                        .onDelete { offsets in
                            let doomed = offsets.map { conversations[$0] }
                            Task { for c in doomed { await model.delete(c) } }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle(app.agentName)
            .toolbar {
                if pinsCheckIns, let conversation = checkIns.conversation {
                    ToolbarItem(placement: .trailingBar) {
                        CheckInsButton(hasNew: checkIns.hasNew) { path.append(.existing(conversation)) }
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { path.append(.new(UUID())) } label: {
                        Label("New conversation", systemImage: "square.and.pencil")
                    }
                }
            }
            .navigationDestination(for: ChatRoute.self) { route in
                switch route {
                case .existing(let conversation): ChatView(client: client, conversation: conversation)
                case .new: ChatView(client: client, conversation: nil)
                }
            }
            .refreshable { await model.refresh() }
            .task(id: notifications.pendingConversationId) {
                guard let id = notifications.pendingConversationId else { return }
                defer { notifications.pendingConversationId = nil }
                if let conversation = try? await client.getConversation(id) { path = [.existing(conversation)] }
            }
            .overlay {
                if !model.hasLoaded {
                    ProgressView("Loading conversations…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .onAppear {
                Task { await model.refresh() }
                if pinsCheckIns { Task { await checkIns.refresh() } }
            }
            .alert("Something went wrong", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
                Button("OK") {}
            } message: {
                Text(model.error ?? "")
            }
        }
    }
}

extension ConversationListView {
    /// With Home, Check-ins has its own button in the toolbar instead of a place in the list.
    private var pinsCheckIns: Bool { app.info?.home?.enabled == true }

    private var conversations: [Conversation] {
        pinsCheckIns ? model.conversations.filter { $0.kind != "heartbeat" } : model.conversations
    }
}

private struct ConversationRow: View {
    let conversation: Conversation
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if conversation.kind == "heartbeat" {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
                Text(conversation.displayTitle)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if conversation.kind == "heartbeat" {
                Text("Reminders and follow-ups")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            metadataLayout {
                if conversation.activeRunId != nil {
                    HStack(spacing: 4) {
                        TurningStar(size: 12)
                            .accessibilityHidden(true)
                        Text("Working")
                            .foregroundStyle(Color.accentColor)
                    }
                    if conversation.updatedDate != nil, !dynamicTypeSize.isAccessibilitySize {
                        Text("·").accessibilityHidden(true)
                    }
                }
                if let date = conversation.updatedDate {
                    Text(date, format: .relative(presentation: .named))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
    }

    private var metadataLayout: AnyLayout {
        if dynamicTypeSize.isAccessibilitySize {
            AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
        } else {
            AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 6))
        }
    }
}
