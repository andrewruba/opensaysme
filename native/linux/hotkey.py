#!/usr/bin/env python3
"""Bounded X11 Ctrl+Shift+Space proof; never records ordinary keystrokes."""

import argparse
import ctypes as c
import ctypes.util
import json
import os
import select
import signal
import time


class KeyEvent(c.Structure):
    _fields_ = [
        ("type", c.c_int), ("serial", c.c_ulong), ("send_event", c.c_int),
        ("display", c.c_void_p), ("window", c.c_ulong), ("root", c.c_ulong),
        ("subwindow", c.c_ulong), ("time", c.c_ulong),
        ("x", c.c_int), ("y", c.c_int), ("x_root", c.c_int), ("y_root", c.c_int),
        ("state", c.c_uint), ("keycode", c.c_uint), ("same_screen", c.c_int),
    ]


class Event(c.Union):
    _fields_ = [("type", c.c_int), ("key", KeyEvent), ("pad", c.c_long * 24)]


class ErrorEvent(c.Structure):
    _fields_ = [
        ("type", c.c_int), ("display", c.c_void_p), ("resourceid", c.c_ulong),
        ("serial", c.c_ulong), ("error_code", c.c_ubyte),
        ("request_code", c.c_ubyte), ("minor_code", c.c_ubyte),
    ]


class ModifierMap(c.Structure):
    _fields_ = [("max_keypermod", c.c_int), ("modifiermap", c.POINTER(c.c_ubyte))]


ErrorHandler = c.CFUNCTYPE(c.c_int, c.c_void_p, c.POINTER(ErrorEvent))


def load_x11():
    library = ctypes.util.find_library("X11")
    if not library:
        raise OSError("libX11 is unavailable")
    x11 = c.CDLL(library)
    declarations = {
        "XOpenDisplay": ([c.c_char_p], c.c_void_p),
        "XCloseDisplay": ([c.c_void_p], c.c_int),
        "XDefaultRootWindow": ([c.c_void_p], c.c_ulong),
        "XConnectionNumber": ([c.c_void_p], c.c_int),
        "XKeysymToKeycode": ([c.c_void_p, c.c_ulong], c.c_ubyte),
        "XGetModifierMapping": ([c.c_void_p], c.POINTER(ModifierMap)),
        "XFreeModifiermap": ([c.POINTER(ModifierMap)], c.c_int),
        "XSetErrorHandler": ([ErrorHandler], c.c_void_p),
        "XGrabKey": ([c.c_void_p, c.c_int, c.c_uint, c.c_ulong, c.c_int, c.c_int, c.c_int], c.c_int),
        "XUngrabKey": ([c.c_void_p, c.c_int, c.c_uint, c.c_ulong], c.c_int),
        "XUngrabKeyboard": ([c.c_void_p, c.c_ulong], c.c_int),
        "XSync": ([c.c_void_p, c.c_int], c.c_int),
        "XPending": ([c.c_void_p], c.c_int),
        "XNextEvent": ([c.c_void_p, c.POINTER(Event)], c.c_int),
    }
    for name, (arguments, result) in declarations.items():
        function = getattr(x11, name)
        function.argtypes = arguments
        function.restype = result
    return x11


def lock_variants(x11, display):
    masks = {2}  # Caps Lock; discover Num Lock and Scroll Lock rather than assume Mod2.
    keycodes = {x11.XKeysymToKeycode(display, symbol) for symbol in (0xFF7F, 0xFF14)} - {0}
    mapping = x11.XGetModifierMapping(display)
    if not mapping:
        raise OSError("Cannot inspect modifier mapping")
    try:
        width = mapping.contents.max_keypermod
        if not 0 <= width <= 256:
            raise OSError("Invalid modifier mapping")
        for modifier in range(8):
            if any(mapping.contents.modifiermap[modifier * width + key] in keycodes for key in range(width)):
                # Never ignore the activation chord's own Shift/Control modifiers.
                if not (1 << modifier) & 5:
                    masks.add(1 << modifier)
    finally:
        x11.XFreeModifiermap(mapping)
    variants = {0}
    for mask in masks:
        variants |= {variant | mask for variant in variants}
    return variants


def result(status, detail):
    return {"capability": "globalHotkey", "status": status, "detail": detail}


def test_hotkey(x11, duration):
    if os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        return result("unavailable", "Native Wayland shortcuts require a portal adapter; XWayland is not used.")
    display = x11.XOpenDisplay(None)
    if not display:
        return result("unavailable", "Cannot open DISPLAY. Run in an authorized, logged-in X11 session.")
    root = x11.XDefaultRootWindow(display)
    keycode = x11.XKeysymToKeycode(display, 0x20)  # XK_space
    grabs = []
    errors = []
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    @ErrorHandler
    def on_error(_display, error):
        errors.append(error.contents.error_code)
        return 0

    old_handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    x11.XSetErrorHandler(on_error)
    try:
        if not keycode:
            return result("unavailable", "The X11 keyboard map has no Space key.")
        variants = lock_variants(x11, display)
        for variant in variants:
            modifiers = 5 | variant  # ControlMask | ShiftMask, with lock variants.
            x11.XGrabKey(display, keycode, modifiers, root, 0, 1, 1)
            grabs.append(modifiers)
        x11.XSync(display, 0)  # Forces asynchronous BadAccess errors to be delivered.
        if errors:
            return result("unavailable", "Ctrl+Shift+Space registration failed; another application may own the shortcut.")
        deadline = time.monotonic() + duration
        event = Event()
        while not stopped and time.monotonic() < deadline:
            while x11.XPending(display):
                x11.XNextEvent(display, c.byref(event))
                if event.type == 2 and event.key.keycode == keycode and not event.key.send_event:
                    return result("passed", "Observed Ctrl+Shift+Space through an X11 passive grab; the grab was released.")
            remaining = deadline - time.monotonic()
            if remaining > 0:
                select.select([x11.XConnectionNumber(display)], [], [], min(remaining, 0.1))
        return result("not-observed", "Shortcut test cancelled." if stopped else "Shortcut registered, but Ctrl+Shift+Space was not observed before the deadline.")
    finally:
        # A passive grab becomes active while the key is down. Release both kinds.
        x11.XUngrabKeyboard(display, 0)
        for modifiers in grabs:
            x11.XUngrabKey(display, keycode, modifiers, root)
        x11.XSync(display, 0)
        x11.XCloseDisplay(display)
        for sig, old_handler in old_handlers.items():
            signal.signal(sig, old_handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--seconds", type=int, choices=range(1, 31), default=10)
    args = parser.parse_args()
    try:
        x11 = load_x11()
        output = {"available": True} if args.probe else test_hotkey(x11, args.seconds)
    except (OSError, AttributeError, ValueError):
        output = {"available": False} if args.probe else result("unavailable", "Python ctypes/libX11 prerequisites or the X11 connection are unavailable.")
    print(json.dumps(output))


if __name__ == "__main__":
    main()
