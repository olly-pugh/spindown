import SwiftUI
import InRideKit

/// "Lakes" tab: ride a cartoon Lake District loop at your real speed. Purely a different view of
/// the same ride: it reads the trainer and heart rate and uses the same Start/Pause/Finish as the
/// Ride tab, so recording, saving and Garmin upload behave exactly the same.
struct GameView: View {
    @Environment(AppModel.self) private var model
    @Environment(TrainerManager.self) private var trainer
    @Environment(HeartRateMonitor.self) private var heartRate
    @Environment(RideSession.self) private var session
    @Environment(AppSettings.self) private var settings

    @State private var engine = GameEngine()
    @State private var workout: Workout?
    @State private var showWorkouts = false
    @State private var showSensors = false
    @State private var confirmFinish = false
    @State private var celebratedWorkoutEnd = false

    var body: some View {
        ZStack {
            TimelineView(.animation) { context in
                Canvas { g, size in
                    let reading = trainer.freshReading(now: context.date)
                    engine.step(now: context.date,
                                targetSpeed: (reading?.speedKPH ?? 0) / 3.6,
                                cadence: reading?.cadenceRPM ?? 0,
                                recording: session.phase == .recording)
                    WorldRenderer.draw(&g, size: size, engine: engine)
                }
            }
            .ignoresSafeArea()

            TimelineView(.periodic(from: .now, by: 0.25)) { context in
                hud(now: context.date)
            }
        }
        .background(Color.black)
        .onAppear { Platform.setScreenAlwaysOn(true) }
        .onDisappear { if session.phase == .idle { Platform.setScreenAlwaysOn(false) } }
        .sheet(isPresented: $showWorkouts) {
            WorkoutPicker(selected: workout) { choice in
                workout = choice
                engine.workout = choice
                celebratedWorkoutEnd = false
                if choice != nil, session.phase == .idle { session.start() }
            }
        }
        .sheet(isPresented: $showSensors) { SensorsView() }
        .confirmationDialog("Finish ride?", isPresented: $confirmFinish, titleVisibility: .visible) {
            Button("Save Ride") {
                model.finishRide()
                workout = nil
                engine.workout = nil
            }
            Button("Keep Riding", role: .cancel) {}
        }
    }

    // MARK: HUD

