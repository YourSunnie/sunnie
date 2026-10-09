import Foundation
import Observation

@Observable
final class MemoryModel {
    private let client: SunnieClient
    private(set) var memories: [Memory] = []
    private(set) var total = 0
    private(set) var core: CoreMemory?
    private(set) var isLoading = false
    var query = ""
    var error: String?

    init(client: SunnieClient) {
        self.client = client
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let page = client.listMemories(query: query)
            async let core = client.coreMemory()
            let (p, c) = try await (page, core)
            memories = p.memories
            total = p.total
            self.core = c
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func search() async {
        do {
            let page = try await client.listMemories(query: query)
            memories = page.memories
            total = page.total
        } catch {
            self.error = error.localizedDescription
        }
    }

    func save(_ existing: Memory?, content: String, kind: MemoryKind) async -> Bool {
        do {
            if let existing {
                let updated = try await client.updateMemory(existing.id, content: content, kind: kind)
                if let i = memories.firstIndex(where: { $0.id == updated.id }) { memories[i] = updated }
            } else {
                let created = try await client.createMemory(content: content, kind: kind)
                memories.removeAll { $0.id == created.id }
                memories.insert(created, at: 0)
                total += 1
            }
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func delete(_ memory: Memory) async {
        do {
            try await client.deleteMemory(memory.id)
            memories.removeAll { $0.id == memory.id }
            total = max(0, total - 1)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func saveCore(block: String, content: String) async -> String? {
        do {
            let saved = try await client.setCoreMemory(block: block, content: content)
            core?.blocks[block] = saved
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
