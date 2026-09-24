// Optional control values do not hide permission, communication or discovery failures.
import ApplicationServices
import Foundation
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

private func wrappedAXError(_ code: AXError) throws -> AXValue {
    var error = code
    return try #require(AXValueCreate(.axError, &error))
}

@Test func batchValuesRetainScalarArrayAndGeometryTypes() throws {
    var point = CGPoint(x: 20, y: 40)
    let position = try #require(AXValueCreate(.cgPoint, &point))
    let values: [CFTypeRef] = ["Title" as CFString, kCFBooleanTrue, NSNumber(value: 7), [] as CFArray, position]
    for value in values {
        let decoded = try #require(try AXAccess.batchAttribute(value, name: "AXValue"))
        #expect(CFGetTypeID(decoded) == CFGetTypeID(value))
        #expect(CFEqual(decoded, value))
    }
    #expect(try AXAccess.batchAttribute(NSNull(), name: "AXValue") == nil)
}

@Test func batchUnavailableValuesKeepIndividualAttributeRules() throws {
    for error in [AXError.attributeUnsupported, .noValue, .notImplemented] {
        #expect(try AXAccess.batchAttribute(wrappedAXError(error), name: "AXChildren") == nil)
    }
    #expect(try AXAccess.batchAttribute(wrappedAXError(.failure), name: "AXTitle") == nil)
    #expect(throws: NativeFailure.self) {
        try AXAccess.batchAttribute(wrappedAXError(.failure), name: "AXChildren")
    }
}

@Test func batchFailuresPreservePermissionCommunicationAndStaleElementErrors() throws {
    for code in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .illegalArgument] {
        let value = try wrappedAXError(code)
        do {
            _ = try AXAccess.batchAttribute(value, name: "AXTitle")
            Issue.record("Batch attribute accepted an accessibility failure")
        } catch let error as NativeFailure {
            #expect(error.code == (code == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR"))
            #expect(error.message.contains("AXTitle"))
            #expect(error.message.contains(String(code.rawValue)))
        }
    }
}

@Test func batchRejectsSuccessEncodedAsAnAttributeError() throws {
    let value = try wrappedAXError(.success)
    #expect(throws: NativeFailure.self) {
        try AXAccess.batchAttribute(value, name: "AXTitle")
    }
}
