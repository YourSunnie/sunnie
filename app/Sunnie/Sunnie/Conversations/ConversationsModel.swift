import Foundation
import Observation

@Observable
final class ConversationsModel {
    private let client: SunnieClient
    private(set) var conversations: [Conversation] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    var error: String?

    init(client: SunnieClient) {
        self.client = client
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false; hasLoaded = true }
        do {
            conversations = try await client.listConversations(limit: 100)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func delete(_ conversation: Conversation) async {
        do {
            try await client.deleteConversation(conversation.id)
            conversations.removeAll { $0.id == conversation.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
