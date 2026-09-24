// Actor-owned native identities, scoped AX snapshots and synchronous desktop operations.
import Foundation
import Dispatch
import ApplicationServices

final class NativeSerialExecutor: SerialExecutor {
    private let queue = DispatchQueue(label: "dsh.cua.ax")
    func enqueue(_ job: consuming ExecutorJob) {
        let unowned = UnownedJob(job)
        let executor = asUnownedSerialExecutor()
        queue.async { unowned.runSynchronously(on: executor) }
    }
    func checkIsolated() { dispatchPrecondition(condition: .onQueue(queue)) }
}

struct SnapshotScope: Hashable { let appHandle: String; let windowID: UInt32? }
struct NativeSnapshot {
    let id: String
    let scope: SnapshotScope
    let elements: [Int: AXUIElement]
}
struct CaptureTarget: Sendable {
    let appHandle: String
    let process: ProcessIdentity
    let window: WindowInfo
}
struct ForegroundPlan: Sendable {
    let appHandle: String
    let identity: ProcessIdentity
    let snapshotID: String?
    let index: Int?
    let targetWindowID: UInt32?
    let role: String?
    let main: Bool?
    let minimized: Bool?
    var isRaise: Bool { index != nil }
}
struct ForegroundObservation: Sendable {
    let frontPID: Int32?
    let focusedWindowID: UInt32?
    let frontWindowID: UInt32?
    let frontWindowPID: Int32?
    var json: JSONValue {
        .object(["frontPid": frontPID.map { .number(Double($0)) } ?? .null,
                 "focusedWindowId": focusedWindowID.map { .number(Double($0)) } ?? .null,
                 "frontWindowId": frontWindowID.map { .number(Double($0)) } ?? .null,
                 "frontWindowPid": frontWindowPID.map { .number(Double($0)) } ?? .null])
    }
}
enum DriverOutcome: Sendable { case result(JSONValue), capture(CaptureTarget), foreground(ForegroundPlan) }

