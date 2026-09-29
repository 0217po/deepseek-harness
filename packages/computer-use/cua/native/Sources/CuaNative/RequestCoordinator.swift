// One active request remains reserved through every await and the final stdout write.
import Foundation
import AppKit
import Dispatch
import Darwin

@MainActor final class RequestCoordinator {
    private let configuration: HelperConfiguration
    private let cancellation: CancellationLatch
    private let worker: AXWorker
    private let capture = WindowCapture()
    private let input: JSONLInput
    private let writer: JSONLWriter
    private let signalQueue = DispatchQueue(label: "dsh.cua.signals")
    private var signalSources: [DispatchSourceSignal] = []
    private var active: UUID?
    private var operation: Task<Void, Never>?
    private var stopping = false

    init(configuration: HelperConfiguration) {
        self.configuration = configuration
        let cancellation = CancellationLatch()
        self.cancellation = cancellation
        worker = AXWorker(cancellation: cancellation, axTimeout: configuration.axTimeoutSeconds,
                          textEventInterval: configuration.textEventIntervalSeconds)
        input = JSONLInput(limit: configuration.maxRequestBytes, cancellation: cancellation)
        writer = JSONLWriter(limit: configuration.maxResponseBytes)
    }
    func start() {
        signal(SIGPIPE, SIG_IGN)
        let latch = cancellation
        let grace = configuration.shutdownGraceSeconds
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: signalQueue)
            source.setEventHandler { [weak self] in
                latch.cancel()
                // This queue remains responsive even if an AppKit system call stalls the main actor.
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + grace) { _exit(128 + number) }
                Task { @MainActor in self?.shutdown(status: 128 + number) }
            }
            source.resume()
            signalSources.append(source)
        }
        input.start(onFrame: { [weak self] frame in
            Task { @MainActor in self?.receive(frame) }
        }, onEOF: { [weak self] in
            Task { @MainActor in self?.shutdown(status: 0) }
        }, onFailure: { [weak self] failure in
            Task { @MainActor in self?.transportFailed(failure) }
        })
    }
    private func receive(_ data: Data) {
        guard !stopping else { return }
        guard active == nil else { transportFailed(NativeFailure(code: "NATIVE_PROTOCOL", message: "Concurrent helper request admission")); return }
        let token = UUID()
        active = token
        operation = Task { [weak self] in
            guard let self else { return }
            var requestID: JSONValue = .null
            let response: JSONValue
            do {
                let request = try NativeRequest(data: data)
                requestID = .string(request.id)
                let params = try RequestParameters(request)
                let requiresCatalog = ["getApp", "listApps", "findApps", "typeText", "pressKey"].contains(request.method)
                let catalog = requiresCatalog ? ApplicationCatalog.snapshot() : ApplicationCatalogSnapshot(applications: [], frontPID: nil)
                let result: JSONValue
                if request.method == "findApps" {
                    result = .array(try ApplicationDiscovery.applications(matching: params.string("query"), exact: false,
                        limit: params.integer("maxAppMatches", in: 1...1000), cancellation: self.cancellation).map { $0.json(catalog: catalog) })
                } else {
                    var installed: InstalledApplication?
                    if request.method == "getApp" {
                        let selector = try params.string("selector")
                        if !catalog.applications.contains(where: { $0.matches(selector) }) && Int32(selector) == nil {
                            installed = try ApplicationDiscovery.applications(matching: selector, exact: true, limit: 1,
                                                                               cancellation: self.cancellation).first
                        }
                    }
                    let outcome = try await self.worker.execute(request.method, params: params, catalog: catalog, installed: installed)
                    switch outcome {
                case .result(let value): result = value
                case .capture(let target):
                    let image = try await self.capture.capture(target, cancellation: self.cancellation)
                    result = try await self.worker.finishCapture(target, image: image)
                    case .foreground(let plan): result = try await self.performForeground(plan, requestID: request.id)
                    case .launch(let plan):
                        let pid = try await ApplicationDiscovery.launch(plan.application, cancellation: self.cancellation)
                        result = try await self.worker.finishLaunch(plan, pid: pid)
                    }
                }
                response = .object(["id": requestID, "result": result])
            } catch let failure as NativeFailure {
                response = .object(["id": requestID, "error": .object(["code": .string(failure.code), "message": .string(failure.message)])])
            } catch {
                response = .object(["id": requestID, "error": .object([
                    "code": .string(requestID == .null ? "INVALID_REQUEST" : "NATIVE_ERROR"), "message": .string(error.localizedDescription)])])
            }
            guard !self.stopping, self.active == token else { return }
            do { try await self.writer.write(response) }
            catch let failure as NativeFailure {
                if failure.code == "NATIVE_RESPONSE_LIMIT" {
                    // The bounded writer rejects before emitting any bytes, so one small
                    // error frame can identify the limit before this helper is invalidated.
                    try? await self.writer.write(.object(["id": requestID, "error": .object([
                        "code": .string(failure.code), "message": .string(failure.message),
                    ])]))
                }
                self.transportFailed(failure)
                return
            }
            catch { self.transportFailed(NativeFailure(code: "NATIVE_IO", message: error.localizedDescription)); return }
            guard !self.stopping, self.active == token else { return }
            self.active = nil
            self.operation = nil
            self.input.next()
        }
    }
    private func performForeground(_ plan: ForegroundPlan, requestID: String) async throws -> JSONValue {
        let before = try await worker.foregroundObservation(plan)
        let raiseRequested = plan.isRaise && AXWorker.shouldRaise(plan, before: before)
        var activationRequested = false
        if !plan.isRaise || raiseRequested {
            if before.frontPID != plan.identity.pid {
                try cancellation.check()
                try ApplicationCatalog.activate(plan.identity)
                activationRequested = true
            }
        }
        if raiseRequested { try await worker.raise(plan) }
        let after = try await worker.foregroundObservation(plan)
        return .object(["dispatched": .bool(true), "verified": .bool(false), "foreground": .object([
            "requestId": .string(requestID), "operation": .string(plan.isRaise ? "AXRaise" : "activate"),
            "targetPid": .number(Double(plan.identity.pid)), "targetWindowId": plan.targetWindowID.map { .number(Double($0)) } ?? .null,
            "before": before.json, "after": after.json, "activationRequested": .bool(activationRequested), "raiseRequested": .bool(raiseRequested),
        ])])
    }
    private func transportFailed(_ failure: NativeFailure) {
        if let bytes = "\(failure.code): \(failure.message)\n".data(using: .utf8) { try? FileHandle.standardError.write(contentsOf: bytes) }
        shutdown(status: 1)
    }
    private func shutdown(status: Int32) {
        guard !stopping else { return }
        stopping = true
        cancellation.cancel()
        active = nil
        operation?.cancel()
        input.stop()
        let grace = configuration.shutdownGraceSeconds
        signalQueue.asyncAfter(deadline: .now() + grace) { _exit(status == 0 ? 1 : status) }
        Task { [worker] in
            await worker.shutdown()
            // Worker shutdown runs after every earlier synchronous AX/input segment.
            exit(status)
        }
    }
}
