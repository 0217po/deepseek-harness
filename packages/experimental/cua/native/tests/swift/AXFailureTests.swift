// Optional control values do not hide permission, communication or discovery failures.
import ApplicationServices
import Testing
@testable import CuaNative

@Test func onlyTreatsGenericAXValueFailureAsAnUnavailableValue() {
    #expect(AXAccess.valueUnavailable(.failure, attribute: "AXValue"))
    for name in ["AXChildren", "AXWindows", "AXFocusedWindow", "AXRole"] {
        #expect(!AXAccess.valueUnavailable(.failure, attribute: name))
    }
    for error in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .illegalArgument] {
        #expect(!AXAccess.valueUnavailable(error, attribute: "AXValue"))
        #expect(!AXAccess.actionsUnavailable(error))
    }
    #expect(AXAccess.actionsUnavailable(.failure))
    #expect(AXAccess.actionsUnavailable(.actionUnsupported))
}
