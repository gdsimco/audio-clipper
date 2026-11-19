#!/bin/bash
# Builds Audio Clipper and installs it like any other Mac app.
#   mac/install.sh                    install into /Applications
#   mac/install.sh --default          …and open .wav and .mp3 files with it
#   mac/install.sh --default wav,mp3,m4a,flac
#   mac/install.sh --uninstall        remove it again
# Needs only the Xcode command line tools (it offers to install them if missing).
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="Audio Clipper.app"
DEFAULT_TYPES=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --default)
      if [ $# -gt 1 ] && [[ "$2" != --* ]]; then DEFAULT_TYPES="$2"; shift; else DEFAULT_TYPES="wav,mp3"; fi ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
  shift
done

# /Applications if we can write there, otherwise the per-user Applications folder.
if [ -w /Applications ]; then DEST_DIR=/Applications; else DEST_DIR="$HOME/Applications"; fi
DEST="$DEST_DIR/$NAME"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ $UNINSTALL = 1 ]; then
  for d in "/Applications/$NAME" "$HOME/Applications/$NAME"; do
    if [ -d "$d" ]; then
      "$LSREGISTER" -u "$d" 2>/dev/null || true
      rm -rf "$d"
      echo "Removed $d"
    fi
  done
  exit 0
fi

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Audio Clipper is built from source and needs Apple's command line tools."
  echo "A window will ask to install them; run this script again when that finishes."
  xcode-select --install 2>/dev/null || true
  exit 1
fi

mac/build.sh

pkill -x AudioClipper 2>/dev/null && sleep 0.5 || true # quit a running copy so it can be replaced
mkdir -p "$DEST_DIR"
rm -rf "$DEST"
ditto "dist/mac/$NAME" "$DEST"
"$LSREGISTER" -f "$DEST"
echo "Installed $DEST"

if [ -n "$DEFAULT_TYPES" ]; then
  swift mac/Tools/set-default.swift "$DEST" ${DEFAULT_TYPES//,/ }
fi

echo "Open it from Launchpad or Spotlight, or right-click an audio file → Open With → Audio Clipper."
