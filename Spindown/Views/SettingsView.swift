import SwiftUI
import InRideKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppSettings.self) private var settings
    @Environment(TrainerManager.self) private var trainer
    @Environment(UploadCoordinator.self) private var uploads

    @State private var showGarminSignIn = false
    @State private var garminTestResult: String?
    @State private var stravaClientID = ""
    @State private var stravaSecret = ""

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Form {
                Section("Trainer") {
                    LabeledValue("Trainer", settings.rememberedTrainerName ?? "None")
                    Toggle("Reconnect automatically", isOn: $settings.autoConnect)
                    Picker("Sensor update rate", selection: $settings.preferredUpdateRate) {
                        Text("Sensor default").tag(InRideUpdateRate?.none)
                        ForEach(InRideUpdateRate.allCases, id: \.self) { Text($0.label).tag(InRideUpdateRate?.some($0)) }
                    }
                    .onChange(of: settings.preferredUpdateRate) { _, _ in trainer.applyUpdateRateNow() }
                }

                Section("Display") {
                    Picker("Units", selection: $settings.units) {
                        ForEach(UnitSystem.allCases) { Text($0.label).tag($0) }
                    }
                    Picker("Power display", selection: $settings.powerSmoothing) {
                        ForEach(PowerSmoothing.allCases) { Text($0.label).tag($0) }
                    }
                    Toggle("Keep screen on while riding", isOn: $settings.keepScreenOn)
                }

                garminSection
                stravaSection

                Section {
                    Toggle("Save raw Bluetooth capture with rides", isOn: $settings.captureRawPackets)
                } header: {
                    Text("Recording")
                } footer: {
                    Text("About 100 KB per hour. Lets the decoder be improved later from your real trainer data.")
                }

                Section("About") {
                    LabeledValue("Version", Platform.appVersion)
                    Text("Spindown is an independent, open-source app for Kinetic Road Machine Smart trainers with the inRide sensor. Power, speed and cadence use Kinetic's published inRide algorithm. Not affiliated with Kinetic, Garmin or Strava.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("Rides are stored only on this iPhone (and its backups) unless you upload them.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showGarminSignIn) { GarminSignInView() }
            .task {
                let config = await uploads.strava.config
                stravaClientID = config.clientID
                stravaSecret = config.clientSecret
            }
        }
    }

    private var garminSection: some View {
        @Bindable var settings = settings
        return Section {
            if uploads.garminSignedIn {
                LabeledValue("Account", uploads.garminAccountName ?? "Signed in")
                if uploads.garminNeedsSignIn {
                    Label("Garmin needs you to sign in again", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    Button("Sign In Again") { showGarminSignIn = true }
                }
                Toggle("Upload rides automatically", isOn: $settings.autoUploadGarmin)
                Button("Test Connection") { Task { garminTestResult = await uploads.testGarmin() } }
                if let garminTestResult { Text(garminTestResult).font(.footnote) }
                Button("Sign Out", role: .destructive) { Task { await uploads.signOutGarmin() } }
            } else {
                Button("Sign In to Garmin Connect", systemImage: "person.crop.circle.badge.plus") { showGarminSignIn = true }
                Toggle("Upload rides automatically", isOn: $settings.autoUploadGarmin)
            }
        } header: {
            Text("Garmin Connect")
        } footer: {
            Text("You sign in on Garmin's own page; Spindown never sees your password, only a token kept in the iPhone Keychain. Garmin has no public upload API for apps like this, so Spindown uses the same upload service as Garmin's app. It works today but Garmin could change it. Rides that cannot be sent are kept and retried, and can always be exported as FIT. Rides appear in Garmin Connect as Indoor Cycling, and are forwarded to Strava if you have linked the two.")
        }
    }

    private var stravaSection: some View {
        @Bindable var settings = settings
        return Section {
            if uploads.stravaSignedIn {
                LabeledValue("Athlete", uploads.stravaAccountName ?? "Signed in")
                Toggle("Upload rides automatically", isOn: $settings.autoUploadStrava)
                Button("Disconnect Strava", role: .destructive) { Task { await uploads.signOutStrava() } }
            } else {
                TextField("Client ID", text: $stravaClientID).plainTextEntry()
                SecureField("Client Secret", text: $stravaSecret)
                Button("Save API Credentials") {
                    Task { await model.updateStravaCredentials(clientID: stravaClientID, secret: stravaSecret) }
                }
                .disabled(stravaClientID.isEmpty || stravaSecret.isEmpty)
                StravaSignInButton()
            }
        } header: {
            Text("Strava")
        } footer: {
            Text(settings.autoUploadGarmin && settings.autoUploadStrava
                 ? "Both Garmin and Strava uploads are on. If Garmin Connect is already linked to Strava you will get duplicates; turn one off."
                 : "Only needed if your Garmin account is not linked to Strava. Create a free API application at strava.com/settings/api with the callback domain \"localhost\", then enter its Client ID and Secret. Uploads are marked as indoor trainer rides.")
        }
    }
}
