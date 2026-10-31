import AppKit
import ApplicationServices
import AVFoundation
import CryptoKit
import Foundation

struct Capability: Encodable {
    let status: String
    let detail: String
}

struct DesktopReport: Encodable {
    let platform = "darwin"
    let session: String
    let capabilities: [String: Capability]
    let notes: [String]
}

struct Window: Encodable {
    let id: String
    let application: String
    let title: String?
}

struct WindowInventory: Encodable {
    let windows: [Window]
    let warnings: [String]
}

struct Snapshot: Encodable {
    let platform = "darwin"
    let window: Window?
    let selectedText: String?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(platform, forKey: .platform)
        try container.encode(window, forKey: .window)
        try container.encodeIfPresent(selectedText, forKey: .selectedText)
    }

    private enum CodingKeys: String, CodingKey { case platform, window, selectedText }
}

struct DesktopError: Error, CustomStringConvertible {
    let description: String
    let code: String
    init(_ message: String, code: String = "accessibility-unavailable") {
        description = message
        self.code = code
    }
}

let permissionHelp = "Enable Accessibility for the launching terminal/helper in System Settings > Privacy & Security > Accessibility, then retry."

func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    guard result == .success, let value else {
        throw DesktopError("Accessibility could not read \(name) (code \(result.rawValue)); the application may not expose it.")
    }
    return value
}

func elementAttribute(_ element: AXUIElement, _ name: String) throws -> AXUIElement {
    let value = try attribute(element, name)
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
        throw DesktopError("Accessibility returned an invalid element.")
    }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    return (try? attribute(element, name)) as? String
}

func applicationElement(_ application: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(application.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 1)
    return element
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else { throw DesktopError(permissionHelp, code: "permission-required") }
}

// Public AX APIs do not expose a universal stable window ID. These short-lived
// tokens fail closed when titles change, the app restarts, or windows collide.
func targetID(_ application: NSRunningApplication, _ window: AXUIElement) throws -> String {
    guard !isDesktopHelperProcess(application.processIdentifier) else {
        throw DesktopError("OpenSaysMe feedback is not a desktop target.", code: "invalid-target")
    }
    guard let started = try? processStartIdentity(application.processIdentifier) else {
        throw DesktopError("This application's launch identity is unavailable; it cannot be targeted safely.")
    }
    let title = stringAttribute(window, kAXTitleAttribute) ?? ""
    let identifier = stringAttribute(window, kAXIdentifierAttribute) ?? ""
    let data = try JSONSerialization.data(withJSONObject: [identifier, title])
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return "mac:\(application.processIdentifier):\(started):\(digest)"
}

func listWindows() throws -> WindowInventory {
    try requireAccessibility()
    var found: [Window] = []
    var omitted = false
    var limited = false
    let deadline = Date().addingTimeInterval(3)
    for application in NSWorkspace.shared.runningApplications where application.activationPolicy == .regular
        && !isDesktopHelperProcess(application.processIdentifier) {
        if found.count >= 128 || Date() >= deadline { limited = true; break }
        let app = applicationElement(application)
        AXUIElementSetMessagingTimeout(app, 0.15)
        guard let windows = try? attribute(app, kAXWindowsAttribute) as? [AXUIElement] else {
            omitted = true
            continue
        }
        var candidates: [Window] = []
        for window in windows {
            if found.count + candidates.count >= 128 || Date() >= deadline { limited = true; break }
            AXUIElementSetMessagingTimeout(window, 0.15)
            guard let id = try? targetID(application, window) else { omitted = true; continue }
            candidates.append(Window(id: id, application: String((application.localizedName ?? "Application").prefix(1024)),
                title: stringAttribute(window, kAXTitleAttribute).map { String($0.prefix(16384)) }))
        }
        // The focus helper cannot disambiguate identical AX identifiers/titles.
        let counts = Dictionary(grouping: candidates, by: { $0.id })
        for candidate in candidates {
            if counts[candidate.id]?.count == 1 { found.append(candidate) }
            else { omitted = true }
        }
    }
    var warnings: [String] = []
    if omitted { warnings.append("Some inaccessible or ambiguous windows were omitted.") }
    if limited { warnings.append("Window discovery reached its time or 128-window limit; some windows may be missing.") }
    return WindowInventory(windows: found, warnings: warnings)
}

