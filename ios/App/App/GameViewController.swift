import Capacitor
import UIKit

class GameViewController: CAPBridgeViewController {
    override var prefersStatusBarHidden: Bool { true }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.scrollView.bounces = false
        // A game left on auto-drop gets no touches, so iOS would dim and lock the screen mid-play.
        // Applies only while the app is in front; iOS restores auto-lock everywhere else.
        UIApplication.shared.isIdleTimerDisabled = true

        let hinge = HingePlugin()
        bridge?.registerPluginInstance(hinge)
        hinge.attach(to: view)

        #if DEBUG
        // Store screenshots: the simulator cannot tap into the web view, so a debug build runs a
        // script for it: SIMCTL_CHILD_COIN_PUSHER_EVAL='<js>' xcrun simctl launch <udid> <bundle>
        if let script = ProcessInfo.processInfo.environment["COIN_PUSHER_EVAL"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                self?.webView?.evaluateJavaScript(script)
            }
        }
        #endif
    }
}
