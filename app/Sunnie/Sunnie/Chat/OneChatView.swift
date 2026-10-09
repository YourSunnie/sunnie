import SwiftUI

/// The Chats tab in the one-chat mode: the one conversation with Sunnie, and nothing to pick
/// from. Check-ins, and chats a notification opens, are pushed on top of it.
struct OneChatView: View {
    let client: SunnieClient
    let oneChat: OneChat
    @Environment(AppModel.self) private var app
    @Environment(CheckInsModel.self) private var checkIns
    @Environment(Notifications.self) private var notifications
    @State private var path: [Conversation] = []
    @State private var conversation: Conversation?
    @State private var isLoading = true
    @State private var error: String?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if isLoading {
                    ProgressView("Loading…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else if let error {
                    ContentUnavailableView {
                        Label("\(app.agentName) is not available", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { Task { await load() } }
                    }
                } else {
                    // After a fresh start the old conversation must not reach the new screen.
                    ChatView(client: client, conversation: conversation.flatMap { $0.id == oneChat.conversationId ? $0 : nil },
                             style: .person, oneChat: oneChat)
                        // Only a fresh start makes a new screen; the first send's new id does not.
                        .id(oneChat.generation)
                }
            }
            .toolbar {
                if let conversation = checkIns.conversation {
                    ToolbarItem(placement: .leadingBar) {
                        CheckInsButton(hasNew: checkIns.hasNew) { path.append(conversation) }
                    }
                }
            }
            .navigationDestination(for: Conversation.self) { ChatView(client: client, conversation: $0) }
        }
        .task(id: oneChat.generation) { await load() }
        .task(id: notifications.pendingConversationId) {
            guard let id = notifications.pendingConversationId else { return }
            defer { notifications.pendingConversationId = nil }
            // The one chat is already on screen and catches up by itself.
            guard id != oneChat.conversationId else { path = []; return }
            if let other = try? await client.getConversation(id) { path = [other] }
        }
    }

    private func load() async {
        guard let id = oneChat.conversationId else {
            conversation = nil
            error = nil
            isLoading = false
            return
        }
        guard conversation?.id != id else { isLoading = false; return }
        do {
            conversation = try await client.getConversation(id)
            error = nil
        } catch let gone as APIError where gone.status == 404 {
            // Deleted elsewhere: the next message starts a new one chat.
            conversation = nil
            error = nil
            oneChat.startOver()
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
