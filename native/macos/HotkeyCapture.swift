import AppKit
import ApplicationServices
import Carbon
import Foundation

enum HotkeyCaptureFailure: String {
    case permission = "accessibility-permission-required"
    case unavailable = "capture-unavailable"
    case timeout
    case focusChanged = "focus-changed"
}

enum HotkeyCaptureResult: Equatable {
    case captured(String)
    case cancelled
    case unavailable(HotkeyCaptureFailure)

    var payload: [String: String] {
        switch self {
        case .captured(let shortcut): return ["status": "captured", "shortcut": shortcut]
        case .cancelled: return ["status": "cancelled"]
        case .unavailable(let reason): return ["status": "unavailable", "reason": reason.rawValue]
        }
    }
}

// Retains only a supported key code and modifier names. No typed text is read.
struct HotkeyCaptureState {
    // secondaryFn can mark an F-key event even after physical Fn release.
    static let releaseFlags: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand, .maskShift]
    private var down = Set<UInt32>()
    private var candidate: String?
    private var overlapping = false
    private var cancelling = false
    private(set) var result: HotkeyCaptureResult?

    mutating func stop(_ result: HotkeyCaptureResult) { if self.result == nil { self.result = result } }

    // True means suppress this event; flag changes always pass through unchanged.
    mutating func handle(_ type: CGEventType, keyCode: UInt32, flags: CGEventFlags, repeating: Bool = false) -> Bool {
        guard result == nil else { return false }
        var suppress = false
        switch type {
        case .keyDown:
            suppress = true
            let fresh = down.insert(keyCode).inserted
            if keyCode == UInt32(kVK_Escape) || (keyCode == UInt32(kVK_ANSI_C) && flags.contains(.maskControl)) {
                cancelling = true
                candidate = nil
            } else if down.count > 1 || (fresh && candidate != nil) {
                candidate = nil
                overlapping = true
            } else if fresh && !repeating && !cancelling && !overlapping {
                candidate = ActivationHotkey.shortcut(keyCode: keyCode, flags: flags)
            }
        case .keyUp:
            suppress = down.remove(keyCode) != nil
        case .flagsChanged: break
        default: return false
        }
        if down.isEmpty && flags.intersection(Self.releaseFlags).isEmpty {
            if cancelling { result = .cancelled }
            else if let candidate { result = .captured(candidate) }
            overlapping = false
        }
        return suppress
    }
}

func hotkeyCaptureOwnerIsAncestor(_ owner: pid_t, parent: pid_t, parentOf: (pid_t) -> pid_t?) -> Bool {
    guard owner > 1 else { return false }
    var current = parent
    var seen = Set<pid_t>()
    for _ in 0..<64 {
        if current == owner { return true }
        guard current > 1, seen.insert(current).inserted, let next = parentOf(current) else { return false }
        current = next
    }
    return false
}

private func parentProcess(_ pid: pid_t) -> pid_t? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var info = kinfo_proc()
    let expected = MemoryLayout<kinfo_proc>.size
    var size = expected
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
          size == expected, info.kp_proc.p_pid == pid else { return nil }
    return info.kp_eproc.e_ppid
}

final class HotkeyCaptureSession {
    private var state = HotkeyCaptureState()
    private var owner: pid_t = 0
    private var ownerApplication: AXUIElement?
    private var ownerWindow: AXUIElement?

    func run() {
        signal(SIGPIPE, SIG_IGN)
        let result = capture()
        _ = write(result.payload)
    }

    private func write(_ payload: [String: String]) -> Bool {
        guard var data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return false }
        data.append(10)
        do { try FileHandle.standardOutput.write(contentsOf: data); return true }
        catch { return false }
    }

    private func capture() -> HotkeyCaptureResult {
        guard AXIsProcessTrusted() else { return .unavailable(.permission) }
        _ = CGMainDisplayID()
        let parent = getppid()
        guard let frontmost = NSWorkspace.shared.frontmostApplication,
              hotkeyCaptureOwnerIsAncestor(frontmost.processIdentifier, parent: parent, parentOf: parentProcess) else {
            return .unavailable(.focusChanged)
        }
        owner = frontmost.processIdentifier
        let application = AXUIElementCreateApplication(owner)
        guard AXUIElementSetMessagingTimeout(application, 0.05) == .success,
              let window = focusedWindow(application) else { return .unavailable(.unavailable) }
        ownerApplication = application
        ownerWindow = window
        let signals = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.state.stop(.cancelled) }
            source.resume()
            return source
        }
        defer { signals.forEach { $0.cancel() } }
        let mask = [CGEventType.keyDown, .keyUp, .flagsChanged].reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                         options: .defaultTap, eventsOfInterest: mask,
                                         callback: { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            return Unmanaged<HotkeyCaptureSession>.fromOpaque(context).takeUnretainedValue().event(type, event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return .unavailable(.unavailable) }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return .unavailable(.unavailable)
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        defer {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
            CFMachPortInvalidate(tap)
        }
        let previousFlags = fcntl(STDIN_FILENO, F_GETFL)
        guard previousFlags >= 0, fcntl(STDIN_FILENO, F_SETFL, previousFlags | O_NONBLOCK) == 0 else {
            return .unavailable(.unavailable)
        }
        defer { _ = fcntl(STDIN_FILENO, F_SETFL, previousFlags) }
        guard write(["status": "ready"]) else { return .cancelled }
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while state.result == nil {
            if getppid() != parent { state.stop(.cancelled); break }
            if !focusMatches() {
                state.stop(.unavailable(.focusChanged)); break
            }
            var byte: UInt8 = 0
            let count = read(STDIN_FILENO, &byte, 1)
            if count >= 0 { state.stop(.cancelled); break }
            if errno != EAGAIN && errno != EINTR { state.stop(.cancelled); break }
            if ProcessInfo.processInfo.systemUptime >= deadline { state.stop(.unavailable(.timeout)); break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return state.result ?? .cancelled
    }

    private func event(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            state.stop(.unavailable(.unavailable))
            return Unmanaged.passUnretained(event)
        }
        guard focusMatches() else {
            state.stop(.unavailable(.focusChanged))
            return Unmanaged.passUnretained(event)
        }
        let suppress = state.handle(type, keyCode: UInt32(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode)),
                                    flags: event.flags, repeating: event.getIntegerValueField(.keyboardEventAutorepeat) != 0)
        return suppress ? nil : Unmanaged.passUnretained(event)
    }

    private func focusedWindow(_ application: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func focusMatches() -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == owner,
              let application = ownerApplication, let original = ownerWindow,
              let current = focusedWindow(application) else { return false }
        return CFEqual(current, original)
    }
}
