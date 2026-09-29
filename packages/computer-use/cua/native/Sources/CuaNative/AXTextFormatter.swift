// Pure model-facing text projection; the AX walker owns native references, indexing and traversal.
import Foundation

struct AXTextNode {
    let index: Int?
    let role: String
    let title: String?
    let value: String?
    let description: String?
    let actions: [String]
    let enabled: Bool?
    let valueWritable: Bool
    let selectionWritable: Bool
    let selected: Bool?
    let selectedRange: CFRange?
    let selectedText: String?
}

enum AXTextFormatter {
    static let truncated = "Accessibility tree truncated; observe another window or use screenshot coordinates for unlisted elements."
    static func line(_ node: AXTextNode, level: Int) -> String {
        var line = String(repeating: "  ", count: level) + "- "
        if let index = node.index { line += "[\(index)] " }
        line += node.role
        if node.enabled == false { line += " disabled" }
        if node.valueWritable { line += " valueWritable=true" }
        if node.selectionWritable { line += " selectionWritable=true" }
        if let selected = node.selected { line += " selected=\(selected)" }
        if let title = node.title, !title.isEmpty { line += " \(String(reflecting: title))" }
        if let value = node.value, !value.isEmpty { line += " = \(String(reflecting: value))" }
        if let description = node.description, !description.isEmpty { line += " (\(description))" }
        if let range = node.selectedRange { line += " selection=[\(range.location), \(range.length)]" }
        if let text = node.selectedText, !text.isEmpty { line += " selectedText=\(String(reflecting: text))" }
        if !node.actions.isEmpty { line += " actions=[\(node.actions.joined(separator: ", "))]" }
        return line
    }
}
