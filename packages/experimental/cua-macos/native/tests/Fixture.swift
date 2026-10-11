import AppKit

final class DragPad: NSView {
    var changed: (() -> Void)?
    var dragDownCount = 0
    var dragCount = 0
    var rightDownCount = 0
    var rightUpCount = 0
    var lastPoint = NSPoint.zero
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { lastPoint = convert(event.locationInWindow, from: nil); dragDownCount += 1; changed?() }
    override func mouseDragged(with event: NSEvent) { lastPoint = convert(event.locationInWindow, from: nil); needsDisplay = true }
    override func mouseUp(with event: NSEvent) { lastPoint = convert(event.locationInWindow, from: nil); dragCount += 1; needsDisplay = true; changed?() }
    override func rightMouseDown(with event: NSEvent) { rightDownCount += 1; changed?() }
    override func rightMouseUp(with event: NSEvent) { rightUpCount += 1; changed?() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.withAlphaComponent(0.12).setFill(); bounds.fill()
        ("Drag across this area" as NSString).draw(at: NSPoint(x: 12, y: 12), withAttributes: [.font: NSFont.systemFont(ofSize: 15)])
        NSColor.systemBlue.setFill(); NSBezierPath(ovalIn: NSRect(x: lastPoint.x - 5, y: lastPoint.y - 5, width: 10, height: 10)).fill()
    }
}
final class ScrollDocument: NSView { override var isFlipped: Bool { true } }
final class CountingScrollView: NSScrollView {
    var changed: (() -> Void)?
    var eventCount = 0
    override func scrollWheel(with event: NSEvent) { eventCount += 1; super.scrollWheel(with: event); changed?() }
}

/// Every assertion reads this application's own state file after real OS input.
final class Fixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let statePath: String
    let rowCount: Int
    var window: NSWindow!
    var second: NSWindow!
    var field: NSTextField!
    var countLabel: NSTextField!
    var dragPad: DragPad!
    var scroll: CountingScrollView!
    var count = 0
    var secondaryCount = 0
    var selectedFile = ""

    init(statePath: String, rowCount: Int = 35) { self.statePath = statePath; self.rowCount = rowCount }
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
        // Keep fixture geometry stable when Stage Manager switches application sets.
        window.collectionBehavior = [.canJoinAllApplications, .stationary]
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
        let open = NSButton(title: "Open fixture file", target: self, action: #selector(openFile))
        open.frame = NSRect(x: 30, y: 212, width: 350, height: 30)
        content.addSubview(open)
        scroll = CountingScrollView(frame: NSRect(x: 30, y: 30, width: 350, height: 180))
        scroll.changed = { [weak self] in self?.persist() }
        scroll.hasVerticalScroller = true
        let document = ScrollDocument(frame: NSRect(x: 0, y: 0, width: 330, height: CGFloat(rowCount * 40)))
        for index in 0..<rowCount {
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
        second.collectionBehavior = [.canJoinAllApplications, .stationary]
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
    @objc func openFile() {
        let panel = NSOpenPanel()
        panel.collectionBehavior = [.canJoinAllApplications, .stationary]
        panel.directoryURL = URL(fileURLWithPath: statePath).deletingLastPathComponent()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] response in
            if response == .OK { self?.selectedFile = panel.url?.path ?? "" }
            self?.persist()
        }
    }
    @objc func closeSecondary() { second.close(); second = nil; persist() }
    @objc func scrolled() { if field != nil && dragPad != nil && scroll != nil { persist() } }
    func controlTextDidChange(_ notification: Notification) { persist() }
    func controlTextDidEndEditing(_ notification: Notification) { persist() }
    func windowPoints(_ view: NSView) -> [CGFloat] {
        let rect = view.convert(view.bounds, to: nil)
        return [rect.minX, window.frame.height - rect.maxY, rect.width, rect.height]
    }
    func persist() {
        let state: [String: Any] = ["count": count, "secondaryCount": secondaryCount, "text": field.stringValue, "selectedFile": selectedFile,
            "rowCount": rowCount, "primaryWindowId": window.windowNumber,
            "dragDownCount": dragPad.dragDownCount, "dragCount": dragPad.dragCount, "dragPoint": [dragPad.lastPoint.x, dragPad.lastPoint.y],
            "rightDownCount": dragPad.rightDownCount, "rightUpCount": dragPad.rightUpCount,
            "scrollEventCount": scroll.eventCount, "scrollY": scroll.contentView.bounds.origin.y, "dragBounds": windowPoints(dragPad), "scrollBounds": windowPoints(scroll),
            "primaryWindowSize": [window.frame.width, window.frame.height],
            "secondaryWindowSize": second != nil ? [second.frame.width, second.frame.height] : []]
        let data = try! JSONSerialization.data(withJSONObject: state)
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}
let arguments = CommandLine.arguments
guard (2...3).contains(arguments.count), let rowCount = arguments.count == 3 ? Int(arguments[2]) : 35,
      (1...1000).contains(rowCount) else {
    fputs("usage: Fixture STATE_PATH [ROW_COUNT:1...1000]\n", stderr)
    exit(2)
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let fixture = Fixture(statePath: arguments[1], rowCount: rowCount)
application.delegate = fixture
application.run()
