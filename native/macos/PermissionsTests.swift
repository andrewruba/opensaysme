import AVFoundation
import Foundation

@main
struct PermissionsTests {
    static func main() throws {
        let launcher = PermissionLauncher(name: "Terminal", bundleIdentifier: "com.apple.Terminal", path: "/Applications/Terminal.app")
        let parents: [Int32: Int32] = [10: 11, 11: 12, 12: 1]
        let observed = observedPermissionLauncher(start: 10, parent: { parents[$0] }, application: { $0 == 12 ? launcher : nil })
        precondition(observed?.bundleIdentifier == launcher.bundleIdentifier)
        precondition(observedPermissionLauncher(start: 10, parent: { _ in 10 }, application: { _ in nil }) == nil)
        precondition(observedPermissionLauncher(start: 10, parent: { $0 == 10 ? 11 : 10 }, application: { _ in nil }) == nil)
        var reads = 0
        precondition(observedPermissionLauncher(start: 100, parent: { $0 + 1 }, application: { _ in reads += 1; return nil }) == nil)
        precondition(reads == 32)
        precondition(observedPermissionLauncher(start: 0, parent: { _ in fatalError() }, application: { _ in fatalError() }) == nil)
        for (status, expected): (AVAuthorizationStatus, String) in [(.authorized, "granted"), (.notDetermined, "not-determined"), (.denied, "denied"), (.restricted, "restricted")] {
            precondition(microphonePermissionStatus(status) == expected)
        }
        precondition(microphonePermissionBlock(.authorized) == nil)
        precondition(microphonePermissionBlock(.denied) == .permissionRequired)
        precondition(microphonePermissionBlock(.restricted) == .restricted)
        precondition(microphonePermissionBlock(.notDetermined) == .notDetermined)
        precondition(microphoneVerificationOutcome(status: .authorized, frames: 1, cancelled: false, timedOut: false) == .verified)
        precondition(microphoneVerificationOutcome(status: .authorized, frames: 0, cancelled: false, timedOut: false) == .captureFailed)
        precondition(microphoneVerificationOutcome(status: .denied, frames: 1, cancelled: false, timedOut: false) == .permissionRequired)
        precondition(microphoneVerificationOutcome(status: .authorized, frames: 1, cancelled: false, timedOut: true) == .timeout)
        precondition(microphoneVerificationOutcome(status: .authorized, frames: 1, cancelled: true, timedOut: true) == .cancelled)
        for permission in DesktopPermission.allCases {
            let data = try JSONEncoder().encode(PermissionVerification(permission: permission, outcome: .verified))
            let object = try JSONSerialization.jsonObject(with: data) as! [String: String]
            precondition(object == ["permission": permission.rawValue, "outcome": "verified"])
        }
        precondition(DesktopPermission(rawValue: "screenCapture;echo") == nil)
        let report = PermissionReport(helperPath: "/helper", bundleIdentifier: "dev.opensaysme.desktop", launcher: nil,
            desktopAvailable: false, permissions: PermissionGrants(microphone: "denied", accessibility: "not-granted", screenCapture: "unsupported"))
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as! [String: Any]
        precondition(Set(object.keys) == ["helperPath", "bundleIdentifier", "launcher", "desktopAvailable", "permissions"])
        precondition(object["launcher"] is NSNull)
        let optionalIdentity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(PermissionLauncher(name: "Launcher", bundleIdentifier: nil, path: nil))) as! [String: Any]
        precondition(optionalIdentity["bundleIdentifier"] is NSNull && optionalIdentity["path"] is NSNull)
        print("Permission checks passed (bounded ancestry, grant states and content-free protocol). No permissions requested, audio recorded or screenshots captured.")
    }
}
