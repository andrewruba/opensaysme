#!/usr/bin/env python3
"""Bounded X11 virtual-root screenshots, encoded only in memory."""

import argparse
import base64
from datetime import datetime, timezone
import io
import json
import os
from x11 import load_x11


def libraries():
    from PIL import Image, ImageGrab, features
    if not features.check_feature("xcb"):
        raise OSError("Pillow XCB support is unavailable")
    return Image, ImageGrab


def encode(image, image_module):
    image = image.convert("RGB")
    image.thumbnail((1600, 1600), image_module.Resampling.LANCZOS)
    for quality in (80, 65, 45):
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=quality)
        if output.tell() <= 700_000:
            return {"mimeType": "image/jpeg", "width": image.width, "height": image.height,
                    "data": base64.b64encode(output.getvalue()).decode("ascii")}
    raise OSError("Image exceeds the protocol limit")


def capture():
    if os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" or not os.environ.get("DISPLAY"):
        raise OSError("An X11 desktop session is required")
    image_module, grab_module = libraries()
    x11 = load_x11()
    connection = x11.XOpenDisplay(os.environ["DISPLAY"].encode())
    if not connection:
        raise OSError("X11 display unavailable")
    try:
        screen = x11.XDefaultScreen(connection)
        width, height = x11.XDisplayWidth(connection, screen), x11.XDisplayHeight(connection, screen)
        if width <= 0 or height <= 0 or width * height > 64_000_000:
            raise OSError("Desktop image exceeds the capture limit")
    finally:
        x11.XCloseDisplay(connection)
    # Explicit xdisplay disables Pillow's external screenshot-tool fallback.
    # The virtual root and cursor use the same X11 desktop coordinate system.
    captured_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    image = grab_module.grab(xdisplay=os.environ["DISPLAY"])
    if not 0 < image.width * image.height <= 64_000_000:
        raise OSError("Desktop image exceeds the capture limit")
    width, height = image.size
    return {"capturedAt": captured_at,
            "display": {"id": "x11:root", "bounds": {"x": 0, "y": 0, "width": width, "height": height}},
            "image": encode(image, image_module),
            "warnings": ["X11 frames cover the virtual root desktop; physical monitors are not identified separately."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    try:
        if args.probe:
            libraries()
            result = {"available": True}
        else:
            result = capture()
    except (ImportError, OSError, ValueError, AttributeError):
        result = {"available": False} if args.probe else {"error": "screen-capture-unavailable"}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
