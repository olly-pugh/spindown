import SwiftUI

@main
struct SpindownApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.settings)
                .environment(model.trainer)
                .environment(model.heartRate)
                .environment(model.broadcaster)
                .environment(model.session)
                .environment(model.store)
                .environment(model.uploads)
                .preferredColorScheme(.dark)
                .onOpenURL { model.handleOpenURL($0) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.appBecameActive()
            case .background: model.appEnteredBackground()
            default: break
            }
        }
    }
}
