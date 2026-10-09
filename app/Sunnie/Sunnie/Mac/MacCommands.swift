#if os(macOS)
import SwiftUI

/// What the menu bar can ask of the window in front.
nonisolated struct SunnieActions: Sendable {
    let newChat: @MainActor @Sendable () -> Void
    let showSettings: @MainActor @Sendable () -> Void
    let refresh: @MainActor @Sendable () -> Void
}

extension FocusedValues {
    @Entry var sunnieActions: SunnieActions?
}

/// File → New Conversation, Sunnie → Settings… and View → Refresh, for the connected window.
/// Settings is the sidebar's own screen rather than a window of its own: it shares the window's
/// state (what this Mac shares, the saved servers), as the tab does on iOS.
struct SunnieCommands: Commands {
    @FocusedValue(\.sunnieActions) private var actions

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Conversation") { actions?.newChat() }
                .keyboardShortcut("n")
                .disabled(actions == nil)
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { actions?.showSettings() }
                .keyboardShortcut(",")
                .disabled(actions == nil)
        }
        CommandGroup(after: .sidebar) {
            Button("Refresh") { actions?.refresh() }
                .keyboardShortcut("r")
                .disabled(actions == nil)
        }
    }
}
#endif
