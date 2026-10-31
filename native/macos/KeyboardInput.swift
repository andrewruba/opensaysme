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
    let element = try keyboardFocusAfterInitialization(isMainThread: Thread.isMainThread, initialize: {
        _ = NSApplication.shared
    }, lookup: {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.1)
        return try elementAttribute(system, kAXFocusedUIElementAttribute)
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

func assertInputUnprotected(_ element: AXUIElement, deadline: TimeInterval? = nil) throws {
    do {
        try validateInputAncestry(element, deadline: deadline ?? ProcessInfo.processInfo.systemUptime + 1,
            same: { CFEqual($0, $1) }, describe: { ancestor in
                AXUIElementSetMessagingTimeout(ancestor, 0.05)
                return (try keyboardString(ancestor, kAXRoleAttribute, limit: 128),
                        try keyboardString(ancestor, kAXSubroleAttribute, limit: 128))
            }, parent: { try elementAttribute($0, kAXParentAttribute) })
    } catch InputFailureReason.secureField {
        throw DesktopError("Input is unavailable in secure text fields.", code: "secure-field")
    }
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

private func keyboardControlPath(_ element: AXUIElement, window: AXUIElement) -> [Int]? {
    keyboardWindowControlPath(element, window: window, same: { CFEqual($0, $1) }, parent: {
        AXUIElementSetMessagingTimeout($0, 0.1)
        return try elementAttribute($0, kAXParentAttribute)
    }, children: { parent, limit in
        AXUIElementSetMessagingTimeout(parent, 0.1)
        var count = 0; var values: CFArray?
        guard AXUIElementGetAttributeValueCount(parent, kAXChildrenAttribute as CFString, &count) == .success,
              count > 0, count <= limit,
              AXUIElementCopyAttributeValues(parent, kAXChildrenAttribute as CFString, 0, count, &values) == .success,
              let children = values as? [AXUIElement], children.count == count else { throw InputError.unavailable }
        return children
    })
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
    guard keyboardIdle() else { throw InputFailureReason.userIntervention }
    let element = try keyboardFocus()
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success,
          !isDesktopHelperProcess(pid), let application = NSRunningApplication(processIdentifier: pid),
          !application.isTerminated else { throw InputError.unavailable }
    try assertInputUnprotected(element) // Never read the value before checking protection.
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
    let controlPath = !editable && ["AXTextArea", "AXWebArea"].contains(role)
        ? window.flatMap { keyboardControlPath(element, window: $0) } : nil
    let events: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel]
    let fingerprint = try keyboardFingerprint(KeyboardFingerprintState(pid: pid, started: processStartIdentity(pid),
        role: role, title: title, description: description, value: value.digest,
        identifier: keyboardString(element, kAXIdentifierAttribute, limit: 1024),
        windowTitle: window.map { try keyboardString($0, kAXTitleAttribute, limit: 1024) } ?? "",
        windowIdentifier: window.map { try keyboardString($0, kAXIdentifierAttribute, limit: 1024) } ?? "",
        windowBounds: window.map(keyboardGeometry) ?? [],
        bounds: keyboardGeometry(element), controlPath: controlPath, selection: keyboardSelection(element),
        interaction: events.map { CGEventSource.counterForEventType(.hidSystemState, eventType: $0) }, editable: editable))
    guard keyboardIdle() else { throw InputFailureReason.userIntervention }
    guard CFEqual(try keyboardFocus(), element) else { throw InputFailureReason.focusChanged }
    let name = application.localizedName ?? "Application"
    guard name.utf16.count <= 1024 else { throw InputError.unavailable }
    return KeyboardTarget(application: application, element: element,
        evidence: KeyboardEvidence(fingerprint: fingerprint, application: name, role: role, title: title,
            description: description, value: value.text, editable: editable, valueTruncated: value.truncated))
}

func inspectKeyboard() throws -> KeyboardEvidence {
    do { return try resolveKeyboard().evidence }
    catch is InputFailureReason { throw InputError.unavailable }
}

struct FocusedTextCapture: Encodable {
    let capturedAt: String
    let application: String; let role: String; let title: String; let description: String; let windowTitle: String
    let text: String; let start: Int; let totalLength: Int
}

func readFocusedText() throws -> FocusedTextCapture {
    try requireAccessibility()
    let deadline = ProcessInfo.processInfo.systemUptime + 3
    let element = try keyboardFocus()
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success, !isDesktopHelperProcess(pid),
          let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated else { throw InputError.unavailable }
    try assertInputUnprotected(element, deadline: deadline)
    let role = try keyboardString(element, kAXRoleAttribute, limit: 128)
    let title = try keyboardString(element, kAXTitleAttribute, limit: 1024)
    let description = try keyboardString(element, kAXDescriptionAttribute, limit: 1024)
    let window = try? elementAttribute(element, kAXWindowAttribute)
    let windowTitle = try window.map { try keyboardString($0, kAXTitleAttribute, limit: 1024) } ?? ""
    let name = application.localizedName ?? "Application"
    guard !role.isEmpty, !name.isEmpty, name.utf16.count <= 256 else { throw InputError.unavailable }
    // A readable string AXValue is the source. No clipboard, selection change,
    // keyboard event, or truncation of the immutable source before slicing.
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw) == .success,
          let full = raw as? String else { throw InputError.unavailable }
    let tail = focusedTextTail(full)
    guard ProcessInfo.processInfo.systemUptime < deadline, !application.isTerminated,
          CFEqual(try keyboardFocus(), element) else { throw InputError.unavailable }
    try assertInputUnprotected(element, deadline: deadline)
    guard CFEqual(try keyboardFocus(), element), ProcessInfo.processInfo.systemUptime < deadline else { throw InputError.unavailable }
    return FocusedTextCapture(capturedAt: captureTimestamp(), application: name, role: role,
        title: title, description: description, windowTitle: windowTitle,
        text: tail.text, start: tail.start, totalLength: tail.totalLength)
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
    let target: KeyboardTarget
    do { target = try resolveKeyboard() }
    catch { return rejectedInput(error) }
    guard target.evidence.fingerprint == command.fingerprint else {
        return InputResult(status: "not-issued", reason: .staleObservation)
    }
    let action = command.action
    guard let source = CGEventSource(stateID: .privateState) else { return InputResult(status: "not-issued", reason: .eventCreationFailed) }
    var batches: [[CGEvent]] = []
    if action.kind == "press_key" {
        var events: [CGEvent] = []
        for stroke in keyboardShortcutStrokes(key: keyboardKeyCodes[action.key!]!, modifiers: action.modifiers!) {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: stroke.key, keyDown: stroke.down) else {
                return InputResult(status: "not-issued", reason: .eventCreationFailed)
            }
            event.flags = stroke.flags; events.append(event)
        }
        batches.append(events)
    } else {
        guard target.evidence.editable else { return InputResult(status: "not-issued", reason: .unsupportedTextTarget) }
        for units in keyboardTextChunks(action.text!) {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                return InputResult(status: "not-issued", reason: .eventCreationFailed)
            }
            down.flags = []; up.flags = []
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            batches.append([down, up])
        }
    }
    let current: KeyboardTarget
    do { current = try resolveKeyboard() }
    catch { return rejectedInput(error) }
    guard current.evidence.fingerprint == command.fingerprint else {
        return InputResult(status: "not-issued", reason: .staleObservation)
    }
    return withExtendedLifetime((source, batches)) {
        dispatchInputBatches(count: batches.count, cancelled: { keyboardCancelled != 0 }, validate: {
            guard keyboardIdle() else { return .userIntervention }
            guard !target.application.isTerminated else { return .inputUnavailable }
            do {
                let current = try keyboardFocus()
                guard CFEqual(current, target.element) else { return .focusChanged }
                try assertInputUnprotected(current)
            } catch { return inputFailureReason(error) }
            return nil
        }, batch: { index in postInputEvents(batches[index], cancelled: { keyboardCancelled != 0 }) }, drain: drainInputEvents)
    }
}
