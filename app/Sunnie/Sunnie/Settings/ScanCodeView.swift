import AVFoundation
import SwiftUI
import UniformTypeIdentifiers
import Vision
#if os(iOS)
import VisionKit
#else
import AppKit
#endif

#if os(iOS)
/// Scans a host's connect code and hands back the link in it.
struct ScanCodeView: View {
    var onLink: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var allowed: Bool?
    @State private var notOurs = false

    /// False in the simulator and on devices whose camera cannot scan.
    static var isSupported: Bool { DataScannerViewController.isSupported }

    var body: some View {
        NavigationStack {
            Group {
                switch allowed {
                case true?:
                    CodeScanner { text in
                        guard let link = ConnectLink.parse(text) else {
                            notOurs = true
                            return
                        }
                        dismiss()
                        onLink(link)
                    }
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .bottom) {
                        Text(notOurs ? "That is not a Sunnie code." : "Point the camera at the code you were sent.")
                            .font(.subheadline)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(.regularMaterial, in: .capsule)
                            .padding(.bottom, 32)
                    }
                case false?:
                    ContentUnavailableView(
                        "Camera access is off",
                        systemImage: "camera",
                        description: Text("Allow the camera for Sunnie in the Settings app, or open the link you were sent instead.")
                    )
                case nil:
                    ProgressView()
                }
            }
            .navigationTitle("Scan code")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { allowed = await AVCaptureDevice.requestAccess(for: .video) }
        }
    }
}

private struct CodeScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in addedItems {
                if let text = code.payloadStringValue { onCode(text) }
            }
        }
    }
}
#else
/// The Mac has no live code scanner: the connect link is pasted, or read from a picture of the
/// code (a file, or a screenshot on the clipboard). Only a `…/c/<code>` link is accepted, as on iOS.
struct ConnectLinkSection: View {
    var connecting: Bool
    var onLink: (URL) -> Void
    @State private var linkText = ""
    @State private var choosingImage = false
    @State private var problem: String?

    var body: some View {
        Section {
            HStack {
                TextField("Connect link", text: $linkText, prompt: Text("https://…/c/…"))
                    .urlTextEntry()
                    .onSubmit(useText)
                Button("Use Link", action: useText)
                    .disabled(linkText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            HStack {
                Button("Choose Picture of Code…", systemImage: "qrcode.viewfinder") { choosingImage = true }
                Button("Paste Code", systemImage: "doc.on.clipboard") { usePasteboard() }
            }
            .buttonStyle(.borderless)
        } header: {
            Text("Connect link")
        } footer: {
            if let problem {
                Label(problem, systemImage: "exclamationmark.circle").foregroundStyle(.red)
            } else {
                Text("Were you sent a QR code or a link? Paste the link, or choose a picture or screenshot of the code, and Sunnie connects by itself.")
            }
        }
        .disabled(connecting)
        .fileImporter(isPresented: $choosingImage, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            use(QRCodeReader.payloads(VNImageRequestHandler(url: url)))
        }
    }

    private func useText() {
        guard let link = ConnectLink.parse(linkText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            problem = "That is not a Sunnie connect link."
            return
        }
        problem = nil
        onLink(link)
    }

    private func usePasteboard() {
        let board = NSPasteboard.general
        if let text = board.string(forType: .string), ConnectLink.parse(text.trimmingCharacters(in: .whitespacesAndNewlines)) != nil {
            linkText = text
            useText()
        } else if let image = NSImage(pasteboard: board), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            use(QRCodeReader.payloads(VNImageRequestHandler(cgImage: cg)))
        } else {
            problem = "The clipboard has no connect link or picture of a code."
        }
    }

    private func use(_ payloads: [String]) {
        guard let link = payloads.lazy.compactMap(ConnectLink.parse).first else {
            problem = payloads.isEmpty ? "No QR code was found in that picture." : "That is not a Sunnie code."
            return
        }
        problem = nil
        onLink(link)
    }
}

private enum QRCodeReader {
    static func payloads(_ handler: VNImageRequestHandler) -> [String] {
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try? handler.perform([request])
        return (request.results ?? []).compactMap(\.payloadStringValue)
    }
}
#endif