actor AXWorker {
    nonisolated let executor = NativeSerialExecutor()
    nonisolated var unownedExecutor: UnownedSerialExecutor { executor.asUnownedSerialExecutor() }
    private let namespace = UUID().uuidString
    private var generation: UInt64 = 0
    private var targets: [String: ProcessIdentity] = [:]
    private var snapshots: [SnapshotScope: NativeSnapshot] = [:]
    private let cancellation: CancellationLatch
    private let axTimeout: Float
    private let textEventInterval: Double
    private var access: AXAccess?
    private var keyboard: KeyboardInput?
    private var pointer: WindowPointerInput?
    private var closed = false

    init(cancellation: CancellationLatch, axTimeout: Float, textEventInterval: Double) {
        self.cancellation = cancellation
        self.axTimeout = axTimeout
        self.textEventInterval = textEventInterval
    }
    private func identifier(_ kind: String) throws -> String {
        guard generation < UInt64.max else { throw NativeFailure(code: "NATIVE_ERROR", message: "Native identity space exhausted") }
        generation += 1
        return "\(namespace):\(kind):\(generation)"
    }
    private func ax() -> AXAccess {
        if let access { return access }
        let created = AXAccess(timeout: axTimeout, cancellation: cancellation)
        access = created
        return created
    }
    private func inputs() -> (KeyboardInput, WindowPointerInput) {
        if let keyboard, let pointer { return (keyboard, pointer) }
        let poster = PIDEventPoster()
        let latch = cancellation
        let key = KeyboardInput(poster: poster, textEventInterval: textEventInterval, checkCancellation: { try latch.check() })
        let mouse = WindowPointerInput(poster: poster, checkCancellation: { try latch.check() })
        keyboard = key; pointer = mouse
        return (key, mouse)
    }
    private func observeSession() -> Bool? {
        let state = NativePlatform.sessionLocked()
        if state != false { snapshots.removeAll() }
        return state
    }
    private func forget(_ handle: String) {
        targets.removeValue(forKey: handle)
        snapshots = snapshots.filter { $0.key.appHandle != handle }
    }
    func validateIdentity(_ handle: String) throws -> ProcessIdentity {
        guard !closed else { throw NativeFailure(code: "STALE_APP", message: "Helper is closing; acquire fresh application handles") }
        guard let identity = targets[handle] else { throw NativeFailure(code: "STALE_APP", message: "Application handle expired; call getApp again") }
        do { try NativePlatform.verify(identity) }
        catch { forget(handle); throw error }
        return identity
    }
    private func acquire(_ identity: ProcessIdentity) throws -> String {
        if let old = targets.first(where: { $0.value.pid == identity.pid }) {
            if old.value == identity { return old.key }
            forget(old.key)
        }
        let id = try identifier("app")
        targets[id] = identity
        return id
    }
    private func snapshot(_ handle: String, _ id: String) throws -> NativeSnapshot {
        guard let result = snapshots.values.first(where: { $0.scope.appHandle == handle && $0.id == id }) else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Snapshot expired; read fresh getAXState")
        }
        return result
    }
    private func element(_ handle: String, _ params: RequestParameters) throws -> AXUIElement {
        let value = try snapshot(handle, params.string("snapshotId"))
        let index = try params.integer("elementIndex", in: 0...Int.max)
        guard let element = value.elements[index] else { throw RequestParameters.invalid("elementIndex is absent from the selected snapshot") }
        return element
    }
    private func coordinateSnapshot(_ handle: String, _ params: RequestParameters, _ windowID: UInt32) throws {
        guard let id = try params.optionalString("snapshotId") else { return }
        let value = try snapshot(handle, id)
        guard value.scope.windowID == nil || value.scope.windowID == windowID else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Snapshot belongs to another window")
        }
    }
    static func actionKey(_ value: String) -> String {
        let name = value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
        return name.filter { !$0.isWhitespace }.lowercased()
    }
    static var actionResult: JSONValue { .object(["dispatched": .bool(true), "verified": .bool(false)]) }

    // Only observation failures allow a fresh read. Input failures can follow
    // partial effects and keep their original classification.
    static func observationFailure(_ failure: NativeFailure) -> NativeFailure {
        guard failure.accessibilityError == AXError.invalidUIElement.rawValue else { return failure }
        return NativeFailure(code: "STALE_SNAPSHOT",
                             message: "Accessibility tree changed during observation; read fresh getAXState",
                             accessibilityError: failure.accessibilityError)
    }

    func execute(_ request: NativeRequest, catalog: ApplicationCatalogSnapshot) throws -> DriverOutcome {
        try cancellation.check()
        guard !closed else { throw NativeFailure(code: "NATIVE_CLOSED", message: "Helper is closing") }
        let params = try RequestParameters(request)
        let locked = observeSession()
        if request.method == "getCapabilities" {
            return .result(.object(["platform": .string("macos"), "permissions": .object([
                "accessibility": .bool(AXIsProcessTrusted()), "screenRecording": .bool(CGPreflightScreenCaptureAccess())]),
                "sessionLocked": locked.map(JSONValue.bool) ?? .null,
                "methods": .array(RequestParameters.fields.keys.sorted().map(JSONValue.string)), "coordinateSpace": .string("window-points"), "browser": .bool(false)]))
        }
        if request.method == "listApps" { return .result(.array(catalog.applications.filter { $0.regular && $0.name != nil }.map(\.json))) }
        try NativePlatform.requireUnlocked(locked)
        if request.method == "getApp" {
            let selector = try params.string("selector")
            let matches = catalog.applications.filter { app in
                app.regular && app.name != nil && (app.name == selector || app.bundleID == selector || String(app.pid) == selector || (selector.hasPrefix("/") && app.path == selector))
            }
            guard !matches.isEmpty else { throw NativeFailure(code: "APP_UNAVAILABLE", message: "No running application matches selector") }
            guard matches.count == 1, let app = matches.first else { throw NativeFailure(code: "AMBIGUOUS_APP", message: "Select an exact PID from listApps") }
            let handle = try acquire(NativePlatform.identity(app.pid))
            var response = app.json.object ?? [:]
            response["appHandle"] = .string(handle)
            return .result(.object(response))
        }
        let handle = try params.string("appHandle")
        let identity = try validateIdentity(handle)
        if request.method == "listWindows" {
            let windows = NativePlatform.windows().filter { $0.pid == identity.pid }
            // Remove closed window scopes using the current WindowServer identity set.
            let ids = Set(windows.map(\.windowID))
            snapshots = snapshots.filter { key, _ in key.appHandle != handle || (key.windowID.map { ids.contains($0) } ?? true) }
            return .result(.array(windows.map(\.json)))
        }
        if request.method == "getState" { snapshots.removeValue(forKey: SnapshotScope(appHandle: handle, windowID: try params.optionalWindowID())) }
        if request.method != "screenshot" { try NativePlatform.requireAccessibility() }
        switch request.method {
        case "activate":
            return .foreground(ForegroundPlan(appHandle: handle, identity: identity, snapshotID: nil, index: nil, targetWindowID: nil, role: nil, main: nil, minimized: nil))
        case "getState":
            let window = try params.optionalWindowID()
            if let window { _ = try NativePlatform.ownedWindow(identity.pid, window) }
            let projection: AXProjection
            do {
                projection = try ax().project(identity: identity, windowID: window,
                    maxElements: params.integer("maxElements", in: 1...10000), maxDepth: params.integer("maxDepth", in: 1...100))
            } catch let failure as NativeFailure {
                throw Self.observationFailure(failure)
            }
            _ = try validateIdentity(handle)
            try NativePlatform.requireUnlocked(observeSession())
            try NativePlatform.requireAccessibility()
            if let window { _ = try NativePlatform.ownedWindow(identity.pid, window) }
            try cancellation.check()
            let observedWindows = NativePlatform.windows().filter { $0.pid == identity.pid }
            let id = try identifier("snapshot")
            let scope = SnapshotScope(appHandle: handle, windowID: window)
            snapshots[scope] = NativeSnapshot(id: id, scope: scope, elements: projection.indexed)
            return .result(.object(["appHandle": .string(handle), "pid": .number(Double(identity.pid)),
                "windowId": window.map { .number(Double($0)) } ?? .null,
                "focusedWindowId": projection.focusedWindowID.map { .number(Double($0)) } ?? .null,
                "snapshotId": .string(id), "tree": .string(projection.tree), "elements": .array(projection.elements),
                "windows": .array(observedWindows.map(\.json)), "truncated": .bool(projection.truncated)]))
        case "screenshot":
            try NativePlatform.requireScreenRecording()
            let window = try NativePlatform.ownedWindow(identity.pid, params.windowID())
            return .capture(CaptureTarget(appHandle: handle, process: identity, window: window))
        case "typeText", "pressKey":
            let recipient = try ax().keyboardRecipient(identity, catalog: catalog)
            try NativePlatform.verify(recipient)
            if request.method == "typeText" { try inputs().0.typeText(params.string("text"), to: recipient.pid) }
            else { try inputs().0.pressKey(params.string("key"), modifiers: params.modifiers(), to: recipient.pid) }
        case "setValue": try ax().setValue(element(handle, params), params.string("value"))
        case "performSecondaryAction":
            let selected = try element(handle, params)
            let requested = try params.string("action")
            guard let action = try ax().actions(selected).first(where: { Self.actionKey($0) == Self.actionKey(requested) }) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Element does not advertise this action; refresh getAXState")
            }
            try ax().requireEnabled(selected)
            if action == "AXRaise" {
                return .foreground(ForegroundPlan(appHandle: handle, identity: identity, snapshotID: try params.string("snapshotId"),
                    index: try params.integer("elementIndex", in: 0...Int.max), targetWindowID: try ax().windowID(selected),
                    role: try ax().string(selected, "AXRole"), main: try ax().boolean(selected, "AXMain"), minimized: try ax().boolean(selected, "AXMinimized")))
            }
            try ax().perform(selected, action)
        case "click":
            let button = try params.optionalString("mouseButton") ?? "left"
            let count = params.contains("clickCount") ? try params.integer("clickCount", in: 1...2) : 1
            guard button == "left" || (button == "right" && count == 1) else { throw RequestParameters.invalid("Unsupported mouse button or click count") }
            if params.contains("elementIndex") {
                guard !params.contains("x"), !params.contains("y"), !params.contains("windowId") else { throw RequestParameters.invalid("Element and coordinate targets cannot be combined") }
                let selected = try element(handle, params)
                let names = try ax().actions(selected)
                let action: String? = button == "right" && names.contains("AXShowMenu") ? "AXShowMenu"
                    : (button == "left" && count == 1 ? (names.contains("AXPress") ? "AXPress" : names.contains("AXPick") ? "AXPick" : nil) : nil)
                if let action { try ax().perform(selected, action) }
                else {
                    try ax().requireEnabled(selected)
                    guard let bounds = try ax().bounds(selected), bounds.width > 0, bounds.height > 0 else { throw NativeFailure(code: "NATIVE_ERROR", message: "Element has no pointer bounds") }
                    let window = try ax().enclosingWindow(selected, owner: identity)
                    let point = WindowPoint(x: bounds.x + bounds.width / 2 - window.bounds.x, y: bounds.y + bounds.height / 2 - window.bounds.y)
                    try inputs().1.click(in: WindowRoute(owner: identity, windowID: window.windowID, bounds: window.bounds), at: point, button: button, count: count)
                }
            } else {
                let id = try params.windowID()
                try coordinateSnapshot(handle, params, id)
                let window = try NativePlatform.ownedWindow(identity.pid, id)
                try inputs().1.click(in: WindowRoute(owner: identity, windowID: id, bounds: window.bounds), at: params.point(), button: button, count: count)
            }
        case "scroll", "drag":
            let id = try params.windowID()
            try coordinateSnapshot(handle, params, id)
            let window = try NativePlatform.ownedWindow(identity.pid, id)
            let route = WindowRoute(owner: identity, windowID: id, bounds: window.bounds)
            if request.method == "scroll" {
                let dx = params.contains("deltaLinesX") ? try params.integer("deltaLinesX", in: -10...10) : 0
                let dy = params.contains("deltaLinesY") ? try params.integer("deltaLinesY", in: -10...10) : 0
                try inputs().1.scroll(in: route, at: params.point(), deltaLinesX: Int32(dx), deltaLinesY: Int32(dy))
            } else {
                try inputs().1.drag(in: route, from: params.point("fromX", "fromY"), to: params.point("toX", "toY"),
                    durationMs: params.integer("durationMs", in: 1...5000), steps: params.integer("steps", in: 1...240))
            }
        default: throw NativeFailure(code: "UNSUPPORTED", message: request.method)
        }
        return .result(Self.actionResult)
    }

    func foregroundObservation(_ plan: ForegroundPlan) throws -> ForegroundObservation {
        _ = try validateIdentity(plan.appHandle)
        try NativePlatform.requireUnlocked(observeSession())
        let top = NativePlatform.windows().first { $0.isOnScreen }
        return ForegroundObservation(frontPID: NativePlatform.frontPID(), focusedWindowID: try ax().focusedWindowID(plan.identity.pid),
                                     frontWindowID: top?.windowID, frontWindowPID: top?.pid)
    }
    static func shouldRaise(_ plan: ForegroundPlan, before: ForegroundObservation) -> Bool {
        guard let id = plan.targetWindowID else { return true }
        return !(plan.role == "AXWindow" && plan.main == true && plan.minimized == false && before.frontPID == plan.identity.pid
                 && before.focusedWindowID == id && before.frontWindowID == id && before.frontWindowPID == plan.identity.pid)
    }
    func raise(_ plan: ForegroundPlan) throws {
        _ = try validateIdentity(plan.appHandle)
        try NativePlatform.requireUnlocked(observeSession())
        try NativePlatform.requireAccessibility()
        guard let id = plan.snapshotID, let index = plan.index, let element = try snapshot(plan.appHandle, id).elements[index] else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Raise target is no longer available")
        }
        try ax().perform(element, "AXRaise")
    }
    func finishCapture(_ target: CaptureTarget, image: CapturedPNG) throws -> JSONValue {
        try cancellation.check()
        let identity = try validateIdentity(target.appHandle)
        guard identity == target.process else { throw NativeFailure(code: "STALE_APP", message: "Capture process identity changed") }
        try NativePlatform.requireUnlocked(observeSession())
        try NativePlatform.requireScreenRecording()
        let after = try NativePlatform.ownedWindow(identity.pid, target.window.windowID)
        guard after.bounds == target.window.bounds else { throw NativeFailure(code: "WINDOW_CHANGED", message: "Window moved or resized during capture; observe again") }
        return .object(["mimeType": .string("image/png"), "data": .string(image.bytes.base64EncodedString()),
            "pixelWidth": .number(Double(image.width)), "pixelHeight": .number(Double(image.height)), "bounds": after.bounds.json,
            "coordinateSpace": .string("window-points"), "windowId": .number(Double(after.windowID))])
    }
    func shutdown() { closed = true; snapshots.removeAll(); targets.removeAll(); access = nil; keyboard = nil; pointer = nil }
}
