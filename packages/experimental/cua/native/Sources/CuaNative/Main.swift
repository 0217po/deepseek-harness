// Executable entry: AppKit owns the main run loop, while protocol and AX work stay off it.
import AppKit
import Foundation
import Darwin

@main enum CuaNativeMain {
    @MainActor static func main() {
        do {
            let configuration = try HelperConfiguration(arguments: Array(CommandLine.arguments.dropFirst()))
            let app = NSApplication.shared
            app.setActivationPolicy(.prohibited)
            let coordinator = RequestCoordinator(configuration: configuration)
            coordinator.start()
            withExtendedLifetime(coordinator) { app.run() }
        } catch {
            let diagnostic = (error as? NativeFailure)?.message ?? error.localizedDescription
            if let data = "dsh-cua-native: \(diagnostic)\n".data(using: .utf8) { try? FileHandle.standardError.write(contentsOf: data) }
            exit(1)
        }
    }
}
