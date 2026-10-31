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
    var windowTitle: String; var windowIdentifier: String; var windowBounds: [Double]
    var bounds: [Double]; var controlPath: [Int]?
    var selection: [Int]; var interaction: [UInt32]; var editable: Bool
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

struct KeyboardStroke: Equatable {
    let key: CGKeyCode
    let down: Bool
    let flags: CGEventFlags
}

func keyboardShortcutStrokes(key: CGKeyCode, modifiers: [String]) -> [KeyboardStroke] {
    let definitions: [(String, CGKeyCode, CGEventFlags)] = [
        ("Cmd", CGKeyCode(kVK_Command), .maskCommand), ("Ctrl", CGKeyCode(kVK_Control), .maskControl),
        ("Alt", CGKeyCode(kVK_Option), .maskAlternate), ("Shift", CGKeyCode(kVK_Shift), .maskShift),
    ]
    let held = definitions.filter { modifiers.contains($0.0) }
    var flags = CGEventFlags(), strokes: [KeyboardStroke] = []
    for (_, code, flag) in held {
        flags.insert(flag); strokes.append(KeyboardStroke(key: code, down: true, flags: flags))
    }
    strokes.append(KeyboardStroke(key: key, down: true, flags: flags))
    strokes.append(KeyboardStroke(key: key, down: false, flags: flags))
    for (_, code, flag) in held.reversed() {
        flags.remove(flag); strokes.append(KeyboardStroke(key: code, down: false, flags: flags))
    }
    return strokes
}

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

// A bare CLI needs AppKit initialized on its physical main thread before system
// AX focus works. Accessory UI can own focus while another app stays foreground.
func keyboardFocusAfterInitialization<Element>(
    isMainThread: Bool, initialize: () throws -> Void, lookup: () throws -> Element
) throws -> Element {
    guard isMainThread else { throw InputError.unavailable }
    try initialize()
    return try lookup()
}

// Read only the ancestry and direct sibling lists, not descendants or their values.
// A unique path distinguishes same-labeled panes without depending on content size.
func keyboardWindowControlPath<Element>(
    _ element: Element, window: Element, same: (Element, Element) -> Bool,
    parent: (Element) throws -> Element, children: (Element, Int) throws -> [Element]
) -> [Int]? {
    var current = element, reversed: [Int] = []
    for _ in 0..<16 {
        if same(current, window) { return reversed.reversed() }
        guard let ancestor = try? parent(current), let siblings = try? children(ancestor, 512),
              siblings.count <= 512 else { return nil }
        let matches = siblings.indices.filter { same(siblings[$0], current) }
        guard matches.count == 1 else { return nil }
        reversed.append(matches[0]); current = ancestor
    }
    return same(current, window) ? reversed.reversed() : nil
}

func keyboardFingerprint(_ target: KeyboardFingerprintState) throws -> String {
    var state = target
    // Output and scrollback geometry can change while the same content surface
    // stays focused. Bind its owning window, preserving geometry for input controls.
    if !state.editable {
        state.value = ""; state.selection = []
        if ["AXTextArea", "AXWebArea"].contains(state.role),
           state.controlPath != nil, !state.windowBounds.isEmpty {
            state.bounds = state.windowBounds
        }
    }
    // A stable window identifier survives titles that follow the current process.
    if !state.windowIdentifier.isEmpty { state.windowTitle = "" }
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    return SHA256.hash(data: try encoder.encode(state)).map { String(format: "%02x", $0) }.joined()
}
