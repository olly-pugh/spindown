import Charts
import SwiftUI
import InRideKit

struct HistoryView: View {
    @Environment(RideStore.self) private var store
    @Environment(AppSettings.self) private var settings
    @State private var pendingDelete: RideRecord?

    var body: some View {
        NavigationStack {
            List {
                if store.records.isEmpty {
                    ContentUnavailableView("No rides yet", systemImage: "bicycle",
                                           description: Text("Finished rides are saved here automatically."))
                }
                ForEach(store.records) { record in
                    NavigationLink(value: record.id) { row(record) }
                        .swipeActions {
                            Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = record }
                        }
                }
                if !store.loadErrors.isEmpty {
                    Section("Unreadable files") {
                        ForEach(store.loadErrors, id: \.self) { Text($0).font(.caption).foregroundStyle(.red) }
                    }
                }
            }
            .navigationTitle("History")
            .navigationDestination(for: UUID.self) { RideDetailView(rideID: $0) }
            .refreshable { store.load() }
            .alert("Delete ride?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                   presenting: pendingDelete) { record in
                Button("Delete", role: .destructive) { store.delete(record.id) }
                Button("Cancel", role: .cancel) {}
            } message: { record in
                Text("\"\(record.name)\" will be removed from this iPhone. Copies already uploaded are not affected.")
            }
        }
    }

    private func row(_ r: RideRecord) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(r.name).font(.headline)
                if r.recovered { Image(systemName: "arrow.counterclockwise.circle").foregroundStyle(.orange) }
                Spacer()
                ForEach(UploadDestination.allCases) { d in
                    if let state = r.uploads[d] { uploadBadge(d, state) }
                }
            }
            Text(r.startDate.formatted(date: .abbreviated, time: .shortened)).font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 14) {
                Label(Format.shortDuration(r.summary.timerTime), systemImage: "clock")
                Label("\(Format.distance(r.summary.distance, settings.units)) \(Format.distanceUnit(settings.units))", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                Label("\(Format.watts(r.summary.averagePower)) W", systemImage: "bolt")
                if let hr = r.summary.averageHeartRate {
                    Label("\(Int(hr.rounded())) bpm", systemImage: "heart")
                }
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private func uploadBadge(_ d: UploadDestination, _ s: UploadState) -> some View {
        let color: Color
        switch s {
        case .uploaded, .duplicate: color = .green
        case .failed(_, let retryable): color = retryable ? .orange : .red
        default: color = .secondary
        }
        return Image(systemName: d.symbol).font(.caption).foregroundStyle(color)
            .accessibilityLabel("\(d.displayName): \(String(describing: s))")
    }
}

struct RideDetailView: View {
    let rideID: UUID
    var isPostRide = false

    @Environment(RideStore.self) private var store
    @Environment(UploadCoordinator.self) private var uploads
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var track: RideTrack?
    @State private var exports: [ExportFormat: URL] = [:]
    @State private var rawCapture: URL?
    @State private var name = ""
    @State private var loadError: String?

    var body: some View {
        if let record = store.record(rideID) {
            List {
                Section {
                    TextField("Name", text: $name)
                        .font(.headline)
                        .onSubmit { rename(record) }
                    Text(record.startDate.formatted(date: .complete, time: .shortened)).foregroundStyle(.secondary)
                    if record.recovered {
                        Label("Recovered after the app closed unexpectedly", systemImage: "arrow.counterclockwise.circle")
                            .foregroundStyle(.orange).font(.footnote)
                    }
                }
                summarySection(record.summary)
                if let track, track.samples.count > 1 { chartSection(track) }
                uploadsSection(record)
                exportSection(record)
                if let t = record.trainer { trainerSection(t) }
                if let loadError { Text(loadError).foregroundStyle(.red) }
            }
            .groupedList()
            .navigationTitle(isPostRide ? "Ride Saved" : "Ride")
            .inlineNavigationTitle()
            .toolbar {
                if isPostRide {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { rename(record); dismiss() } }
                }
            }
            .task(id: rideID) { load(record) }
            .onDisappear { rename(record) }
        } else {
            ContentUnavailableView("Ride not found", systemImage: "questionmark.folder")
        }
    }

    private func load(_ record: RideRecord) {
        name = record.name
        do {
            track = try store.track(for: rideID)
            for format in ExportFormat.allCases {
                exports[format] = try store.exportFile(rideID, format: format)
            }
            rawCapture = store.packetCaptureURL(for: rideID)
        } catch {
            loadError = "Could not read this ride's samples: \(error.localizedDescription)"
        }
    }

    private func rename(_ record: RideRecord) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != record.name else { return }
        var r = record
        r.name = trimmed
        store.update(r)
    }

    private func summarySection(_ s: RideSummary) -> some View {
        let u = settings.units
        return Section("Summary") {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                MetricTile(title: "Moving", value: Format.duration(s.movingTime), unit: nil, size: 26)
                MetricTile(title: "Elapsed", value: Format.duration(s.elapsedTime), unit: nil, size: 26)
                MetricTile(title: "Distance", value: Format.distance(s.distance, u), unit: Format.distanceUnit(u), size: 26)
                MetricTile(title: "Avg Speed", value: Format.speed(metresPerSecond: s.averageSpeed, u), unit: Format.speedUnit(u), size: 26)
                MetricTile(title: "Avg Power", value: Format.watts(s.averagePower), unit: "W", size: 26)
                MetricTile(title: "Max Power", value: Format.watts(s.maxPower), unit: "W", size: 26)
                MetricTile(title: "Norm. Power", value: Format.watts(s.normalizedPower), unit: "W", size: 26)
                MetricTile(title: "Energy", value: String(Int((s.work / 1000).rounded())), unit: "kJ", size: 26)
                MetricTile(title: "Avg Cadence", value: Format.rpm(s.averageCadence), unit: "rpm", size: 26)
                MetricTile(title: "Max Speed", value: Format.speed(metresPerSecond: s.maxSpeed, u), unit: Format.speedUnit(u), size: 26)
                if s.averageHeartRate != nil {
                    MetricTile(title: "Avg HR", value: Format.rpm(s.averageHeartRate), unit: "bpm", tint: .red, size: 26)
                    MetricTile(title: "Max HR", value: s.maxHeartRate.map(String.init) ?? "--", unit: "bpm", tint: .red, size: 26)
                }
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
        }
    }

    private func chartSection(_ track: RideTrack) -> some View {
        // Downsample to ~600 points; plenty for a phone-width chart.
        let step = max(1, track.samples.count / 600)
        let points = stride(from: 0, to: track.samples.count, by: step).map { track.samples[$0] }
        let hasHeartRate = points.contains { $0.heartRate != nil }
        return Section(hasHeartRate ? "Power and heart rate" : "Power") {
            Chart(points, id: \.t) { s in
                if let p = s.power {
                    LineMark(x: .value("Time", s.t / 60), y: .value("Power", p))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(.yellow)
                }
            }
            .chartXAxisLabel("minutes")
            .chartYAxisLabel("W")
            .frame(height: 160)
            if hasHeartRate {
                Chart(points, id: \.t) { s in
                    if let hr = s.heartRate {
                        LineMark(x: .value("Time", s.t / 60), y: .value("Heart rate", hr))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(.red)
                    }
                }
                .chartXAxisLabel("minutes")
                .chartYAxisLabel("bpm")
                .chartYScale(domain: .automatic(includesZero: false))
                .frame(height: 130)
            }
        }
    }

    private func uploadsSection(_ record: RideRecord) -> some View {
        Section {
            ForEach(UploadDestination.allCases) { d in
                let state = record.uploads[d]
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Label(d.displayName, systemImage: d.symbol)
                        Spacer()
                        statusText(d, state)
                    }
                    HStack {
                        if let url = activityURL(d, state) {
                            Button("Open", systemImage: "arrow.up.right.square") { openURL(url) }
                                .buttonStyle(.bordered)
                        }
                        if canUpload(d, state) {
                            Button(state == nil ? "Upload" : "Retry", systemImage: "arrow.up.circle") {
                                Task { await uploads.retry(rideID, d) }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
        } header: {
            Text("Uploads")
        } footer: {
            if record.uploads[.garmin] != nil, record.uploads[.strava] != nil {
                Text("If Garmin Connect is linked to Strava, Garmin also forwards this ride there; uploading to both may create a duplicate.")
            }
        }
    }

    private func statusText(_ d: UploadDestination, _ state: UploadState?) -> some View {
        let signedIn = d == .garmin ? uploads.garminSignedIn : uploads.stravaSignedIn
        let needsSignIn = d == .garmin ? uploads.garminNeedsSignIn : uploads.stravaNeedsSignIn
        let text: String
        if state == .pending && (!signedIn || needsSignIn) {
            text = "Waiting for sign-in"
        } else {
            text = uploads.describe(state)
        }
        return Text(text).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
    }

    private func canUpload(_ d: UploadDestination, _ state: UploadState?) -> Bool {
        switch state {
        case nil, .failed: return true
        default: return false
        }
    }

    private func activityURL(_ d: UploadDestination, _ state: UploadState?) -> URL? {
        let id: String?
        switch state {
        case .uploaded(let a), .duplicate(let a): id = a
        default: id = nil
        }
        guard let id else { return nil }
        return d == .garmin ? GarminConnectClient.activityURL(id) : StravaClient.activityURL(id)
    }

    private func exportSection(_ record: RideRecord) -> some View {
        Section {
            ForEach(ExportFormat.allCases) { format in
                if let url = exports[format] {
                    ShareLink(item: url) { Label(format.displayName, systemImage: "square.and.arrow.up") }
                }
            }
            if let rawCapture {
                ShareLink(item: rawCapture) { Label("Raw Bluetooth capture (JSONL)", systemImage: "waveform") }
            }
        } header: {
            Text("Export")
        } footer: {
            Text("FIT is the most complete format and imports into Garmin Connect, Strava, TrainingPeaks and intervals.icu.")
        }
    }

    private func trainerSection(_ t: TrainerInfo) -> some View {
        Section("Equipment") {
            LabeledValue("Trainer sensor", t.model ?? t.name)
            LabeledValue("Firmware", t.firmware)
            LabeledValue("Spindown", t.spindownTime.map { String(format: "%.2f s", $0) })
            LabeledValue("Pro Flywheel", t.proFlywheel.map { $0 ? "Yes" : "No" })
            LabeledValue("Heart-rate monitor", t.heartRateMonitor ?? "None")
        }
    }
}
