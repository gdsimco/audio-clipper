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

**Opens:** MP3, WAV, FLAC, OGG/Opus, M4A/AAC, WebM, using the decoders built into Chromium. **Exports:** 16-bit WAV, or MP3 at 192 kbps.

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

```bash
npm run dist:mac
```

This produces a `.dmg`. It must run on a Mac; code signing and notarization still need to be set up.

The icon comes from `build/icon.svg`. After editing it, regenerate `build/icon.png` with `npm run icon`.

## Layout

```
src/main/main.js        window, file dialogs, export menu, file writes (Electron main)
src/main/preload.js     the small `window.api` bridge exposed to the page
src/renderer/app.mjs    app state, playback, keyboard, export flow
src/renderer/strip.mjs  the trim strip: drawing + handle/scrub interaction
src/renderer/audio-ops.mjs  pure editing model (clips, split, trim, flatten, peaks)
src/renderer/codecs.mjs     sample-rate sniffing, WAV + MP3 encoding
```

The edit model is a list of clips. Each clip is `{ lo, hi, s, e }`: the span of the original audio it came from and the part kept inside its handles. Undo is a stack of these lists.

### macOS notes

The app is already cross-platform. It has a hidden title bar with traffic lights, Mac menu items for every command, ⌘ shortcuts, and handling for the `open-file` event. It has only been run on Windows so far.
