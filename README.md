# Audio Clipper

A tiny audio trimmer modeled on the iPhone/Mac video trim tool. Open an audio file, drag the yellow handles, split it into clips, and export.

## Using it

| To… | Do this |
| --- | --- |
| Open a file | Drop it on the window, click the window, or press **Ctrl/⌘+O** (or use *Open with → Audio Clipper*) |
| Trim the start/end | Drag the yellow handles |
| Play / scrub | **Space**, or click/drag anywhere on the strip |
| Split into clips | Put the playhead where you want the cut and press **S** (✂) |
| Remove a middle part | Split before and after it, click that clip, then press **Delete** (🗑) |
| Fine-tune | Each clip has its own handles: click a clip, then drag its handles. Dragging a handle back out recovers trimmed audio |
| Undo / redo | **Ctrl/⌘+Z**, **Ctrl+Y** / **⇧⌘Z** |
| Export | **Export** (Ctrl/⌘+S). With several clips you choose *separate files* (`name 1.wav`, `name 2.wav`, …) or *joined into one file*, as WAV or MP3 |

Other keys: **←/→** nudge the playhead 0.1 s (hold **Shift** for 1 s), **Tab** selects the next clip, **Home/End** jump to the start or end.

Edits are non-destructive and the original file is never touched. Every cut gets a 3 ms fade, so joins don't click.

**Opens:** MP3, WAV, FLAC, M4A/AAC, AIFF/CAF (Mac), OGG/Opus, WebM, using the browser engine's built-in decoders (Chromium on Windows, the system WebKit on Mac; Ogg/WebM support on Mac depends on the macOS version). **Exports:** 16-bit WAV, or MP3 at 192 kbps.

## Development

Requires Node 16 or newer.

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

`npm test` runs the editing and codec unit tests with no dependencies. To launch the app with a file, take a screenshot and optionally run a JS snippet in the page, use the dev helper:

```bash
npx electron scripts/capture.js out.png path/to/audio.mp3 --js-file snippet.js
```

### Building

```bash
npm run dist:win
```

This produces an NSIS installer and a portable `.exe` in `dist/`. On Windows, electron-builder needs permission to create symlinks while it unpacks its signing tools. Turn on *Settings → System → For developers → Developer Mode*, or build from an admin terminal. Without that, only `dist/win-unpacked/` is produced. That folder is a runnable app, but there's no installer.

#### macOS (native, no Electron)

The Mac app is a small native AppKit shell (`mac/Sources/main.swift`) that runs the same `src/renderer` UI in the system's WKWebView, so no browser is bundled: the app is under 1 MB (about 450 KB zipped) instead of ~250 MB. It needs only the Xcode command line tools; Node isn't required.

```bash
mac/build.sh
```

This produces a universal (Apple silicon + Intel) `dist/mac/Audio Clipper.app`, ad-hoc signed, for macOS 13 or newer. Add `--zip` for a shareable `.zip`, or use `--debug` for a quick single-arch build with the Web Inspector enabled (Safari → Develop menu). For other people to open it without a Gatekeeper warning, sign it with a Developer ID and notarize it.

The debug build has a test hook, like `scripts/capture.js`. It types keys through AppKit, runs a JS snippet, prints the result, saves a page snapshot and quits:

```bash
open -W --stdout out.txt --env AC_KEYS="s cmd+z" --env AC_JS=$PWD/snippet.js --env AC_SNAPSHOT=$PWD/out.png "dist/mac/Audio Clipper.app" --args $PWD/audio.wav
```

Use `open` rather than running the binary directly, so the app is frontmost and ⌘ shortcuts arrive.

`npm run dist:mac` still builds the Electron version as a `.dmg`, if you ever want it.

The icon comes from `build/icon.svg`. After editing it, regenerate `build/icon.png` with `npm run icon`.

## Layout

```
src/main/main.js        window, file dialogs, export menu, file writes (Electron main)
src/main/preload.js     the small `window.api` bridge exposed to the page
mac/Sources/main.swift  native macOS shell: window, menus, panels, file IO, and the same `window.api`
mac/build.sh            builds dist/mac/Audio Clipper.app
src/renderer/app.mjs    app state, playback, keyboard, export flow
src/renderer/strip.mjs  the trim strip: drawing + handle/scrub interaction
src/renderer/audio-ops.mjs  pure editing model (clips, split, trim, flatten, peaks)
src/renderer/codecs.mjs     sample-rate sniffing, WAV + MP3 encoding
```

The edit model is a list of clips. Each clip is `{ lo, hi, s, e }`: the span of the original audio it came from and the part kept inside its handles. Undo is a stack of these lists.

### macOS notes

The Mac shell provides the same `window.api` as `preload.js`, so the renderer needs no Mac-specific code beyond `api.platform === 'darwin'`. Opened files are streamed to the page and exports are written back through a private `audioclipper://` URL scheme. The page can only read files the user chose (open panel, Finder, or drag and drop) and only write to save-panel targets. Unexported edits show in the close button's dot and prompt before the window closes or the app quits.
