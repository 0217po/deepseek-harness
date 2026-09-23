import AppKit

final class DragPad: NSView {
    var changed: (() -> Void)?
    var dragCount = 0
    var lastPoint = NSPoint.zero
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { lastPoint = convert(event.locationInWindow, from: nil) }
    override func mouseDragged(with event: NSEvent) { lastPoint = convert(event.locationInWindow, from: nil); needsDisplay = true }
    override func mouseUp(with event: NSEvent) { lastPoint = convert(event.locationInWindow, from: nil); dragCount += 1; needsDisplay = true; changed?() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.withAlphaComponent(0.12).setFill(); bounds.fill()
        ("Drag across this area" as NSString).draw(at: NSPoint(x: 12, y: 12), withAttributes: [.font: NSFont.systemFont(ofSize: 15)])
        NSColor.systemBlue.setFill(); NSBezierPath(ovalIn: NSRect(x: lastPoint.x - 5, y: lastPoint.y - 5, width: 10, height: 10)).fill()
    }
}
final class ScrollDocument: NSView { override var isFlipped: Bool { true } }

/// Every assertion reads this application's own state file after real OS input.
final class Fixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let statePath: String
    var window: NSWindow!
    var second: NSWindow!
    var field: NSTextField!
    var countLabel: NSTextField!
    var dragPad: DragPad!
    var scroll: NSScrollView!
    var count = 0
    var secondaryCount = 0

    init(statePath: String) { self.statePath = statePath }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApplication.shared.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 420, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "DSH CUA primary fixture"
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        let content = window.contentView!
        field = NSTextField(frame: NSRect(x: 30, y: 425, width: 350, height: 28))
        field.placeholderString = "Test text"
        field.setAccessibilityIdentifier("dsh-cua-test-text")
        field.setAccessibilityLabel("Fixture text")
        field.delegate = self
        content.addSubview(field)
        let button = NSButton(title: "Increment primary", target: self, action: #selector(increment))
        button.frame = NSRect(x: 30, y: 365, width: 200, height: 32)
        button.setAccessibilityIdentifier("dsh-cua-test-button")
        content.addSubview(button)
        countLabel = NSTextField(labelWithString: "Count: 0")
        countLabel.frame = NSRect(x: 260, y: 371, width: 130, height: 24)
        content.addSubview(countLabel)
        dragPad = DragPad(frame: NSRect(x: 30, y: 245, width: 350, height: 90))
        dragPad.changed = { [weak self] in self?.persist() }
        content.addSubview(dragPad)
        scroll = NSScrollView(frame: NSRect(x: 30, y: 30, width: 350, height: 180))
        scroll.hasVerticalScroller = true
        let document = ScrollDocument(frame: NSRect(x: 0, y: 0, width: 330, height: 1400))
        for index in 0..<35 {
            let label = NSTextField(labelWithString: "Scroll row \(index + 1)")
            label.frame = NSRect(x: 15, y: CGFloat(index * 40), width: 270, height: 24)
            document.addSubview(label)
        }
        scroll.documentView = document
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        content.addSubview(scroll)
        second = NSWindow(contentRect: NSRect(x: 560, y: 100, width: 320, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        second.title = "DSH CUA secondary fixture"
        second.isReleasedWhenClosed = false
        second.animationBehavior = .none
        let secondary = NSButton(title: "Increment secondary", target: self, action: #selector(incrementSecondary))
        secondary.frame = NSRect(x: 30, y: 90, width: 240, height: 32)
        second.contentView!.addSubview(secondary)
        let close = NSButton(title: "Close secondary", target: self, action: #selector(closeSecondary))
        close.frame = NSRect(x: 30, y: 30, width: 240, height: 32)
        second.contentView!.addSubview(close)
        second.orderFront(nil)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        persist()
        print("READY")
        fflush(stdout)
    }
    @objc func increment() { count += 1; countLabel.stringValue = "Count: \(count)"; persist() }
    @objc func incrementSecondary() { secondaryCount += 1; persist() }
    @objc func closeSecondary() { second.close(); second = nil; persist() }
    @objc func scrolled() { if field != nil && dragPad != nil && scroll != nil { persist() } }
    func controlTextDidChange(_ notification: Notification) { persist() }
    func controlTextDidEndEditing(_ notification: Notification) { persist() }
    func windowPoints(_ view: NSView) -> [CGFloat] {
        let rect = view.convert(view.bounds, to: nil)
        return [rect.minX, window.frame.height - rect.maxY, rect.width, rect.height]
    }
    func persist() {
        let state: [String: Any] = ["count": count, "secondaryCount": secondaryCount, "text": field.stringValue,
            "dragCount": dragPad.dragCount, "dragPoint": [dragPad.lastPoint.x, dragPad.lastPoint.y],
            "scrollY": scroll.contentView.bounds.origin.y, "dragBounds": windowPoints(dragPad), "scrollBounds": windowPoints(scroll),
            "primaryWindowSize": [window.frame.width, window.frame.height],
            "secondaryWindowSize": second != nil ? [second.frame.width, second.frame.height] : []]
        let data = try! JSONSerialization.data(withJSONObject: state)
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let fixture = Fixture(statePath: CommandLine.arguments[1])
application.delegate = fixture
application.run()
