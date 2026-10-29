"""Small Xlib surface shared by desktop probes and the voice event loop."""

import ctypes as c
import ctypes.util
import os


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
    pointer = c.POINTER
    declarations = {
        "XOpenDisplay": ([c.c_char_p], c.c_void_p),
        "XCloseDisplay": ([c.c_void_p], c.c_int),
        "XDefaultRootWindow": ([c.c_void_p], c.c_ulong),
        "XConnectionNumber": ([c.c_void_p], c.c_int),
        "XKeysymToKeycode": ([c.c_void_p, c.c_ulong], c.c_ubyte),
        "XGetModifierMapping": ([c.c_void_p], pointer(ModifierMap)),
        "XFreeModifiermap": ([pointer(ModifierMap)], c.c_int),
        "XSetErrorHandler": ([ErrorHandler], c.c_void_p),
        "XGrabKey": ([c.c_void_p, c.c_int, c.c_uint, c.c_ulong, c.c_int, c.c_int, c.c_int], c.c_int),
        "XUngrabKey": ([c.c_void_p, c.c_int, c.c_uint, c.c_ulong], c.c_int),
        "XUngrabKeyboard": ([c.c_void_p, c.c_ulong], c.c_int),
        "XSync": ([c.c_void_p, c.c_int], c.c_int),
        "XPending": ([c.c_void_p], c.c_int),
        "XNextEvent": ([c.c_void_p, pointer(Event)], c.c_int),
        "XQueryKeymap": ([c.c_void_p, c.c_char_p], c.c_int),
        "XkbSetDetectableAutoRepeat": ([c.c_void_p, c.c_int, pointer(c.c_int)], c.c_int),
        "XQueryPointer": ([c.c_void_p, c.c_ulong, pointer(c.c_ulong), pointer(c.c_ulong), pointer(c.c_int), pointer(c.c_int), pointer(c.c_int), pointer(c.c_int), pointer(c.c_uint)], c.c_int),
        "XInternAtom": ([c.c_void_p, c.c_char_p, c.c_int], c.c_ulong),
        "XGetWindowProperty": ([c.c_void_p, c.c_ulong, c.c_ulong, c.c_long, c.c_long, c.c_int, c.c_ulong, pointer(c.c_ulong), pointer(c.c_int), pointer(c.c_ulong), pointer(c.c_ulong), pointer(pointer(c.c_ubyte))], c.c_int),
        "XFree": ([c.c_void_p], c.c_int),
        "XBell": ([c.c_void_p, c.c_int], c.c_int),
    }
    for name, (arguments, result) in declarations.items():
        function = getattr(x11, name)
        function.argtypes = arguments
        function.restype = result
    return x11


def lock_variants(x11, display):
    masks = {2}
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
                if not (1 << modifier) & 5:
                    masks.add(1 << modifier)
    finally:
        x11.XFreeModifiermap(mapping)
    variants = {0}
    for mask in masks:
        variants |= {variant | mask for variant in variants}
    return variants


class Desktop:
    def __init__(self, x11=None):
        if os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
            raise OSError("Native Wayland is unsupported")
        self.x11 = x11 or load_x11()
        self.display = self.x11.XOpenDisplay(None)
        if not self.display:
            raise OSError("Cannot open X11 display")
        self.root = self.x11.XDefaultRootWindow(self.display)
        self.grabs = set()
        self.pressed = set()
        self.errors = []

        @ErrorHandler
        def on_error(_display, error):
            self.errors.append(error.contents.error_code)
            return 0

        self.error_handler = on_error
        self.x11.XSetErrorHandler(on_error)
        self.variants = lock_variants(self.x11, self.display)
        self.space = self.x11.XKeysymToKeycode(self.display, 0x20)
        self.escape = self.x11.XKeysymToKeycode(self.display, 0xFF1B)
        supported = c.c_int()
        self.x11.XkbSetDetectableAutoRepeat(self.display, 1, c.byref(supported))
        self.detectable_repeat = bool(supported.value)

    @property
    def fd(self):
        return self.x11.XConnectionNumber(self.display)

    def grab(self, keycode, modifiers):
        if not keycode:
            raise OSError("Key unavailable")
        self.errors.clear()
        for variant in self.variants:
            grab = (keycode, modifiers | variant)
            self.x11.XGrabKey(self.display, *grab, self.root, 0, 1, 1)
            self.grabs.add(grab)
        self.x11.XSync(self.display, 0)
        if self.errors:
            self.ungrab(keycode)
            raise OSError("Shortcut registration failed")

    def ungrab(self, keycode):
        self.x11.XUngrabKeyboard(self.display, 0)
        for grab in list(self.grabs):
            if grab[0] == keycode:
                self.x11.XUngrabKey(self.display, *grab, self.root)
                self.grabs.remove(grab)
        self.pressed.discard(keycode)
        self.x11.XSync(self.display, 0)

    def events(self):
        event = Event()
        while self.x11.XPending(self.display):
            self.x11.XNextEvent(self.display, c.byref(event))
            code = event.key.keycode
            if event.type == 3:
                keys = c.create_string_buffer(32)
                self.x11.XQueryKeymap(self.display, keys)
                if self.detectable_repeat or not keys.raw[code // 8] & (1 << (code % 8)):
                    self.pressed.discard(code)
            elif event.type == 2 and not event.key.send_event and code not in self.pressed:
                self.pressed.add(code)
                if code == self.space and event.key.state & 5 == 5:
                    yield "toggle"
                elif code == self.escape:
                    yield "cancel"

    def has_property(self, window, name):
        atom = self.x11.XInternAtom(self.display, name, 1)
        if not atom:
            return False
        actual, form, items, after = c.c_ulong(), c.c_int(), c.c_ulong(), c.c_ulong()
        value = c.POINTER(c.c_ubyte)()
        self.x11.XGetWindowProperty(self.display, window, atom, 0, 0, 0, 0, c.byref(actual), c.byref(form), c.byref(items), c.byref(after), c.byref(value))
        if value:
            self.x11.XFree(value)
        return bool(actual.value)

    def pointer(self):
        window = self.root
        owner = None
        fallback = None
        coordinates = None
        self.errors.clear()
        for _ in range(64):
            root, child, rx, ry, x, y, mask = c.c_ulong(), c.c_ulong(), c.c_int(), c.c_int(), c.c_int(), c.c_int(), c.c_uint()
            if not self.x11.XQueryPointer(self.display, window, c.byref(root), c.byref(child), c.byref(rx), c.byref(ry), c.byref(x), c.byref(y), c.byref(mask)):
                raise OSError("Cannot query pointer")
            if coordinates is None:
                coordinates = (rx.value, ry.value)
            elif coordinates != (rx.value, ry.value):
                raise OSError("Pointer moved during capture")
            if window != self.root:
                if self.has_property(window, b"WM_STATE"):
                    owner = window
                    break
                if self.has_property(window, b"WM_CLASS"):
                    fallback = window
            if not child.value:
                break
            window = child.value
        self.x11.XSync(self.display, 0)
        if self.errors:
            raise OSError("Window changed during capture")
        return {"x": coordinates[0], "y": coordinates[1], "windowId": str(owner or fallback) if owner or fallback else None}

    def bell(self):
        self.x11.XBell(self.display, 0)
        self.x11.XSync(self.display, 0)

    def close(self):
        if self.display:
            self.x11.XUngrabKeyboard(self.display, 0)
            for keycode in {grab[0] for grab in self.grabs}:
                self.ungrab(keycode)
            self.x11.XCloseDisplay(self.display)
            self.display = None
