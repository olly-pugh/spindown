import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView {
            RideView()
                .tabItem { Label("Ride", systemImage: "bicycle") }
            GameView()
                .tabItem { Label("Lakes", systemImage: "mountain.2.fill") }
            HistoryView()
                .tabItem { Label("History", systemImage: "list.bullet.rectangle") }
            DiagnosticsView()
                .tabItem { Label("Diagnostics", systemImage: "waveform.path.ecg") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .alert("Ride recovered", isPresented: Binding(get: { model.recoveryMessage != nil },
                                                      set: { if !$0 { model.recoveryMessage = nil } })) {
            Button("OK") { model.recoveryMessage = nil }
        } message: {
            Text(model.recoveryMessage ?? "")
        }
        .sheet(item: Binding(get: { model.finishedRideID.map(IdentifiedUUID.init) },
                             set: { model.finishedRideID = $0?.id })) { item in
            NavigationStack {
                RideDetailView(rideID: item.id, isPostRide: true)
            }
        }
    }
}

struct IdentifiedUUID: Identifiable {
    let id: UUID
}
