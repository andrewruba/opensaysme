import Foundation
import CoreGraphics

enum CaptureExecutionError: Error {
    case wrongThread
    case displayUnavailable
    case timeout
}

// The CLI has a synchronous main entry point. Keep its main run loop alive
// while a capture awaits framework callbacks, without moving AppKit/SC setup
// onto a worker thread. Async capture callees must also declare @MainActor.
func runMainActorCapture<Value>(deadline: TimeInterval,
                               mainDisplay: () -> CGDirectDisplayID = CGMainDisplayID,
                               operation: @escaping @MainActor () async throws -> Value) throws -> Value {
    guard Thread.isMainThread else { throw CaptureExecutionError.wrongThread }
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw CaptureExecutionError.timeout }
    // A bare CLI may not have initialized its CoreGraphics display connection.
    // ScreenCaptureKit's window-filter initializer requires that connection and
    // can abort the process if it is absent. A public display query initializes
    // it before any SC work; no pixels or window activation are requested here.
    guard mainDisplay() != 0 else { throw CaptureExecutionError.displayUnavailable }
    var result: Result<Value, Error>?
    let task = Task { @MainActor in
        do { result = .success(try await operation()) }
        catch { result = .failure(error) }
    }
    while result == nil && ProcessInfo.processInfo.systemUptime < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    guard let result, ProcessInfo.processInfo.systemUptime < deadline else {
        task.cancel()
        throw CaptureExecutionError.timeout
    }
    return try result.get()
}
