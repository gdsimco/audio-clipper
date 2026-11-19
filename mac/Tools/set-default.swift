// Makes an app the default for opening files with the given extensions.
//   swift mac/Tools/set-default.swift "/Applications/Audio Clipper.app" wav mp3
// Same effect as Finder → Get Info → Open with → Change All…, and undone the same way.

import AppKit
import UniformTypeIdentifiers

let args = CommandLine.arguments.dropFirst()
guard let appPath = args.first, args.count > 1 else {
    print("usage: set-default.swift <app> <ext> [ext…]")
    exit(1)
}
let app = URL(fileURLWithPath: appPath)
var pending = 0
var failed = false

for ext in args.dropFirst() {
    guard let type = UTType(filenameExtension: ext.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))) else {
        print("  .\(ext): unknown file type, skipped")
        continue
    }
    pending += 1
    NSWorkspace.shared.setDefaultApplication(at: app, toOpen: type) { error in
        DispatchQueue.main.async {
            if let error {
                failed = true
                print("  .\(ext): couldn’t set (\(error.localizedDescription))")
            } else {
                print("  .\(ext) files now open with \(app.deletingPathExtension().lastPathComponent)")
            }
            pending -= 1
            if pending == 0 { exit(failed ? 1 : 0) }
        }
    }
}
if pending == 0 { exit(1) }
RunLoop.main.run()
