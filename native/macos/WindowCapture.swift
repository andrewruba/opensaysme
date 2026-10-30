import AppKit
import Foundation
import ScreenCaptureKit

enum WindowCaptureError: String, Error {
    case unsupported = "window-capture-unsupported"
    case unavailable = "window-capture-unavailable"
    case ambiguous = "window-capture-ambiguous"
    case stale = "window-capture-stale"
    case timeout = "window-capture-timeout"
    case failed = "window-capture-failed"
}

struct WindowCaptureTarget {
    let processID: Int32
    let title: String
    let bounds: CGRect
}

struct WindowCaptureCandidate: Equatable {
    let id: CGWindowID
    let processID: Int32
    let title: String
    let bounds: CGRect
    let layer: Int
}

struct CapturedWindowImage {
    let capturedAt: String
    let bounds: CGRect
    let image: FrameImage
    let warnings: [String]
}

func validWindowCaptureBounds(_ rect: CGRect) -> Bool {
    [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy { $0.isFinite }
        && rect.width > 0 && rect.height > 0 && rect.width <= 65_536 && rect.height <= 65_536
}

func captureEvidenceMatches(_ target: WindowCaptureTarget, _ candidate: WindowCaptureTarget) -> Bool {
    candidate.processID == target.processID && candidate.title == target.title
        && validWindowCaptureBounds(target.bounds) && validWindowCaptureBounds(candidate.bounds)
        && abs(candidate.bounds.origin.x - target.bounds.origin.x) <= 1
        && abs(candidate.bounds.origin.y - target.bounds.origin.y) <= 1
        && abs(candidate.bounds.width - target.bounds.width) <= 1
        && abs(candidate.bounds.height - target.bounds.height) <= 1
}

func uniqueCaptureTarget(_ target: WindowCaptureTarget, candidates: [WindowCaptureTarget]) throws -> Int {
    let matches = candidates.indices.filter { captureEvidenceMatches(target, candidates[$0]) }
    guard !matches.isEmpty else { throw WindowCaptureError.stale }
    guard matches.count == 1 else { throw WindowCaptureError.ambiguous }
    return matches[0]
}

// AX and ScreenCaptureKit expose different identities. Never choose a window
// by title alone. Small cross-API rounding differences are allowed only here;
// revalidation below requires unchanged geometry and the same CGWindowID.
func matchCaptureWindow(_ target: WindowCaptureTarget, candidates: [WindowCaptureCandidate]) throws -> WindowCaptureCandidate {
    guard validWindowCaptureBounds(target.bounds), candidates.count <= 4096 else { throw WindowCaptureError.unavailable }
    let matches = candidates.filter { candidate in
        candidate.id != 0 && candidate.layer == 0 && captureEvidenceMatches(target,
            WindowCaptureTarget(processID: candidate.processID, title: candidate.title, bounds: candidate.bounds))
    }
    guard !matches.isEmpty else { throw WindowCaptureError.unavailable }
    guard matches.count == 1 else { throw WindowCaptureError.ambiguous }
    return matches[0]
}

func revalidateCaptureWindow(_ target: WindowCaptureTarget, original: WindowCaptureCandidate,
                             candidates: [WindowCaptureCandidate]) throws {
    // Any failure here discards pixels, including a replacement with identical labels.
    guard let current = try? matchCaptureWindow(target, candidates: candidates), current == original else {
        throw WindowCaptureError.stale
    }
}

func windowCaptureSize(bounds: CGRect, pixelScale: Float) -> (width: Int, height: Int)? {
    guard validWindowCaptureBounds(bounds), pixelScale.isFinite, pixelScale > 0, pixelScale <= 8 else { return nil }
    return boundedImageSize(width: Int((bounds.width * Double(pixelScale)).rounded(.up)),
                            height: Int((bounds.height * Double(pixelScale)).rounded(.up)))
}

@available(macOS 14.0, *)
private func captureCandidate(_ window: SCWindow) -> WindowCaptureCandidate {
    WindowCaptureCandidate(id: window.windowID, processID: window.owningApplication?.processID ?? -1,
                           title: window.title ?? "", bounds: window.frame, layer: window.windowLayer)
}

@available(macOS 14.0, *)
private func captureWindowImage(_ target: WindowCaptureTarget) async throws -> CapturedWindowImage {
    try Task.checkCancellation()
    guard CGPreflightScreenCaptureAccess() else { throw VisualCaptureError.permissionRequired }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    try Task.checkCancellation()
    let matched = try matchCaptureWindow(target, candidates: content.windows.map(captureCandidate))
    guard let window = content.windows.first(where: { $0.windowID == matched.id }) else { throw WindowCaptureError.stale }
    // This captures the window itself, including when another window covers it.
    // It never crops the foreground display or raises/restores the target.
    let filter = SCContentFilter(desktopIndependentWindow: window)
    guard abs(filter.contentRect.width - matched.bounds.width) <= 1,
          abs(filter.contentRect.height - matched.bounds.height) <= 1,
          let size = windowCaptureSize(bounds: filter.contentRect, pixelScale: filter.pointPixelScale) else {
        throw WindowCaptureError.unavailable
    }
    let configuration = SCStreamConfiguration()
    configuration.width = size.width
    configuration.height = size.height
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.scalesToFit = true
    configuration.preservesAspectRatio = true
    let capturedAt = captureTimestamp()
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    try Task.checkCancellation()
    let refreshed = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    try Task.checkCancellation()
    try revalidateCaptureWindow(target, original: matched, candidates: refreshed.windows.map(captureCandidate))
    guard image.width == size.width, image.height == size.height else { throw WindowCaptureError.failed }
    return CapturedWindowImage(capturedAt: capturedAt, bounds: matched.bounds, image: try encodeFrameImage(image),
        warnings: ["Window pixels are a snapshot; protected or non-rendered content may be blank. Reinspect before acting if content or geometry changes."])
}

func captureWindowFrame(_ target: WindowCaptureTarget, deadline: TimeInterval) throws -> CapturedWindowImage {
    guard #available(macOS 14.0, *) else { throw WindowCaptureError.unsupported }
    guard CGPreflightScreenCaptureAccess() else { throw VisualCaptureError.permissionRequired }
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw WindowCaptureError.timeout }
    var result: Result<CapturedWindowImage, Error>?
    let task = Task { @MainActor in
        do { result = .success(try await captureWindowImage(target)) }
        catch { result = .failure(error) }
    }
    while result == nil && ProcessInfo.processInfo.systemUptime < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    guard let result, ProcessInfo.processInfo.systemUptime < deadline else {
        task.cancel(); throw WindowCaptureError.timeout
    }
    do { return try result.get() }
    catch let error as WindowCaptureError { throw error }
    catch {
        if !CGPreflightScreenCaptureAccess() { throw VisualCaptureError.permissionRequired }
        throw WindowCaptureError.failed
    }
}
