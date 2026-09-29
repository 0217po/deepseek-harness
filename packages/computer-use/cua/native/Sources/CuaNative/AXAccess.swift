// Checked AX access and tree projection. Behavioral reference: native/upstream.json (MIT Cua Driver).
import Foundation
import ApplicationServices
import Darwin

private typealias AXWindowFunction = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

struct AXProjection {
    let tree: String
    let elements: [JSONValue]
    let indexed: [Int: AXUIElement]
    let focusedWindowID: UInt32?
    let truncated: Bool
}

enum AXNodeObservation {
    case children([AXUIElement])
    case element(role: String, attribute: (String) throws -> CFTypeRef?)
}

final class AXAccess {
    let timeout: Float
    let cancellation: CancellationLatch
    private let framework: UnsafeMutableRawPointer?
    private let windowFunction: AXWindowFunction?
    private var enabledProcesses: Set<ProcessIdentityKey> = []

    init(timeout: Float, cancellation: CancellationLatch) {
        self.timeout = timeout
        self.cancellation = cancellation
        framework = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_LOCAL)
        if let framework, let symbol = dlsym(framework, "_AXUIElementGetWindow") {
            windowFunction = unsafeBitCast(symbol, to: AXWindowFunction.self)
        } else { windowFunction = nil }
    }
    deinit { if let framework { dlclose(framework) } }

    private func prepare(_ element: AXUIElement) throws {
        try cancellation.check()
        let error = AXUIElementSetMessagingTimeout(element, timeout)
        guard error == .success else { throw failure(error, "set AX messaging timeout") }
    }
    func failure(_ error: AXError, _ operation: String) -> NativeFailure {
        NativeFailure(code: error == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR",
                      message: "Accessibility \(operation) failed with error \(error.rawValue)", accessibilityError: error.rawValue)
    }
    private func absent(_ error: AXError) -> Bool { error == .attributeUnsupported || error == .noValue || error == .notImplemented }
    static func optionalAttributeUnavailable(_ error: AXError, attribute: String) -> Bool {
        // File-panel controls can lack descriptive metadata while their role
        // and accessibility children remain readable.
        guard error == .failure else { return false }
        let optional: Set<String> = ["AXValue", "AXTitle", "AXDescription", "AXIdentifier", "AXPlaceholderValue",
                                     "AXSubrole", "AXEnabled", "AXSelected", "AXSelectedText", "AXSelectedTextRange", "AXPosition", "AXSize", "AXMain", "AXMinimized"]
        return optional.contains(attribute)
    }
    static func actionsUnavailable(_ error: AXError) -> Bool {
        error == .failure || error == .actionUnsupported
    }
    func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
        try prepare(element)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if absent(error) || Self.optionalAttributeUnavailable(error, attribute: name) { return nil }
        guard error == .success else { throw failure(error, "read \(name)") }
        guard let value else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) returned no value after success") }
        return value
    }
    func string(_ element: AXUIElement, _ name: String) throws -> String? {
        try stringValue(try attribute(element, name), attribute: name)
    }
    private func stringValue(_ raw: CFTypeRef?, attribute name: String) throws -> String? {
        guard let value = raw else { return nil }
        guard CFGetTypeID(value) == CFStringGetTypeID() else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not a string") }
        return value as? String
    }
    func boolean(_ element: AXUIElement, _ name: String) throws -> Bool? {
        try booleanValue(try attribute(element, name), attribute: name)
    }
    private func booleanValue(_ raw: CFTypeRef?, attribute name: String) throws -> Bool? {
        guard let value = raw else { return nil }
        guard CFGetTypeID(value) == CFBooleanGetTypeID() else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not a boolean") }
        return (value as? NSNumber)?.boolValue
    }
    func elementValue(_ value: CFTypeRef, _ name: String) throws -> AXUIElement {
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not an element") }
        return unsafeDowncast(value, to: AXUIElement.self)
    }
    func element(_ element: AXUIElement, _ name: String) throws -> AXUIElement? {
        guard let value = try attribute(element, name) else { return nil }
        return try elementValue(value, name)
    }
    func children(_ element: AXUIElement, _ name: String = "AXChildren") throws -> [AXUIElement] {
        try childValues(try attribute(element, name), attribute: name)
    }
    private func childValues(_ raw: CFTypeRef?, attribute name: String) throws -> [AXUIElement] {
        guard let value = raw else { return [] }
        guard CFGetTypeID(value) == CFArrayGetTypeID(), let array = value as? [AnyObject] else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not an array")
        }
        return try array.map { try elementValue($0, name) }
    }
    func windowID(_ element: AXUIElement) throws -> UInt32? {
        try prepare(element)
        guard let windowFunction else { return nil }
        var id: UInt32 = 0
        let error = windowFunction(element, &id)
        if absent(error) { return nil }
        guard error == .success else { throw failure(error, "resolve window ID") }
        return id == 0 ? nil : id
    }
    func focusedWindowID(_ pid: Int32) throws -> UInt32? {
        guard let focused = try element(AXUIElementCreateApplication(pid), "AXFocusedWindow") else { return nil }
        return try windowID(focused)
    }
    func actions(_ element: AXUIElement) throws -> [String] {
        try prepare(element)
        var names: CFArray?
        let error = AXUIElementCopyActionNames(element, &names)
        if absent(error) || Self.actionsUnavailable(error) { return [] }
        guard error == .success else { throw failure(error, "read actions") }
        guard let names else { return [] }
        guard let result = names as? [String] else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility actions are not strings") }
        return result
    }
    func writable(_ element: AXUIElement, _ name: String) throws -> Bool {
        try prepare(element)
        var result: DarwinBoolean = false
        let error = AXUIElementIsAttributeSettable(element, name as CFString, &result)
        if absent(error) { return false }
        guard error == .success else { throw failure(error, "read attribute writability") }
        return result.boolValue
    }
    func requireEnabled(_ element: AXUIElement) throws {
        if try boolean(element, "AXEnabled") == false { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility element is disabled") }
    }
    func perform(_ element: AXUIElement, _ action: String) throws {
        try requireEnabled(element)
        try prepare(element)
        let error = AXUIElementPerformAction(element, action as CFString)
        guard error == .success else { throw failure(error, "perform \(action)") }
    }
    func setValue(_ element: AXUIElement, _ value: String) throws {
        try requireEnabled(element)
        try prepare(element)
        let error = AXUIElementSetAttributeValue(element, "AXValue" as CFString, value as CFString)
        guard error == .success else { throw failure(error, "set AXValue") }
    }
    func paste(_ pid: Int32, maxElements: Int, maxDepth: Int, beforeDispatch: () throws -> Void) throws {
        guard let menu = try element(AXUIElementCreateApplication(pid), "AXMenuBar") else {
            throw NativeFailure(code: "UNSUPPORTED", message: "The application does not expose a Paste menu command")
        }
        var pending: [(AXUIElement, Int)] = [(menu, 0)]
        var found: AXUIElement?
        var seen: [CFHashCode: [AXUIElement]] = [:]
        var count = 0
        while let (node, depth) = pending.popLast() {
            let hash = CFHash(node)
            if seen[hash, default: []].contains(where: { CFEqual($0, node) }) { continue }
            seen[hash, default: []].append(node)
            guard count < maxElements, depth <= maxDepth else {
                throw NativeFailure(code: "UNSUPPORTED", message: "Paste menu discovery exceeded its observation limits")
            }
            count += 1
            if try string(node, "AXRole") == "AXMenuItem", try string(node, "AXMenuItemCmdChar")?.lowercased() == "v" {
                let raw = try attribute(node, "AXMenuItemCmdModifiers")
                if let raw, CFGetTypeID(raw) == CFNumberGetTypeID(), let number = raw as? NSNumber, number.intValue == 0,
                   try actions(node).contains("AXPress"), try boolean(node, "AXEnabled") != false {
                    guard found == nil else { throw NativeFailure(code: "UNSUPPORTED", message: "The application exposes ambiguous Paste commands") }
                    found = node
                }
            }
            for child in try children(node) { pending.append((child, depth + 1)) }
        }
        guard let found else { throw NativeFailure(code: "UNSUPPORTED", message: "No enabled standard Paste command is available") }
        try beforeDispatch()
        try perform(found, "AXPress")
    }
    func selectText(_ element: AXUIElement, text: String, prefix: String?, suffix: String?, mode: String) throws {
        try requireEnabled(element)
        guard try writable(element, "AXSelectedTextRange"), let original = try string(element, "AXValue") else {
            throw NativeFailure(code: "UNSUPPORTED", message: "This control does not expose writable text selection")
        }
        var range = try TextSelection.range(in: original, text: text, prefix: prefix, suffix: suffix, mode: mode)
        guard let value = AXValueCreate(.cfRange, &range) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create the text selection range")
        }
        guard try string(element, "AXValue") == original else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Text changed before selection; read fresh state")
        }
        try prepare(element)
        let error = AXUIElementSetAttributeValue(element, "AXSelectedTextRange" as CFString, value)
        guard error == .success else { throw failure(error, "set text selection") }
        let actual = try textRange(attribute(element, "AXSelectedTextRange"))
        guard actual?.location == range.location, actual?.length == range.length, try string(element, "AXValue") == original else {
            throw NativeFailure(code: "SELECTION_CHANGED", message: "The requested selection was not retained; read fresh state before input")
        }
    }
    private func textRange(_ raw: CFTypeRef?) throws -> CFRange? {
        guard let raw else { return nil }
        guard CFGetTypeID(raw) == AXValueGetTypeID() else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "AXSelectedTextRange is not an accessibility value")
        }
        let value = unsafeDowncast(raw, to: AXValue.self)
        var range = CFRange()
        guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range), range.location >= 0, range.length >= 0 else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "AXSelectedTextRange is not a valid range")
        }
        return range
    }
    func bounds(_ element: AXUIElement) throws -> WindowBounds? {
        guard let position = try attribute(element, "AXPosition") else { return nil }
        return try bounds(position: position, size: attribute(element, "AXSize"))
    }
    /// Resolve an exact AX window or sheet without enabling accessibility or traversing its controls.
    func windowBounds(_ id: UInt32, owner: ProcessIdentity) throws -> WindowBounds? {
        let app = AXUIElementCreateApplication(owner.pid)
        var windows = try children(app, "AXWindows")
        if let focused = try element(app, "AXFocusedWindow"), !windows.contains(where: { CFEqual($0, focused) }) {
            windows.append(focused)
        }
        for window in windows {
            let role = try string(window, "AXRole")
            guard role == "AXWindow" || role == "AXSheet" else { continue }
            if try windowID(window) == id { return try bounds(window) }
            for sheet in try children(window) where try string(sheet, "AXRole") == "AXSheet" {
                if try windowID(sheet) == id { return try bounds(sheet) }
            }
        }
        return nil
    }
    private func bounds(position: CFTypeRef?, size: CFTypeRef?) throws -> WindowBounds? {
        guard let position, let size else { return nil }
        guard CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        let positionValue = unsafeDowncast(position, to: AXValue.self)
        let sizeValue = unsafeDowncast(size, to: AXValue.self)
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &dimensions),
              point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite else { return nil }
        return WindowBounds(x: point.x, y: point.y, width: dimensions.width, height: dimensions.height)
    }
    private func controlValue(_ raw: CFTypeRef?) -> String? {
        guard let value = raw else { return nil }
        if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
        if CFGetTypeID(value) == CFBooleanGetTypeID() { return ((value as? NSNumber)?.boolValue == true) ? "1" : "0" }
        if CFGetTypeID(value) == CFNumberGetTypeID() { return (value as? NSNumber)?.stringValue }
        return nil
    }
    // A node's values are retained only for this observation. Input always reads
    // live attributes, and unsupported batch APIs retain the individual read path.
    private func metadata(_ element: AXUIElement) throws -> [String: CFTypeRef]? {
        try prepare(element)
        let names = ["AXRole", "AXTitle", "AXValue", "AXPlaceholderValue", "AXDescription", "AXEnabled",
                     "AXIdentifier", "AXPosition", "AXSize", "AXChildren", "AXSelected", "AXSelectedText", "AXSelectedTextRange"]
        var output: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &output)
        if error == .notImplemented || error == .attributeUnsupported { return nil }
        guard error == .success else { throw failure(error, "read node attributes") }
        guard let output, CFArrayGetCount(output) == names.count else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility batch returned mismatched attribute values")
        }
        let values = output as [AnyObject]
        return Dictionary(uniqueKeysWithValues: zip(names, values))
    }
    static func batchAttribute(_ value: CFTypeRef, name: String) throws -> CFTypeRef? {
        if CFGetTypeID(value) == CFNullGetTypeID() { return nil }
        if CFGetTypeID(value) == AXValueGetTypeID() {
            let wrapped = unsafeDowncast(value, to: AXValue.self)
            if AXValueGetType(wrapped) == .axError {
                var error = AXError.success
                guard AXValueGetValue(wrapped, .axError, &error), error != .success else {
                    throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility batch returned an invalid attribute error")
                }
                if error == .attributeUnsupported || error == .noValue || error == .notImplemented
                    || optionalAttributeUnavailable(error, attribute: name) { return nil }
                throw NativeFailure(code: error == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR",
                                    message: "Accessibility read \(name) failed with error \(error.rawValue)", accessibilityError: error.rawValue)
            }
        }
        return value
    }

    // Only consumed attributes are decoded: transparent containers require role
    // and children even when optional metadata carries an accessibility error.
    func nodeObservation(attributes: [String: CFTypeRef]?, fallback: @escaping (String) throws -> CFTypeRef?) throws -> AXNodeObservation {
        func observed(_ name: String) throws -> CFTypeRef? {
            guard let attributes else { return try fallback(name) }
            guard let value = attributes[name] else { throw NativeFailure(code: "NATIVE_ERROR", message: "Missing requested observation attribute") }
            return try Self.batchAttribute(value, name: name)
        }
        let role = try stringValue(observed("AXRole"), attribute: "AXRole") ?? "AXUnknown"
        if role == "AXGroup" || role == "AXScrollArea" {
            return .children(try childValues(observed("AXChildren"), attribute: "AXChildren"))
        }
        return .element(role: role, attribute: observed)
    }

    private func enableAX(_ app: AXUIElement, identity: ProcessIdentity) throws {
        let key = ProcessIdentityKey(identity)
        if enabledProcesses.contains(key) { return }
        try prepare(app)
        var error = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if error == .attributeUnsupported { error = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
        if error == .apiDisabled { throw failure(error, "enable application accessibility") }
        if error == .success { enabledProcesses.insert(key) }
    }

    func project(identity: ProcessIdentity, windowID requested: UInt32?, maxElements: Int, maxDepth: Int) throws -> AXProjection {
        let app = AXUIElementCreateApplication(identity.pid)
        try enableAX(app, identity: identity)
        var roots = try children(app)
        func appendUnique(_ element: AXUIElement) {
            if !roots.contains(where: { CFEqual($0, element) }) { roots.append(element) }
        }
        for root in try children(app, "AXWindows") { appendUnique(root) }
        let focused = try element(app, "AXFocusedWindow")
        if let focused { appendUnique(focused) }
        var cursor = 0
        while cursor < roots.count && cursor < maxElements {
            let root = roots[cursor]
            cursor += 1
            let role = try string(root, "AXRole")
            guard role == "AXWindow" || role == "AXSheet" else { continue }
            for child in try children(root) where roots.count < maxElements {
                if try string(child, "AXRole") == "AXSheet" { appendUnique(child) }
            }
        }
        let focusedID = try focused.flatMap { try windowID($0) }
        if let requested {
            var matches: [AXUIElement] = []
            var nonWindows: [AXUIElement] = []
            var anonymousSheets: [AXUIElement] = []
            for root in roots {
                let role = try string(root, "AXRole") ?? ""
                if role == "AXWindow" || role == "AXSheet" {
                    let id = try windowID(root)
                    if id == requested { matches.append(root) }
                    else if role == "AXSheet" && id == nil { anonymousSheets.append(root) }
                } else { nonWindows.append(root) }
            }
            if matches.isEmpty {
                _ = try NativePlatform.ownedWindow(identity.pid, requested)
                return AXProjection(tree: "", elements: [], indexed: [:], focusedWindowID: focusedID, truncated: false)
            }
            let dialog = try matches.contains { root in
                let role = try string(root, "AXRole")
                let subrole = try string(root, "AXSubrole")
                let identifier = try string(root, "AXIdentifier")
                return role == "AXSheet" || ["AXDialog", "AXSystemDialog", "AXSheet"].contains(subrole ?? "") || ["open-panel", "save-panel"].contains(identifier ?? "")
            }
            roots = matches
            for root in nonWindows {
                let role = try string(root, "AXRole")
                if !dialog || role != "AXMenuBar" { roots.append(root) }
            }
            if !dialog { roots.append(contentsOf: anonymousSheets) }
        }
        var visited: [CFHashCode: [AXUIElement]] = [:]
        var count = 0
        var truncated = false
        var lines: [String] = []
        var elements: [JSONValue] = []
        var indexed: [Int: AXUIElement] = [:]
        let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXStaticText"]
        let valueRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXStepper", "AXCheckBox", "AXRadioButton"]
        func walk(_ element: AXUIElement, level: Int, depth: Int) throws {
            try cancellation.check()
            let hash = CFHash(element)
            if visited[hash, default: []].contains(where: { CFEqual($0, element) }) { return }
            guard count < maxElements, depth <= maxDepth else { truncated = true; return }
            visited[hash, default: []].append(element)
            count += 1
            let role: String
            let observed: (String) throws -> CFTypeRef?
            switch try nodeObservation(attributes: metadata(element), fallback: { try self.attribute(element, $0) }) {
            case .children(let children):
                for child in children { try walk(child, level: level, depth: depth + 1) }
                return
            case .element(let value, let read):
                role = value
                observed = read
            }
            let title = try stringValue(observed("AXTitle"), attribute: "AXTitle")
            let rawValue = try controlValue(observed("AXValue"))
            let value: String?
            if let rawValue, !rawValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { value = rawValue }
            else { value = try stringValue(observed("AXPlaceholderValue"), attribute: "AXPlaceholderValue") }
            let description = try stringValue(observed("AXDescription"), attribute: "AXDescription")
            let actionNames = try self.actions(element)
            let valueWritable: Bool
            if valueRoles.contains(role) { valueWritable = try writable(element, "AXValue") }
            else { valueWritable = false }
            let enabled = try booleanValue(observed("AXEnabled"), attribute: "AXEnabled")
            let selected = try booleanValue(observed("AXSelected"), attribute: "AXSelected")
            let selectionWritable = textRoles.contains(role) ? try writable(element, "AXSelectedTextRange") : false
            let selectedRange = textRoles.contains(role) ? try textRange(observed("AXSelectedTextRange")) : nil
            let selectedText = textRoles.contains(role) ? try stringValue(observed("AXSelectedText"), attribute: "AXSelectedText") : nil
            let addressable = enabled != false && (!actionNames.isEmpty || valueWritable || selectionWritable)
            let meaningful = [title, value, description].contains { !($0?.isEmpty ?? true) }
            if !addressable && !meaningful && role != "AXWindow" && role != "AXSheet" {
                for child in try childValues(observed("AXChildren"), attribute: "AXChildren") { try walk(child, level: level, depth: depth + 1) }
                return
            }
            let index: Int? = addressable ? indexed.count : nil
            var line = String(repeating: "  ", count: level) + "- "
            if let index { indexed[index] = element; line += "[\(index)] " }
            line += role
            if enabled == false { line += " disabled" }
            if valueWritable { line += " valueWritable=true" }
            if selectionWritable { line += " selectionWritable=true" }
            if let selected { line += " selected=\(selected)" }
            if let title, !title.isEmpty { line += " \(String(reflecting: title))" }
            if let value, !value.isEmpty { line += " = \(String(reflecting: value))" }
            if let description, !description.isEmpty { line += " (\(description))" }
            if let selectedRange { line += " selection=[\(selectedRange.location), \(selectedRange.length)]" }
            if let selectedText, !selectedText.isEmpty { line += " selectedText=\(String(reflecting: selectedText))" }
            if !actionNames.isEmpty { line += " actions=[\(actionNames.joined(separator: ", "))]" }
            lines.append(line)
            if let index {
                let frame: WindowBounds?
                if let position = try observed("AXPosition") { frame = try bounds(position: position, size: observed("AXSize")) }
                else { frame = nil }
                let frameJSON: JSONValue = frame.map { .array([.number($0.x), .number($0.y), .number($0.width), .number($0.height)]) } ?? .null
                elements.append(.object([
                    "index": .number(Double(index)), "role": .string(role), "title": title.map(JSONValue.string) ?? .null,
                    "value": value.map(JSONValue.string) ?? .null, "description": description.map(JSONValue.string) ?? .null,
                    "identifier": try stringValue(observed("AXIdentifier"), attribute: "AXIdentifier").map(JSONValue.string) ?? .null,
                    "bounds": frameJSON, "actions": .array(actionNames.map(JSONValue.string)), "enabled": enabled.map(JSONValue.bool) ?? .null,
                    "valueWritable": .bool(valueWritable), "selectionWritable": .bool(selectionWritable),
                    "selected": selected.map(JSONValue.bool) ?? .null,
                    "selectedText": selectedText.map(JSONValue.string) ?? .null,
                    "selectedRange": selectedRange.map { .array([.number(Double($0.location)), .number(Double($0.length))]) } ?? .null,
                ]))
            }
            for child in try childValues(observed("AXChildren"), attribute: "AXChildren") { try walk(child, level: level + 1, depth: depth + 1) }
        }
        for root in roots { try walk(root, level: 0, depth: 0) }
        if truncated { lines.append("Accessibility tree truncated; observe another window or use screenshot coordinates for unlisted elements.") }
        return AXProjection(tree: lines.joined(separator: "\n"), elements: elements, indexed: indexed, focusedWindowID: focusedID, truncated: truncated)
    }

    func enclosingWindow(_ element: AXUIElement, owner: ProcessIdentity) throws -> WindowInfo {
        var current: AXUIElement? = element
        var visited: [AXUIElement] = []
        for _ in 0..<100 {
            guard let node = current else { break }
            if visited.contains(where: { CFEqual($0, node) }) { break }
            visited.append(node)
            let role = try string(node, "AXRole")
            if role == "AXWindow" || role == "AXSheet", let id = try windowID(node) {
                return try WindowGeometry.resolve(owner: owner, windowID: id) { try bounds(node) }
            }
            current = try self.element(node, "AXParent")
        }
        throw NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Element has no app-owned window or sheet; refresh getAXState")
    }
    func keyboardRecipient(_ owner: ProcessIdentity, catalog: ApplicationCatalogSnapshot) throws -> ProcessIdentity {
        var current = try element(AXUIElementCreateApplication(owner.pid), "AXFocusedWindow")
        var visited: [AXUIElement] = []
        for _ in 0..<100 {
            guard let node = current else { return owner }
            if visited.contains(where: { CFEqual($0, node) }) { break }
            visited.append(node)
            if ["open-panel", "save-panel"].contains(try string(node, "AXIdentifier") ?? "") {
                guard let hostID = try windowID(node) else { throw NativeFailure(code: "PANEL_NOT_READY", message: "File panel has no window ID") }
                _ = try NativePlatform.ownedWindow(owner.pid, hostID)
                var recipient: (ProcessIdentity, UInt32)?
                for child in try children(node) {
                    guard let id = try windowID(child), let window = NativePlatform.windows(allLayers: true).first(where: { $0.windowID == id }), window.pid != owner.pid else { continue }
                    guard catalog.application(window.pid)?.bundleID == "com.apple.appkit.xpc.openAndSavePanelService" else {
                        throw NativeFailure(code: "PANEL_NOT_READY", message: "File panel refers to an unsupported remote process")
                    }
                    let process = try NativePlatform.identity(window.pid)
                    if let old = recipient, old.0 != process || old.1 != id { throw NativeFailure(code: "PANEL_NOT_READY", message: "File panel has ambiguous remote recipients") }
                    recipient = (process, id)
                }
                guard let (process, id) = recipient else { throw NativeFailure(code: "PANEL_NOT_READY", message: "System file panel has no ready input recipient") }
                var focus = try element(AXUIElementCreateApplication(process.pid), "AXFocusedWindow")
                for _ in 0..<100 {
                    guard let focused = focus else { break }
                    if try windowID(focused) == id { try NativePlatform.verify(process); return process }
                    focus = try element(focused, "AXParent")
                }
                throw NativeFailure(code: "PANEL_NOT_READY", message: "System file panel focus changed; observe fresh state")
            }
            current = try element(node, "AXParent")
        }
        throw NativeFailure(code: "PANEL_NOT_READY", message: "Focused accessibility ancestry exceeds the traversal limit")
    }
}

private struct ProcessIdentityKey: Hashable {
    let pid: Int32
    let seconds: UInt64
    let microseconds: UInt64
    init(_ value: ProcessIdentity) { pid = value.pid; seconds = value.startedSeconds; microseconds = value.startedMicroseconds }
}