func focusedElement(_ app: AXUIElement) throws -> AXUIElement {
    let focused = try elementAttribute(app, kAXFocusedUIElementAttribute)
    guard stringAttribute(focused, kAXSubroleAttribute) != kAXSecureTextFieldSubrole else {
        throw DesktopError("Selected text is unavailable in secure text fields.", code: "secure-field")
    }
    return focused
}

func selectedTextCapability(_ app: AXUIElement) -> Capability {
    do {
        let focused = try focusedElement(app)
        var attributes: CFArray?
        guard AXUIElementCopyAttributeNames(focused, &attributes) == .success,
              let names = attributes as? [String], names.contains(kAXSelectedTextAttribute) else {
            return Capability(status: "unavailable", detail: "The focused control does not expose selected text; support varies by application.")
        }
        return Capability(status: "available", detail: "The focused control advertises selected-text access. Text is read only with desktop inspect --selection.")
    } catch {
        return Capability(status: "unavailable", detail: String(describing: error))
    }
}

func microphoneCapability() -> Capability {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return Capability(status: "unverified", detail: "Microphone permission is granted; try a voice request to verify capture. Doctor does not record.")
    case .notDetermined:
        return Capability(status: "permission-required", detail: "Microphone permission has not been requested. Start voice mode and activate a request to allow access; doctor does not prompt or record.")
    case .denied:
        return Capability(status: "permission-required", detail: "Microphone access is denied. Enable it in System Settings > Privacy & Security > Microphone before recording.")
    case .restricted:
        return Capability(status: "unavailable", detail: "Microphone access is restricted by macOS.")
    @unknown default:
        return Capability(status: "unverified", detail: "macOS returned an unknown microphone authorization status.")
    }
}

func screenCaptureCapability() -> Capability {
    guard #available(macOS 14.0, *) else {
        return Capability(status: "unavailable", detail: "Visual frames require macOS 14 or later for ScreenCaptureKit screenshot capture.")
    }
    return CGPreflightScreenCaptureAccess()
        ? Capability(status: "unverified", detail: "Screen Recording permission is granted; frames are captured only during an activated voice turn. Doctor takes no screenshot.")
        : Capability(status: "permission-required", detail: "Enable Screen Recording for the launching terminal/helper in System Settings > Privacy & Security, then restart the terminal. Doctor does not request access or capture the screen.")
}

func probe() -> DesktopReport {
    let permission = Capability(status: "permission-required", detail: permissionHelp)
    var capabilities = [
        "activeWindow": permission,
        "focusWindow": permission,
        "selectedText": permission,
        "globalHotkey": Capability(status: "unverified", detail: "Start voice mode and press your configured activation hotkey to activate a request; doctor installs no hook."),
        "microphone": microphoneCapability(),
        "screenCapture": screenCaptureCapability(),
    ]
    if let application = NSWorkspace.shared.frontmostApplication {
        if AXIsProcessTrusted() {
            let app = applicationElement(application)
            do {
                let window = try elementAttribute(app, kAXFocusedWindowAttribute)
                _ = try targetID(application, window)
                capabilities["activeWindow"] = Capability(status: "available", detail: "Read the frontmost application's focused window through Accessibility; titles are not included in doctor output.")
                var actions: CFArray?
                let result = AXUIElementCopyActionNames(window, &actions)
                let canRaise = result == .success && (actions as? [String])?.contains(kAXRaiseAction) == true
                capabilities["focusWindow"] = Capability(status: canRaise ? "unverified" : "unavailable", detail: canRaise ? "The focused window exposes AXRaise; run an explicit desktop focus test to verify activation." : "The focused window does not expose AXRaise.")
            } catch {
                capabilities["activeWindow"] = Capability(status: "unavailable", detail: String(describing: error))
                capabilities["focusWindow"] = Capability(status: "unverified", detail: "No targetable focused window is available to probe.")
            }
            capabilities["selectedText"] = selectedTextCapability(app)
        }
    } else {
        for name in ["activeWindow", "focusWindow", "selectedText"] {
            capabilities[name] = Capability(status: "unavailable", detail: "No frontmost application. Run inside the logged-in graphical desktop session.")
        }
    }
    return DesktopReport(session: NSWorkspace.shared.frontmostApplication == nil ? "no foreground desktop" : "macOS desktop", capabilities: capabilities, notes: [
        "Doctor does not request permissions, change focus, capture selections or screenshots, or record audio.",
        "Window tokens are temporary. Reinspect after a title change or app restart; identical titles without unique AX identifiers are ambiguous.",
        "Accessibility, microphone, and Screen Recording permissions can depend on the launching terminal and helper signature.",
    ])
}

