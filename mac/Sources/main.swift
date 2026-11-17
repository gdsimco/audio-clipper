// Audio Clipper for macOS — a native AppKit shell around the shared web UI.
//
// The editor itself (src/renderer) runs in the system WKWebView, so there is no bundled
// browser engine. This file provides what Electron's main process + preload did:
// the window, menus, open/save panels, file IO, and the `window.api` bridge.

import AppKit
import UniformTypeIdentifiers
import WebKit

let audioExtensions = ["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "webm", "weba", "aif", "aiff", "caf"]
let scheme = "audioclipper"
let host = "app"
let bg = NSColor(srgbRed: 0x1c / 255, green: 0x1c / 255, blue: 0x1e / 255, alpha: 1)
let titlebarHeight: CGFloat = 34 // matches --titlebar-h in styles.css

func isAudio(_ url: URL) -> Bool { audioExtensions.contains(url.pathExtension.lowercased()) }

// MARK: - Bridge script (the `window.api` the renderer expects)

let bridgeJS = #"""
(() => {
  const h = window.webkit.messageHandlers.native;
  const call = (cmd, args) => h.postMessage({ cmd, args: args ?? null });
  const base = `\#(scheme)://\#(host)/`;
  let onOpen = () => {}, onMenu = () => {};
  const withData = async (f) => {
    if (!f) return null;
    const r = await fetch(base + '__file/' + f.token);
    if (!r.ok) throw new Error('Couldn’t read file');
    return { path: f.path, name: f.name, data: new Uint8Array(await r.arrayBuffer()) };
  };
  window.__native = { openPath: (p) => onOpen(p), menu: (c) => onMenu(c) };
  window.api = {
    platform: 'darwin',
    openDialog: async () => withData(await call('openDialog')),
    readFile: async (p) => withData(await call('readFile', p)),
    initialFile: () => call('initialFile'),
    exportMenu: (opts) => call('exportMenu', opts),
    saveDialog: (opts) => call('saveDialog', opts),
    writeExport: async ({ target, files }) => {
      const { id, paths } = await call('beginExport', { target, count: files.length });
      for (let i = 0; i < files.length; i++) {
        const r = await fetch(`${base}__write/${id}/${i}`, { method: 'POST', body: files[i] });
        if (!r.ok) throw new Error(await r.text());
      }
      return paths;
    },
    reveal: (p) => call('reveal', p),
    setDirty: (v) => call('setDirty', !!v),
    pathForFile: () => null, // native drops are handled by the window (see WebView.performDragOperation)
    onOpenPath: (cb) => { onOpen = cb; },
    onMenu: (cb) => { onMenu = cb; },
  };
})();
"""#

// MARK: - Web view with a native title bar and native file drops

final class WebView: WKWebView {
    var onDropFile: ((URL) -> Void)?

    // The page's title bar strip drags the window, like -webkit-app-region: drag in Electron.
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let fromTop = isFlipped ? p.y : bounds.height - p.y
        if fromTop < titlebarHeight {
            if event.clickCount == 2 {
                window?.performTitleBarDoubleClick()
            } else {
                window?.performDrag(with: event)
            }
            return
        }
        super.mouseDown(with: event)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        guard let url = urls?.first else { return super.performDragOperation(sender) }
        // Let the page clear its "Drop to open" overlay, then open the file natively so we know its folder.
        evaluateJavaScript("window.dispatchEvent(new Event('drop'))")
        onDropFile?(url)
        return true
    }
}

extension NSWindow {
    /// Honors the "double-click a window's title bar to" system setting.
    func performTitleBarDoubleClick() {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize": performMiniaturize(nil)
        case "None": break
        default: performZoom(nil)
        }
    }
}

// MARK: - App

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandlerWithReply,
    WKURLSchemeHandler, WKUIDelegate, WKNavigationDelegate, NSMenuItemValidation
{
    var window: NSWindow!
    var web: WebView!
    var pageReady = false
    var pendingPath: String?
    var dirty = false

    // Files the user chose (dialog, Finder, drop) — the page can only read these.
    var readable: [String: URL] = [:] // token -> file
    var readablePaths: Set<String> = []
    var approvedTargets: Set<String> = [] // save-panel results
    var exports: [String: [URL]] = [:] // export id -> output files
    var written: Set<String> = [] // files we exported (allowed for Show in Finder)

    // MARK: launch

    func applicationWillFinishLaunching(_ notification: Notification) {
        buildMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if pendingPath == nil, let arg = CommandLine.arguments.dropFirst().first(where: { !$0.hasPrefix("-") }) {
            let url = URL(fileURLWithPath: arg)
            if isAudio(url) { pendingPath = allow(url) }
        }
        createWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: \.isFileURL) else { return }
        open(url)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard dirty, let window else { return .terminateNow }
        confirmDiscard(in: window) { ok in sender.reply(toApplicationShouldTerminate: ok) }
        return .terminateLater
    }

    func createWindow() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(self, forURLScheme: scheme)
        config.mediaTypesRequiringUserActionForPlayback = []
        let ucc = config.userContentController
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        ucc.addUserScript(WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #endif

        web = WebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.uiDelegate = self
        web.navigationDelegate = self
        web.allowsMagnification = false
        if #available(macOS 13.3, *) { web.isInspectable = true }
        web.onDropFile = { [weak self] url in self?.open(url) }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 190),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Audio Clipper"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = bg
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentMinSize = NSSize(width: 440, height: 170)
        window.contentMaxSize = NSSize(width: 10000, height: 320)
        window.collectionBehavior = [.fullScreenNone]
        window.delegate = self
        window.contentView = web
        window.setFrameAutosaveName("Main")
        if !window.setFrameUsingName("Main") { window.center() }
        window.isReleasedWhenClosed = false

        let index = URL(string: "\(scheme)://\(host)/src/renderer/index.html")!
        web.load(URLRequest(url: index))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        if !window.isVisible {
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(web)
            centerTrafficLights()
            #if DEBUG
                debugCapture()
            #endif
        }
    }

    #if DEBUG
        /// Dev helper, like scripts/capture.js for Electron:
        ///   AC_KEYS="s cmd+z" AC_JS=snippet.js AC_SNAPSHOT=out.png "Audio Clipper.app/Contents/MacOS/AudioClipper" file.mp3
        /// Waits a moment, types AC_KEYS through AppKit (so menus see them like real keys), runs the
        /// snippet (its result is printed), saves a PNG of the page, and quits.
        func debugCapture() {
            let env = ProcessInfo.processInfo.environment
            guard env["AC_JS"] != nil || env["AC_SNAPSHOT"] != nil else { return }
            if let pre = env["AC_PRE"] { // e.g. move the playhead before AC_KEYS
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [self] in web.evaluateJavaScript(pre) }
            }
            let keys = (env["AC_KEYS"] ?? "").split(separator: " ").map(String.init)
            for (i, k) in keys.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1 + Double(i) * 0.15) { [self] in
                    if k.hasPrefix("click:") { // click:x,y in page points from the top-left
                        let xy = k.dropFirst(6).split(separator: ",").compactMap { Double($0) }
                        let p = NSPoint(x: xy[0], y: web.bounds.height - xy[1])
                        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                            let e = NSEvent.mouseEvent(
                                with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
                            NSApp.sendEvent(e)
                        }
                        return
                    }
                    let cmd = k.hasPrefix("cmd+")
                    let ch = k == "delete" ? "\u{7f}" : String(k.dropFirst(cmd ? 4 : 0))
                    let code: UInt16 = ["s": 1, "z": 6, "delete": 51][String(k.dropFirst(cmd ? 4 : 0))] ?? 0
                    for type in [NSEvent.EventType.keyDown, .keyUp] {
                        let e = NSEvent.keyEvent(
                            with: type, location: .zero, modifierFlags: cmd ? .command : [], timestamp: ProcessInfo.processInfo.systemUptime,
                            windowNumber: window.windowNumber, context: nil, characters: ch, charactersIgnoringModifiers: ch,
                            isARepeat: false, keyCode: code)!
                        NSApp.sendEvent(e)
                    }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5 + Double(keys.count) * 0.15) { [self] in
                let js = env["AC_JS"].flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? "null"
                web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [self] result in
                    print("result:", result)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
                        guard let out = env["AC_SNAPSHOT"] else { exit(0) }
                        web.takeSnapshot(with: nil) { image, _ in
                            if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
                            }
                            exit(0)
                        }
                    }
                }
            }
        }
    #endif

    // Center the window buttons in the page's 34px title strip.
    func centerTrafficLights() {
        for (i, type) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
            guard let b = window.standardWindowButton(type), let sv = b.superview else { continue }
            let y = sv.isFlipped ? (titlebarHeight - b.frame.height) / 2 : sv.bounds.height - (titlebarHeight + b.frame.height) / 2
            b.setFrameOrigin(NSPoint(x: 12 + CGFloat(i) * 20, y: y))
        }
    }

    func windowDidResize(_ notification: Notification) { centerTrafficLights() }

    // MARK: opening files

    @discardableResult
    func allow(_ url: URL) -> String {
        let path = url.standardizedFileURL.path
        readablePaths.insert(path)
        return path
    }

    func open(_ url: URL) {
        let path = allow(url)
        if pageReady, let web {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            web.evaluateJavaScript("window.__native.openPath(\(jsString(path)))")
        } else {
            pendingPath = path
        }
    }

    func fileInfo(_ path: String) -> [String: Any] {
        let token = UUID().uuidString
        let url = URL(fileURLWithPath: path)
        readable[token] = url
        return ["token": token, "path": path, "name": url.lastPathComponent]
    }

    // MARK: bridge

    func userContentController(
        _ ucc: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return replyHandler(nil, "Bad message")
        }
        let args = body["args"]
        switch cmd {
        case "openDialog":
            let panel = NSOpenPanel()
            panel.title = "Open audio"
            panel.allowedContentTypes = audioExtensions.compactMap { UTType(filenameExtension: $0) }
            panel.allowsOtherFileTypes = true
            panel.beginSheetModal(for: window) { [self] r in
                guard r == .OK, let url = panel.url else { return replyHandler(NSNull(), nil) }
                replyHandler(fileInfo(allow(url)), nil)
            }

        case "readFile":
            guard let p = args as? String else { return replyHandler(nil, "Invalid path") }
            let path = URL(fileURLWithPath: p).standardizedFileURL.path
            guard readablePaths.contains(path) else { return replyHandler(nil, "File was not opened by the user") }
            replyHandler(fileInfo(path), nil)

        case "initialFile":
            replyHandler(pendingPath ?? NSNull(), nil)
            pendingPath = nil

        case "exportMenu":
            let o = args as? [String: Any] ?? [:]
            showExportMenu(multi: o["multi"] as? Bool ?? false, count: o["count"] as? Int ?? 1) { replyHandler($0 ?? NSNull(), nil) }

        case "saveDialog":
            let o = args as? [String: Any] ?? [:]
            let ext = o["ext"] as? String ?? "wav"
            let multi = o["multi"] as? Bool ?? false
            let panel = NSSavePanel()
            panel.title = multi ? "Export clips" : "Export audio"
            panel.message = multi ? "Each clip is saved as “name 1”, “name 2”, …" : ""
            panel.nameFieldStringValue = o["defaultName"] as? String ?? "Untitled.\(ext)"
            if let t = UTType(filenameExtension: ext) { panel.allowedContentTypes = [t] }
            let dir = (o["defaultDir"] as? String).map { URL(fileURLWithPath: $0, isDirectory: true) }
            panel.directoryURL = dir ?? FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first
            panel.beginSheetModal(for: window) { [self] r in
                guard r == .OK, let url = panel.url else { return replyHandler(NSNull(), nil) }
                approvedTargets.insert(url.path)
                replyHandler(url.path, nil)
            }

        case "beginExport":
            let o = args as? [String: Any] ?? [:]
            guard let target = o["target"] as? String, approvedTargets.remove(target) != nil else {
                return replyHandler(nil, "Target was not chosen by the user")
            }
            let count = max(1, o["count"] as? Int ?? 1)
            let url = URL(fileURLWithPath: target)
            let ext = url.pathExtension
            let base = url.deletingPathExtension().path
            let pad = String(count).count
            let outs = (0..<count).map { i -> URL in
                if count == 1 { return url }
                let n = String(i + 1)
                return URL(fileURLWithPath: "\(base) \(String(repeating: "0", count: pad - n.count))\(n).\(ext)")
            }
            let id = UUID().uuidString
            exports[id] = outs
            replyHandler(["id": id, "paths": outs.map(\.path)], nil)

        case "reveal":
            if let p = args as? String, written.contains(p) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
            }
            replyHandler(nil, nil)

        case "setDirty":
            dirty = args as? Bool ?? false
            hasFile = true // the page only reports this once a file is loaded
            window.isDocumentEdited = dirty
            replyHandler(nil, nil)

        #if DEBUG
            case "debugApprove": // lets AC_JS snippets test exports without a save panel
                if let p = args as? String { approvedTargets.insert(p) }
                replyHandler(nil, nil)
        #endif

        default:
            replyHandler(nil, "Unknown command \(cmd)")
        }
    }

    func showExportMenu(multi: Bool, count: Int, done: @escaping (String?) -> Void) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var picked: String?
        let handler = MenuHandler { picked = $0 }
        func item(_ title: String, _ value: String, indent: Bool = false) {
            let it = NSMenuItem(title: title, action: #selector(MenuHandler.pick(_:)), keyEquivalent: "")
            it.target = handler
            it.representedObject = value
            if indent { it.indentationLevel = 1 }
            menu.addItem(it)
        }
        func header(_ title: String) {
            if #available(macOS 14.0, *) { menu.addItem(.sectionHeader(title: title)) } else {
                let h = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                h.isEnabled = false
                menu.addItem(h)
            }
        }
        if multi {
            header("\(count) separate files")
            item("WAV…", "wav:separate")
            item("MP3…", "mp3:separate")
            menu.addItem(.separator())
            header("Joined into one file")
            item("WAV…", "wav:single")
            item("MP3…", "mp3:single")
        } else {
            item("Save as WAV…", "wav:single")
            item("Save as MP3…", "mp3:single")
        }
        // Pop up at the mouse (the Export button was just clicked); pop-up tracking is modal.
        let at = web.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        menu.popUp(positioning: nil, at: at, in: web)
        withExtendedLifetime(handler) { done(picked) }
    }

    // MARK: custom scheme: app files, opened audio, export writes

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let parts = url.path.split(separator: "/").map(String.init)

        func respond(_ status: Int, _ data: Data, _ mime: String) {
            let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"]
            let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            task.didReceive(r)
            task.didReceive(data)
            task.didFinish()
        }
        func fail(_ status: Int, _ msg: String) { respond(status, Data(msg.utf8), "text/plain") }

        if parts.first == "__file", parts.count == 2 {
            guard let file = readable.removeValue(forKey: parts[1]) else { return fail(404, "Not found") }
            // Read off the main thread so big files don't stall the UI.
            DispatchQueue.global(qos: .userInitiated).async {
                let data = try? Data(contentsOf: file, options: .mappedIfSafe)
                DispatchQueue.main.async {
                    if let data { respond(200, data, "application/octet-stream") } else { fail(500, "Couldn’t read file") }
                }
            }
            return
        }

        if parts.first == "__write", parts.count == 3, task.request.httpMethod == "POST" {
            guard let outs = exports[parts[1]], let i = Int(parts[2]), outs.indices.contains(i) else {
                return fail(403, "Not allowed")
            }
            guard let body = task.request.httpBody else { return fail(400, "No data") }
            do {
                try body.write(to: outs[i], options: .atomic)
                written.insert(outs[i].path)
                if i == outs.count - 1 { exports[parts[1]] = nil }
                respond(200, Data(), "text/plain")
            } catch {
                fail(500, error.localizedDescription)
            }
            return
        }

        // Static app files from the bundle's web root.
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web").standardizedFileURL else { return }
        let file = root.appendingPathComponent(url.path).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else { return fail(404, "Not found") }
        let mime: String
        switch file.pathExtension {
        case "html": mime = "text/html; charset=utf-8"
        case "js", "mjs": mime = "text/javascript; charset=utf-8"
        case "css": mime = "text/css; charset=utf-8"
        case "svg": mime = "image/svg+xml"
        case "png": mime = "image/png"
        default: mime = "application/octet-stream"
        }
        respond(200, data, mime)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    // MARK: JS dialogs (the page uses confirm() before discarding edits)

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "Discard Changes")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    // MARK: closing with unsaved edits

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard dirty else { return true }
        confirmDiscard(in: sender) { [self] ok in
            if ok {
                dirty = false
                sender.close()
            }
        }
        return false
    }

    func confirmDiscard(in window: NSWindow, _ done: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "You have edits that haven’t been exported."
        a.informativeText = "Close anyway and discard them?"
        a.addButton(withTitle: "Cancel")
        let discard = a.addButton(withTitle: "Discard Changes")
        discard.hasDestructiveAction = true
        a.beginSheetModal(for: window) { done($0 == .alertSecondButtonReturn) }
    }

    // MARK: menus

    @objc func menuCommand(_ sender: NSMenuItem) {
        guard let cmd = sender.representedObject as? String else { return }
        web?.evaluateJavaScript("window.__native.menu(\(jsString(cmd)))")
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        // Before a file is open only "Open…" does anything; let other keys reach the page.
        if item.action == #selector(menuCommand(_:)), let cmd = item.representedObject as? String, cmd != "open" {
            return window?.isKeyWindow == true && hasFile
        }
        return true
    }

    var hasFile = false
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Only our own pages load in the window.
        decisionHandler(action.request.url?.scheme == scheme ? .allow : .cancel)
    }

    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let holder = NSMenuItem()
            holder.submenu = m
            main.addItem(holder)
            return m
        }
        func cmd(_ title: String, _ key: String, _ command: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let it = NSMenuItem(title: title, action: #selector(menuCommand(_:)), keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            it.representedObject = command
            it.target = self
            return it
        }
        func std(_ title: String, _ sel: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            return it
        }
        let name = "Audio Clipper"
        _ = sub(name, [
            std("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            std("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
            std("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            std("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            std("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = sub("File", [
            cmd("Open…", "o", "open"),
            cmd("Export…", "s", "export"),
            .separator(),
            std("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = sub("Edit", [
            cmd("Undo", "z", "undo"),
            cmd("Redo", "z", "redo", [.command, .shift]),
            .separator(),
            cmd("Split Clip", "s", "split", []),
            cmd("Delete Clip", "\u{8}", "delete", []),
        ])
        let win = sub("Window", [
            std("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            std("Zoom", #selector(NSWindow.performZoom(_:)), ""),
        ])
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

final class MenuHandler: NSObject {
    let onPick: (String) -> Void
    init(_ onPick: @escaping (String) -> Void) { self.onPick = onPick }
    @objc func pick(_ sender: NSMenuItem) { if let v = sender.representedObject as? String { onPick(v) } }
}

func jsString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s])
    return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
