// Bounded line I/O and cooperative termination independent of the AX executor.
import Foundation
import Dispatch
import Darwin

final class CancellationLatch: @unchecked Sendable {
    // The synchronous AX/input loops cannot await a cancellation message on their own actor.
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.withLock { cancelled = true } }
    func check() throws {
        if lock.withLock({ cancelled }) { throw NativeFailure(code: "NATIVE_CANCELLED", message: "Helper operation cancelled") }
    }
    var isCancelled: Bool { lock.withLock { cancelled } }
}

struct HelperConfiguration: Sendable {
    var maxRequestBytes = 1024 * 1024
    var maxResponseBytes = 32 * 1024 * 1024
    var axTimeoutSeconds: Float = 30
    var shutdownGraceSeconds: Double = 3
    init(arguments: [String]) throws {
        var index = 0
        while index < arguments.count {
            guard index + 1 < arguments.count else { throw RequestParameters.invalid("Missing value for \(arguments[index])") }
            let key = arguments[index]
            let text = arguments[index + 1]
            switch key {
            case "--max-request-bytes", "--max-response-bytes":
                guard let value = Int(text), value >= 1024, value < Int.max else { throw RequestParameters.invalid("\(key) must be a positive byte limit") }
                if key == "--max-request-bytes" { maxRequestBytes = value } else { maxResponseBytes = value }
            case "--ax-timeout-ms":
                guard let value = Float(text), value.isFinite, value > 0 else { throw RequestParameters.invalid("AX timeout must be positive") }
                axTimeoutSeconds = value / 1000
            case "--shutdown-grace-ms":
                guard let value = Double(text), value.isFinite, value > 0 else { throw RequestParameters.invalid("Shutdown grace must be positive") }
                shutdownGraceSeconds = value / 1000
            default: throw RequestParameters.invalid("Unknown helper option \(key)")
            }
            index += 2
        }
    }
}

final class JSONLInput: Sendable {
    // Buffer and reads belong exclusively to queue; stop state uses the shared latch.
    private let queue = DispatchQueue(label: "dsh.cua.stdin")
    private let permit = DispatchSemaphore(value: 0)
    private let cancellation: CancellationLatch
    private let limit: Int
    init(limit: Int, cancellation: CancellationLatch) { self.limit = limit; self.cancellation = cancellation }
    func start(onFrame: @escaping @Sendable (Data) -> Void, onEOF: @escaping @Sendable () -> Void,
               onFailure: @escaping @Sendable (NativeFailure) -> Void) {
        queue.async {
            var buffer = Data()
            do {
                while !self.cancellation.isCancelled {
                    if let newline = buffer.firstIndex(of: 10) {
                        let frame = Data(buffer[..<newline])
                        buffer.removeSubrange(...newline)
                        guard frame.count + 1 <= self.limit else { throw NativeFailure(code: "NATIVE_REQUEST_LIMIT", message: "Request exceeded helper byte limit") }
                        onFrame(frame)
                        self.permit.wait()
                        continue
                    }
                    guard buffer.count <= self.limit else { throw NativeFailure(code: "NATIVE_REQUEST_LIMIT", message: "Request exceeded helper byte limit") }
                    let chunk = try FileHandle.standardInput.read(upToCount: min(65536, self.limit + 1 - buffer.count)) ?? Data()
                    if chunk.isEmpty {
                        if !buffer.isEmpty { onFrame(buffer); self.permit.wait() }
                        onEOF()
                        return
                    }
                    buffer.append(chunk)
                }
            } catch let error as NativeFailure { onFailure(error) }
            catch { onFailure(NativeFailure(code: "NATIVE_IO", message: "Reading helper stdin failed: \(error.localizedDescription)")) }
        }
    }
    func next() { permit.signal() }
    func stop() { permit.signal(); try? FileHandle.standardInput.close() }
}

final class JSONLWriter: Sendable {
    private let queue = DispatchQueue(label: "dsh.cua.stdout")
    let limit: Int
    init(limit: Int) { self.limit = limit }
    func write(_ response: JSONValue) async throws {
        let limit = self.limit
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async {
                do {
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
                    var frame = try encoder.encode(response)
                    frame.append(10)
                    guard frame.count <= limit else { throw NativeFailure(code: "NATIVE_RESPONSE_LIMIT", message: "Reply exceeded helper byte limit") }
                    try FileHandle.standardOutput.write(contentsOf: frame)
                    continuation.resume()
                } catch let error as NativeFailure { continuation.resume(throwing: error) }
                catch { continuation.resume(throwing: NativeFailure(code: "NATIVE_IO", message: "Encoding or writing helper reply failed")) }
            }
        }
    }
}