func inspect(includeSelection: Bool) throws -> Snapshot {
    try requireAccessibility()
    guard let application = NSWorkspace.shared.frontmostApplication else {
        return Snapshot(window: nil, selectedText: nil)
    }
    let app = applicationElement(application)
    let window = try elementAttribute(app, kAXFocusedWindowAttribute)
    var selection: String?
    var selectionElement: AXUIElement?
    if includeSelection {
        let focused = try focusedElement(app)
        guard let selectedWindow = try? elementAttribute(focused, kAXWindowAttribute), CFEqual(selectedWindow, window) else {
            throw DesktopError("The selection cannot be tied to the inspected window. Retry with focus held steady.", code: "focus-changed")
        }
        guard let text = try attribute(focused, kAXSelectedTextAttribute) as? String else {
            throw DesktopError("Accessibility returned invalid selected text.")
        }
        guard text.utf8.count <= 65_536 else {
            throw DesktopError("Selection exceeds 64 KiB. Select a smaller excerpt.", code: "selection-too-large")
        }
        selection = text
        selectionElement = focused
    }
    let title = stringAttribute(window, kAXTitleAttribute)
    let target = Window(id: try targetID(application, window), application: application.localizedName ?? application.bundleIdentifier ?? "Unknown application", title: title)
    if let selectionElement {
        guard let currentElement = try? focusedElement(app), CFEqual(currentElement, selectionElement) else {
            throw DesktopError("The focused control changed while reading the selection. Retry with focus held steady.", code: "focus-changed")
        }
    }
    guard let currentWindow = try? elementAttribute(app, kAXFocusedWindowAttribute), CFEqual(currentWindow, window),
          NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
        throw DesktopError("The focused application or window changed during inspection. Retry with focus held steady.", code: "focus-changed")
    }
    return Snapshot(window: target, selectedText: selection)
}

struct PointerContext: Encodable {
    let x: Double
    let y: Double
    let window: Window?
    private enum CodingKeys: String, CodingKey { case x, y, window }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(x, forKey: .x)
        try container.encode(y, forKey: .y)
        try container.encode(window, forKey: .window)
    }
}

struct DesktopContext: Encodable {
    let platform = "darwin"
    let capturedAt: String
    let activeWindow: Window?
    let selectedText: String?
    let pointer: PointerContext?
    let warnings: [String]
    let issues: [String]
    private enum CodingKeys: String, CodingKey { case platform, capturedAt, activeWindow, selectedText, pointer, warnings, issues }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(platform, forKey: .platform)
        try container.encode(capturedAt, forKey: .capturedAt)
        try container.encode(activeWindow, forKey: .activeWindow)
        try container.encodeIfPresent(selectedText, forKey: .selectedText)
        try container.encodeIfPresent(pointer, forKey: .pointer)
        try container.encode(warnings, forKey: .warnings)
        if !issues.isEmpty { try container.encode(issues, forKey: .issues) }
    }
}

