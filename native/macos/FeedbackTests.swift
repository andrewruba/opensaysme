import AppKit
import Foundation
import CoreGraphics

@main
struct FeedbackTests {
    static func main() throws {
        func parse(_ object: [String: Any]) throws -> FeedbackCommand? {
            FeedbackCommand.parse(try JSONSerialization.data(withJSONObject: object))
        }
        let message = "Which agent?\nThe left one or the right one? 日本語 🌱"
        let shown = try parse(["type": "show", "title": "Response", "message": message, "detail": "Speak to reply", "persistent": true])
        precondition(shown?.message == message && shown?.persistent == true)
        let hidden = try parse(["type": "hide"])
        let shutdown = try parse(["type": "shutdown"])
        precondition(hidden?.type == "hide" && shutdown?.type == "shutdown")
        for object: [String: Any] in [
            ["type": "show", "title": "Missing fields"], ["type": "hide", "message": "private"],
            ["type": "activate"], ["type": "show", "title": "", "message": "", "detail": "", "persistent": false],
            ["type": "show", "title": String(repeating: "x", count: 161), "message": "", "detail": "", "persistent": false],
            ["type": "show", "title": "Test", "message": String(repeating: "🌱", count: 16_385), "detail": "", "persistent": true],
            ["type": "show", "title": "Test", "message": "", "detail": String(repeating: "x", count: 513), "persistent": false],
            ["type": "show", "title": "Test", "message": 1, "detail": "", "persistent": false],
            ["type": "show", "title": "Test", "message": "", "detail": ""],
            ["type": "show", "title": "Test", "message": "", "detail": "", "persistent": 1],
            ["type": "show", "title": "Test", "message": "", "detail": "", "persistent": "true"],
        ] { let parsed = try parse(object); precondition(parsed == nil) }
        let escaped = String(repeating: "\u{0000}", count: 32_768)
        let escapedCommand = try parse(["type": "show", "title": "Test", "message": escaped, "detail": "", "persistent": true])
        precondition(escapedCommand?.message == escaped)
        precondition(FeedbackCommand.parse(Data(repeating: 32, count: 262_145)) == nil)
        precondition(FeedbackCommand.parse(Data("not JSON".utf8)) == nil)
        let paths: [Int32: String] = [1: "/repo/native/bin/helper", 2: "/repo/native/bin/helper", 3: "/other/helper", 4: ""]
        precondition(isDesktopHelperProcess(2, currentPID: 1, path: { paths[$0] }))
        for pid: Int32 in [3, 4, 5] { precondition(!isDesktopHelperProcess(pid, currentPID: 1, path: { paths[$0] })) }
        precondition(!isDesktopHelperProcess(2, currentPID: 5, path: { paths[$0] }))
        precondition(helperExecutablePath(getpid()) != nil)
        for screen in [CGRect(x: 0, y: 24, width: 1440, height: 850), CGRect(x: -1920, y: -1080, width: 1920, height: 1040),
                       CGRect(x: 20, y: 30, width: 180, height: 120)] {
            let frame = feedbackPanelFrame(screen: screen, height: 320)!
            precondition(screen.contains(frame) && frame.width <= 500 && frame.height <= 320)
        }
        precondition(feedbackPanelFrame(screen: .zero, height: 320) == nil)
        precondition(feedbackPanelFrame(screen: CGRect(x: 0, y: 0, width: 100, height: 100), height: .infinity) == nil)
        _ = NSApplication.shared
        let view = FeedbackView(frame: .zero)
        let paragraph = String(repeating: "A longer answer must wrap naturally without losing any words. ", count: 12)
        let wrapped = FeedbackCommand(type: "show", title: "Response", message: paragraph,
                                      detail: "Ctrl+Shift+Space to reply", persistent: true)
        let wideHeight = view.configure(wrapped, width: 500, maximumHeight: 640)
        precondition(view.messageView.string == paragraph)
        precondition(view.messageView.frame.height > 60 && !view.hasOverflow)
        let narrowHeight = view.configure(wrapped, width: 320, maximumHeight: 640)
        precondition(narrowHeight > wideHeight)
        let longText = String(repeating: paragraph + "\n\n", count: 20) + "FINAL PARAGRAPH"
        let long = FeedbackCommand(type: "show", title: "Response", message: longText,
                                   detail: "Ctrl+Shift+Space to reply", persistent: true)
        let height = view.configure(long, width: 500, maximumHeight: 520)
        precondition(height == 520 && view.hasOverflow && view.messageView.string == longText)
        precondition(view.messageView.frame.height > view.scrollView.contentView.bounds.height)
        view.messageView.scrollRangeToVisible(NSRange(location: longText.utf16.count - 1, length: 1))
        precondition(view.scrollView.contentView.bounds.minY > 0)
        let compact = view.configure(FeedbackCommand(type: "show", title: "Listening…", message: "",
            detail: "Ctrl+Shift+Space to finish · Escape to cancel", persistent: false), width: 500, maximumHeight: 520)
        precondition(compact < wideHeight && !view.hasOverflow && view.messageView.string.isEmpty)
        precondition(view.scrollView.contentView.bounds.minY == 0)
        view.configure(wrapped, width: 500, maximumHeight: 640)
        var dismissed = false
        view.onDismiss = { dismissed = true }
        view.subviews.compactMap { $0 as? NSButton }.first!.performClick(nil)
        precondition(dismissed)
        view.clear()
        precondition(view.messageView.string.isEmpty)
        print("Feedback checks passed (strict commands, Unicode, helper exclusion, screen bounds, wrapping, scrolling and cleanup). No panel or desktop input issued.")
    }
}
