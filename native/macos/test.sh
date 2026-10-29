#!/bin/sh
set -eu
helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$helper_dir/bin/module-cache"
xcrun swiftc -O \
  -target "$(uname -m)-apple-macosx12.0" \
  -module-cache-path "$helper_dir/bin/module-cache" \
  -framework AppKit -framework AVFoundation -framework Carbon \
  "$helper_dir/Voice.swift" "$helper_dir/VoiceTests.swift" -o "$helper_dir/bin/voice-tests"
"$helper_dir/bin/voice-tests"
