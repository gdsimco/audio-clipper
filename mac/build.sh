#!/bin/bash
# Builds the native macOS app (no Electron) into dist/mac/Audio Clipper.app.
#   mac/build.sh            release build, universal (Apple silicon + Intel)
#   mac/build.sh --debug    faster, current architecture only, Web Inspector on
#   mac/build.sh --zip      also make dist/mac/Audio Clipper-<version>.zip for sharing
# Needs only the Xcode command line tools — no Node.
set -euo pipefail
cd "$(dirname "$0")/.."

DEBUG=0
ZIP=0
for a in "$@"; do
  case "$a" in
    --debug) DEBUG=1 ;;
    --zip) ZIP=1 ;;
    *) echo "unknown option: $a" >&2; exit 1 ;;
  esac
done

VERSION=$(sed -n 's/^ *"version": *"\(.*\)".*/\1/p' package.json | head -1)
OUT=dist/mac
APP="$OUT/Audio Clipper.app"
LAME=node_modules/lamejs/lame.min.js
LAME_SHA512="s7bxvjvYthw6oPLCm5pFxvA84wUROODB8jEO2+CE1adhKgrIvVOlmMgY8zyugxGrvRaDHNJanOiS21/emty6dQ==" # package-lock.json

# lamejs (MP3 encoder) normally comes from `npm install`; fetch it directly if Node isn't set up.
if [ ! -f "$LAME" ]; then
  echo "Fetching lamejs 1.2.1…"
  tmp=$(mktemp -d)
  curl -sSfL https://registry.npmjs.org/lamejs/-/lamejs-1.2.1.tgz -o "$tmp/lamejs.tgz"
  got=$(shasum -a 512 "$tmp/lamejs.tgz" | cut -d' ' -f1 | xxd -r -p | base64)
  [ "$got" = "$LAME_SHA512" ] || { echo "lamejs checksum mismatch" >&2; exit 1; }
  tar -xzf "$tmp/lamejs.tgz" -C "$tmp"
  mkdir -p node_modules/lamejs
  cp -R "$tmp/package/." node_modules/lamejs/
  rm -rf "$tmp"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/src" "$APP/Contents/Resources/web/node_modules/lamejs"

# Web UI, laid out like the repo so index.html's relative paths still work.
cp -R src/renderer "$APP/Contents/Resources/web/src/"
cp "$LAME" "$APP/Contents/Resources/web/node_modules/lamejs/"

sed "s/__VERSION__/$VERSION/g" mac/Info.plist > "$APP/Contents/Info.plist"

# Icon: build/icon.png -> AppIcon.icns
ICONSET=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Native shell
FLAGS=(-swift-version 5 -framework AppKit -framework WebKit -framework UniformTypeIdentifiers)
if [ $DEBUG = 1 ]; then
  swiftc "${FLAGS[@]}" -Onone -g -D DEBUG -target "$(uname -m)-apple-macos13.0" mac/Sources/*.swift -o "$APP/Contents/MacOS/AudioClipper"
else
  BIN=$(mktemp -d)
  for arch in arm64 x86_64; do
    swiftc "${FLAGS[@]}" -O -target "$arch-apple-macos13.0" mac/Sources/*.swift -o "$BIN/$arch"
  done
  lipo -create "$BIN/arm64" "$BIN/x86_64" -output "$APP/Contents/MacOS/AudioClipper"
  strip -x "$APP/Contents/MacOS/AudioClipper"
fi

# Ad-hoc signature (required to run on Apple silicon). For distribution, sign with a
# Developer ID and notarize — see README.
codesign --force --sign - "$APP" >/dev/null

if [ $ZIP = 1 ]; then
  (cd "$OUT" && rm -f "Audio Clipper-$VERSION.zip" && ditto -c -k --keepParent "Audio Clipper.app" "Audio Clipper-$VERSION.zip")
fi

echo "Built $APP ($(du -sh "$APP" | cut -f1))"
