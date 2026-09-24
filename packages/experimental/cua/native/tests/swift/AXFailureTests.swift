// Optional control values do not hide permission, communication or discovery failures.
import ApplicationServices
import Testing
@testable import CuaNative

@Test func optionalMetadataFailuresDoNotHideStructuralOrPermissionFailures() {
    for name in ["AXValue", "AXTitle", "AXDescription", "AXIdentifier", "AXPlaceholderValue", "AXSubrole",
                 "AXEnabled", "AXPosition", "AXSize", "AXMain", "AXMinimized"] {
        #expect(AXAccess.optionalAttributeUnavailable(.failure, attribute: name))
    }
    for name in ["AXChildren", "AXWindows", "AXFocusedWindow", "AXRole", "AXParent"] {
        #expect(!AXAccess.optionalAttributeUnavailable(.failure, attribute: name))
    }
    for error in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .illegalArgument] {
        #expect(!AXAccess.optionalAttributeUnavailable(error, attribute: "AXValue"))
        #expect(!AXAccess.actionsUnavailable(error))
    }
    #expect(AXAccess.actionsUnavailable(.failure))
    #expect(AXAccess.actionsUnavailable(.actionUnsupported))
}