    @ViewBuilder
    private func hud(now: Date) -> some View {
        let reading = trainer.freshReading(now: now)
        let hr = heartRate.freshHeartRate(now: now)
        let power = session.displayPower(at: now)
        let recordingDistance = session.phase == .idle ? engine.odometer : session.stats.distance
        let u = settings.units
        let position = workout.map { $0.position(at: engine.workoutElapsed) }

        VStack(spacing: 8) {
            HStack(spacing: 8) {
                hudValue(Format.watts(power), unit: "W", label: "POWER", color: powerColor(power, position), big: true)
                hudValue(hr.map(String.init) ?? "--", unit: "bpm", label: "HEART", color: hr == nil ? .secondary : .red, big: true)
                hudValue(Format.speed(kph: reading?.speedKPH, u), unit: Format.speedUnit(u), label: "SPEED", color: .primary, big: false)
            }
            HStack(spacing: 8) {
                hudValue(Format.duration(session.elapsed(at: now)), unit: nil, label: "TIME", color: .primary, big: false)
                hudValue(Format.distance(recordingDistance, u), unit: Format.distanceUnit(u), label: "DISTANCE", color: .primary, big: false)
                hudValue("\(engine.sheepCount)", unit: "🐑", label: "SHEEP", color: .primary, big: false)
            }
            routeStrip
            if let workout, let position { workoutCard(workout, position, power: power) }
            Spacer()
            if let banner = engine.banner, engine.time - banner.at < 3.5 {
                Text(banner.text)
                    .font(.title2.weight(.heavy))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(.ultraThinMaterial, in: Capsule())
                    .transition(.scale.combined(with: .opacity))
            }
            Spacer()
            if !trainer.state.isStreaming {
                Button { showSensors = true } label: {
                    Label(trainer.state.title, systemImage: "antenna.radiowaves.left.and.right")
                        .font(.footnote.weight(.semibold))
                        .padding(8)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .buttonStyle(.plain)
            }
            controls
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(.spring(duration: 0.4), value: engine.banner?.text)
        .sensoryFeedback(.impact(weight: .heavy), trigger: position?.index ?? -1)
        .onChange(of: position?.isComplete ?? false) { _, done in
            if done, !celebratedWorkoutEnd {
                celebratedWorkoutEnd = true
                engine.celebrate("Workout complete! Great riding 🎉")
            }
        }
    }

    private func hudValue(_ value: String, unit: String?, label: String, color: Color, big: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.system(size: big ? 40 : 24, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                if let unit { Text(unit).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
            }
            Text(label).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var routeStrip: some View {
        let lapDistance = LakeRoute.lapDistance(engine.odometer)
        let (next, gap) = LakeRoute.nextLandmark(after: engine.odometer)
        return VStack(spacing: 4) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.25)).frame(height: 6)
                    Capsule().fill(.green).frame(width: geo.size.width * lapDistance / LakeRoute.lapLength, height: 6)
                    ForEach(LakeRoute.landmarks, id: \.name) { l in
                        Circle().fill(l.kind == .pass ? Color.orange : .white).frame(width: 7, height: 7)
                            .offset(x: geo.size.width * l.distance / LakeRoute.lapLength - 3.5)
                    }
                    Image(systemName: "bicycle").font(.caption.weight(.bold)).foregroundStyle(.yellow)
                        .offset(x: geo.size.width * lapDistance / LakeRoute.lapLength - 8, y: -12)
                }
            }
            .frame(height: 18)
            HStack {
                Text("Lap \(LakeRoute.lap(engine.odometer))")
                Spacer()
                Text("Next: \(next.name) · \(Format.distance(gap, settings.units)) \(Format.distanceUnit(settings.units))")
                Spacer()
                Text("\(Int(LakeRoute.elevation(at: engine.odometer))) m")
            }
            .font(.caption.weight(.semibold).monospacedDigit())
        }
        .padding(8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func workoutCard(_ workout: Workout, _ p: Workout.Position, power: Int?) -> some View {
        let target = p.step.targetWatts(ftp: settings.ftp)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(p.isComplete ? "Workout complete" : p.step.label).font(.headline.weight(.heavy))
                Spacer()
                Text(Format.duration(p.remainingInStep).replacingOccurrences(of: "0:", with: "", options: .anchored))
                    .font(.title3.weight(.bold).monospacedDigit())
            }
            if !p.isComplete {
                HStack {
                    Text("Target \(target.lowerBound)–\(target.upperBound) W").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(compliance(power, target)).font(.subheadline.weight(.heavy)).foregroundStyle(powerColor(power, p))
                }
                ProgressView(value: p.elapsedInStep, total: max(1, p.step.duration)).tint(.yellow)
                if let next = p.next {
                    Text("Next: \(next.label) · \(Int(next.duration / 60)) min @ \(next.targetWatts(ftp: settings.ftp).lowerBound)–\(next.targetWatts(ftp: settings.ftp).upperBound) W")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            ProgressView(value: p.fractionOfWorkout).tint(.green)
            if session.phase != .recording {
                Text("Workout clock runs while the ride is recording.").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func compliance(_ power: Int?, _ target: ClosedRange<Int>) -> String {
        guard let power else { return "—" }
        if power < target.lowerBound { return "PUSH ↑" }
        if power > target.upperBound { return "EASE ↓" }
        return "ON TARGET ✓"
    }

    private func powerColor(_ power: Int?, _ p: Workout.Position?) -> Color {
        guard let power, let p, !p.isComplete else { return .primary }
        let target = p.step.targetWatts(ftp: settings.ftp)
        if power < target.lowerBound { return .orange }
        if power > target.upperBound { return .cyan }
        return .green
    }

    // MARK: Controls (same session as the Ride tab)

    private var controls: some View {
        HStack(spacing: 8) {
            Button { showWorkouts = true } label: {
                Label(workout == nil ? "Workouts" : "Change", systemImage: "list.bullet.rectangle.portrait")
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.bordered)
            .tint(.white)

            switch session.phase {
            case .idle:
                bigButton("Start", "play.fill", .green) { session.start() }
            case .recording:
                bigButton("Pause", "pause.fill", .yellow) { session.pause() }
                bigButton("Finish", "stop.fill", .red) { confirmFinish = true }
            case .paused:
                bigButton("Resume", "play.fill", .green) { session.resume() }
                bigButton("Finish", "stop.fill", .red) { confirmFinish = true }
            }
        }
        .font(.headline.weight(.bold))
    }

    private func bigButton(_ title: String, _ icon: String, _ color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(color)
        .foregroundStyle(.black)
    }
}

struct WorkoutPicker: View {
    let selected: Workout?
    let onChoose: (Workout?) -> Void
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            List {
                Section {
                    Stepper(value: $settings.ftp, in: 80...500, step: 5) {
                        LabeledValue("Your FTP", "\(settings.ftp) W")
                    }
                } footer: {
                    Text("Targets are set from your FTP (the power you could hold for about an hour). Choosing a workout starts the ride if it isn't already recording.")
                }
                Section("Workouts") {
                    Button {
                        onChoose(nil)
                        dismiss()
                    } label: {
                        row(name: "Free Ride", tagline: "Just ride the lakes", selected: selected == nil)
                    }
                    ForEach(WorkoutLibrary.all) { w in
                        Button {
                            onChoose(w)
                            dismiss()
                        } label: {
                            row(name: w.name, tagline: w.tagline, selected: selected?.id == w.id)
                        }
                    }
                }
            }
            .groupedList()
            .navigationTitle("Lake District Workouts")
            .inlineNavigationTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func row(name: String, tagline: String, selected: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.semibold)).foregroundStyle(.primary)
                Text(tagline).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(.green) }
        }
    }
}
