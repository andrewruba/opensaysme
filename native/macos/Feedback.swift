import AppKit
import Foundation

private final class FeedbackPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class FeedbackSession {
    private var running = true
    private var input = Data()
    private var panel: FeedbackPanel?
    private var titleLabel: NSTextField?
    private var messageLabel: NSTextField?
    private var detailLabel: NSTextField?
    private var visibleScreen: NSScreen?
    private var hideAt: TimeInterval?

    func run() {
        let application = NSApplication.shared
        guard application.setActivationPolicy(.accessory), !NSScreen.screens.isEmpty else { return }
        application.finishLaunching()
        signal(SIGPIPE, SIG_IGN)
        let signals = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.running = false }
            source.resume()
            return source
        }
        defer {
            hide()
            panel?.close()
            signals.forEach { $0.cancel() }
            input.removeAll()
        }
        _ = fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK)
        FileHandle.standardOutput.write(Data("{\"type\":\"ready\"}\n".utf8))
        while running {
            readCommands()
            if let deadline = hideAt, ProcessInfo.processInfo.systemUptime >= deadline { hide() }
            // A separate AppKit process keeps panel lifecycle independent of the
            // voice helper's Carbon hotkeys and microphone loop.
            if let event = application.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02),
                                                  inMode: .default, dequeue: true) {
                application.sendEvent(event)
            }
            application.updateWindows()
            RunLoop.current.run(until: Date().addingTimeInterval(0.001))
        }
    }

    private func readCommands() {
        var bytes = [UInt8](repeating: 0, count: 8192)
        // Bound work per UI iteration as well as buffered input.
        for _ in 0..<8 {
            let count = read(STDIN_FILENO, &bytes, bytes.count)
            if count == 0 { running = false; return }
            if count < 0 {
                if errno != EAGAIN && errno != EINTR { running = false }
                return
            }
            input.append(contentsOf: bytes.prefix(count))
            while let end = input.firstIndex(of: 10) {
                let line = input.prefix(upTo: end)
                guard let command = FeedbackCommand.parse(Data(line)) else { running = false; return }
                input.removeSubrange(...end)
                switch command.type {
                case "show": show(command)
                case "hide": hide()
                default: running = false; return
                }
            }
            if input.count > 32_768 { running = false; return }
        }
    }

    private func makePanel() {
        let panel = FeedbackPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                                  backing: .buffered, defer: false)
        panel.title = "OpenSaysMe Feedback"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = true
        panel.setAccessibilityElement(false)
        panel.setAccessibilityHidden(true)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.sharingType = .none
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        let background = NSVisualEffectView()
        background.material = .hudWindow
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 14
        background.layer?.masksToBounds = true
        background.setAccessibilityHidden(true)
        panel.contentView = background
        let title = NSTextField(labelWithString: "")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        let message = NSTextField(wrappingLabelWithString: "")
        message.font = .systemFont(ofSize: 14)
        message.maximumNumberOfLines = 12
        message.lineBreakMode = .byTruncatingTail
        let detail = NSTextField(wrappingLabelWithString: "")
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.maximumNumberOfLines = 3
        detail.lineBreakMode = .byTruncatingTail
        let stack = NSStackView(views: [title, message, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: background.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: background.bottomAnchor, constant: -14),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        self.panel = panel
        titleLabel = title; messageLabel = message; detailLabel = detail
    }

    private func show(_ command: FeedbackCommand) {
        if panel == nil { makePanel() }
        guard let panel else { return }
        if !panel.isVisible || visibleScreen.map({ !NSScreen.screens.contains($0) }) != false {
            visibleScreen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main
        }
        guard let screen = visibleScreen else { hide(); return }
        titleLabel?.stringValue = command.title
        messageLabel?.stringValue = command.message
        messageLabel?.isHidden = command.message.isEmpty
        detailLabel?.stringValue = command.detail
        detailLabel?.isHidden = command.detail.isEmpty
        let textWidth = min(440, screen.visibleFrame.width - 32) - 32
        let messageHeight = command.message.isEmpty ? 0 : min(216, (command.message as NSString).boundingRect(
            with: NSSize(width: max(1, textWidth), height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: NSFont.systemFont(ofSize: 14)]).height + 8)
        let detailHeight: CGFloat = command.detail.isEmpty ? 0 : 48
        guard let frame = feedbackPanelFrame(screen: screen.visibleFrame, height: 48 + messageHeight + detailHeight) else { hide(); return }
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
        // This also bounds retention if the parent stops sending updates without
        // exiting. The parent normally dismisses final responses sooner.
        hideAt = ProcessInfo.processInfo.systemUptime + 120
    }

    private func hide() {
        panel?.orderOut(nil)
        titleLabel?.stringValue = ""
        messageLabel?.stringValue = ""
        detailLabel?.stringValue = ""
        visibleScreen = nil
        hideAt = nil
    }
}
