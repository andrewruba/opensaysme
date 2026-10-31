import Carbon
import Foundation

@main
struct KeyboardProtocolTests {
    static func main() throws {
        let fingerprint = String(repeating: "a", count: 64)
        func data(_ action: [String: Any], digest: Any? = nil) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["action": action, "fingerprint": digest ?? fingerprint])
        }
        func reject(_ payload: Data) {
            do { _ = try parseKeyboardCommand(payload); preconditionFailure("Invalid keyboard input accepted") }
            catch { }
        }
        for action: [String: Any] in [
            ["kind": "press_key", "key": "Space", "modifiers": ["Cmd"]],
            ["kind": "press_key", "key": "L", "modifiers": ["Cmd"]],
            ["kind": "press_key", "key": "Enter", "modifiers": []],
            ["kind": "press_key", "key": "ArrowLeft", "modifiers": ["Shift", "Alt"]],
            ["kind": "type_keyboard_text", "text": "Literal $(text) café e\u{301} 🌱"],
        ] { _ = try parseKeyboardCommand(data(action)) }
        for key in keyboardKeyCodes.keys {
            _ = try parseKeyboardCommand(data(["kind": "press_key", "key": key, "modifiers": []]))
        }
        precondition(keyboardKeyCodes["L"] == CGKeyCode(kVK_ANSI_L) && keyboardKeyCodes["Space"] == CGKeyCode(kVK_Space))
        precondition(keyboardKeyCodes["Backspace"] == CGKeyCode(kVK_Delete) && keyboardKeyCodes["Delete"] == CGKeyCode(kVK_ForwardDelete))
        for action: [String: Any] in [
            ["kind": "press_key", "key": "Escape", "modifiers": []],
            ["kind": "press_key", "key": "C", "modifiers": ["Ctrl"]],
            ["kind": "press_key", "key": "C", "modifiers": ["Cmd", "Ctrl", "Shift"]],
            ["kind": "press_key", "key": "V", "modifiers": ["Cmd", "Shift"]],
            ["kind": "press_key", "key": "V", "modifiers": ["Ctrl", "Alt"]],
            ["kind": "press_key", "key": "L", "modifiers": ["Cmd", "Cmd"]],
            ["kind": "press_key", "key": "L", "modifiers": ["Meta"]],
            ["kind": "press_key", "key": "Cmd+L", "modifiers": []],
            ["kind": "press_key", "key": "L"],
            ["kind": "press_key", "key": "L", "modifiers": [], "approved": true],
            ["kind": "type_keyboard_text", "text": "", "key": "Enter"],
            ["kind": "shell", "text": "open Chrome"],
        ] { reject(try data(action)) }
        for text in ["", "\t", "\n", "\r", "\u{85}", "\u{2028}", "\u{2029}", String(repeating: "x", count: 4097), String(repeating: "🌱", count: 2049)] {
            reject(try data(["kind": "type_keyboard_text", "text": text]))
        }
        for scalar in Array(0..<32) + [127] {
            reject(try data(["kind": "type_keyboard_text", "text": "before" + String(UnicodeScalar(scalar)!) + "after"]))
        }
        for text in ["Chess", "https://www.chess.com", String(repeating: "🌱", count: 2048)] {
            let parsed = try parseKeyboardCommand(data(["kind": "type_keyboard_text", "text": text]))
            precondition(parsed.action.text!.utf16.elementsEqual(text.utf16))
            let chunks = keyboardTextChunks(text)
            precondition(chunks.allSatisfy { !$0.isEmpty && $0.count <= 20 })
            precondition(chunks.flatMap { $0 }.elementsEqual(text.utf16))
            precondition(chunks.allSatisfy { !(0xD800...0xDBFF).contains($0.last!) && !(0xDC00...0xDFFF).contains($0.first!) })
        }
        reject(try data(["kind": "press_key", "key": "Enter", "modifiers": []], digest: ""))
        reject(Data(repeating: 32, count: 65537))
        var state = KeyboardFingerprintState(pid: 42, started: 123456789, role: "AXTextField", title: "Address",
            description: "Address", value: "", identifier: "omnibox", windowTitle: "Chrome", windowIdentifier: "window",
            bounds: [0, 0, 500, 30], selection: [0, 0], interaction: [1, 2, 3, 4, 5], editable: true)
        let digest = try keyboardFingerprint(state)
        state.started += 1
        let restarted = try keyboardFingerprint(state)
        precondition(restarted != digest, "Process restart must invalidate keyboard evidence")
        state.started -= 1; state.selection = [1, 2]
        let selected = try keyboardFingerprint(state)
        precondition(selected != digest, "Selection changes must invalidate keyboard evidence")
        for role in ["AXTextField", "AXComboBox"] {
            precondition(keyboardEditable(role: role, valueWritable: false, selectionWritable: false, enabled: true))
        }
        precondition(!keyboardEditable(role: "AXTextArea", valueWritable: false, selectionWritable: false, enabled: true))
        precondition(keyboardEditable(role: "AXTextArea", valueWritable: false, selectionWritable: true, enabled: true))
        precondition(!keyboardEditable(role: "AXTextField", valueWritable: true, selectionWritable: true, enabled: false))
        state.editable = false; state.role = "AXTextArea"
        let terminalBefore = try keyboardFingerprint(state)
        state.value = "interpreting\nacting\n"; state.selection = [300, 0]
        let terminalAfter = try keyboardFingerprint(state)
        precondition(terminalBefore == terminalAfter, "Runtime status output must not invalidate a shortcut in Terminal")
        state.interaction[3] += 1
        let userIntervened = try keyboardFingerprint(state)
        precondition(terminalAfter != userIntervened, "Physical user input must still invalidate keyboard evidence")
        var cancelled = false, edges: [String] = []
        let partial = dispatchKeyboardPairs(count: 3, ready: { !cancelled }, pair: { _ in
            edges.append("down"); cancelled = true; edges.append("up")
        })
        precondition(edges == ["down", "up"] && partial.status == "uncertain", "Cancellation must release the current pair and stop the rest")
        let none = dispatchKeyboardPairs(count: 3, ready: { false }, pair: { _ in preconditionFailure("Cancelled dispatch") })
        precondition(none.status == "not-issued")
        var completed = 0
        precondition(dispatchKeyboardPairs(count: 3, ready: { true }, pair: { _ in completed += 1 }).status == "issued" && completed == 3)
        print("Keyboard checks passed (shortcuts, literal text, focus evidence and cancellation boundaries). No desktop input issued.")
    }
}
