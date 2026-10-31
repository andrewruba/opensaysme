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
        let multiline = "Error: café e\u{301} 🌱\r\n\tfile.ts:12\n\nExplanation\rTrailing\u{85}next\u{2028}line\u{2029}paragraph\n"
        for text in [multiline, "\t", "\n", "\r", "\r\n", "\u{85}", "\u{2028}", "\u{2029}", String(repeating: "🌱", count: 2048)] {
            let decoded = try parseInputCommand(data(["kind": "type_text", "text": text]), execute: false)
            precondition(decoded.action.text!.utf16.elementsEqual(text.utf16), "Literal text changed in the native protocol")
        }
        for scalar in (0..<32).filter({ ![9, 10, 13].contains($0) }) + [127] {
            reject(try data(["kind": "type_text", "text": "before" + String(UnicodeScalar(scalar)!) + "after"]))
        }
        for text in [String(repeating: "x", count: 4097), String(repeating: "🌱", count: 2048) + "x"] {
            reject(try data(["kind": "type_text", "text": text]))
        }

        // An AXTextField is never a multiline destination, even when its value
        // is settable. Literal separators and tabs require a writable text area.
        for text in [multiline, "\t", "\n", "\r", "\u{85}", "\u{2028}", "\u{2029}"] {
            precondition(inputTextRequiresTextArea(text))
            for (role, editable) in [("AXTextField", true), ("AXButton", true), ("AXTextArea", false)] {
                let result = replaceInputText(text, role: role, editable: editable,
                    write: { _ in preconditionFailure("Unsupported target reached a text write") },
                    read: { preconditionFailure("Unsupported target reached verification") })
                precondition(result.status == "not-issued")
            }
        }
        for text in [multiline, "", "Literal $(text) 🌱"] {
            var writes: [String] = []
            let result = replaceInputText(text, role: "AXTextArea", editable: true,
                write: { writes.append($0); return true }, read: { writes.last })
            precondition(result.status == "verified" && writes.count == 1 && writes[0].utf16.elementsEqual(text.utf16))
        }
        precondition(replaceInputText("single line", role: "AXTextField", editable: true,
            write: { $0 == "single line" }, read: { "single line" }).status == "verified")
        for actual: String? in [nil, "", multiline.replacingOccurrences(of: "\r\n", with: "\n"), String(multiline.dropLast())] {
            var writes = 0
            let result = replaceInputText(multiline, role: "AXTextArea", editable: true,
                write: { _ in writes += 1; return true }, read: { actual })
            precondition(result.status == "uncertain" && writes == 1, "A mismatched write must not be verified or retried")
        }
        precondition(replaceInputText("", role: "AXTextArea", editable: true,
            write: { _ in true }, read: { nil }).status == "uncertain")
        precondition(replaceInputText(multiline, role: "AXTextArea", editable: true,
            write: { _ in false }, read: { preconditionFailure("A failed setter cannot verify success") }).status == "uncertain")
        // Swift string equality is canonically equivalent, which is weaker than
        // exact replacement. A control that normalizes Unicode is uncertain.
        precondition("e\u{301}" == "é")
        precondition(replaceInputText("e\u{301}", role: "AXTextArea", editable: true,
            write: { _ in true }, read: { "é" }).status == "uncertain")
        var outside = target; outside["point"] = ["x": -400, "y": 0]
        reject(try data(["kind": "click"], targetOverride: outside))
        var invalid = target; invalid["bounds"] = ["x": 0, "y": 0, "width": 0, "height": 10]
        reject(try data(["kind": "click"], targetOverride: invalid))
        reject(Data(repeating: 32, count: 65537))

        func targetState(_ values: [String: String]) -> InputFingerprintState {
            InputFingerprintState(windowId: target["windowId"] as! String,
                windowBounds: InputBounds(CGRect(x: -1200, y: -100, width: 800, height: 600)),
                role: "AXTextArea", title: "Message", description: "Agent input", value: values["input"]!,
                identifier: "composer", bounds: InputBounds(CGRect(x: -1150, y: -50, width: 700, height: 400)),
                focused: true, editable: true, pointer: InputPoint(x: -1100, y: 0), interaction: [1, 2, 3, 4, 5])
        }
        let state = targetState(["input": multiline, "badge": "9"])
        let digest = try inputFingerprint(state)
        let unrelatedChange = try inputFingerprint(targetState(["input": multiline, "badge": "10", "timer": "00:42"]))
        precondition(digest == unrelatedChange, "Unrelated live window content must not invalidate the target")
        func changed(_ update: (inout InputFingerprintState) -> Void) throws {
            var current = state; update(&current)
            let currentDigest = try inputFingerprint(current)
            precondition(currentDigest != digest, "Target or user-intervention changes must invalidate input")
        }
        try changed { $0.value = "different request" }
        try changed { $0.identifier = "other-composer" }
        try changed { $0.windowId = "mac:123:1700000000001:" + String(repeating: "a", count: 64) }
        try changed { $0.windowBounds = InputBounds(CGRect(x: -1200, y: -50, width: 800, height: 600)) }
        try changed { $0.bounds = InputBounds(CGRect(x: -1150, y: 0, width: 700, height: 400)) }
        try changed { $0.focused = false }
        try changed { $0.editable = false }
        try changed { $0.role = "AXButton" }
        try changed { $0.pointer = InputPoint(x: -1000, y: 0) }
        try changed { $0.interaction[3] += 1 }
        let longText = String(repeating: "x", count: 4095) + "a"
        let longDigest = try inputFingerprint(targetState(["input": longText]))
        let tailDigest = try inputFingerprint(targetState(["input": String(longText.dropLast()) + "b"]))
        precondition(longDigest != tailDigest, "The full target value, including its tail, remains revalidated")
        print("Input protocol checks passed (typed actions, literal multiline text, exact read-back, target freshness and user intervention). No desktop input issued.")
    }
}
