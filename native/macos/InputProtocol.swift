import Foundation
import CoreGraphics
import CryptoKit

enum InputError: String, Error { case invalid = "invalid-input", unavailable = "input-unavailable" }
struct InputPoint: Codable { let x: Double; let y: Double; var cg: CGPoint { CGPoint(x: x, y: y) } }
struct InputBounds: Codable {
    let x: Double; let y: Double; let width: Double; let height: Double
    init(_ rect: CGRect) { x = rect.origin.x; y = rect.origin.y; width = rect.width; height = rect.height }
    var cg: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    var valid: Bool { [x, y, width, height].allSatisfy { $0.isFinite } && width > 0 && height > 0 && width <= 65536 && height <= 65536 }
}
struct InputAction: Decodable {
    let kind: String
    let text: String?
    let deltaY: Int?
}
struct InputTarget: Decodable { let windowId: String; let bounds: InputBounds; let point: InputPoint }
struct InputCommand: Decodable {
    let target: InputTarget
    let action: InputAction
    let fingerprint: String?
}
struct InputEvidence: Encodable {
    let fingerprint: String
    let role: String; let title: String; let description: String; let value: String
    let bounds: InputBounds; let focused: Bool; let editable: Bool
}
// Finite diagnostics only: never return captured values or exception messages.
enum InputFailureReason: String, Encodable, CaseIterable, Error {
    case inputUnavailable = "input-unavailable", invalidInput = "invalid-input"
    case permissionRequired = "permission-required", secureField = "secure-field"
    case staleTarget = "stale-or-ambiguous-target", invalidTarget = "invalid-target"
    case accessibilityUnavailable = "accessibility-unavailable"
    case staleObservation = "stale-observation", focusChanged = "focus-changed"
    case userIntervention = "user-intervention", unsupportedTextTarget = "unsupported-text-target"
    case eventCreationFailed = "event-creation-failed", cancelled
    case textWriteUnverified = "text-write-unverified", pointerUnverified = "pointer-unverified"
}
struct InputResult: Encodable {
    let status: String
    let reason: InputFailureReason?
    init(status: String, reason: InputFailureReason? = nil) {
        self.status = status; self.reason = reason
    }
}

// A batch releases every pressed button/key before returning. Drain exactly once
// after posting, including when later validation stops a partial keyboard action.
func dispatchInputBatches(count: Int, cancelled: () -> Bool, validate: () -> InputFailureReason?, batch: (Int) -> Bool,
                          drain: () -> Void) -> InputResult {
    var issued = 0
    defer { if issued > 0 { drain() } }
    for index in 0..<count {
        if cancelled() { return InputResult(status: issued == 0 ? "not-issued" : "uncertain", reason: .cancelled) }
        if let reason = validate() { return InputResult(status: issued == 0 ? "not-issued" : "uncertain", reason: reason) }
        // Validation can block on Accessibility IPC while cancellation arrives.
        if cancelled() { return InputResult(status: issued == 0 ? "not-issued" : "uncertain", reason: .cancelled) }
        guard batch(index) else { return InputResult(status: issued == 0 ? "not-issued" : "uncertain", reason: .cancelled) }
        issued += 1
    }
    return issued == 0 ? InputResult(status: "not-issued", reason: .invalidInput) : InputResult(status: "issued")
}

// Revalidate the actual target and user intervention, not unrelated live content
// elsewhere in the window. Other form fields are contextual evidence for the
// actor/commit check, not part of this native target identity.
struct InputFingerprintState: Encodable {
    var windowId: String; var windowBounds: InputBounds
    var role: String; var title: String; var description: String; var value: String
    var identifier: String; var bounds: InputBounds
    var focused: Bool; var editable: Bool
    var pointer: InputPoint; var interaction: [UInt32]
}

func inputFingerprint(_ state: InputFingerprintState) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return SHA256.hash(data: try encoder.encode(state)).map { String(format: "%02x", $0) }.joined()
}

func validInputText(_ text: String) -> Bool {
    text.utf16.count <= 4096 && text.unicodeScalars.allSatisfy {
        [9, 10, 13].contains($0.value) || ($0.value >= 32 && $0.value != 127)
    }
}

func inputTextRequiresTextArea(_ text: String) -> Bool {
    text.unicodeScalars.contains { [9, 10, 13, 0x85, 0x2028, 0x2029].contains($0.value) }
}

func supportsInputText(_ text: String, role: String, editable: Bool) -> Bool {
    validInputText(text) && editable && ["AXTextField", "AXTextArea"].contains(role)
        && (!inputTextRequiresTextArea(text) || role == "AXTextArea")
}

// The only write path is literal value replacement. There is deliberately no
// key or clipboard fallback, including when a control rejects or normalizes text.
func replaceInputText(_ text: String, role: String, editable: Bool,
                      write: (String) -> Bool, read: () -> String?) -> InputResult {
    guard supportsInputText(text, role: role, editable: editable) else {
        return InputResult(status: "not-issued", reason: .unsupportedTextTarget)
    }
    guard write(text), let actual = read(), actual.utf16.elementsEqual(text.utf16) else {
        return InputResult(status: "uncertain", reason: .textWriteUnverified)
    }
    return InputResult(status: "verified")
}

func parseInputCommand(_ data: Data, execute: Bool) throws -> InputCommand {
    guard data.count <= 65536,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == ["target", "action", "fingerprint"],
          let target = object["target"] as? [String: Any], Set(target.keys) == ["windowId", "bounds", "point"],
          let bounds = target["bounds"] as? [String: Any], Set(bounds.keys) == ["x", "y", "width", "height"],
          let point = target["point"] as? [String: Any], Set(point.keys) == ["x", "y"],
          let action = object["action"] as? [String: Any], let kind = action["kind"] as? String else { throw InputError.invalid }
    let keys: Set<String>
    switch kind {
    case "move_pointer", "click": keys = ["kind"]
    case "scroll": keys = ["kind", "deltaY"]
    case "type_text": keys = ["kind", "text"]
    default: throw InputError.invalid
    }
    guard Set(action.keys) == keys else { throw InputError.invalid }
    let command = try JSONDecoder().decode(InputCommand.self, from: data)
    guard command.target.windowId.range(of: "^mac:[1-9][0-9]{0,9}:[0-9]{1,16}:[a-f0-9]{64}$", options: .regularExpression) != nil,
          command.target.bounds.valid, command.target.point.x.isFinite, command.target.point.y.isFinite,
          command.target.bounds.cg.contains(command.target.point.cg) else { throw InputError.invalid }
    if execute {
        guard let fingerprint = command.fingerprint,
              fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw InputError.invalid }
    } else if command.fingerprint != nil { throw InputError.invalid }
    switch kind {
    case "type_text":
        guard let text = command.action.text, validInputText(text) else { throw InputError.invalid }
    case "scroll": guard let delta = command.action.deltaY, delta != 0, delta >= -600, delta <= 600 else { throw InputError.invalid }
    default: break
    }
    return command
}
