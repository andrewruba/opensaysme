import AppKit
import ApplicationServices
import AVFoundation
import Foundation

private func parentProcess(_ pid: Int32) -> Int32? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_pid == UInt32(pid), info.pbi_ppid <= UInt32(Int32.max) else { return nil }
    return Int32(info.pbi_ppid)
}

func permissionReport() -> PermissionReport {
    let launcher = observedPermissionLauncher(start: getppid(), parent: parentProcess, application: { pid in
        guard let app = NSRunningApplication(processIdentifier: pid), let bundle = app.bundleURL,
              !isDesktopHelperProcess(pid) else { return nil }
        return PermissionLauncher(name: String((app.localizedName ?? bundle.lastPathComponent).prefix(512)),
            bundleIdentifier: app.bundleIdentifier.map { String($0.prefix(512)) }, path: String(bundle.path.prefix(4096)))
    })
    let screenStatus: String
    if #available(macOS 14.0, *) { screenStatus = CGPreflightScreenCaptureAccess() ? "granted" : "not-granted" }
    else { screenStatus = "unsupported" }
    return PermissionReport(helperPath: helperExecutablePath(getpid()) ?? CommandLine.arguments[0],
        bundleIdentifier: Bundle.main.bundleIdentifier ?? "dev.opensaysme.desktop", launcher: launcher,
        desktopAvailable: NSWorkspace.shared.frontmostApplication != nil,
        permissions: PermissionGrants(microphone: microphonePermissionStatus(AVCaptureDevice.authorizationStatus(for: .audio)),
            accessibility: AXIsProcessTrusted() ? "granted" : "not-granted", screenCapture: screenStatus))
}

private func verifyMicrophone(_ state: TestState, deadline: Date) -> PermissionOutcome {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        while AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined && !state.cancelled && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
    }
    if state.cancelled { return .cancelled }
    guard Date() < deadline else { return .timeout }
    if let blocked = microphonePermissionBlock(AVCaptureDevice.authorizationStatus(for: .audio)) { return blocked }
    guard AVCaptureDevice.default(for: .audio) != nil else { return .noDevice }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate > 0 else { return .noDevice }
    let stats = AudioStats()
    input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in stats.add(buffer.frameLength) }
    defer { engine.stop(); input.removeTap(onBus: 0); engine.reset() }
    do { try engine.start() } catch { return .captureFailed }
    let stop = min(deadline, Date().addingTimeInterval(3))
    while !state.cancelled && Date() < stop { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    return microphoneVerificationOutcome(status: AVCaptureDevice.authorizationStatus(for: .audio), frames: stats.total(),
        cancelled: state.cancelled, timedOut: Date() >= deadline)
}

private func verifyAccessibility(_ state: TestState) -> PermissionOutcome {
    if !AXIsProcessTrusted() {
        // Apple's prompt is asynchronous; setup explains how to grant and recheck.
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
    if state.cancelled { return .cancelled }
    guard AXIsProcessTrusted() else { return .permissionRequired }
    guard let application = NSWorkspace.shared.frontmostApplication else { return .noWindow }
    let app = applicationElement(application)
    AXUIElementSetMessagingTimeout(app, 0.2)
    // Read only the focused window's role. No titles, selection, values or focus changes.
    guard let window = try? elementAttribute(app, kAXFocusedWindowAttribute) else { return .noWindow }
    AXUIElementSetMessagingTimeout(window, 0.2)
    guard stringAttribute(window, kAXRoleAttribute) == kAXWindowRole else { return .noWindow }
    if state.cancelled { return .cancelled }
    return AXIsProcessTrusted() ? .verified : .permissionRequired
}

private func verifyScreenCapture(_ state: TestState) -> PermissionOutcome {
    guard #available(macOS 14.0, *) else { return .unsupported }
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    if state.cancelled { return .cancelled }
    guard CGPreflightScreenCaptureAccess() else { return .permissionRequired }
    guard NSWorkspace.shared.frontmostApplication != nil else { return .noWindow }
    do {
        // The screenshot stays inside this helper. Only the verification outcome
        // is returned; no image bytes, titles or selection reach stdout or files.
        _ = try captureFrame()
        if state.cancelled { return .cancelled }
        return .verified
    } catch VisualCaptureError.permissionRequired { return .permissionRequired }
    catch VisualCaptureError.timeout { return .timeout }
    catch { return state.cancelled ? .cancelled : .captureFailed }
}

func verifyPermission(_ permission: DesktopPermission) -> PermissionVerification {
    let state = TestState()
    let signals = cancellationSources(state)
    defer { signals.forEach { $0.cancel() } }
    let deadline = Date().addingTimeInterval(20)
    let outcome: PermissionOutcome
    switch permission {
    case .microphone: outcome = verifyMicrophone(state, deadline: deadline)
    case .accessibility: outcome = verifyAccessibility(state)
    case .screenCapture: outcome = verifyScreenCapture(state)
    }
    return PermissionVerification(permission: permission,
        outcome: state.cancelled ? .cancelled : Date() >= deadline ? .timeout : outcome)
}
