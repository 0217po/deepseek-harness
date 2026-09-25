// Compare independent window frames before capture or pointer delivery.
import CoreGraphics

enum WindowGeometry {
    static let conflictMessage = "Window display and accessibility bounds disagree. Read fresh state; if unchanged, use AX actions or explicitly restore the window before capture or coordinate input"

    /// Read CG bounds around the AX query; missing AX geometry does not disable an owned window.
    static func resolve(
        owner: ProcessIdentity, windowID: UInt32, accessibilityBounds: () throws -> WindowBounds?
    ) throws -> WindowInfo {
        let before = try NativePlatform.ownedWindow(owner.pid, windowID)
        let accessibility = try accessibilityBounds()
        try NativePlatform.verify(owner)
        let after = try NativePlatform.ownedWindow(owner.pid, windowID)
        try validate(before: before.bounds, after: after.bounds, accessibility: accessibility)
        return after
    }

    /// CG must stay unchanged during the read. Integral point rectangles absorb frame representation rounding.
    static func validate(before: WindowBounds, after: WindowBounds, accessibility: WindowBounds?) throws {
        guard before == after else {
            throw NativeFailure(code: "WINDOW_CHANGED", message: "Window moved or resized while checking geometry; read fresh state")
        }
        guard let accessibility, let ax = rectangle(accessibility), let cg = rectangle(after) else { return }
        guard ax.integral == cg.integral else {
            throw NativeFailure(code: "WINDOW_CHANGED", message: conflictMessage)
        }
    }

    private static func rectangle(_ bounds: WindowBounds) -> CGRect? {
        guard bounds.x.isFinite, bounds.y.isFinite, bounds.width.isFinite, bounds.height.isFinite,
              bounds.width > 0, bounds.height > 0,
              (bounds.x + bounds.width).isFinite, (bounds.y + bounds.height).isFinite else { return nil }
        return CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
    }
}
