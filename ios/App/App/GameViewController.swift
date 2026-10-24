import Capacitor
import UIKit

class GameViewController: CAPBridgeViewController {
    override var prefersStatusBarHidden: Bool { true }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.scrollView.bounces = false

        let hinge = HingePlugin()
        bridge?.registerPluginInstance(hinge)
        hinge.attach(to: view)
    }
}
