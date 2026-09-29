// Temporary clipboard contents are restored only while this transaction still owns them.
import AppKit
import Foundation

final class ClipboardPaste {
    private struct SavedItem { let values: [(NSPasteboard.PasteboardType, Data)] }
    private static let ownerType = NSPasteboard.PasteboardType("org.deepseek-harness.cua.clipboard-owner")
    private let pasteboard: NSPasteboard

    init(pasteboard: NSPasteboard = .general) { self.pasteboard = pasteboard }

    func perform(text: String, format: String, maxBytes: Int, operation: (() throws -> Void) throws -> Void) throws {
        let type: NSPasteboard.PasteboardType
        switch format {
        case "text": type = .string
        case "html": type = .html
        default: throw RequestParameters.invalid("Paste format must be text or html")
        }
        let data = Data(text.utf8)
        guard data.count <= maxBytes else { throw NativeFailure(code: "CLIPBOARD_LIMIT", message: "Paste data exceeds the configured clipboard byte limit") }
        let originalCount = pasteboard.changeCount
        let saved = try snapshot(maxBytes: maxBytes)
        let owner = Data(UUID().uuidString.utf8)
        let item = NSPasteboardItem()
        guard item.setData(data, forType: type), item.setData(owner, forType: Self.ownerType) else {
            throw NativeFailure(code: "CLIPBOARD_UNAVAILABLE", message: "Could not prepare paste contents")
        }
        guard pasteboard.changeCount == originalCount else {
            throw NativeFailure(code: "CLIPBOARD_CHANGED", message: "Clipboard changed while preserving it; paste was not dispatched")
        }
        let cleared = pasteboard.clearContents()
        guard pasteboard.writeObjects([item]) else {
            if pasteboard.changeCount == cleared { try restore(saved) }
            throw NativeFailure(code: "CLIPBOARD_UNAVAILABLE", message: "Could not publish paste contents")
        }
        let expectedCount = pasteboard.changeCount
        func owned() -> Bool { pasteboard.changeCount == expectedCount && pasteboard.data(forType: Self.ownerType) == owner }
        func requireOwnership() throws {
            guard owned() else { throw NativeFailure(code: "CLIPBOARD_CHANGED", message: "Clipboard changed before paste; input was not dispatched") }
        }
        do {
            try requireOwnership()
            try operation(requireOwnership)
        } catch {
            if owned() { try restore(saved) }
            throw error
        }
        if owned() { try restore(saved) }
    }

    private func snapshot(maxBytes: Int) throws -> [SavedItem] {
        var total = 0
        return try (pasteboard.pasteboardItems ?? []).map { item in
            let values = try item.types.map { type -> (NSPasteboard.PasteboardType, Data) in
                guard let data = item.data(forType: type) else {
                    throw NativeFailure(code: "CLIPBOARD_UNAVAILABLE", message: "Existing clipboard formats could not be preserved")
                }
                guard data.count <= maxBytes - total else {
                    throw NativeFailure(code: "CLIPBOARD_LIMIT", message: "Existing clipboard exceeds the configured preservation byte limit")
                }
                total += data.count
                return (type, data)
            }
            return SavedItem(values: values)
        }
    }

    private func restore(_ saved: [SavedItem]) throws {
        let items = try saved.map { original -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in original.values {
                guard item.setData(data, forType: type) else {
                    throw NativeFailure(code: "CLIPBOARD_RESTORE_FAILED", message: "Could not reconstruct the original clipboard formats")
                }
            }
            return item
        }
        pasteboard.clearContents()
        if !items.isEmpty && !pasteboard.writeObjects(items) {
            throw NativeFailure(code: "CLIPBOARD_RESTORE_FAILED", message: "Could not restore the original clipboard contents")
        }
    }
}
