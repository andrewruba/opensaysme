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
    private var content: FeedbackView?
    private var visibleScreen: NSScreen?
    private var hideAt: TimeInterval?
    private lazy var escapeMonitor = FeedbackEscapeMonitor { [weak self] in self?.hide() }

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
            if input.count > 262_144 { running = false; return }
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
        let content = FeedbackView(frame: .zero)
        content.setAccessibilityHidden(true)
        content.onDismiss = { [weak self] in self?.hide() }
        panel.contentView = content
        self.panel = panel
        self.content = content
    }

    private func show(_ command: FeedbackCommand) {
        if panel == nil { makePanel() }
        guard let panel, let content else { return }
        if !panel.isVisible || visibleScreen.map({ !NSScreen.screens.contains($0) }) != false {
            visibleScreen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main
        }
        guard let screen = visibleScreen,
              let available = feedbackPanelFrame(screen: screen.visibleFrame, height: screen.visibleFrame.height) else { hide(); return }
        let height = content.configure(command, width: available.width, maximumHeight: available.height)
        guard let frame = feedbackPanelFrame(screen: screen.visibleFrame, height: height) else { hide(); return }
        // Only settled answers receive scrolling/dismissal clicks. In-flight
        // feedback remains click-through so it cannot intercept an agent action.
        panel.ignoresMouseEvents = !command.persistent
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
        escapeMonitor.show(persistent: command.persistent)
        // Keep answers available for reading; EOF/shutdown and dismissal still
        // clear them. Transient progress retains a deadline if the parent stalls.
        hideAt = command.persistent ? nil : ProcessInfo.processInfo.systemUptime + 120
    }

    private func hide() {
        escapeMonitor.stop()
        panel?.orderOut(nil)
        content?.clear()
        visibleScreen = nil
        hideAt = nil
    }
}
