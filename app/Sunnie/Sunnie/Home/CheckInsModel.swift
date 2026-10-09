import Foundation
import Observation

/// The Check-ins conversation as the toolbars show it: where it is, and whether it holds news the
/// user has not seen. What was seen is remembered on this device, per server and conversation.
@Observable
final class CheckInsModel {
    private let client: SunnieClient
    private let defaults: UserDefaults
    private(set) var status: CheckInStatus?
    private(set) var conversation: Conversation?
    private(set) var seenSeq = 0

    init(client: SunnieClient, defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
    }

    /// Something arrived after the last thing the user saw there.
    var hasNew: Bool { Self.isNew(latest: status?.latestSeq, seen: seenSeq) }

    nonisolated static func isNew(latest: Int?, seen: Int) -> Bool {
        guard let latest else { return false }
        return latest > seen
    }

    func refresh() async {
        guard let status = try? await client.checkIns() else { return }
        await update(status)
    }

    /// Takes the status the Home feed already carries, so Home needs no second request.
    func update(_ status: CheckInStatus) async {
        self.status = status
        guard let id = status.conversationId else {
            conversation = nil
            return
        }
        seenSeq = defaults.integer(forKey: key(id))
        if conversation?.id != id { conversation = try? await client.getConversation(id) }
    }

    /// The user has looked at the conversation up to `seq`.
    func markSeen(_ seq: Int?, in conversationId: String?) {
        guard let seq, let conversationId, conversationId == status?.conversationId ?? conversation?.id,
              seq > seenSeq else { return }
        seenSeq = seq
        defaults.set(seq, forKey: key(conversationId))
    }

    private func key(_ conversationId: String) -> String {
        "checkIns.seen.\(client.baseURL.absoluteString).\(conversationId)"
    }
}
