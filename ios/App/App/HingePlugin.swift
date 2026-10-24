import Capacitor
import UIKit

@objc(HingePlugin)
public class HingePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HingePlugin"
    public let jsName = "Hinge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]

    private var state: [String: Any] = ["angle": NSNull(), "status": "unknown"]

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(state)
    }

    func attach(to view: UIView) {
        #if DEBUG
        // Debug builds can pin the angle, so every fold can be screenshotted without dragging
        // Device Hub's slider: SIMCTL_CHILD_COIN_PUSHER_HINGE=120 xcrun simctl launch <udid> <bundle>
        if let pinned = ProcessInfo.processInfo.environment["COIN_PUSHER_HINGE"].flatMap(Double.init) {
            state = ["angle": pinned, "status": "partiallyOpen"]
            NSLog("Hinge pinned angle=%f", pinned)
            return
        }
        #endif
        if #available(iOS 27.1, *) {
            let interaction = UIHingeInteraction { [weak self] _, update in
                self?.publish(update.hinge)
            }
            view.addInteraction(interaction)
        }
    }

    @available(iOS 27.1, *)
    private func publish(_ hinge: UIHinge?) {
        let status: String
        switch hinge?.status {
        case .closed: status = "closed"
        case .partiallyOpen: status = "partiallyOpen"
        case .fullyOpen: status = "fullyOpen"
        default: status = "unknown"
        }

        let angle = hinge.map { Double($0.angle) * 180 / .pi }
        state = ["angle": angle.map { $0 as Any } ?? NSNull(), "status": status]
        NSLog("Hinge update angle=%@ status=%@", angle.map { String($0) } ?? "null", status)
        notifyListeners("change", data: state)
    }
}
