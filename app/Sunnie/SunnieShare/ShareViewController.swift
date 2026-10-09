import SwiftUI
#if os(iOS)
import UIKit

final class ShareViewController: UIViewController {
    private var shareModel: ShareModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        shareModel = model
        let host = UIHostingController(rootView: ShareView(model: model).tint(Color("AccentColor")).preferredColorScheme(.light))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed || parent?.isBeingDismissed == true || navigationController?.isBeingDismissed == true {
            shareModel?.discard()
        }
    }
}
#else
import AppKit

/// The Mac's share sheet hosts the same view; macOS sizes the sheet from `preferredContentSize`.
final class ShareViewController: NSViewController {
    private var shareModel: ShareModel?

    override func loadView() {
        let model = ShareModel(context: extensionContext)
        shareModel = model
        let host = NSHostingView(rootView: ShareView(model: model).tint(Color("AccentColor")).preferredColorScheme(.light))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 520)
        view = host
        preferredContentSize = host.frame.size
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        shareModel?.discard()
    }
}
#endif
