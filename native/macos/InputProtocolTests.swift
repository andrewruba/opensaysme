import Foundation

@main
struct InputProtocolTests {
    static func main() throws {
        let target: [String: Any] = ["windowId": "mac:123:1700000000000:" + String(repeating: "a", count: 64),
            "bounds": ["x": -1200, "y": -100, "width": 800, "height": 600], "point": ["x": -1100, "y": 0]]
        func data(_ action: [String: Any], targetOverride: [String: Any]? = nil, fingerprint: Any = NSNull()) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["target": targetOverride ?? target, "action": action, "fingerprint": fingerprint])
        }
        func reject(_ data: Data, execute: Bool = false) {
            do { _ = try parseInputCommand(data, execute: execute); preconditionFailure("Invalid input accepted") }
            catch { }
        }
        let parsed = try parseInputCommand(data(["kind": "type_text", "text": "Literal $(text) 🌱"]), execute: false)
        precondition(parsed.target.point.x == -1100 && parsed.action.text == "Literal $(text) 🌱")
        for action: [String: Any] in [["kind": "move_pointer"], ["kind": "click"], ["kind": "scroll", "deltaY": -600],
                                     ["kind": "press_key", "key": "Tab"], ["kind": "press_key", "key": "Enter"], ["kind": "type_text", "text": ""]] {
            _ = try parseInputCommand(data(action), execute: false)
            _ = try parseInputCommand(data(action, fingerprint: String(repeating: "a", count: 64)), execute: true)
            reject(try data(action), execute: true)
        }
        for action: [String: Any] in [["kind": "shell", "text": "command"], ["kind": "click", "approved": true],
                                     ["kind": "click", "text": "extra"], ["kind": "press_key", "key": "Command+Enter"],
                                     ["kind": "scroll", "deltaY": 601], ["kind": "scroll", "deltaY": Int.min],
                                     ["kind": "scroll", "deltaY": 0], ["kind": "scroll", "deltaY": 1.5]] {
            reject(try data(action))
        }
        for text in ["line\n", "line\r", "tab\t", "\0", "\u{2028}", "\u{2029}", String(repeating: "x", count: 4097)] {
            reject(try data(["kind": "type_text", "text": text]))
        }
        var outside = target; outside["point"] = ["x": -400, "y": 0]
        reject(try data(["kind": "click"], targetOverride: outside))
        var invalid = target; invalid["bounds"] = ["x": 0, "y": 0, "width": 0, "height": 10]
        reject(try data(["kind": "click"], targetOverride: invalid))
        reject(Data(repeating: 32, count: 65537))
        print("Input protocol checks passed (typed actions, literal text, key limits, negative coordinates, bounds and fingerprints). No desktop input issued.")
    }
}
