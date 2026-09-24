import AppKit
import Darwin

/// Removes this app's AX roots while keeping its CG window and native button alive.
final class AxlessFixture: NSObject, NSApplicationDelegate {
    let statePath: String
    var window: NSWindow!
    var button: NSButton!
    var savedChildren: [Any]?
    var hiddenAX = false
    var count = 0
    var controls: [DispatchSourceSignal] = []

    init(statePath: String) { self.statePath = statePath }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 360, height: 180),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "DSH AXless window fixture"
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.canJoinAllApplications, .stationary]
        button = NSButton(title: "Increment AXless fixture", target: self, action: #selector(increment))
        button.frame = NSRect(x: 40, y: 65, width: 280, height: 40)
        window.contentView!.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        savedChildren = NSApplication.shared.accessibilityChildren()
        for number in [SIGUSR1, SIGUSR2] {
            signal(number, SIG_IGN)
            let control = DispatchSource.makeSignalSource(signal: number, queue: .main)
            control.setEventHandler { [weak self] in self?.setAXHidden(number == SIGUSR1) }
            control.resume()
            controls.append(control)
        }
        persist()
        print("READY")
        fflush(stdout)
    }
    @objc func increment() { count += 1; persist() }
    func setAXHidden(_ hidden: Bool) {
        let app = NSApplication.shared
        app.setAccessibilityChildren(hidden ? [] : savedChildren)
        app.setAccessibilityWindows(hidden ? [] : [window!])
        app.setAccessibilityFocusedWindow(hidden ? nil : window)
        hiddenAX = hidden
        NSAccessibility.post(element: app, notification: .layoutChanged)
        persist()
    }
    func persist() {
        let rect = button.convert(button.bounds, to: nil)
        let data = try! JSONSerialization.data(withJSONObject: [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "windowId": window.windowNumber,
            "hiddenAX": hiddenAX, "count": count,
            "size": [window.frame.width, window.frame.height],
            "buttonPoint": [rect.midX, window.frame.height - rect.midY],
        ])
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = AxlessFixture(statePath: CommandLine.arguments[1])
app.delegate = fixture
app.run()
