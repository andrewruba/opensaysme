import AppKit
import ApplicationServices
import Carbon

/// Passive observers preserve Escape delivery to the foreground app and the
/// voice helper, including when a new request starts as an answer is dismissed.
final class FeedbackEscapeMonitor {
    typealias KeyHandler = (UInt16, NSEvent.ModifierFlags, Bool) -> Void
    typealias Installer = (@escaping KeyHandler) -> (() -> Void)?

    private let install: Installer
    private let onDismiss: () -> Void
    private var remove: (() -> Void)?
    private var generation: UInt64 = 0
    var isMonitoring: Bool { remove != nil }

    init(install: @escaping Installer = installFeedbackEscapeObservers, onDismiss: @escaping () -> Void) {
        self.install = install
        self.onDismiss = onDismiss
    }

    deinit { remove?() }

    func show(persistent: Bool) {
        stop()
        guard persistent else { return }
        let currentGeneration = generation
        remove = install { [weak self] keyCode, flags, repeating in
            guard let self, self.generation == currentGeneration, self.isMonitoring,
                  keyCode == UInt16(kVK_Escape), !repeating,
                  flags.intersection([.command, .control, .option, .shift, .function, .help]).isEmpty else { return }
            self.stop()
            self.onDismiss()
        }
    }

    func stop() {
        generation &+= 1
        let previous = remove
        remove = nil
        previous?()
    }
}

private func installFeedbackEscapeObservers(_ handler: @escaping FeedbackEscapeMonitor.KeyHandler) -> (() -> Void)? {
    // Never request permission for decorative feedback. The close button remains
    // available if global keyboard observation is unavailable.
    guard AXIsProcessTrusted() else { return nil }
    let observe: (NSEvent) -> Void = { event in handler(event.keyCode, event.modifierFlags, event.isARepeat) }
    guard let global = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: observe) else { return nil }
    guard let local = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { event in
        observe(event)
        return event
    }) else {
        NSEvent.removeMonitor(global)
        return nil
    }
    return { NSEvent.removeMonitor(global); NSEvent.removeMonitor(local) }
}
