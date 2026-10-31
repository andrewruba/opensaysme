import AppKit
import ApplicationServices
import Carbon
import Foundation

private struct ResolvedInput {
    let application: NSRunningApplication
    let window: AXUIElement
    let element: AXUIElement
    let evidence: InputEvidence
}

private func inputBounds(_ element: AXUIElement) throws -> InputBounds {
    let position = try attribute(element, kAXPositionAttribute)
    let size = try attribute(element, kAXSizeAttribute)
    guard CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw InputError.unavailable }
    let p = unsafeBitCast(position, to: AXValue.self), s = unsafeBitCast(size, to: AXValue.self)
    var point = CGPoint.zero; var dimensions = CGSize.zero
    guard AXValueGetType(p) == .cgPoint, AXValueGetType(s) == .cgSize,
          AXValueGetValue(p, .cgPoint, &point), AXValueGetValue(s, .cgSize, &dimensions) else { throw InputError.unavailable }
    let bounds = InputBounds(CGRect(origin: point, size: dimensions))
    guard bounds.valid else { throw InputError.unavailable }
    return bounds
}

private func inputString(_ element: AXUIElement, _ attributeName: String, limit: Int) throws -> String {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attributeName as CFString, &raw)
    if result == .attributeUnsupported || result == .noValue { return "" }
    guard result == .success else { throw InputError.unavailable }
    let value: String
    if let text = raw as? String { value = text }
    else if attributeName == kAXValueAttribute, let number = raw as? NSNumber { value = number.stringValue }
    else { throw InputError.unavailable }
    guard value.utf16.count <= limit else { throw InputError.unavailable }
    return value
}

private func assertInputFocus(_ application: NSRunningApplication, _ window: AXUIElement) throws {
    guard !application.isHidden, NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier,
          (try attribute(window, kAXMinimizedAttribute) as? Bool) == false,
          CFEqual(try elementAttribute(applicationElement(application), kAXFocusedWindowAttribute), window) else { throw InputError.unavailable }
    let modifiers: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]
    guard CGEventSource.flagsState(.hidSystemState).intersection(modifiers).isEmpty,
          !CGEventSource.buttonState(.hidSystemState, button: .left),
          !CGEventSource.buttonState(.hidSystemState, button: .right),
          !CGEventSource.buttonState(.hidSystemState, button: .center),
          !(0..<128).contains(where: { CGEventSource.keyState(.hidSystemState, key: CGKeyCode($0)) }) else { throw InputError.unavailable }
}

private func resolveInput(_ command: InputCommand) throws -> ResolvedInput {
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    let (application, window) = try resolveWindow(command.target.windowId, deadline: deadline)
    try assertInputFocus(application, window)
    let bounds = try inputBounds(window)
    // Capture and AX geometry can differ by rounding, but not by a moved window.
    guard abs(bounds.x - command.target.bounds.x) <= 1, abs(bounds.y - command.target.bounds.y) <= 1,
          abs(bounds.width - command.target.bounds.width) <= 1, abs(bounds.height - command.target.bounds.height) <= 1,
          bounds.cg.contains(command.target.point.cg) else { throw InputError.unavailable }
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.1)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(command.target.point.x), Float(command.target.point.y), &hit) == .success,
          let element = hit else { throw InputError.unavailable }
    AXUIElementSetMessagingTimeout(element, 0.1)
    let role = try inputString(element, kAXRoleAttribute, limit: 128)
    guard !role.isEmpty else { throw InputError.unavailable }
    let hitWindow = role == kAXWindowRole ? element : try elementAttribute(element, kAXWindowAttribute)
    guard CFEqual(hitWindow, window), (try? attribute(element, kAXEnabledAttribute) as? Bool) != false else { throw InputError.unavailable }
    // Do not expose protected values or descendants of protected controls.
    var ancestor = element; var reachedWindow = false
    for _ in 0..<32 {
        guard ProcessInfo.processInfo.systemUptime < deadline,
              try inputString(ancestor, kAXSubroleAttribute, limit: 128) != kAXSecureTextFieldSubrole else { throw InputError.unavailable }
        if CFEqual(ancestor, window) { reachedWindow = true; break }
        ancestor = try elementAttribute(ancestor, kAXParentAttribute)
        AXUIElementSetMessagingTimeout(ancestor, 0.05)
    }
    guard reachedWindow else { throw InputError.unavailable }
    let title = try inputString(element, kAXTitleAttribute, limit: 1024)
    let description = try inputString(element, kAXDescriptionAttribute, limit: 1024)
    let value = try inputString(element, kAXValueAttribute, limit: 4096)
    let elementBounds = try inputBounds(element)
    guard elementBounds.cg.contains(command.target.point.cg) else { throw InputError.unavailable }
    var settable: DarwinBoolean = false
    let editable = [kAXTextFieldRole, kAXTextAreaRole].contains(role)
        && AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
    let focused = (try? focusedElement(applicationElement(application))).map { CFEqual($0, element) } ?? false
    if command.action.kind == "type_text" {
        guard focused else { throw InputError.unavailable }
        guard let text = command.action.text, supportsInputText(text, role: role, editable: editable) else {
            throw DesktopError("The input does not support literal text replacement.", code: "unsupported-text-target")
        }
    }
    guard let pointer = CGEvent(source: nil)?.location else { throw InputError.unavailable }
    let events: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel]
    let fingerprint = try inputFingerprint(InputFingerprintState(
        windowId: command.target.windowId, windowBounds: bounds,
        role: role, title: title, description: description, value: value,
        identifier: try inputString(element, kAXIdentifierAttribute, limit: 1024),
        bounds: elementBounds, focused: focused, editable: editable,
        pointer: InputPoint(x: pointer.x, y: pointer.y),
        interaction: events.map { CGEventSource.counterForEventType(.hidSystemState, eventType: $0) }))
    try assertInputFocus(application, window)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw InputError.unavailable }
    return ResolvedInput(application: application, window: window, element: element,
        evidence: InputEvidence(fingerprint: fingerprint, role: role, title: title, description: description, value: value,
            bounds: elementBounds, focused: focused, editable: editable))
}

