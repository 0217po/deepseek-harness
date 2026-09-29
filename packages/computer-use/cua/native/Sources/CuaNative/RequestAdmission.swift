// Strict model/native request admission; defaults match the existing JSONL operations.
import Foundation

struct RequestParameters: Sendable {
    static let fields: [String: Set<String>] = [
        "getCapabilities": [], "listApps": [], "getApp": ["selector"],
        "listWindows": ["appHandle"], "activate": ["appHandle"],
        "getState": ["appHandle", "windowId", "maxElements", "maxDepth"],
        "click": ["appHandle", "snapshotId", "elementIndex", "windowId", "x", "y", "mouseButton", "clickCount", "modifiers"],
        "setValue": ["appHandle", "snapshotId", "elementIndex", "value"],
        "selectText": ["appHandle", "snapshotId", "elementIndex", "text", "prefix", "suffix", "selectionType"],
        "performSecondaryAction": ["appHandle", "snapshotId", "elementIndex", "action"],
        "paste": ["appHandle", "text", "format", "maxClipboardBytes", "maxElements", "maxDepth"],
        "typeText": ["appHandle", "text"], "pressKey": ["appHandle", "key", "modifiers"],
        "scroll": ["appHandle", "windowId", "snapshotId", "x", "y", "deltaLinesX", "deltaLinesY"],
        "drag": ["appHandle", "windowId", "snapshotId", "fromX", "fromY", "toX", "toY", "durationMs", "steps", "mouseButton", "modifiers"],
        "screenshot": ["appHandle", "windowId"],
    ]
    let values: [String: JSONValue]
    init(_ request: NativeRequest) throws {
        guard let values = request.params.object else { throw Self.invalid("params must be an object") }
        guard let allowed = Self.fields[request.method] else { throw NativeFailure(code: "UNSUPPORTED", message: "Unsupported native operation: \(request.method)") }
        guard Set(values.keys).isSubset(of: allowed) else { throw Self.invalid("Unknown operation parameter") }
        self.values = values
    }
    static func invalid(_ message: String) -> NativeFailure { NativeFailure(code: "INVALID_ARGUMENT", message: message) }
    func contains(_ key: String) -> Bool { values[key] != nil }
    func string(_ key: String) throws -> String {
        guard let value = values[key]?.string else { throw Self.invalid("\(key) must be a string") }
        return value
    }
    func optionalString(_ key: String) throws -> String? { contains(key) ? try string(key) : nil }
    func number(_ key: String) throws -> Double {
        guard let value = values[key]?.number, value.isFinite else { throw Self.invalid("\(key) must be finite") }
        return value
    }
    func integer(_ key: String, in bounds: ClosedRange<Int> = Int(Int32.min)...Int(Int32.max)) throws -> Int {
        let value = try number(key)
        guard value.rounded(.towardZero) == value, value >= Double(bounds.lowerBound), value <= Double(bounds.upperBound),
              let integer = Int(exactly: value), bounds.contains(integer) else {
            throw Self.invalid("\(key) must be an integer in \(bounds)")
        }
        return integer
    }
    func windowID() throws -> UInt32 { UInt32(try integer("windowId", in: 1...Int(UInt32.max))) }
    func optionalWindowID() throws -> UInt32? { contains("windowId") ? try windowID() : nil }
    func modifiers() throws -> [String] {
        guard let value = values["modifiers"] else { return [] }
        guard case .array(let items) = value else { throw Self.invalid("modifiers must be an array") }
        let allowed: Set<String> = ["command", "cmd", "shift", "option", "alt", "control", "ctrl", "fn"]
        return try items.map { item in
            guard let name = item.string, allowed.contains(name) else { throw Self.invalid("Unsupported key modifier") }
            return name
        }
    }
    func point(_ x: String = "x", _ y: String = "y") throws -> WindowPoint { WindowPoint(x: try number(x), y: try number(y)) }
}
