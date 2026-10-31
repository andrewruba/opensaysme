#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo 'The macOS helper must be built on macOS with Xcode Command Line Tools.' >&2
  exit 1
fi

helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$helper_dir/bin/module-cache"
xcrun swiftc -O \
  -target "$(uname -m)-apple-macosx12.0" \
  -module-cache-path "$helper_dir/bin/module-cache" \
  -framework AppKit -framework ApplicationServices -framework AVFoundation -framework Carbon \
  -Xlinker -weak_framework -Xlinker ScreenCaptureKit \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$helper_dir/Info.plist" \
  "$helper_dir/Desktop.swift" "$helper_dir/ProcessIdentity.swift" \
  "$helper_dir/WindowContent.swift" "$helper_dir/WindowCapture.swift" "$helper_dir/CaptureExecution.swift" \
  "$helper_dir/InputProtocol.swift" "$helper_dir/DesktopInput.swift" \
  "$helper_dir/KeyboardProtocol.swift" "$helper_dir/KeyboardInput.swift" \
  "$helper_dir/Voice.swift" "$helper_dir/HotkeyCapture.swift" "$helper_dir/Visual.swift" \
  "$helper_dir/FeedbackSupport.swift" "$helper_dir/FeedbackView.swift" "$helper_dir/Feedback.swift" -o "$helper_dir/bin/opensaysme-desktop"

echo "Built $helper_dir/bin/opensaysme-desktop"
