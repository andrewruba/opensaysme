import Foundation
import Darwin

@main
struct CaptureExecutionTests {
    private enum SyntheticError: Error { case failed }

    static func main() throws {
        precondition(pthread_main_np() != 0)
        let mainThread = pthread_self()
        var constructionCount = 0
        var displayQueries = 0
        let value = try runMainActorCapture(deadline: ProcessInfo.processInfo.systemUptime + 1, mainDisplay: {
            precondition(pthread_main_np() != 0 && constructionCount == 0)
            displayQueries += 1
            return 1
        }) {
            precondition(displayQueries == 1, "Capture started before CoreGraphics display initialization")
            precondition(pthread_main_np() != 0 && pthread_equal(pthread_self(), mainThread) != 0)
            // ScreenCaptureKit returns asynchronously. Force a worker-thread
            // suspension before the work that would construct its filter.
            let workerWasMain = await Task.detached { pthread_main_np() != 0 }.value
            precondition(!workerWasMain)
            precondition(pthread_main_np() != 0 && pthread_equal(pthread_self(), mainThread) != 0,
                         "Capture setup resumed off the physical main thread")
            constructionCount += 1
            await Task.yield()
            precondition(pthread_main_np() != 0 && pthread_equal(pthread_self(), mainThread) != 0,
                         "Capture completion resumed off the physical main thread")
            return "synthetic image"
        }
        precondition(value == "synthetic image" && constructionCount == 1 && displayQueries == 1)

        do {
            let _: Void = try runMainActorCapture(deadline: ProcessInfo.processInfo.systemUptime + 1, mainDisplay: { 0 }) {
                preconditionFailure("Capture started without an available display")
            }
            preconditionFailure("Missing display was accepted")
        } catch CaptureExecutionError.displayUnavailable { }

        do {
            let _: Void = try runMainActorCapture(deadline: ProcessInfo.processInfo.systemUptime + 1, mainDisplay: { 1 }) {
                throw SyntheticError.failed
            }
            preconditionFailure("Capture failure was swallowed")
        } catch SyntheticError.failed { }

        var cancelled = false
        do {
            let _: Void = try runMainActorCapture(deadline: ProcessInfo.processInfo.systemUptime + 0.03, mainDisplay: { 1 }) {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) }
                catch { cancelled = Task.isCancelled; throw error }
            }
            preconditionFailure("Capture deadline was ignored")
        } catch CaptureExecutionError.timeout { }
        let cancellationDeadline = ProcessInfo.processInfo.systemUptime + 1
        while !cancelled && ProcessInfo.processInfo.systemUptime < cancellationDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        precondition(cancelled, "Timed-out capture task was not cancelled")

        let rejectedWorker = try runMainActorCapture(deadline: ProcessInfo.processInfo.systemUptime + 1, mainDisplay: { 1 }) {
            await Task.detached {
                do {
                    let _: Bool = try runMainActorCapture(deadline: ProcessInfo.processInfo.systemUptime + 1, mainDisplay: {
                        preconditionFailure("A worker must not initialize the display connection")
                    }) { true }
                    return false
                } catch CaptureExecutionError.wrongThread { return true }
                catch { return false }
            }.value
        }
        precondition(rejectedWorker, "A worker must not pump the main capture run loop")
        print("Capture execution checks passed (display initialization before capture, missing displays, physical main thread after async suspension, failures and cancellation). No desktop access used.")
    }
}