// Ignore SIGTERM process-wide only while queuing a down/up pair. This one-shot
// helper exits immediately afterward; SIGKILL remains the parent's bounded fallback.
private func postPair(_ down: CGEvent, _ up: CGEvent, pid: pid_t) {
    let previous = signal(SIGTERM, SIG_IGN)
    defer { signal(SIGTERM, previous) }
    down.flags = []; up.flags = []
    down.postToPid(pid); up.postToPid(pid)
}

private func executeInput(_ command: InputCommand) -> InputResult {
    guard let resolved = try? resolveInput(command), resolved.evidence.fingerprint == command.fingerprint else {
        return InputResult(status: "not-issued")
    }
    let action = command.action, point = command.target.point.cg
    let pid = resolved.application.processIdentifier
    // All events are created before the final focus check. AX text writes target the
    // exact element; keyboard/mouse events go to the validated process, never globally.
    let source = CGEventSource(stateID: .privateState)
    switch action.kind {
    case "move_pointer":
        guard (try? assertInputFocus(resolved.application, resolved.window)) != nil else { return InputResult(status: "not-issued") }
        guard CGWarpMouseCursorPosition(point) == .success else { return InputResult(status: "uncertain") }
        let current = CGEvent(source: nil)?.location
        return InputResult(status: current == point ? "verified" : "uncertain")
    case "click":
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left),
              (try? assertInputFocus(resolved.application, resolved.window)) != nil else { return InputResult(status: "not-issued") }
        down.setIntegerValueField(.mouseEventClickState, value: 1); up.setIntegerValueField(.mouseEventClickState, value: 1)
        postPair(down, up, pid: pid)
    case "scroll":
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1,
                                  wheel1: Int32(-action.deltaY!), wheel2: 0, wheel3: 0),
              (try? assertInputFocus(resolved.application, resolved.window)) != nil else { return InputResult(status: "not-issued") }
        event.location = point; event.flags = []; event.postToPid(pid)
    case "type_text":
        guard (try? assertInputFocus(resolved.application, resolved.window)) != nil,
              let focused = try? focusedElement(applicationElement(resolved.application)), CFEqual(focused, resolved.element) else { return InputResult(status: "not-issued") }
        return replaceInputText(action.text!, role: resolved.evidence.role, editable: resolved.evidence.editable,
            write: { AXUIElementSetAttributeValue(resolved.element, kAXValueAttribute as CFString, $0 as CFString) == .success },
            read: {
                guard let actual = stringAttribute(resolved.element, kAXValueAttribute), actual.utf16.count <= 4096 else { return nil }
                return actual
            })
    default: return InputResult(status: "not-issued")
    }
    return InputResult(status: "issued")
}

func desktopInput(execute: Bool) throws {
    var data = Data()
    while data.count <= 65536 {
        let next = FileHandle.standardInput.readData(ofLength: 65537 - data.count)
        if next.isEmpty { break }; data.append(next)
    }
    let command = try parseInputCommand(data, execute: execute)
    if execute { try output(executeInput(command)) }
    else { try output(resolveInput(command).evidence) }
}
