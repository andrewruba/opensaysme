import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import Foundation

private var keyboardCancelled: sig_atomic_t = 0
private struct KeyboardTarget {
    let application: NSRunningApplication
    let element: AXUIElement
    let evidence: KeyboardEvidence
}

private func keyboardString(_ element: AXUIElement, _ name: String, limit: Int) throws -> String {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &raw)
    if result == .attributeUnsupported || result == .noValue { return "" }
    guard result == .success, let value = raw as? String, value.utf16.count <= limit else { throw InputError.unavailable }
    return value
}

private func keyboardFocus() throws -> AXUIElement {
    let element = try keyboardFocusWithForegroundFallback(systemFocus: {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.1)
        return try elementAttribute(system, kAXFocusedUIElementAttribute)
    }, foregroundPID: { NSWorkspace.shared.frontmostApplication?.processIdentifier }, applicationFocus: { pid in
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.1)
        return try elementAttribute(application, kAXFocusedUIElementAttribute)
    }, processID: { focused in
        var pid: pid_t = 0
        return AXUIElementGetPid(focused, &pid) == .success ? pid : nil
    })
    AXUIElementSetMessagingTimeout(element, 0.1)
    return element
}

private func keyboardIdle() -> Bool {
    let modifiers: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]
    return CGEventSource.flagsState(.hidSystemState).intersection(modifiers).isEmpty
        && ![CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.hidSystemState, button: $0) }
        && !(0..<128).contains { CGEventSource.keyState(.hidSystemState, key: CGKeyCode($0)) }
}

private func assertKeyboardUnprotected(_ element: AXUIElement) throws {
    var ancestor = element
    for _ in 0..<32 {
        AXUIElementSetMessagingTimeout(ancestor, 0.1)
        guard try keyboardString(ancestor, kAXSubroleAttribute, limit: 128) != kAXSecureTextFieldSubrole else {
            throw DesktopError("Keyboard input is unavailable in secure text fields.", code: "secure-field")
        }
        if try keyboardString(ancestor, kAXRoleAttribute, limit: 128) == kAXApplicationRole { return }
        ancestor = try elementAttribute(ancestor, kAXParentAttribute)
    }
    throw InputError.unavailable
}

private func keyboardGeometry(_ element: AXUIElement) -> [Double] {
    guard let rawPosition = try? attribute(element, kAXPositionAttribute), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
          let rawSize = try? attribute(element, kAXSizeAttribute), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return [] }
    var point = CGPoint.zero; var size = CGSize.zero
    let position = unsafeBitCast(rawPosition, to: AXValue.self), dimensions = unsafeBitCast(rawSize, to: AXValue.self)
    guard AXValueGetType(position) == .cgPoint, AXValueGetType(dimensions) == .cgSize,
          AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(dimensions, .cgSize, &size) else { return [] }
    let values = [point.x, point.y, size.width, size.height].map(Double.init)
    return values.allSatisfy { $0.isFinite } ? values : []
}

private func keyboardSelection(_ element: AXUIElement) -> [Int] {
    guard let raw = try? attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return [] }
    let value = unsafeBitCast(raw, to: AXValue.self); var range = CFRange()
    guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range) else { return [] }
    return [range.location, range.length]
}

private func keyboardValue(_ element: AXUIElement) throws -> (text: String, digest: String, truncated: Bool) {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw)
    let full: String
    if result == .attributeUnsupported || result == .noValue { full = "" }
    else if result == .success, let text = raw as? String { full = text }
    else if result == .success, let number = raw as? NSNumber { full = number.stringValue }
    else { throw InputError.unavailable }
    var units = Array(full.utf16.prefix(4096))
    if let last = units.last, (0xD800...0xDBFF).contains(last) { units.removeLast() }
    return (String(decoding: units, as: UTF16.self),
        SHA256.hash(data: Data(full.utf8)).map { String(format: "%02x", $0) }.joined(), full.utf16.count > units.count)
}

