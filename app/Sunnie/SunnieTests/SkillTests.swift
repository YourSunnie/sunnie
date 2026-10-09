import Foundation
import Testing
@testable import Sunnie

struct SkillTests {
    @Test func decodesCatalogAndTrustedRepositories() throws {
        let data = Data(#"{"skills":[{"name":"release-notes","description":"Write release notes.","path":"/home/sunnie/.agents/skills/release-notes/SKILL.md"}],"warnings":[],"sources":[{"repository":"https://github.com/example/skills","trustedAt":"2026-10-03T00:00:00Z"}]}"#.utf8)
        let catalog = try JSONDecoder().decode(SkillCatalog.self, from: data)
        #expect(catalog.skills.first?.name == "release-notes")
        #expect(catalog.sources.first?.repository == "https://github.com/example/skills")
    }

    @Test func decodesSkillsShippedWithSunnieAndOlderServers() throws {
        let data = Data(#"{"skills":[{"name":"pdf","description":"Read, extract from and create PDF files. Use when the user shares a PDF.","path":"/opt/sunnie/skills/bundled/pdf/SKILL.md","bundled":true,"enabled":false},{"name":"release-notes","description":"Write release notes","path":"/home/sunnie/.agents/skills/release-notes/SKILL.md"}],"warnings":[],"sources":[]}"#.utf8)
        let catalog = try JSONDecoder().decode(SkillCatalog.self, from: data)
        let pdf = try #require(catalog.skills.first)
        #expect(pdf.isBundled && !pdf.isOn)
        #expect(pdf.summary == "Read, extract from and create PDF files.")
        let own = catalog.skills[1]
        #expect(!own.isBundled && own.isOn)
        #expect(own.summary == "Write release notes")
    }

    @Test func skillsHaveReadableProgress() {
        #expect(ChatRow.StepKind(tool: "skill_read").progress == "Reading its skills…")
        #expect(ChatRow.StepKind(tool: "skill_install").phrase(count: 1) == "installed a skill")
        #expect(ChatRow.StepKind(tool: "skill_write").progress == "Saving a skill…")
    }
}
