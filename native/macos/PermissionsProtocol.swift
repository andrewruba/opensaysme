import AVFoundation
import Darwin
import Foundation

enum DesktopPermission: String, CaseIterable, Encodable {
    case microphone, accessibility, screenCapture
}

enum PermissionOutcome: String, Encodable {
    case verified, restricted, unsupported, cancelled, timeout
    case permissionRequired = "permission-required"
    case notDetermined = "not-determined"
    case noDevice = "no-device"
    case noWindow = "no-window"
    case captureFailed = "capture-failed"
}

struct PermissionVerification: Encodable {
    let permission: DesktopPermission
    let outcome: PermissionOutcome
}

struct PermissionLauncher: Encodable {
    let name: String
    let bundleIdentifier: String?
    let path: String?
    private enum CodingKeys: String, CodingKey { case name, bundleIdentifier, path }
    func encode(to encoder: Encoder) throws {
        var output = encoder.container(keyedBy: CodingKeys.self)
        try output.encode(name, forKey: .name)
        try output.encode(bundleIdentifier, forKey: .bundleIdentifier)
        try output.encode(path, forKey: .path)
    }
}

struct PermissionGrants: Encodable {
    let microphone: String
    let accessibility: String
    let screenCapture: String
}

struct PermissionReport: Encodable {
    let helperPath: String
    let bundleIdentifier: String
    let launcher: PermissionLauncher?
    let desktopAvailable: Bool
    let permissions: PermissionGrants
    private enum CodingKeys: String, CodingKey { case helperPath, bundleIdentifier, launcher, desktopAvailable, permissions }
    func encode(to encoder: Encoder) throws {
        var output = encoder.container(keyedBy: CodingKeys.self)
        try output.encode(helperPath, forKey: .helperPath)
        try output.encode(bundleIdentifier, forKey: .bundleIdentifier)
        try output.encode(launcher, forKey: .launcher)
        try output.encode(desktopAvailable, forKey: .desktopAvailable)
        try output.encode(permissions, forKey: .permissions)
    }
}

func microphonePermissionStatus(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .notDetermined: return "not-determined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unavailable"
    }
}

// Nil means verification may proceed; a grant alone never proves device access.
func microphonePermissionBlock(_ status: AVAuthorizationStatus) -> PermissionOutcome? {
    switch status {
    case .authorized: return nil
    case .notDetermined: return .notDetermined
    case .denied: return .permissionRequired
    case .restricted: return .restricted
    @unknown default: return .captureFailed
    }
}

func microphoneVerificationOutcome(status: AVAuthorizationStatus, frames: UInt64,
                                   cancelled: Bool, timedOut: Bool) -> PermissionOutcome {
    if cancelled { return .cancelled }
    if timedOut { return .timeout }
    if let blocked = microphonePermissionBlock(status) { return blocked }
    return frames > 0 ? .verified : .captureFailed
}

// Diagnostic ancestry is bounded and does not establish which identity TCC uses.
func observedPermissionLauncher(start: Int32, parent: (Int32) -> Int32?,
                                application: (Int32) -> PermissionLauncher?) -> PermissionLauncher? {
    var current = start
    var seen = Set<Int32>()
    for _ in 0..<32 {
        guard current > 1, seen.insert(current).inserted else { return nil }
        if let launcher = application(current) { return launcher }
        guard let next = parent(current), next != current else { return nil }
        current = next
    }
    return nil
}