private func resolveKeyboard() throws -> KeyboardTarget {
    try requireAccessibility()
    guard keyboardIdle() else { throw InputError.unavailable }
    let element = try keyboardFocus()
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success,
          !isDesktopHelperProcess(pid), let application = NSRunningApplication(processIdentifier: pid),
          !application.isTerminated else { throw InputError.unavailable }
    try assertKeyboardUnprotected(element) // Never read the value before checking protection.
    let role = try keyboardString(element, kAXRoleAttribute, limit: 128)
    guard !role.isEmpty else { throw InputError.unavailable }
    let title = try keyboardString(element, kAXTitleAttribute, limit: 1024)
    let description = try keyboardString(element, kAXDescriptionAttribute, limit: 1024)
    let value = try keyboardValue(element)
    var valueSettable: DarwinBoolean = false, selectionSettable: DarwinBoolean = false
    let valueWritable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable) == .success && valueSettable.boolValue
    let selectionWritable = AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &selectionSettable) == .success && selectionSettable.boolValue
    let editable = keyboardEditable(role: role, valueWritable: valueWritable, selectionWritable: selectionWritable,
        enabled: (try? attribute(element, kAXEnabledAttribute) as? Bool) != false)
    let window = try? elementAttribute(element, kAXWindowAttribute)
    let events: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel]
    let fingerprint = try keyboardFingerprint(KeyboardFingerprintState(pid: pid, started: processStartIdentity(pid),
        role: role, title: title, description: description, value: value.digest,
        identifier: keyboardString(element, kAXIdentifierAttribute, limit: 1024),
        windowTitle: window.map { try keyboardString($0, kAXTitleAttribute, limit: 1024) } ?? "",
        windowIdentifier: window.map { try keyboardString($0, kAXIdentifierAttribute, limit: 1024) } ?? "",
        bounds: keyboardGeometry(element), selection: keyboardSelection(element),
        interaction: events.map { CGEventSource.counterForEventType(.hidSystemState, eventType: $0) }, editable: editable))
    guard keyboardIdle(), CFEqual(try keyboardFocus(), element) else { throw InputError.unavailable }
    let name = application.localizedName ?? "Application"
    guard name.utf16.count <= 1024 else { throw InputError.unavailable }
    return KeyboardTarget(application: application, element: element,
        evidence: KeyboardEvidence(fingerprint: fingerprint, application: name, role: role, title: title,
            description: description, value: value.text, editable: editable, valueTruncated: value.truncated))
}

func inspectKeyboard() throws -> KeyboardEvidence { try resolveKeyboard().evidence }

private func postKeyboardPair(_ down: CGEvent, _ up: CGEvent) {
    // Block (rather than discard) cancellation during a balanced pair. A pending
    // signal is delivered on restoration and stops before the next pair.
    var blocked = sigset_t(); var previous = sigset_t()
    sigemptyset(&blocked); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGINT)
    sigprocmask(SIG_BLOCK, &blocked, &previous)
    defer { sigprocmask(SIG_SETMASK, &previous, nil) }
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
}

func executeKeyboard() throws -> InputResult {
    var data = Data()
    while data.count <= 65536 {
        let next = FileHandle.standardInput.readData(ofLength: 65537 - data.count)
        if next.isEmpty { break }; data.append(next)
    }
    let command = try parseKeyboardCommand(data)
    keyboardCancelled = 0
    let term = signal(SIGTERM) { _ in keyboardCancelled = 1 }
    let interrupt = signal(SIGINT) { _ in keyboardCancelled = 1 }
    defer { signal(SIGTERM, term); signal(SIGINT, interrupt) }
    guard let target = try? resolveKeyboard(), target.evidence.fingerprint == command.fingerprint else {
        return InputResult(status: "not-issued")
    }
    let action = command.action, source = CGEventSource(stateID: .privateState)
    var pairs: [(CGEvent, CGEvent)] = []
    if action.kind == "press_key" {
        let code = keyboardKeyCodes[action.key!]!
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return InputResult(status: "not-issued") }
        let flags: [String: CGEventFlags] = ["Cmd": .maskCommand, "Ctrl": .maskControl, "Alt": .maskAlternate, "Shift": .maskShift]
        let modifiers = action.modifiers!.reduce(CGEventFlags()) { $0.union(flags[$1]!) }
        down.flags = modifiers; up.flags = modifiers
        pairs.append((down, up))
    } else {
        guard target.evidence.editable else { return InputResult(status: "not-issued") }
        for units in keyboardTextChunks(action.text!) {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return InputResult(status: "not-issued") }
            down.flags = []; up.flags = []
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            pairs.append((down, up))
        }
    }
    guard let current = try? resolveKeyboard(), current.evidence.fingerprint == command.fingerprint else {
        return InputResult(status: "not-issued")
    }
    return dispatchKeyboardPairs(count: pairs.count, ready: {
        guard keyboardCancelled == 0, keyboardIdle(), !target.application.isTerminated,
              let current = try? keyboardFocus(), CFEqual(current, target.element),
              (try? assertKeyboardUnprotected(current)) != nil else { return false }
        return true
    }, pair: { index in postKeyboardPair(pairs[index].0, pairs[index].1) })
}