// Capture is deliberately best effort: inaccessible selection or a transient
// focus change must not stop speech. No clipboard operations or focus changes.
func captureContext() -> DesktopContext {
    let capturedAt = captureTimestamp()
    let position = CGEvent(source: nil)?.location
    var warnings: [String] = []
    var issues: [String] = []
    var active: Window?
    var selection: String?
    var pointedWindow: Window?
    if AXIsProcessTrusted() {
        do { active = try inspect(includeSelection: false).window }
        catch { warnings.append("Active window unavailable or focus changed during capture.") }
        if let active {
            do {
                let selected = try inspect(includeSelection: true)
                if selected.window?.id == active.id { selection = selected.selectedText }
                else { warnings.append("Selection omitted because focus changed during capture.") }
            } catch { warnings.append("Selection unavailable, secure, oversized, or changed during capture.") }
        }
        if let position {
            let system = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(system, 0.5)
            var element: AXUIElement?
            if AXUIElementCopyElementAtPosition(system, Float(position.x), Float(position.y), &element) == .success,
               let element {
                var pid: pid_t = 0
                if AXUIElementGetPid(element, &pid) == .success, let app = NSRunningApplication(processIdentifier: pid) {
                    let window = stringAttribute(element, kAXRoleAttribute) == kAXWindowRole
                        ? element : try? elementAttribute(element, kAXWindowAttribute)
                    if let window, let id = try? targetID(app, window) {
                        pointedWindow = Window(id: id, application: app.localizedName ?? app.bundleIdentifier ?? "Unknown application", title: stringAttribute(window, kAXTitleAttribute))
                    }
                }
            }
            if pointedWindow == nil { warnings.append("No accessible window was resolved under the pointer.") }
        }
    } else { warnings.append(permissionHelp); issues.append("permission-required") }
    if position == nil { warnings.append("Pointer location unavailable in this desktop session.") }
    return DesktopContext(capturedAt: capturedAt, activeWindow: active, selectedText: selection,
        pointer: position.map { PointerContext(x: $0.x, y: $0.y, window: pointedWindow) }, warnings: warnings, issues: issues)
}

func resolveWindow(_ id: String, deadline: TimeInterval) throws -> (NSRunningApplication, AXUIElement) {
    try requireAccessibility()
    let parts = id.split(separator: ":")
    guard parts.count == 4, parts[0] == "mac", let pid = Int32(parts[1]), pid > 0, !isDesktopHelperProcess(pid),
          let application = NSRunningApplication(processIdentifier: pid) else {
        throw DesktopError("Invalid or expired macOS window target. Run desktop inspect again.", code: "invalid-target")
    }
    let app = applicationElement(application)
    AXUIElementSetMessagingTimeout(app, 0.1)
    var count = 0
    guard AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count) == .success, count <= 128 else {
        throw DesktopError("The target application does not expose its windows.")
    }
    guard count > 0 else { throw DesktopError("The window closed.", code: "stale-or-ambiguous-target") }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, 0, count, &values) == .success,
          let windows = values as? [AXUIElement] else { throw DesktopError("The target application's windows are unavailable.") }
    var matches: [AXUIElement] = []
    for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw DesktopError("Window resolution timed out.") }
        AXUIElementSetMessagingTimeout(window, 0.05)
        if try targetID(application, window) == id { matches.append(window) }
    }
    guard matches.count == 1, let window = matches.first else {
        throw DesktopError("Window target is stale or ambiguous. Run desktop inspect again; duplicate window titles may require a distinct title.", code: "stale-or-ambiguous-target")
    }
    return (application, window)
}

