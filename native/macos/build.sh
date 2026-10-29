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
  "$helper_dir/Desktop.swift" "$helper_dir/WindowContent.swift" "$helper_dir/Voice.swift" "$helper_dir/Visual.swift" -o "$helper_dir/bin/opensaysme-desktop"

echo "Built $helper_dir/bin/opensaysme-desktop"
