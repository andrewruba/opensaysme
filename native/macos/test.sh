#!/bin/sh
set -eu
helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$helper_dir/bin/module-cache"
xcrun swiftc -O \
  -target "$(uname -m)-apple-macosx12.0" \
  -module-cache-path "$helper_dir/bin/module-cache" \
  -framework AppKit -framework AVFoundation -framework Carbon \
  -Xlinker -weak_framework -Xlinker ScreenCaptureKit \
  "$helper_dir/Voice.swift" "$helper_dir/Visual.swift" "$helper_dir/VoiceTests.swift" -o "$helper_dir/bin/voice-tests"
"$helper_dir/bin/voice-tests"
xcrun swiftc -O \
  -target "$(uname -m)-apple-macosx12.0" \
  -module-cache-path "$helper_dir/bin/module-cache" \
  -framework ApplicationServices \
  "$helper_dir/WindowContent.swift" "$helper_dir/WindowContentTests.swift" -o "$helper_dir/bin/window-content-tests"
"$helper_dir/bin/window-content-tests"
xcrun swiftc -O \
  -target "$(uname -m)-apple-macosx12.0" \
  -module-cache-path "$helper_dir/bin/module-cache" \
  -framework AppKit -Xlinker -weak_framework -Xlinker ScreenCaptureKit \
  "$helper_dir/Visual.swift" "$helper_dir/WindowCapture.swift" "$helper_dir/WindowCaptureTests.swift" -o "$helper_dir/bin/window-capture-tests"
"$helper_dir/bin/window-capture-tests"
