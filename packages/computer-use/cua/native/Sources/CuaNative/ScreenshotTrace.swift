// Screenshot phase timing on stderr; request data and captured content stay off this channel.
import Foundation
import Dispatch

struct ScreenshotTrace: Sendable {
    let requestID: String
    private let started = DispatchTime.now().uptimeNanoseconds

    init(requestID: String) { self.requestID = requestID }

    func encoded(_ stage: String, errorCode: String? = nil) throws -> Data {
        struct Entry: Encodable {
            let requestId: String
            let stage: String
            let elapsedMs: Double
            let errorCode: String?
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        let entry = Entry(requestId: requestID, stage: stage, elapsedMs: elapsed, errorCode: errorCode)
        var line = Data("[cua-screenshot] ".utf8)
        line.append(try JSONEncoder().encode(entry))
        line.append(10)
        return line
    }

    func mark(_ stage: String, errorCode: String? = nil) {
        // A diagnostic failure must not replace the capture result or its original error.
        if let line = try? encoded(stage, errorCode: errorCode) {
            try? FileHandle.standardError.write(contentsOf: line)
        }
    }
}
