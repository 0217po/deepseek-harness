// Public ScreenCaptureKit capture with one completion and no blocking wait on the main actor.
import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct CapturedPNG: Sendable { let bytes: Data; let width: Int; let height: Int }

private actor CaptureCompletion {
    private var continuation: CheckedContinuation<CapturedPNG, any Error>?
    private var result: Result<CapturedPNG, NativeFailure>?
    nonisolated func install(_ continuation: CheckedContinuation<CapturedPNG, any Error>) {
        Task { await installed(continuation) }
    }
    nonisolated func finish(_ result: Result<CapturedPNG, NativeFailure>) {
        Task { await finished(result) }
    }
    private func installed(_ continuation: CheckedContinuation<CapturedPNG, any Error>) {
        if let result { Self.resume(continuation, result); return }
        self.continuation = continuation
    }
    private func finished(_ result: Result<CapturedPNG, NativeFailure>) {
        guard self.result == nil else { return }
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        if let continuation { Self.resume(continuation, result) }
    }
    private static func resume(_ continuation: CheckedContinuation<CapturedPNG, any Error>, _ result: Result<CapturedPNG, NativeFailure>) {
        switch result { case .success(let image): continuation.resume(returning: image); case .failure(let error): continuation.resume(throwing: error) }
    }
}

struct WindowCapture: Sendable {
    private let encoder = DispatchQueue(label: "dsh.cua.png")
    func capture(_ target: CaptureTarget, cancellation: CancellationLatch, trace: ScreenshotTrace? = nil) async throws -> CapturedPNG {
        let completion = CaptureCompletion()
        let encoder = self.encoder
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                completion.install(continuation)
                do { try cancellation.check() }
                catch { completion.finish(.failure(NativeFailure(code: "NATIVE_CANCELLED", message: "Capture cancelled"))); return }
                trace?.mark("shareable-content.begin")
                SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
                    trace?.mark("shareable-content.end")
                    guard let content else { completion.finish(.failure(Self.captureFailure(error))); return }
                    guard let window = content.windows.first(where: { $0.windowID == target.window.windowID && $0.owningApplication?.processID == target.process.pid }) else {
                        completion.finish(.failure(NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Selected window is not available for capture"))); return
                    }
                    do { try cancellation.check(); try NativePlatform.verify(target.process) }
                    catch let error as NativeFailure { completion.finish(.failure(error)); return }
                    catch { completion.finish(.failure(Self.captureFailure(error))); return }
                    trace?.mark("capture-config.begin")
                    let filter = SCContentFilter(desktopIndependentWindow: window)
                    let expected = target.window.bounds
                    guard window.frame.origin.x == expected.x, window.frame.origin.y == expected.y,
                          window.frame.width == expected.width, window.frame.height == expected.height,
                          filter.contentRect.width == expected.width, filter.contentRect.height == expected.height else {
                        completion.finish(.failure(NativeFailure(code: "WINDOW_CHANGED", message: "Capture surface does not match the selected window point geometry"))); return
                    }
                    let configuration = SCStreamConfiguration()
                    let scale = Double(filter.pointPixelScale)
                    let width = (filter.contentRect.width * scale).rounded(.up)
                    let height = (filter.contentRect.height * scale).rounded(.up)
                    guard let pixelsWide = Int(exactly: width), let pixelsHigh = Int(exactly: height), pixelsWide > 0, pixelsHigh > 0 else {
                        completion.finish(.failure(NativeFailure(code: "NATIVE_ERROR", message: "Capture reported invalid pixel dimensions"))); return
                    }
                    configuration.width = pixelsWide
                    configuration.height = pixelsHigh
                    configuration.showsCursor = false
                    configuration.ignoreShadowsSingleWindow = true
                    configuration.ignoreGlobalClipSingleWindow = true
                    trace?.mark("capture-config.end")
                    trace?.mark("capture-image.begin")
                    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                        trace?.mark("capture-image.end")
                        guard let image else { completion.finish(.failure(Self.captureFailure(error))); return }
                        guard image.width == pixelsWide, image.height == pixelsHigh else {
                            completion.finish(.failure(NativeFailure(code: "WINDOW_CHANGED", message: "Capture pixel dimensions changed from the selected window geometry"))); return
                        }
                        trace?.mark("png-encode.queued")
                        encoder.async {
                            do {
                                try cancellation.check()
                                trace?.mark("png-encode.begin")
                                let png = try autoreleasepool { try Self.encode(image) }
                                trace?.mark("png-encode.end")
                                try cancellation.check()
                                completion.finish(.success(png))
                            } catch let error as NativeFailure { completion.finish(.failure(error)) }
                            catch { completion.finish(.failure(Self.captureFailure(error))) }
                        }
                    }
                }
            }
        } onCancel: {
            trace?.mark("capture.cancelled")
            completion.finish(.failure(NativeFailure(code: "NATIVE_CANCELLED", message: "Capture cancelled; late frames are discarded")))
        }
    }
    private static func encode(_ image: CGImage) throws -> CapturedPNG {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Cannot create PNG encoder")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw NativeFailure(code: "NATIVE_ERROR", message: "PNG encoding failed") }
        return CapturedPNG(bytes: Data(referencing: data), width: image.width, height: image.height)
    }
    private static func captureFailure(_ error: (any Error)?) -> NativeFailure {
        NativeFailure(code: CGPreflightScreenCaptureAccess() ? "NATIVE_ERROR" : "PERMISSION_DENIED",
                      message: error?.localizedDescription ?? "Window capture failed without an image")
    }
}
