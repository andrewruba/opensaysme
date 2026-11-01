import AppKit
import Foundation
import CoreGraphics

@main
struct FeedbackTests {
    static func main() throws {
        checkFeedbackEscape()
        func parse(_ object: [String: Any]) throws -> FeedbackCommand? {
            FeedbackCommand.parse(try JSONSerialization.data(withJSONObject: object))
        }
        let message = "Which agent?\nThe left one or the right one? 日本語 🌱"
        let shown = try parse(["type": "show", "title": "Response", "message": message, "detail": "Speak to reply", "persistent": true, "expression": "happy"])
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
        ] {
            var invalid = object
            if invalid["type"] as? String == "show" { invalid["expression"] = "neutral" }
            let parsed = try parse(invalid); precondition(parsed == nil)
        }
        let valid: [String: Any] = ["type": "show", "title": "Thinking…", "message": "", "detail": "Escape to cancel", "persistent": false]
        let missingExpression = try parse(valid); precondition(missingExpression == nil)
        for expression in FeedbackExpression.allCases {
            var command = valid; command["expression"] = expression.rawValue
            let parsed = try parse(command); precondition(parsed?.expression == expression)
            for phase in 0...8 {
                let rows = FeedbackFaceView.lines(expression, phase: phase)
                precondition(rows.count == 8 && rows.allSatisfy { $0.utf8.allSatisfy { $0 < 128 } && $0.count == 21 })
            }
        }
        let thoughtTrail = (0..<3).map { phase in
            Array(FeedbackFaceView.lines(.thinking, phase: phase)[0]).enumerated().filter { $0.element != " " }.map { $0.offset }
        }
        precondition(thoughtTrail.map { $0.count } == [1, 2, 3])
        precondition(thoughtTrail[0] == Array(thoughtTrail[1].prefix(1)) && thoughtTrail[1] == Array(thoughtTrail[2].prefix(2)))
        precondition(thoughtTrail[0].last! < thoughtTrail[1].last! && thoughtTrail[1].last! < thoughtTrail[2].last!)
        for expression: Any in ["unknown", 1, true] {
            var command = valid; command["expression"] = expression
            let parsed = try parse(command); precondition(parsed == nil)
        }
        let extraExpression = try parse(["type": "hide", "expression": "neutral"]); precondition(extraExpression == nil)
        let escaped = String(repeating: "\u{0000}", count: 32_768)
        let escapedCommand = try parse(["type": "show", "title": "Test", "message": escaped, "detail": "", "persistent": true, "expression": "happy"])
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
                                      detail: "Ctrl+Shift+Space to reply", persistent: true, expression: .happy)
        let wideHeight = view.configure(wrapped, width: 500, maximumHeight: 640)
        precondition(view.messageView.string == paragraph)
        precondition(view.messageView.frame.height > 60 && !view.hasOverflow)
        precondition(!view.faceView.isHidden && view.faceView.frame.maxY <= view.scrollView.frame.minY)
        let dismissButton = view.subviews.compactMap { $0 as? NSButton }.first!
        precondition(!view.faceView.frame.intersects(dismissButton.frame))
        let heading = view.subviews.compactMap { $0 as? NSTextField }.first { $0.stringValue == "Response" }!
        precondition(!view.faceView.frame.intersects(heading.frame))
        precondition(view.scrollView.frame.width == 448)
        let narrowHeight = view.configure(wrapped, width: 320, maximumHeight: 640)
        precondition(narrowHeight > wideHeight)
        precondition(view.faceView.isHidden && !view.faceView.isAnimating)
        let longTitle = FeedbackCommand(type: "show", title: "Working with the selected project conversation",
            message: "An answer below a wrapped heading.", detail: "Escape to cancel", persistent: true, expression: .focused)
        view.configure(longTitle, width: 380, maximumHeight: 520)
        precondition(view.faceView.isHidden && !view.faceView.isAnimating)
        view.configure(longTitle, width: 400, maximumHeight: 520)
        precondition(!view.faceView.isHidden && !view.faceView.frame.intersects(heading.frame))
        precondition(!view.faceView.frame.intersects(dismissButton.frame))
        precondition(view.scrollView.frame.minY > max(heading.frame.maxY, view.faceView.frame.maxY))
        let longText = String(repeating: paragraph + "\n\n", count: 20) + "FINAL PARAGRAPH"
        let long = FeedbackCommand(type: "show", title: "Response", message: longText,
                                   detail: "Ctrl+Shift+Space to reply", persistent: true, expression: .happy)
        let height = view.configure(long, width: 500, maximumHeight: 520)
        precondition(height == 520 && view.hasOverflow && view.messageView.string == longText)
        precondition(view.messageView.frame.height > view.scrollView.contentView.bounds.height)
        view.messageView.scrollRangeToVisible(NSRange(location: longText.utf16.count - 1, length: 1))
        precondition(view.scrollView.contentView.bounds.minY > 0)
        let compact = view.configure(FeedbackCommand(type: "show", title: "Listening…", message: "",
            detail: "Ctrl+Shift+Space to finish · Escape to cancel", persistent: false, expression: .listening), width: 500, maximumHeight: 520)
        precondition(compact < wideHeight && !view.hasOverflow && view.messageView.string.isEmpty)
        precondition(view.scrollView.contentView.bounds.minY == 0)
        view.configure(wrapped, width: 500, maximumHeight: 220)
        precondition(view.faceView.isHidden && !view.faceView.isAnimating)
        view.configure(wrapped, width: 500, maximumHeight: 640)
        var dismissed = false
        view.onDismiss = { dismissed = true }
        view.subviews.compactMap { $0 as? NSButton }.first!.performClick(nil)
        precondition(dismissed)
        precondition(!view.faceView.isAnimating)
        view.clear()
        precondition(view.messageView.string.isEmpty)
        precondition(view.faceView.isHidden && !view.faceView.isAnimating)
        var reduced = false
        let face = FeedbackFaceView(frame: .zero, reduceMotion: { reduced })
        face.configure(.thinking, active: true)
        precondition(face.isAnimating)
        face.advanceAnimation()
        let phase = face.phase
        face.configure(.thinking, active: true)
        precondition(face.phase == phase)
        reduced = true; face.updateMotion()
        precondition(!face.isAnimating && face.phase == 0)
        face.configure(.happy, active: true)
        precondition(!face.isAnimating)
        reduced = false; face.updateMotion()
        precondition(face.isAnimating)
        for _ in 0..<6 { face.advanceAnimation() }
        precondition(!face.isAnimating && !FeedbackFaceView.lines(.happy, phase: face.phase).first!.contains("*"))
        face.configure(.happy, active: true)
        precondition(!face.isAnimating)
        face.configure(.listening, active: true)
        precondition(face.isAnimating)
        face.clear()
        precondition(face.isHidden && !face.isAnimating)

        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--preview-dir" {
            let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let examples: [(String, FeedbackExpression, String, String, Int)] = [
                ("thinking-start", .thinking, "Thinking…", "", 0),
                ("thinking-middle", .thinking, "Thinking…", "", 1),
                ("thinking", .thinking, "Thinking…", "", 2),
                ("focused", .focused, "Preparing input…", "Workspace — Project conversation", 0),
                ("happy", .happy, "Response", "Said hi to your coding agent and opened Chess.com, ready for you to start a game.", 0),
                ("long-answer", .happy, "Response", longText, 0),
            ]
            for (name, expression, title, body, phase) in examples {
                view.clear()
                view.configure(FeedbackCommand(type: "show", title: title, message: body,
                    detail: expression == .happy ? "Ctrl+Shift+Space to reply" : "Escape to cancel",
                    persistent: expression == .happy, expression: expression), width: 500, maximumHeight: 520)
                for _ in 0..<phase { view.faceView.advanceAnimation() }
                view.displayIfNeeded()
                guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { preconditionFailure("Preview bitmap unavailable") }
                view.cacheDisplay(in: view.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { preconditionFailure("Preview PNG unavailable") }
                try png.write(to: directory.appendingPathComponent("\(name).png"))
            }
            view.clear()
        }
        if CommandLine.arguments.contains("--escape-observer-smoke") { smokeFeedbackEscapeObservers() }
        print("Feedback checks passed (strict expressions, ASCII portraits, reduced motion, bounded animation, wrapping, scrolling and cleanup). No panel or desktop input issued.")
    }
}
