import Foundation
import CoreGraphics

@main
struct FeedbackTests {
    static func main() throws {
        func parse(_ object: [String: Any]) throws -> FeedbackCommand? {
            FeedbackCommand.parse(try JSONSerialization.data(withJSONObject: object))
        }
        let message = "Which agent?\nThe left one or the right one? 日本語 🌱"
        let shown = try parse(["type": "show", "title": "OpenSaysMe", "message": message, "detail": "Speak to reply"])
        precondition(shown?.message == message)
        let hidden = try parse(["type": "hide"])
        let shutdown = try parse(["type": "shutdown"])
        precondition(hidden?.type == "hide" && shutdown?.type == "shutdown")
        for object: [String: Any] in [
            ["type": "show", "title": "Missing fields"], ["type": "hide", "message": "private"],
            ["type": "activate"], ["type": "show", "title": "", "message": "", "detail": ""],
            ["type": "show", "title": String(repeating: "x", count: 161), "message": "", "detail": ""],
            ["type": "show", "title": "Test", "message": String(repeating: "🌱", count: 2049), "detail": ""],
            ["type": "show", "title": "Test", "message": "", "detail": String(repeating: "x", count: 513)],
            ["type": "show", "title": "Test", "message": 1, "detail": ""],
        ] { let parsed = try parse(object); precondition(parsed == nil) }
        precondition(FeedbackCommand.parse(Data(repeating: 32, count: 32_769)) == nil)
        precondition(FeedbackCommand.parse(Data("not JSON".utf8)) == nil)
        let paths: [Int32: String] = [1: "/repo/native/bin/helper", 2: "/repo/native/bin/helper", 3: "/other/helper", 4: ""]
        precondition(isDesktopHelperProcess(2, currentPID: 1, path: { paths[$0] }))
        for pid: Int32 in [3, 4, 5] { precondition(!isDesktopHelperProcess(pid, currentPID: 1, path: { paths[$0] })) }
        precondition(!isDesktopHelperProcess(2, currentPID: 5, path: { paths[$0] }))
        precondition(helperExecutablePath(getpid()) != nil)
        for screen in [CGRect(x: 0, y: 24, width: 1440, height: 850), CGRect(x: -1920, y: -1080, width: 1920, height: 1040),
                       CGRect(x: 20, y: 30, width: 180, height: 120)] {
            let frame = feedbackPanelFrame(screen: screen, height: 320)!
            precondition(screen.contains(frame) && frame.width <= 440 && frame.height <= 320)
        }
        precondition(feedbackPanelFrame(screen: .zero, height: 320) == nil)
        precondition(feedbackPanelFrame(screen: CGRect(x: 0, y: 0, width: 100, height: 100), height: .infinity) == nil)
        print("Feedback checks passed (strict commands, bounded Unicode, helper identity exclusion and multi-display placement). No panel or desktop input issued.")
    }
}
