import AppKit
import Carbon

func checkFeedbackEscape() {
    var handlers: [FeedbackEscapeMonitor.KeyHandler] = []
    var removed = 0
    var dismissed = 0
    var monitor: FeedbackEscapeMonitor? = FeedbackEscapeMonitor(install: { handler in
        handlers.append(handler)
        return { removed += 1 }
    }, onDismiss: { dismissed += 1 })
    let escape = UInt16(kVK_Escape)

    monitor!.show(persistent: false)
    precondition(handlers.isEmpty && !monitor!.isMonitoring)
    monitor!.show(persistent: true)
    precondition(handlers.count == 1 && monitor!.isMonitoring)
    handlers[0](UInt16(kVK_ANSI_A), [], false)
    handlers[0](escape, [], true)
    for modifier: NSEvent.ModifierFlags in [.shift, .control, .option, .command, .function, .help] {
        handlers[0](escape, modifier.union(.capsLock), false)
    }
    precondition(dismissed == 0 && removed == 0 && monitor!.isMonitoring)
    handlers[0](escape, .capsLock, false)
    precondition(dismissed == 1 && removed == 1 && !monitor!.isMonitoring)
    handlers[0](escape, [], false)
    precondition(dismissed == 1)

    // A callback already queued by an older answer must not close a new answer.
    monitor!.show(persistent: true)
    monitor!.show(persistent: true)
    precondition(handlers.count == 3 && removed == 2)
    handlers[1](escape, [], false)
    precondition(dismissed == 1 && monitor!.isMonitoring)
    handlers[2](escape, [], false)
    precondition(dismissed == 2 && removed == 3)

    // Starting transient progress and each hide/shutdown cleanup are idempotent.
    monitor!.show(persistent: true)
    monitor!.show(persistent: false)
    monitor!.stop()
    handlers[3](escape, [], false)
    precondition(dismissed == 2 && removed == 4 && !monitor!.isMonitoring)
    monitor!.show(persistent: true)
    monitor!.stop()
    handlers[4](escape, [], false)
    precondition(dismissed == 2 && removed == 5 && !monitor!.isMonitoring)
    monitor!.show(persistent: true)
    monitor = nil
    handlers[5](escape, [], false)
    precondition(dismissed == 2 && removed == 6)

    var unavailableHandler: FeedbackEscapeMonitor.KeyHandler?
    let unavailable = FeedbackEscapeMonitor(install: { handler in unavailableHandler = handler; return nil },
                                            onDismiss: { preconditionFailure("Unavailable observers cannot dismiss") })
    unavailable.show(persistent: true)
    precondition(!unavailable.isMonitoring)
    unavailableHandler?(escape, [], false)
    unavailable.stop()
    print("Feedback Escape checks passed (plain key, modifiers, repeats, stale callbacks, observer failures and cleanup). No keyboard observer installed or input issued.")
}

/// Optional integration check: send only to this test application's event
/// dispatch. Never post a CGEvent or send a keyboard event to the desktop.
func smokeFeedbackEscapeObservers() {
    let application = NSApplication.shared
    let foregroundBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var dismissed = false
    let monitor = FeedbackEscapeMonitor { dismissed = true }
    monitor.show(persistent: true)
    guard monitor.isMonitoring else {
        print("Feedback Escape observer smoke unavailable: existing permission or observer registration unavailable. No permission requested.")
        return
    }
    guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
        characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: UInt16(kVK_Escape)) else {
        preconditionFailure("Local Escape event unavailable")
    }
    application.sendEvent(event)
    precondition(dismissed && !monitor.isMonitoring)
    let foregroundAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier
    precondition(foregroundBefore == foregroundAfter)
    print("Feedback Escape observer smoke passed (global/local registered, local Escape dismissed, foreground unchanged). No system keyboard input issued.")
}
