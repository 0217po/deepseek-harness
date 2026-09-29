// Formatting fixtures pin model-visible text independently of accessibility APIs.
import Foundation
import Testing
@testable import CuaNative

@Test func formatsEditableTextAndSelectionWithoutAssigningAnotherIndex() {
    let node = AXTextNode(index: 7, role: "AXTextArea", title: "Editor", value: "a😀 target", description: "Document",
                          actions: [], enabled: true, valueWritable: true, selectionWritable: true, selected: nil,
                          selectedRange: CFRange(location: 4, length: 6), selectedText: "target")
    #expect(AXTextFormatter.line(node, level: 1)
        == "  - [7] AXTextArea valueWritable=true selectionWritable=true \"Editor\" = \"a😀 target\" (Document) selection=[4, 6] selectedText=\"target\"")
}

@Test func formatsDisabledAndSelectedControlsWithoutInventingCapabilities() {
    let node = AXTextNode(index: nil, role: "AXButton", title: "Save", value: nil, description: nil,
                          actions: ["AXPress"], enabled: false, valueWritable: false, selectionWritable: false,
                          selected: false, selectedRange: nil, selectedText: nil)
    #expect(AXTextFormatter.line(node, level: 0) == "- AXButton disabled selected=false \"Save\" actions=[AXPress]")
    let empty = AXTextNode(index: nil, role: "AXWindow", title: "", value: "", description: "",
                           actions: [], enabled: nil, valueWritable: false, selectionWritable: false,
                           selected: nil, selectedRange: nil, selectedText: "")
    #expect(AXTextFormatter.line(empty, level: 0) == "- AXWindow")
}
