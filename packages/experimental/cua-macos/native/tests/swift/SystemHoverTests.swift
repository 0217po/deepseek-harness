// System-pointer movement must not target another app or an obscured window.
import Testing
@testable import CuaNative

@Test func systemHoverRequiresTheForegroundUnobscuredTarget() throws {
    let owner = ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0)
    let bounds = WindowBounds(x: 100, y: 100, width: 400, height: 300)
    let route = WindowRoute(owner: owner, windowID: 7, bounds: bounds)
    let target = WindowInfo(windowID: 7, pid: 42, appName: "Fixture", title: "Target", bounds: bounds, isOnScreen: true, onCurrentSpace: true)
    let point = WindowPoint(x: 20, y: 30)
    try WindowPointerInput.requireSystemPointerTarget(route, at: point, frontPID: 42, windows: [target])
    for pid: Int32? in [nil, 99] {
        #expect(throws: NativeFailure.self) {
            try WindowPointerInput.requireSystemPointerTarget(route, at: point, frontPID: pid, windows: [target])
        }
    }
    for pid: Int32 in [42, 99] {
        let cover = WindowInfo(windowID: 8, pid: pid, appName: "Other", title: "Cover", bounds: bounds, isOnScreen: true, onCurrentSpace: true)
        #expect(throws: NativeFailure.self) {
            try WindowPointerInput.requireSystemPointerTarget(route, at: point, frontPID: 42, windows: [cover, target])
        }
    }
    #expect(throws: NativeFailure.self) {
        try WindowPointerInput.requireSystemPointerTarget(route, at: point, frontPID: 42, windows: [])
    }
    let hidden = WindowInfo(windowID: 8, pid: 99, appName: "Other", title: "Hidden", bounds: bounds, isOnScreen: false, onCurrentSpace: false)
    try WindowPointerInput.requireSystemPointerTarget(route, at: point, frontPID: 42, windows: [hidden, target])
}
