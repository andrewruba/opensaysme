#!/usr/bin/env python3
"""Bounded X11 Ctrl+Shift+Space proof; never records ordinary keystrokes."""

import argparse
import json
import select
import signal
import time
from x11 import Desktop, load_x11


def result(status, detail):
    return {"capability": "globalHotkey", "status": status, "detail": detail}


def test_hotkey(duration):
    desktop = Desktop()
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    old_handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        desktop.grab(desktop.space, 5)
        deadline = time.monotonic() + duration
        while not stopped and time.monotonic() < deadline:
            if "toggle" in desktop.events():
                return result("passed", "Observed Ctrl+Shift+Space through an X11 passive grab; the grab was released.")
            select.select([desktop.fd], [], [], min(max(deadline - time.monotonic(), 0), 0.1))
        return result("not-observed", "Shortcut test cancelled." if stopped else "Shortcut registered, but Ctrl+Shift+Space was not observed before the deadline.")
    finally:
        desktop.close()
        for sig, old_handler in old_handlers.items():
            signal.signal(sig, old_handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--seconds", type=int, choices=range(1, 31), default=10)
    args = parser.parse_args()
    try:
        if args.probe:
            load_x11()
            output = {"available": True}
        else:
            output = test_hotkey(args.seconds)
    except (OSError, AttributeError, ValueError):
        output = {"available": False} if args.probe else result("unavailable", "Python ctypes/libX11 prerequisites, X11 authorization, or Ctrl+Shift+Space registration are unavailable.")
    print(json.dumps(output))


if __name__ == "__main__":
    main()
