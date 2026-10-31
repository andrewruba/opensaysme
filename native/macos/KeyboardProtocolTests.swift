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
            windowBounds: [0, 0, 1000, 700],
            bounds: [0, 0, 500, 30], controlPath: nil, selection: [0, 0], interaction: [1, 2, 3, 4, 5], editable: true)
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
        var focusStages: [String] = []
        let focused = try keyboardFocusAfterInitialization(isMainThread: true,
            initialize: { focusStages.append("initialize") }, lookup: { focusStages.append("lookup"); return 77 })
        precondition(focused == 77 && focusStages == ["initialize", "lookup"], "System focus requires AppKit initialization first")
        do {
            let _: Int = try keyboardFocusAfterInitialization(isMainThread: false,
                initialize: { preconditionFailure("AppKit initialized off main thread") },
                lookup: { preconditionFailure("Focus queried off main thread") })
            preconditionFailure("Non-main-thread focus accepted")
        } catch InputError.unavailable { }
        enum FocusFailure: Error { case initialization, lookup }
        do {
            let _: Int = try keyboardFocusAfterInitialization(isMainThread: true,
                initialize: { throw FocusFailure.initialization }, lookup: { preconditionFailure("Initialization failed") })
            preconditionFailure("Initialization error discarded")
        } catch FocusFailure.initialization { }
        do {
            let _: Int = try keyboardFocusAfterInitialization(isMainThread: true, initialize: { },
                lookup: { throw FocusFailure.lookup })
            preconditionFailure("Unavailable system focus accepted")
        } catch FocusFailure.lookup { }
        let parents = [3: 1, 4: 1, 1: 0], siblings = [0: [1, 2], 1: [3, 4]]
        func path(_ element: Int, children: (Int, Int) throws -> [Int]) -> [Int]? {
            keyboardWindowControlPath(element, window: 0, same: ==, parent: {
                guard let parent = parents[$0] else { throw InputError.unavailable }; return parent
            }, children: children)
        }
        precondition(path(3, children: { parent, _ in siblings[parent] ?? [] }) == [0, 0])
        precondition(path(4, children: { parent, _ in siblings[parent] ?? [] }) == [0, 1])
        precondition(path(3, children: { _, _ in [3, 3] }) == nil, "Ambiguous sibling identity must not produce a path")
        precondition(path(3, children: { _, _ in [] }) == nil, "Missing child identity must not produce a path")
        precondition(path(3, children: { _, _ in throw InputError.unavailable }) == nil)
        precondition(path(3, children: { _, limit in Array(repeating: 3, count: limit + 1) }) == nil)
        precondition(keyboardWindowControlPath(1, window: 0, same: ==, parent: { $0 + 1 },
            children: { parent, _ in [parent - 1] }) == nil, "An ancestry that never reaches the window must stop")
        func expectChanged(_ original: KeyboardFingerprintState, _ message: String,
                           change: (inout KeyboardFingerprintState) -> Void) throws {
            var changed = original; change(&changed)
            let before = try keyboardFingerprint(original), after = try keyboardFingerprint(changed)
            precondition(before != after, message)
        }
        try expectChanged(state, "Editable control geometry must remain bound") { $0.bounds[1] += 20 }
        try expectChanged(state, "Editable values must remain bound") { $0.value = "edited" }
        var titled = state; titled.windowTitle = "Different page"
        let renamed = try keyboardFingerprint(titled), originalTitle = try keyboardFingerprint(state)
        precondition(renamed == originalTitle, "Stable window identity must tolerate title updates")
        titled.windowIdentifier = ""
        try expectChanged(titled, "Window titles remain identity evidence when no identifier is available") { $0.windowTitle = "Another window" }
        for role in ["AXTextArea", "AXWebArea"] {
            var content = state; content.editable = false; content.role = role
            content.identifier = ""; content.controlPath = [0, 0]
            content.bounds = [262, -110041, 1270, 111041]; content.windowBounds = [262, 209, 1270, 791]
            let before = try keyboardFingerprint(content)
            content.value = "interpreting\nacting\n"; content.selection = [300, 0]
            content.bounds = [262, -110081, 1270, 111081]
            let after = try keyboardFingerprint(content)
            precondition(before == after, "Content growth must not invalidate a shortcut on a noneditable text surface")
            try expectChanged(content, "Same-labeled panes without identifiers must retain distinct focus identity") { $0.controlPath = [0, 1] }
            try expectChanged(content, "Moving the owning window must invalidate evidence") { $0.windowBounds[0] += 20 }
            try expectChanged(content, "Resizing the owning window must invalidate evidence") { $0.windowBounds[3] += 20 }
            try expectChanged(content, "A different focused control must invalidate evidence") { $0.identifier = "other-control" }
            try expectChanged(content, "Changed focus labels must invalidate evidence") { $0.title = "Other control" }
            try expectChanged(content, "A different process must invalidate evidence") { $0.pid += 1 }
            try expectChanged(content, "Physical user input must still invalidate evidence") { $0.interaction[3] += 1 }
            content.windowBounds = []
            try expectChanged(content, "Missing window geometry must preserve the content bounds check") { $0.bounds[3] += 20 }
            content.windowBounds = [262, 209, 1270, 791]; content.controlPath = nil
            try expectChanged(content, "Missing control path must preserve the content bounds check") { $0.bounds[3] += 20 }
        }
        state.editable = true; state.role = "AXTextArea"
        try expectChanged(state, "Editable text area geometry must remain bound") { $0.bounds[3] += 20 }
        try expectChanged(state, "Editable text area selection must remain bound") { $0.selection = [300, 0] }
        state.editable = false; state.role = "AXButton"
        try expectChanged(state, "Other noneditable controls must retain their geometry") { $0.bounds[0] += 20 }
        let command: CGEventFlags = .maskCommand, control: CGEventFlags = [.maskCommand, .maskControl]
        let option: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate]
        let all: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
        let shortcut = keyboardShortcutStrokes(key: 0, modifiers: ["Shift", "Alt", "Ctrl", "Cmd"])
        precondition(shortcut.map(\.key) == [55, 59, 58, 56, 0, 0, 56, 58, 59, 55], "Shortcut modifiers must press in canonical order and release in reverse")
        precondition(shortcut.map(\.down) == [true, true, true, true, true, false, false, false, false, false])
        precondition(shortcut.map(\.flags) == [command, control, option, all, all, all, option, control, command, []], "Each edge must reflect the modifiers still held")
        let plain = keyboardShortcutStrokes(key: 36, modifiers: [])
        precondition(plain == [KeyboardStroke(key: 36, down: true, flags: []), KeyboardStroke(key: 36, down: false, flags: [])])
        var cancelled = false, edges: [String] = [], drains = 0
        let partial = dispatchInputBatches(count: 3, cancelled: { cancelled }, validate: { nil }, batch: { _ in
            edges.append("down"); cancelled = true; edges.append("up")
            return true
        }, drain: { drains += 1; precondition(edges.last == "up") })
        precondition(edges == ["down", "up"] && partial.status == "uncertain" && partial.reason == .cancelled && drains == 1, "Cancellation must release and drain the current text batch, then report uncertain cancellation")
        cancelled = false; drains = 0
        var posted: [KeyboardStroke] = []
        let cancelledShortcut = dispatchInputBatches(count: 2, cancelled: { cancelled }, validate: { nil }, batch: { _ in
            for stroke in shortcut { posted.append(stroke); cancelled = true }
            return true
        }, drain: { drains += 1; precondition(posted.last?.flags == []) })
        precondition(posted == shortcut && drains == 1 && cancelledShortcut.status == "uncertain", "Cancellation must release all shortcut modifiers before draining and stopping")
        for reason in [InputFailureReason.cancelled, .focusChanged, .userIntervention, .secureField] {
            let none = dispatchInputBatches(count: 3, cancelled: { false }, validate: { reason }, batch: { _ in preconditionFailure("Rejected dispatch") },
                drain: { preconditionFailure("No events to drain") })
            precondition(none.status == "not-issued" && none.reason == reason, "Pre-dispatch failures must retain their cause without issuing input")
            var posted = 0
            let interrupted = dispatchInputBatches(count: 3, cancelled: { false }, validate: { posted == 0 ? nil : reason },
                batch: { _ in posted += 1; return true }, drain: {})
            precondition(interrupted.status == "uncertain" && interrupted.reason == reason && posted == 1,
                "The same failure after a posted batch is uncertain and must not retry")
        }
        var completed = 0
        drains = 0
        let complete = dispatchInputBatches(count: 205, cancelled: { false }, validate: { nil }, batch: { _ in completed += 1; return true },
            drain: { drains += 1; precondition(completed == 205) })
        precondition(complete.status == "issued" && complete.reason == nil && completed == 205 && drains == 1, "Long text must drain once after all chunks, not once per chunk")
        precondition(dispatchInputBatches(count: 0, cancelled: { false }, validate: { nil }, batch: { _ in preconditionFailure("Empty dispatch") },
            drain: { preconditionFailure("Empty dispatch drain") }).status == "not-issued")
        print("Keyboard checks passed (shortcuts, literal text, focus evidence and cancellation boundaries). No desktop input issued.")
    }
}
