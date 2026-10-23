import SwiftUI
#if os(iOS)
import UIKit
import BackgroundTasks
#endif

/// The few UIKit-only calls the app makes, kept in one place.
@MainActor
enum Platform {
    static func setScreenAlwaysOn(_ on: Bool) {
        #if os(iOS)
        UIApplication.shared.isIdleTimerDisabled = on
        #endif
    }

    /// Asks iOS for extra time to finish work (saving, uploading) if the app is backgrounded.
    static func withBackgroundTime(_ name: String, _ work: @MainActor () async -> Void) async {
        #if os(iOS)
        let id = UIApplication.shared.beginBackgroundTask(withName: name)
        defer { if id != .invalid { UIApplication.shared.endBackgroundTask(id) } }
        #endif
        await work()
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "0"
        let b = info?["CFBundleVersion"] as? String ?? "0"
        return "\(v) (\(b))"
    }

    static let uploadTaskIdentifier = "com.spindown.app.upload"

    /// Registers the background task that retries pending uploads.
    static func registerBackgroundUploads(_ handler: @escaping @MainActor @Sendable () async -> Void) {
        #if os(iOS)
        // Launch handlers run on the queue passed here, i.e. the main queue.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: uploadTaskIdentifier, using: .main) { task in
            nonisolated(unsafe) let task = task
            MainActor.assumeIsolated {
                let work = Task { @MainActor in
                    await handler()
                    task.setTaskCompleted(success: !Task.isCancelled)
                }
                task.expirationHandler = { work.cancel() }
            }
        }
        #endif
    }

    static func scheduleBackgroundUploads() {
        #if os(iOS)
        let request = BGProcessingTaskRequest(identifier: uploadTaskIdentifier)
        request.requiresNetworkConnectivity = true
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
        #endif
    }
}

extension View {
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    func plainTextEntry() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        autocorrectionDisabled()
        #endif
    }

    func groupedList() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        self
        #endif
    }
}
