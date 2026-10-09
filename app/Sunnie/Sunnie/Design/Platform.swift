import ImageIO
import SwiftUI
#if canImport(UIKit)
import UIKit

typealias PlatformImage = UIImage
typealias PlatformFont = UIFont
typealias PlatformColor = UIColor
#else
import AppKit

typealias PlatformImage = NSImage
typealias PlatformFont = NSFont
typealias PlatformColor = NSColor

// UIKit's names, so a call site written for iOS reads the same on the Mac.
extension NSColor {
    static var label: NSColor { .labelColor }
    static var secondaryLabel: NSColor { .secondaryLabelColor }
    static var tertiaryLabel: NSColor { .tertiaryLabelColor }
}
#endif

// The few places where iOS and the Mac differ. Everything else in the app is the same SwiftUI.

extension PlatformImage {
    /// Whether SF Symbols has `name` on this system: a widget names its icons, and a model guesses.
    static func hasSymbol(_ name: String) -> Bool {
        #if canImport(UIKit)
        UIImage(systemName: name) != nil
        #else
        NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
        #endif
    }

    /// A picture shrunk to at most `maxPixelSize` on its longer side, read without decoding the whole file.
    nonisolated static func thumbnail(of url: URL, maxPixelSize: Int) -> PlatformImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
              ] as CFDictionary) else { return nil }
        return from(cgImage: cg)
    }

    nonisolated static func from(cgImage: CGImage) -> PlatformImage {
        #if canImport(UIKit)
        UIImage(cgImage: cgImage)
        #else
        NSImage(cgImage: cgImage, size: CGSize(width: cgImage.width, height: cgImage.height))
        #endif
    }
}

extension Image {
    init(platformImage image: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: image)
        #else
        self.init(nsImage: image)
        #endif
    }
}

extension Color {
    // iOS's light grays; the app is light only (AGENTS.md), so the Mac uses the same values.
    #if canImport(UIKit)
    static let systemGray5 = Color(.systemGray5)
    static let systemGray6 = Color(.systemGray6)
    static let tertiaryLabel = Color(.tertiaryLabel)
    #else
    static let systemGray5 = Color(red: 229 / 255, green: 229 / 255, blue: 234 / 255)
    static let systemGray6 = Color(red: 242 / 255, green: 242 / 255, blue: 247 / 255)
    static let tertiaryLabel = Color(nsColor: .tertiaryLabelColor)
    #endif

    /// A grouped screen's ground, and the cards on it, as Settings draws them.
    #if canImport(UIKit)
    static let groupedBackground = Color(.systemGroupedBackground)
    static let groupedCard = Color(.secondarySystemGroupedBackground)
    #else
    static let groupedBackground = Color(red: 242 / 255, green: 242 / 255, blue: 247 / 255)
    static let groupedCard = Color.white
    #endif
}

extension ToolbarItemPlacement {
    /// iOS's trailing navigation-bar slot; on the Mac, the window toolbar's own place for actions.
    static var trailingBar: ToolbarItemPlacement {
        #if os(iOS)
        .topBarTrailing
        #else
        .automatic
        #endif
    }

    static var leadingBar: ToolbarItemPlacement {
        #if os(iOS)
        .topBarLeading
        #else
        .navigation
        #endif
    }
}

extension View {
    /// A pushed screen's small centred title on iOS. The Mac has one kind of title.
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// Text that is a name, a key or a code: no capitals or corrections added while typing.
    func plainTextEntry() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        autocorrectionDisabled()
        #endif
    }

    /// An address field: the URL keyboard on iOS.
    func urlTextEntry() -> some View {
        #if os(iOS)
        keyboardType(.URL).textContentType(.URL).plainTextEntry()
        #else
        textContentType(.URL).plainTextEntry()
        #endif
    }

    /// A list whose rows can be dragged and deleted at once (iOS's edit mode). A Mac list
    /// reorders by dragging without one.
    func alwaysEditing() -> some View {
        #if os(iOS)
        environment(\.editMode, .constant(.active))
        #else
        self
        #endif
    }

    /// A field whose name is already said above it (a caption, a section header). In a Mac form
    /// a field's title is drawn as a label beside it; this keeps it to the placeholder, as on iOS.
    func captionedField() -> some View {
        #if os(macOS)
        labelsHidden()
        #else
        self
        #endif
    }

    /// iOS's grouped list with inset sections; the Mac's inset list.
    func groupedListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }

    /// The tab bar under a pushed screen (iOS); the Mac's sidebar stays.
    func tabBarVisibility(_ visibility: Visibility) -> some View {
        #if os(iOS)
        toolbarVisibility(visibility, for: .tabBar)
        #else
        self
        #endif
    }

    /// A screen without its navigation bar (iOS); a Mac window keeps its toolbar.
    func navigationBarHidden() -> some View {
        #if os(iOS)
        toolbarVisibility(.hidden, for: .navigationBar)
        #else
        self
        #endif
    }

    /// A sheet's size on the Mac, where it does not fill the screen and is only as large as its
    /// content asks for. iOS ignores it.
    func macSheetFrame(width: CGFloat = 520, height: CGFloat = 560) -> some View {
        #if os(macOS)
        frame(minWidth: width, idealWidth: width, minHeight: height, idealHeight: height)
        #else
        self
        #endif
    }
}

enum PlatformOpen {
    #if os(macOS)
    /// Opens a file the app downloaded in the app the system chooses for it (Finder's "Open").
    static func inDefaultApp(_ url: URL) {
        NSWorkspace.shared.open(url)
    }
    #endif

    /// Where the user turns notifications back on for Sunnie.
    static var notificationSettingsURL: URL? {
        #if canImport(UIKit)
        URL(string: UIApplication.openNotificationSettingsURLString)
        #else
        URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(Bundle.main.bundleIdentifier ?? "")")
        #endif
    }

    static var notificationSettingsTitle: String {
        #if os(macOS)
        "Turn on in System Settings"
        #else
        "Turn on in iOS Settings"
        #endif
    }
}
