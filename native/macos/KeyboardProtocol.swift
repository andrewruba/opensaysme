import Carbon
import CryptoKit
import Foundation

struct KeyboardAction: Decodable {
    let kind: String
    let key: String?
    let modifiers: [String]?
    let text: String?
}
struct KeyboardCommand: Decodable { let action: KeyboardAction; let fingerprint: String }
struct KeyboardEvidence: Encodable {
    let fingerprint: String
    let application: String; let role: String; let title: String; let description: String; let value: String
    let editable: Bool; let valueTruncated: Bool
}
struct KeyboardFingerprintState: Encodable {
    var pid: Int32; var started: UInt64
    var role: String; var title: String; var description: String; var value: String; var identifier: String
    var windowTitle: String; var windowIdentifier: String
    var bounds: [Double]; var selection: [Int]; var interaction: [UInt32]; var editable: Bool
}

let keyboardKeyCodes: [String: CGKeyCode] = [
    "A": 0, "B": 11, "C": 8, "D": 2, "E": 14, "F": 3, "G": 5, "H": 4,
    "I": 34, "J": 38, "K": 40, "L": 37, "M": 46, "N": 45, "O": 31, "P": 35,
    "Q": 12, "R": 15, "S": 1, "T": 17, "U": 32, "V": 9, "W": 13, "X": 7, "Y": 16, "Z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    "Space": CGKeyCode(kVK_Space), "Tab": CGKeyCode(kVK_Tab), "Enter": CGKeyCode(kVK_Return),
    "Backspace": CGKeyCode(kVK_Delete), "Delete": CGKeyCode(kVK_ForwardDelete),
    "ArrowUp": CGKeyCode(kVK_UpArrow), "ArrowDown": CGKeyCode(kVK_DownArrow),
    "ArrowLeft": CGKeyCode(kVK_LeftArrow), "ArrowRight": CGKeyCode(kVK_RightArrow),
    "Home": CGKeyCode(kVK_Home), "End": CGKeyCode(kVK_End),
    "PageUp": CGKeyCode(kVK_PageUp), "PageDown": CGKeyCode(kVK_PageDown),
]

func validKeyboardText(_ text: String) -> Bool {
    !text.isEmpty && text.utf16.count <= 4096 && text.unicodeScalars.allSatisfy {
        $0.value >= 32 && ![127, 0x85, 0x2028, 0x2029].contains($0.value)
    }
}

// Keep Unicode scalars intact while fitting the native event's short text payload.
func keyboardTextChunks(_ text: String) -> [[UInt16]] {
    var chunks: [[UInt16]] = [], current: [UInt16] = []
    for scalar in text.unicodeScalars {
        let units = Array(String(scalar).utf16)
        if current.count + units.count > 20 { chunks.append(current); current = [] }
        current.append(contentsOf: units)
    }
    if !current.isEmpty { chunks.append(current) }
    return chunks
}

func parseKeyboardCommand(_ data: Data) throws -> KeyboardCommand {
    guard data.count <= 65536,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == ["action", "fingerprint"],
          let action = object["action"] as? [String: Any], let kind = action["kind"] as? String else { throw InputError.invalid }
    let keys: Set<String> = kind == "press_key" ? ["kind", "key", "modifiers"] : ["kind", "text"]
    guard Set(action.keys) == keys else { throw InputError.invalid }
    let command = try JSONDecoder().decode(KeyboardCommand.self, from: data)
    guard command.fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw InputError.invalid }
    switch kind {
    case "press_key":
        guard let key = command.action.key, keyboardKeyCodes[key] != nil,
              let modifiers = command.action.modifiers, modifiers.count <= 4,
              Set(modifiers).count == modifiers.count,
              modifiers.allSatisfy({ ["Cmd", "Ctrl", "Alt", "Shift"].contains($0) }),
              !(key == "C" && modifiers.contains("Ctrl")),
              !(key == "V" && (modifiers.contains("Cmd") || modifiers.contains("Ctrl"))) else { throw InputError.invalid }
    case "type_keyboard_text":
        guard let text = command.action.text, validKeyboardText(text) else { throw InputError.invalid }
    default: throw InputError.invalid
    }
    return command
}

func keyboardEditable(role: String, valueWritable: Bool, selectionWritable: Bool, enabled: Bool) -> Bool {
    enabled && (["AXTextField", "AXComboBox"].contains(role)
        || (role == "AXTextArea" && (valueWritable || selectionWritable)))
}

// Some desktops cannot answer system-wide AX focus queries even though the
// foreground application's own AX focus is available. Do not substitute a
// remembered background application or a focus returned by another process.
func keyboardFocusWithForegroundFallback<Element>(
    systemFocus: () throws -> Element,
    foregroundPID: () -> Int32?,
    applicationFocus: (Int32) throws -> Element,
    processID: (Element) -> Int32?
) throws -> Element {
    if let focused = try? systemFocus() { return focused }
    guard let pid = foregroundPID(), pid > 0,
          let focused = try? applicationFocus(pid),
          processID(focused) == pid, foregroundPID() == pid else { throw InputError.unavailable }
    return focused
}

func keyboardFingerprint(_ target: KeyboardFingerprintState) throws -> String {
    var state = target
    // Terminal output changes as the runtime reports status. That is evidence,
    // not an editable destination whose contents should freeze a shortcut.
    if !state.editable { state.value = ""; state.selection = [] }
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    return SHA256.hash(data: try encoder.encode(state)).map { String(format: "%02x", $0) }.joined()
}

// A pair must queue both edges before returning, even when cancellation arrives
// during the down event. The next ready check stops the sequence at that boundary.
func dispatchKeyboardPairs(count: Int, ready: () -> Bool, pair: (Int) -> Void) -> InputResult {
    var issued = 0
    for index in 0..<count {
        guard ready() else { return InputResult(status: issued == 0 ? "not-issued" : "uncertain") }
        pair(index); issued += 1
    }
    return InputResult(status: issued == 0 ? "not-issued" : "issued")
}
