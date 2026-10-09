import SwiftUI

// Sunnie's look, kept deliberately light: the app is plain iOS, tinted leaf green (the
// AccentColor), with the logo and its four-point compass star appearing only where they mean
// something — connecting, empty screens, and "working on it". Always light mode.

enum Garden {
    /// The welcome keeps the wordmark's character; interface headings use system type.
    static let display = Font.system(.largeTitle, design: .serif, weight: .semibold)
    static let title = Font.system(.title2, weight: .semibold)
    static let readingWidth: CGFloat = 760
}

/// The logo's compass star: four long points with concave sides.
nonisolated struct CompassStar: Shape {
    /// How far the waist pulls in towards the centre, as a fraction of the radius.
    var waist: CGFloat = 0.14

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let rx = rect.width / 2, ry = rect.height / 2
        let tips = [CGPoint(x: c.x, y: c.y - ry), CGPoint(x: c.x + rx, y: c.y),
                    CGPoint(x: c.x, y: c.y + ry), CGPoint(x: c.x - rx, y: c.y)]
        let w = waist
        let controls = [CGPoint(x: c.x + rx * w, y: c.y - ry * w), CGPoint(x: c.x + rx * w, y: c.y + ry * w),
                        CGPoint(x: c.x - rx * w, y: c.y + ry * w), CGPoint(x: c.x - rx * w, y: c.y - ry * w)]
        var p = Path()
        p.move(to: tips[0])
        for i in 0..<4 {
            p.addQuadCurve(to: tips[(i + 1) % 4], control: controls[i])
        }
        p.closeSubpath()
        return p
    }
}

/// A hairline with a compass star at its centre and a bead at each end, like the logo's
/// cardinal points. Separates a heading from what follows.
struct OrnamentRule: View {
    var width: CGFloat = 160

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(.quaternary).frame(width: 3, height: 3)
            Rectangle().fill(.quaternary).frame(height: 1)
            CompassStar().fill(.petal).frame(width: 12, height: 12)
            Rectangle().fill(.quaternary).frame(height: 1)
            Circle().fill(.quaternary).frame(width: 3, height: 3)
        }
        .frame(width: width)
        .accessibilityHidden(true)
    }
}

/// "Working on it": a compass star turning slowly. Still when Reduce Motion is on.
struct TurningStar: View {
    var size: CGFloat = 14
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let degrees = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 4) * 90
            CompassStar()
                .fill(.petal)
                .frame(width: size, height: size)
                .rotationEffect(.degrees(degrees))
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel("Working")
    }
}

/// The logo itself, on a transparent ground.
struct SunnieMark: View {
    var size: CGFloat

    var body: some View {
        Image(.logo)
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// A rounded bubble with one pointed corner, like a petal tip: bottom trailing for the user,
/// bottom leading for Sunnie.
nonisolated struct PetalShape: InsettableShape {
    var radius: CGFloat = 18
    var tip: CGFloat = 6
    var tipLeading = false
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(
            topLeadingRadius: radius,
            bottomLeadingRadius: tipLeading ? tip : radius,
            bottomTrailingRadius: tipLeading ? radius : tip,
            topTrailingRadius: radius,
            style: .continuous
        ).path(in: rect.insetBy(dx: inset, dy: inset))
    }

    func inset(by amount: CGFloat) -> PetalShape {
        var copy = self
        copy.inset += amount
        return copy
    }
}

/// An empty screen: the logo, a clear heading, a short explanation, and an optional action.
struct GardenEmptyState<Actions: View>: View {
    let title: String
    let message: String
    var markSize: CGFloat = 112
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(spacing: 12) {
            SunnieMark(size: markSize)
                .padding(.bottom, 8)
            Text(title)
                .font(Garden.title)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 300)
            actions()
                .padding(.top, 8)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 24)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity)
    }
}

extension GardenEmptyState where Actions == EmptyView {
    init(title: String, message: String, markSize: CGFloat = 112) {
        self.init(title: title, message: message, markSize: markSize) { EmptyView() }
    }
}
