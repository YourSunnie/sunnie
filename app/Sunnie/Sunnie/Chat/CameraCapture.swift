import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
import UIKit

/// The camera, for a photo straight into the message: receipts, whiteboards, a label to read.
/// UIKit's picker, since SwiftUI has no camera of its own; the picture is handed back as a JPEG
/// file so it goes through the same import as a chosen photo.
struct CameraCaptureView: UIViewControllerRepresentable {
    let captured: (URL) -> Void
    let cancelled: () -> Void

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraCaptureView
        init(_ parent: CameraCaptureView) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) else {
                parent.cancelled()
                return
            }
            let stamp = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false).dateTimeSeparator(.space)).replacingOccurrences(of: ":", with: ".")
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Photo \(stamp).jpg")
            do {
                try data.write(to: url, options: .atomic)
                parent.captured(url)
            } catch {
                parent.cancelled()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.cancelled() }
    }
}
#endif
