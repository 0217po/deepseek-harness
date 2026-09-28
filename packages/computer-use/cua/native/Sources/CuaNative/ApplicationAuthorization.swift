// Native application identity is verified before the Host asks for consent.
import CryptoKit
import Foundation
import Security

enum ApplicationAuthorization {
    // Signed applications retain decisions across restarts only at the same executable path
    // and with the same designated requirement. Unsigned/ad-hoc code gets process-only consent.
    static func describe(_ identity: ProcessIdentity, name: String, expectedExecutablePath: String?) throws -> JSONValue {
        try NativePlatform.verify(identity)
        guard let executablePath = NativePlatform.executablePath(identity.pid), let expectedExecutablePath else {
            throw NativeFailure(code: "APP_UNAVAILABLE", message: "Cannot identify the application executable")
        }
        let path = URL(fileURLWithPath: executablePath).resolvingSymlinksInPath().path
        guard path == URL(fileURLWithPath: expectedExecutablePath).resolvingSymlinksInPath().path else {
            throw NativeFailure(code: "STALE_APP", message: "Application executable changed during selection; select the application again")
        }
        let requirement = signingRequirement(identity.pid)
        let authority = requirement ?? "process:\(identity.pid):\(identity.startedSeconds):\(identity.startedMicroseconds)"
        let id = SHA256.hash(data: Data((path + "\n" + authority).utf8)).map { String(format: "%02x", $0) }.joined()
        try NativePlatform.verify(identity)
        return .object([
            "id": .string(id), "name": .string(name), "executablePath": .string(path),
            "persistable": .bool(requirement != nil),
        ])
    }

    private static func signingRequirement(_ pid: Int32) -> String? {
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: pid] as CFDictionary,
                                            SecCSFlags(), &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else { return nil }
        var info: CFDictionary?
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any],
              let flags = values[kSecCodeInfoFlags as String] as? NSNumber,
              !SecCodeSignatureFlags(rawValue: flags.uint32Value).contains(.adhoc) else { return nil }
        var requirement: SecRequirement?
        var text: CFString?
        guard SecCodeCopyDesignatedRequirement(staticCode, SecCSFlags(), &requirement) == errSecSuccess, let requirement,
              SecRequirementCopyString(requirement, SecCSFlags(), &text) == errSecSuccess else { return nil }
        return text as String?
    }
}
