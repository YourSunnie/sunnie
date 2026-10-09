import SwiftUI

/// The answers Sunnie's last message offers (a `choices` block), as buttons under it on the
/// user's side: a tap sends that answer. The last one opens the message box instead, for an
/// answer of the user's own.
struct QuickReplies: View {
    let answers: [String]
    let send: (String) -> Void
    let writeOwn: () -> Void

    var body: some View {
        TrailingFlow(spacing: 8) {
            ForEach(answers, id: \.self) { answer in
                Button { send(answer) } label: { chip(answer) }
                    .accessibilityHint("Sends this reply")
            }
            Button(action: writeOwn) { chip("Something else", symbol: "square.and.pencil") }
                .accessibilityHint("Write your own reply")
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
    }

    private func chip(_ title: String, symbol: String? = nil) -> some View {
        HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.caption.weight(.semibold)) }
            Text(title).multilineTextAlignment(.leading)
        }
        .font(.subheadline)
        .foregroundStyle(.tint)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(minHeight: 40)
        .overlay(Capsule().strokeBorder(.tint.opacity(0.5), lineWidth: 1))
        .contentShape(Capsule())
    }
}

/// Lays its children out in rows that wrap, each row against the trailing edge.
private struct TrailingFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(width: bounds.width, subviews: subviews) {
            var x = bounds.maxX - row.width
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: .init(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func rows(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width, height: nil))
            let needed = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            if !row.indices.isEmpty, needed > width {
                rows.append(row)
                row = Row()
            }
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}
