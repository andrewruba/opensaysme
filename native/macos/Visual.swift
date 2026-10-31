import AppKit
import Foundation
import ScreenCaptureKit

enum VisualCaptureError: String, Error {
    case permissionRequired = "screen-permission-required"
    case unavailable = "screen-capture-unavailable"
    case failed = "screen-capture-failed"
}

func captureTimestamp(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

func displayAt(_ point: CGPoint) -> CGDirectDisplayID? {
    var display: CGDirectDisplayID = 0
    var count: UInt32 = 0
    guard CGGetDisplaysWithPoint(point, 1, &display, &count) == .success,
          count == 1, display != 0 else { return nil }
    return display
}

// Sampling is independent of audio delivery. Paths describe attention only;
// neither a dwell nor a loop is assigned a gesture or command category.
struct PointerTrajectorySampler {
    private var active = false
    private var nextSample: TimeInterval = 0
    private var previousPoint: CGPoint?
    private var previousDisplay: CGDirectDisplayID?

    mutating func begin() {
        active = true
        nextSample = 0
        previousPoint = nil
        previousDisplay = nil
    }

    mutating func end() { active = false }

    func isDue(at now: TimeInterval) -> Bool { active && now >= nextSample }

    mutating func sample(at now: TimeInterval, point: CGPoint, display: CGDirectDisplayID?) -> Bool {
        guard isDue(at: now), point.x.isFinite, point.y.isFinite else { return false }
        nextSample = now + 0.05
        guard previousPoint != point || previousDisplay != display else { return false }
        previousPoint = point
        previousDisplay = display
        return true
    }
}

struct FrameBounds: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    init(_ rect: CGRect) {
        x = rect.origin.x; y = rect.origin.y
        width = rect.width; height = rect.height
    }
}

struct FrameDisplay: Encodable {
    let id: String
    let bounds: FrameBounds
}

struct FrameImage: Encodable {
    let mimeType = "image/jpeg"
    let width: Int
    let height: Int
    let data: String
}

struct ScreenFrame: Encodable {
    let capturedAt: String
    let display: FrameDisplay
    let image: FrameImage
    let warnings: [String]
}

func boundedImageSize(width: Int, height: Int) -> (width: Int, height: Int)? {
    guard width > 0, height > 0 else { return nil }
    let scale = min(1, 1600 / Double(max(width, height)))
    return (max(1, Int((Double(width) * scale).rounded(.down))),
            max(1, Int((Double(height) * scale).rounded(.down))))
}

func encodeFrameImage(_ image: CGImage) throws -> FrameImage {
    guard let size = boundedImageSize(width: image.width, height: image.height),
          let context = CGContext(data: nil, width: size.width, height: size.height,
            bitsPerComponent: 8, bytesPerRow: size.width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
        throw VisualCaptureError.failed
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
    guard let resized = context.makeImage() else { throw VisualCaptureError.failed }
    let bitmap = NSBitmapImageRep(cgImage: resized)
    for quality in [0.65, 0.45, 0.25] {
        if let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]),
           jpeg.count <= 700_000 {
            return FrameImage(width: size.width, height: size.height, data: jpeg.base64EncodedString())
        }
    }
    throw VisualCaptureError.failed
}

@available(macOS 14.0, *)
@MainActor
private func captureScreenFrame() async throws -> ScreenFrame {
    guard CGPreflightScreenCaptureAccess() else { throw VisualCaptureError.permissionRequired }
    guard let point = CGEvent(source: nil)?.location, let displayID = displayAt(point) else {
        throw VisualCaptureError.unavailable
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayID }),
          let size = boundedImageSize(width: display.width, height: display.height) else {
        throw VisualCaptureError.unavailable
    }
    // CoreGraphics display bounds and CGEvent coordinates share a top-left,
    // global logical coordinate space, including negative monitor origins.
    let bounds = CGDisplayBounds(displayID)
    guard !bounds.isEmpty, !bounds.isInfinite, !bounds.isNull else { throw VisualCaptureError.unavailable }
    let configuration = SCStreamConfiguration()
    configuration.width = size.width
    configuration.height = size.height
    configuration.showsCursor = false
    let capturedAt = captureTimestamp()
    // Exclude the owned helper application, including a feedback window shown
    // after this inventory. Window sharingType alone is not a ScreenCaptureKit
    // exclusion contract. Match executable identity rather than window labels.
    let helpers = content.applications.filter { isDesktopHelperProcess($0.processID) }
    let image = try await SCScreenshotManager.captureImage(
        contentFilter: SCContentFilter(display: display, excludingApplications: helpers, exceptingWindows: []), configuration: configuration)
    return ScreenFrame(capturedAt: capturedAt,
        display: FrameDisplay(id: String(displayID), bounds: FrameBounds(bounds)),
        image: try encodeFrameImage(image), warnings: [])
}

// The CLI's helper is synchronous to keep existing Carbon/audio processing on
// the main thread. Pump its run loop while ScreenCaptureKit performs one capture.
func captureFrame() throws -> ScreenFrame {
    guard #available(macOS 14.0, *) else { throw VisualCaptureError.unavailable }
    guard CGPreflightScreenCaptureAccess() else { throw VisualCaptureError.permissionRequired }
    let deadline = ProcessInfo.processInfo.systemUptime + 3
    do {
        return try runMainActorCapture(deadline: deadline) { try await captureScreenFrame() }
    }
    catch CaptureExecutionError.displayUnavailable { throw VisualCaptureError.unavailable }
    catch let error as VisualCaptureError { throw error }
    catch { throw VisualCaptureError.failed }
}