func focus(_ id: String) throws {
    let (application, window) = try resolveWindow(id, deadline: ProcessInfo.processInfo.systemUptime + 3)
    let pid = application.processIdentifier
    let app = applicationElement(application)
    AXUIElementSetMessagingTimeout(window, 1)
    guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else {
        throw DesktopError("The application rejected raising the target window.", code: "focus-rejected")
    }
    guard application.activate(options: []) else {
        throw DesktopError("macOS rejected application activation.", code: "focus-rejected")
    }
    let deadline = Date().addingTimeInterval(1.5)
    repeat {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
           let current = try? elementAttribute(app, kAXFocusedWindowAttribute), CFEqual(current, window) {
            return
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    } while Date() < deadline
    throw DesktopError("Focus change was requested but could not be verified; macOS may have blocked activation.", code: "focus-unverified")
}

struct WindowInspection: Encodable {
    let status = "ok"
    let capturedAt: String
    let window: Window
    let nodes: [WindowContentNode]
    let warnings: [String]
}

struct WindowFrame: Encodable {
    let status = "ok"
    let capturedAt: String
    let window: Window
    let bounds: FrameBounds
    let image: FrameImage
    let warnings: [String]
}

func windowCaptureTarget(_ application: NSRunningApplication, _ window: AXUIElement) throws -> WindowCaptureTarget {
    let position = try attribute(window, kAXPositionAttribute)
    let size = try attribute(window, kAXSizeAttribute)
    guard CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else {
        throw WindowCaptureError.unavailable
    }
    let positionValue = unsafeBitCast(position, to: AXValue.self)
    let sizeValue = unsafeBitCast(size, to: AXValue.self)
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetType(positionValue) == .cgPoint, AXValueGetType(sizeValue) == .cgSize,
          AXValueGetValue(positionValue, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &dimensions),
          validWindowCaptureBounds(CGRect(origin: point, size: dimensions)) else { throw WindowCaptureError.unavailable }
    guard let title = try attribute(window, kAXTitleAttribute) as? String else { throw WindowCaptureError.unavailable }
    return WindowCaptureTarget(processID: application.processIdentifier, title: title,
                               bounds: CGRect(origin: point, size: dimensions))
}

func validateWindowCaptureSource(_ application: NSRunningApplication, _ window: AXUIElement,
                                 target: WindowCaptureTarget, deadline: TimeInterval) throws {
    guard !application.isHidden, (try attribute(window, kAXMinimizedAttribute) as? Bool) == false else {
        throw WindowCaptureError.unavailable
    }
    let app = applicationElement(application)
    AXUIElementSetMessagingTimeout(app, 0.05)
    var count = 0
    var values: CFArray?
    guard AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count) == .success,
          count > 0, count <= 128,
          AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, 0, count, &values) == .success,
          let windows = values as? [AXUIElement] else { throw WindowCaptureError.unavailable }
    let candidates = try windows.map { candidate in
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw WindowCaptureError.timeout }
        AXUIElementSetMessagingTimeout(candidate, 0.05)
        return try windowCaptureTarget(application, candidate)
    }
    // A unique SC match is insufficient if another AX window could be its source.
    // Check against the actual captured bounds after capture, including rounding.
    let index = try uniqueCaptureTarget(target, candidates: candidates)
    guard CFEqual(windows[index], window) else { throw WindowCaptureError.stale }
}

func captureWindow(_ id: String) throws -> WindowFrame {
    guard #available(macOS 14.0, *) else { throw WindowCaptureError.unsupported }
    guard CGPreflightScreenCaptureAccess() else { throw VisualCaptureError.permissionRequired }
    let deadline = ProcessInfo.processInfo.systemUptime + 4
    let (application, window) = try resolveWindow(id, deadline: deadline)
    let target = try windowCaptureTarget(application, window)
    try validateWindowCaptureSource(application, window, target: target, deadline: deadline)
    let frame = try captureWindowFrame(target, deadline: deadline)
    let (currentApplication, current) = try resolveWindow(id, deadline: deadline)
    let currentTarget = try windowCaptureTarget(currentApplication, current)
    try validateWindowCaptureSource(currentApplication, current,
        target: WindowCaptureTarget(processID: target.processID, title: target.title, bounds: frame.bounds), deadline: deadline)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw WindowCaptureError.timeout }
    guard CFEqual(current, window), currentTarget.title == target.title, currentTarget.bounds == target.bounds else {
        throw WindowCaptureError.stale
    }
    return WindowFrame(capturedAt: frame.capturedAt,
        window: Window(id: id, application: String((application.localizedName ?? "Application").prefix(1024)),
                       title: stringAttribute(current, kAXTitleAttribute).map { String($0.prefix(16384)) }),
        bounds: FrameBounds(frame.bounds), image: frame.image, warnings: frame.warnings)
}

