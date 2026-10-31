import Darwin
import CoreGraphics
import Foundation

struct FeedbackCommand {
    let type: String
    let title: String
    let message: String
    let detail: String

    static func parse(_ data: Data) -> FeedbackCommand? {
        guard data.count <= 32_768,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        if ["hide", "shutdown"].contains(type), Set(object.keys) == ["type"] {
            return FeedbackCommand(type: type, title: "", message: "", detail: "")
        }
        guard type == "show", Set(object.keys) == ["type", "title", "message", "detail"],
              let title = object["title"] as? String, !title.isEmpty, title.utf16.count <= 160,
              let message = object["message"] as? String, message.utf16.count <= 4096,
              let detail = object["detail"] as? String, detail.utf16.count <= 512 else { return nil }
        return FeedbackCommand(type: type, title: title, message: message, detail: detail)
    }
}

// Match the kernel-reported executable path, never a user-controlled window title
// or application label. The helper's feedback windows must not become context or
// action targets, including when another helper invocation performs the capture.
func helperExecutablePath(_ pid: Int32) -> String? {
    guard pid > 0 else { return nil }
    var buffer = [CChar](repeating: 0, count: 4096)
    let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard count > 0, count < buffer.count else { return nil }
    return String(cString: buffer)
}

func isDesktopHelperProcess(_ pid: Int32, currentPID: Int32 = getpid(),
                            path: (Int32) -> String? = helperExecutablePath) -> Bool {
    guard let ownPath = path(currentPID), !ownPath.isEmpty, let candidate = path(pid) else { return false }
    return ownPath == candidate
}

// Cocoa screen coordinates include negative origins; stay inside the chosen
// screen's visible frame even on a small display or with a Dock/menu bar inset.
func feedbackPanelFrame(screen: CGRect, height: CGFloat) -> CGRect? {
    guard [screen.minX, screen.minY, screen.width, screen.height, height].allSatisfy({ $0.isFinite }),
          screen.width > 0, screen.height > 0, height > 0 else { return nil }
    let margin = min(16, min(screen.width, screen.height) / 8)
    let width = min(440, screen.width - margin * 2)
    let boundedHeight = min(height, screen.height - margin * 2)
    return CGRect(x: screen.maxX - width - margin, y: screen.maxY - boundedHeight - margin,
                  width: width, height: boundedHeight)
}
