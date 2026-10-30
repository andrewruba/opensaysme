import Foundation
import CoreGraphics

enum InputError: Error { case invalid, unavailable }
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
    let key: String?
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
struct InputResult: Encodable { let status: String }

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
    case "press_key": keys = ["kind", "key"]
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
        guard let text = command.action.text, text.utf16.count <= 4096,
              text.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 && $0.value != 0x2028 && $0.value != 0x2029 }) else { throw InputError.invalid }
    case "press_key": guard let key = command.action.key, ["Tab", "Enter"].contains(key) else { throw InputError.invalid }
    case "scroll": guard let delta = command.action.deltaY, delta != 0, delta >= -600, delta <= 600 else { throw InputError.invalid }
    default: break
    }
    return command
}