func inspectWindow(_ id: String) throws -> WindowInspection {
    let deadline = ProcessInfo.processInfo.systemUptime + 3
    let (application, window) = try resolveWindow(id, deadline: deadline)
    let capturedAt = captureTimestamp()
    let title = stringAttribute(window, kAXTitleAttribute)
    let contentDeadline = min(deadline - 0.5, ProcessInfo.processInfo.systemUptime + 1.5)
    func check(_ element: AXUIElement) throws {
        guard ProcessInfo.processInfo.systemUptime < contentDeadline else { throw DesktopError("Content inspection timed out.") }
        AXUIElementSetMessagingTimeout(element, 0.05)
    }
    let content = collectWindowContent(root: window, deadline: contentDeadline,
        same: { CFEqual($0, $1) }, read: { element, name in
            try check(element)
            var value: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
            if result == .noValue || result == .attributeUnsupported { return nil }
            guard result == .success else { throw DesktopError("Content is unavailable.") }
            return value as? String
        }, children: { element, limit in
            try check(element)
            var count = 0
            let result = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
            if result == .noValue || result == .attributeUnsupported { return [] }
            guard result == .success else { throw DesktopError("Child elements are unavailable.") }
            if count == 0 { return [] }
            var values: CFArray?
            guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, limit), &values) == .success,
                  let children = values as? [AXUIElement] else { throw DesktopError("Child elements are unavailable.") }
            return children
        })
    // Discard all content if the source window closed, changed identity, or became ambiguous.
    let (_, current) = try resolveWindow(id, deadline: deadline)
    guard CFEqual(current, window), title == stringAttribute(current, kAXTitleAttribute) else {
        throw DesktopError("Window changed during inspection.", code: "stale-or-ambiguous-target")
    }
    guard !content.nodes.isEmpty else { throw DesktopError("No accessible content was available.") }
    return WindowInspection(capturedAt: capturedAt,
        window: Window(id: id, application: String((application.localizedName ?? "Application").prefix(1024)),
                       title: title.map { String($0.prefix(16384)) }),
        nodes: content.nodes, warnings: content.warnings)
}

func output<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data([10]))
}

@main
struct DesktopMain {
    static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            switch arguments {
            case ["--probe"]: try output(probe())
            case ["--inspect"]: try output(inspect(includeSelection: false))
            case ["--inspect-selection"]: try output(inspect(includeSelection: true))
            case ["--list-windows"]: try output(listWindows())
            case ["--context"]: try output(captureContext())
            case ["--frame"]: try output(captureFrame())
            case ["--voice"]: VoiceSession().run()
            case let args where args.count == 2 && args[0] == "--voice":
                guard let hotkey = ActivationHotkey.parse(args[1]) else {
                    try output(["type": "error", "code": "invalid-command"])
                    return
                }
                VoiceSession(activationHotkey: hotkey).run()
            case ["--feedback"]: FeedbackSession().run()
            case ["--inspect-input"]: try desktopInput(execute: false)
            case ["--execute-input"]: try desktopInput(execute: true)
            case let args where args.count == 2 && args[0] == "--inspect-window":
                try output(inspectWindow(args[1]))
            case let args where args.count == 2 && args[0] == "--capture-window":
                try output(captureWindow(args[1]))
            case let args where args.count == 2 && args[0] == "--focus":
                try focus(args[1])
                try output(["ok": true])
            default:
                throw DesktopError("Expected --probe, --inspect, --inspect-selection, --list-windows, --inspect-window <target-id>, --capture-window <target-id>, --context, --frame, --voice [activation-hotkey], or --focus <target-id>.")
            }
        } catch let error as VisualCaptureError {
            try? output(["error": error.rawValue])
        } catch let error as WindowCaptureError {
            try? output(["error": error.rawValue])
        } catch let error as InputError {
            try? output(["error": error.rawValue])
        } catch let error as DesktopError {
            // Expected failures stay in the validated protocol, without native values or
            // captured content. The CLI maps these codes to errors and an exit status.
            try? output(["error": error.code])
        } catch {
            FileHandle.standardError.write(Data("Desktop helper failed.\n".utf8))
            exit(1)
        }
    }
}
