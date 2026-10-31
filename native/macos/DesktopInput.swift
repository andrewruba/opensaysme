import AppKit
import ApplicationServices
import Carbon
import Foundation

private var pointerCancelled: sig_atomic_t = 0

private struct ResolvedInput {
    let application: NSRunningApplication
    let window: AXUIElement
    let element: AXUIElement
    let evidence: InputEvidence
}

func inputFailureReason(_ error: Error) -> InputFailureReason {
    if let reason = error as? InputFailureReason { return reason }
    if let error = error as? InputError { return InputFailureReason(rawValue: error.rawValue) ?? .inputUnavailable }
    if let error = error as? DesktopError { return InputFailureReason(rawValue: error.code) ?? .inputUnavailable }
    return .inputUnavailable
}

func rejectedInput(_ error: Error) -> InputResult {
    InputResult(status: "not-issued", reason: inputFailureReason(error))
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
          CFEqual(try elementAttribute(applicationElement(application), kAXFocusedWindowAttribute), window) else { throw InputFailureReason.focusChanged }
    let modifiers: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]
    guard CGEventSource.flagsState(.hidSystemState).intersection(modifiers).isEmpty,
          !CGEventSource.buttonState(.hidSystemState, button: .left),
          !CGEventSource.buttonState(.hidSystemState, button: .right),
          !CGEventSource.buttonState(.hidSystemState, button: .center),
          !(0..<128).contains(where: { CGEventSource.keyState(.hidSystemState, key: CGKeyCode($0)) }) else { throw InputFailureReason.userIntervention }
    // AX calls above can block, and an inactive app can retain AXFocusedWindow.
    // Recheck the current foreground owner after that work before HID dispatch.
    guard !application.isHidden, NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
        throw InputFailureReason.focusChanged
    }
}

private func resolveInput(_ command: InputCommand) throws -> ResolvedInput {
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    let (application, window) = try resolveWindow(command.target.windowId, deadline: deadline)
    try assertInputFocus(application, window)
    let bounds = try inputBounds(window)
    // Capture and AX geometry can differ by rounding, but not by a moved window.
    guard abs(bounds.x - command.target.bounds.x) <= 1, abs(bounds.y - command.target.bounds.y) <= 1,
          abs(bounds.width - command.target.bounds.width) <= 1, abs(bounds.height - command.target.bounds.height) <= 1,
          bounds.cg.contains(command.target.point.cg) else { throw InputFailureReason.staleObservation }
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
        guard focused else { throw InputFailureReason.focusChanged }
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

// A complete click, shortcut or text chunk releases all input before cancellation
// is delivered. HID posting lets WindowServer route coordinates to real windows;
// postToPid can deliver AppKit mouse events with windowNumber 0 and no control hit.
func postInputEvents(_ events: [CGEvent], cancelled: () -> Bool) -> Bool {
    var blocked = sigset_t(); var previous = sigset_t()
    sigemptyset(&blocked); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGINT)
    sigprocmask(SIG_BLOCK, &blocked, &previous)
    defer { sigprocmask(SIG_SETMASK, &previous, nil) }
    // Cancellation can arrive after validation but before entering this section.
    // A newly blocked signal may be pending rather than reflected in the handler flag.
    var pending = sigset_t(); sigpending(&pending)
    guard !cancelled(), sigismember(&pending, SIGTERM) != 1, sigismember(&pending, SIGINT) != 1 else { return false }
    for event in events { event.post(tap: .cghidEventTap) }
    return true
}

func drainInputEvents() {
    // An immediately exiting one-shot helper can lose queued events. Callers keep
    // the event source and events alive through this single, unblocked drain.
    var remaining = timespec(tv_sec: 0, tv_nsec: 100_000_000), interrupted = timespec()
    while nanosleep(&remaining, &interrupted) != 0 && errno == EINTR { remaining = interrupted }
}

private func dispatchPointerEvents(_ events: [CGEvent], source: CGEventSource, target: ResolvedInput) -> InputResult {
    pointerCancelled = 0
    let term = signal(SIGTERM) { _ in pointerCancelled = 1 }
    let interrupt = signal(SIGINT) { _ in pointerCancelled = 1 }
    defer { signal(SIGTERM, term); signal(SIGINT, interrupt) }
    return withExtendedLifetime((source, events)) {
        dispatchInputBatches(count: 1, cancelled: { pointerCancelled != 0 }, validate: {
            do { try assertInputFocus(target.application, target.window); return nil }
            catch { return inputFailureReason(error) }
        }, batch: { _ in postInputEvents(events, cancelled: { pointerCancelled != 0 }) }, drain: drainInputEvents)
    }
}

private func executeInput(_ command: InputCommand) -> InputResult {
    let resolved: ResolvedInput
    do { resolved = try resolveInput(command) }
    catch { return rejectedInput(error) }
    guard resolved.evidence.fingerprint == command.fingerprint else {
        return InputResult(status: "not-issued", reason: .staleObservation)
    }
    let action = command.action, point = command.target.point.cg
    // Create events before the final foreground check. AX writes still address the
    // exact element; pointer events use WindowServer routing after target validation.
    switch action.kind {
    case "move_pointer":
        do { try assertInputFocus(resolved.application, resolved.window) }
        catch { return rejectedInput(error) }
        guard CGWarpMouseCursorPosition(point) == .success else { return InputResult(status: "uncertain", reason: .pointerUnverified) }
        let current = CGEvent(source: nil)?.location
        return current == point ? InputResult(status: "verified") : InputResult(status: "uncertain", reason: .pointerUnverified)
    case "click":
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            return InputResult(status: "not-issued", reason: .eventCreationFailed)
        }
        down.flags = []; up.flags = []
        down.setIntegerValueField(.mouseEventClickState, value: 1); up.setIntegerValueField(.mouseEventClickState, value: 1)
        return dispatchPointerEvents([down, up], source: source, target: resolved)
    case "scroll":
        guard let source = CGEventSource(stateID: .privateState),
              let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1,
                                  wheel1: Int32(-action.deltaY!), wheel2: 0, wheel3: 0) else {
            return InputResult(status: "not-issued", reason: .eventCreationFailed)
        }
        event.location = point; event.flags = []
        return dispatchPointerEvents([event], source: source, target: resolved)
    case "type_text":
        do {
            try assertInputFocus(resolved.application, resolved.window)
            let focused = try focusedElement(applicationElement(resolved.application))
            guard CFEqual(focused, resolved.element) else { return InputResult(status: "not-issued", reason: .focusChanged) }
        } catch { return rejectedInput(error) }
        return replaceInputText(action.text!, role: resolved.evidence.role, editable: resolved.evidence.editable,
            write: { AXUIElementSetAttributeValue(resolved.element, kAXValueAttribute as CFString, $0 as CFString) == .success },
            read: {
                guard let actual = stringAttribute(resolved.element, kAXValueAttribute), actual.utf16.count <= 4096 else { return nil }
                return actual
            })
    default: return InputResult(status: "not-issued", reason: .invalidInput)
    }
}

func desktopInput(execute: Bool) throws {
    var data = Data()
    while data.count <= 65536 {
        let next = FileHandle.standardInput.readData(ofLength: 65537 - data.count)
        if next.isEmpty { break }; data.append(next)
    }
    let command = try parseInputCommand(data, execute: execute)
    if execute { try output(executeInput(command)) }
    else {
        do { try output(resolveInput(command).evidence) }
        catch is InputFailureReason { throw InputError.unavailable }
    }
}
