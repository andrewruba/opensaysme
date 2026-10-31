import AppKit
import Carbon
import Foundation

func testHotkeyCapture() {
    let cmdShift: CGEventFlags = [.maskCommand, .maskShift]
    let space = UInt32(kVK_Space), a = UInt32(kVK_ANSI_A), b = UInt32(kVK_ANSI_B)
    precondition(ActivationHotkey.shortcut(keyCode: space, flags: cmdShift) == "Cmd+Shift+Space")
    precondition(ActivationHotkey.shortcut(keyCode: a, flags: [.maskControl, .maskAlphaShift]) == "Ctrl+A")
    precondition(ActivationHotkey.shortcut(keyCode: UInt32(kVK_F2), flags: [.maskAlternate, .maskSecondaryFn]) == "Alt+F2")
    precondition(ActivationHotkey.shortcut(keyCode: a, flags: [.maskCommand, .maskSecondaryFn]) == nil)
    precondition(ActivationHotkey.shortcut(keyCode: space, flags: .maskShift) == nil)
    precondition(ActivationHotkey.shortcut(keyCode: UInt32(kVK_ANSI_C), flags: [.maskControl, .maskCommand]) == nil)
    precondition(ActivationHotkey.shortcut(keyCode: UInt32(kVK_Return), flags: .maskCommand) == nil)

    var state = HotkeyCaptureState()
    precondition(!state.handle(.keyUp, keyCode: UInt32(kVK_Return), flags: []))
    precondition(!state.handle(.flagsChanged, keyCode: UInt32(kVK_Command), flags: cmdShift))
    precondition(state.handle(.keyDown, keyCode: space, flags: cmdShift))
    precondition(state.handle(.keyDown, keyCode: space, flags: cmdShift, repeating: true))
    precondition(state.result == nil)
    precondition(state.handle(.keyUp, keyCode: space, flags: cmdShift))
    precondition(state.result == nil)
    precondition(!state.handle(.flagsChanged, keyCode: UInt32(kVK_Shift), flags: []))
    precondition(state.result == .captured("Cmd+Shift+Space"))
    precondition(!state.handle(.keyDown, keyCode: a, flags: []))
    precondition(state.result?.payload == ["status": "captured", "shortcut": "Cmd+Shift+Space"])

    for key in [UInt32(kVK_Escape), UInt32(kVK_ANSI_C)] {
        var cancelling = HotkeyCaptureState()
        precondition(cancelling.handle(.keyDown, keyCode: key, flags: [.maskControl, .maskCommand]))
        precondition(cancelling.result == nil)
        precondition(cancelling.handle(.keyUp, keyCode: key, flags: []))
        precondition(cancelling.result == .cancelled)
    }

    var retry = HotkeyCaptureState()
    precondition(retry.handle(.keyDown, keyCode: a, flags: []))
    precondition(retry.handle(.keyUp, keyCode: a, flags: []))
    precondition(retry.result == nil)
    precondition(retry.handle(.keyDown, keyCode: a, flags: .maskAlternate, repeating: true))
    precondition(retry.handle(.keyUp, keyCode: a, flags: []))
    precondition(retry.result == nil)
    precondition(retry.handle(.keyDown, keyCode: a, flags: .maskCommand))
    precondition(retry.handle(.keyDown, keyCode: b, flags: .maskCommand))
    precondition(retry.handle(.keyUp, keyCode: a, flags: .maskCommand))
    precondition(retry.handle(.keyUp, keyCode: b, flags: []))
    precondition(retry.result == nil)
    precondition(retry.handle(.keyDown, keyCode: space, flags: .maskAlternate))
    precondition(!retry.handle(.flagsChanged, keyCode: UInt32(kVK_Option), flags: []))
    precondition(retry.result == nil)
    precondition(retry.handle(.keyUp, keyCode: space, flags: []))
    precondition(retry.result == .captured("Alt+Space"))

    var sequential = HotkeyCaptureState()
    precondition(sequential.handle(.keyDown, keyCode: a, flags: .maskCommand))
    precondition(sequential.handle(.keyUp, keyCode: a, flags: .maskCommand))
    precondition(sequential.handle(.keyDown, keyCode: b, flags: .maskCommand))
    precondition(sequential.handle(.keyUp, keyCode: b, flags: []))
    precondition(sequential.result == nil)

    var function = HotkeyCaptureState()
    precondition(function.handle(.keyDown, keyCode: UInt32(kVK_F2), flags: [.maskAlternate, .maskSecondaryFn]))
    precondition(!function.handle(.flagsChanged, keyCode: UInt32(kVK_Option), flags: []))
    precondition(function.handle(.keyUp, keyCode: UInt32(kVK_F2), flags: .maskSecondaryFn))
    precondition(function.result == .captured("Alt+F2"))

    for reason in [HotkeyCaptureFailure.permission, .unavailable, .focusChanged, .timeout] {
        var stopped = HotkeyCaptureState()
        stopped.stop(.unavailable(reason))
        precondition(!stopped.handle(.keyDown, keyCode: space, flags: cmdShift))
        precondition(stopped.result == .unavailable(reason))
        precondition(stopped.result?.payload == ["status": "unavailable", "reason": reason.rawValue])
    }
    let parents: [pid_t: pid_t] = [30: 20, 20: 10, 10: 1]
    precondition(hotkeyCaptureOwnerIsAncestor(10, parent: 30, parentOf: { parents[$0] }))
    precondition(!hotkeyCaptureOwnerIsAncestor(11, parent: 30, parentOf: { parents[$0] }))
    precondition(!hotkeyCaptureOwnerIsAncestor(1, parent: 30, parentOf: { parents[$0] }))
    precondition(!hotkeyCaptureOwnerIsAncestor(10, parent: 30, parentOf: { _ in 30 }))
    precondition(!hotkeyCaptureOwnerIsAncestor(100, parent: 2, parentOf: { $0 + 1 }))
    print("Hotkey capture checks passed (physical modifier mapping, release, repeats, cancellation, focus ownership and bounded failures). No event tap installed.")
}
