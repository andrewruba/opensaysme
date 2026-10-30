import AppKit
import Foundation

@main
struct WindowCaptureTests {
    static func main() throws {
        let bounds = CGRect(x: -1200, y: -100, width: 800, height: 600)
        let target = WindowCaptureTarget(processID: 42, title: "Project", bounds: bounds)
        func candidate(id: UInt32 = 7, pid: Int32 = 42, title: String = "Project", rect: CGRect? = nil, layer: Int = 0) -> WindowCaptureCandidate {
            WindowCaptureCandidate(id: id, processID: pid, title: title, bounds: rect ?? bounds, layer: layer)
        }
        func expect(_ expected: WindowCaptureError, _ work: () throws -> Void) {
            do { try work(); preconditionFailure("Expected capture to reject this source") }
            catch let error as WindowCaptureError { precondition(error == expected) }
            catch { preconditionFailure("Unexpected capture error") }
        }
        let original = candidate()
        let sameAXEvidence = WindowCaptureTarget(processID: 42, title: "Project", bounds: bounds)
        expect(.ambiguous) { _ = try uniqueCaptureTarget(target, candidates: [target, sameAXEvidence]) }
        // Distinct AX windows can both map to one SC frame at the rounding boundary.
        let adjacentAX = WindowCaptureTarget(processID: 42, title: "Project", bounds: bounds.offsetBy(dx: 2, dy: 0))
        let between = WindowCaptureTarget(processID: 42, title: "Project", bounds: bounds.offsetBy(dx: 1, dy: 0))
        expect(.ambiguous) { _ = try uniqueCaptureTarget(between, candidates: [target, adjacentAX]) }
        let otherWindow = candidate(id: 8, rect: bounds.offsetBy(dx: 900, dy: 0))
        let matched = try matchCaptureWindow(target, candidates: [candidate(id: 1, pid: 99), otherWindow, original])
        precondition(matched == original && matched.bounds.origin.x == -1200)
        expect(.ambiguous) { _ = try matchCaptureWindow(target, candidates: [original, candidate(id: 9)]) }
        for invalid in [candidate(pid: 99), candidate(title: "Other project"), otherWindow, candidate(layer: 1), candidate(id: 0)] {
            expect(.unavailable) { _ = try matchCaptureWindow(target, candidates: [invalid]) }
        }
        expect(.unavailable) { _ = try matchCaptureWindow(target, candidates: []) }
        expect(.unavailable) { _ = try matchCaptureWindow(target, candidates: Array(repeating: original, count: 4097)) }
        let rounding = candidate(rect: CGRect(x: -1199.5, y: -100, width: 800, height: 600))
        let roundedMatch = try matchCaptureWindow(target, candidates: [rounding])
        precondition(roundedMatch == rounding)

        try revalidateCaptureWindow(target, original: original, candidates: [otherWindow, original])
        for changed in [[], [candidate(id: 9)], [candidate(pid: 99)], [candidate(title: "Changed")],
                        [rounding], [candidate(rect: CGRect(x: -1200, y: -100, width: 801, height: 600))],
                        [original, candidate(id: 9)]] {
            expect(.stale) { try revalidateCaptureWindow(target, original: original, candidates: changed) }
        }
        let retina = windowCaptureSize(bounds: bounds, pixelScale: 2)!
        precondition(retina.width == 1600 && retina.height == 1200)
        let portrait = windowCaptureSize(bounds: CGRect(x: 100, y: -1800, width: 900, height: 1800), pixelScale: 2)!
        precondition(portrait.width == 800 && portrait.height == 1600)
        for invalid in [CGRect.zero, CGRect(x: 0, y: 0, width: 65537, height: 10), CGRect(x: CGFloat.infinity, y: 0, width: 1, height: 1)] {
            precondition(windowCaptureSize(bounds: invalid, pixelScale: 1) == nil)
        }
        for scale: Float in [0, -1, .nan, .infinity, 9] { precondition(windowCaptureSize(bounds: bounds, pixelScale: scale) == nil) }
        print("Window capture checks passed (source matching, ambiguity, stale/replaced windows, negative coordinates, and image scaling).")
    }
}
