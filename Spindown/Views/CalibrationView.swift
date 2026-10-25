import SwiftUI
import InRideKit

/// Guided spindown. The inRide measures how long the flywheel takes to coast from ~31 to ~21 km/h
/// and uses it to correct the power curve for roller pressure (and to detect a Pro Flywheel).
///
/// `SpindownCoach` decides when to arm the sensor and cancels attempts where the rider was still
/// pedalling, so only a genuine coast is timed.
struct CalibrationView: View {
    @Environment(TrainerManager.self) private var trainer
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var coach = SpindownCoach()
    @State private var running = false
    @State private var result: InRidePowerMeasurement?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                if !running {
                    intro
                } else if let result {
                    resultView(result)
                } else if case .failed(let message) = coach.phase {
                    failedView(message)
                } else {
                    progress
                }
                Spacer()
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                actionButton
            }
            .padding()
            .navigationTitle("Spindown Calibration")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(result != nil ? "Done" : "Cancel") { close() }
                }
            }
            .onChange(of: trainer.latestAt) { _, _ in feedCoach() }
            .onAppear { trainer.enterCalibrationMode(armingSpeed: coach.armingSpeed) }
            .onDisappear { trainer.exitCalibrationMode() }
            .interactiveDismissDisabled(running && result == nil)
            .sensoryFeedback(.impact(weight: .heavy), trigger: phaseKey)
        }
    }

    /// Changes whenever the rider needs to act, for a haptic nudge.
    private var phaseKey: Int {
        switch coach.phase {
        case .accelerate: return 0
        case .stopPedalling: return 1
        case .measuring: return 2
        case .finished: return 3
        case .failed: return 4
        }
    }

    private func feedCoach() {
        guard running, result == nil, let m = trainer.latest, let at = trainer.latestAt else { return }
        let action = coach.ingest(speedKPH: m.speedKPH, sensorState: m.state, at: at.timeIntervalSince1970)
        switch action {
        case .sendStart?:
            do { try trainer.send(.startCalibration) } catch { self.error = "Could not start: \(error)" }
        case .sendStop?:
            try? trainer.send(.stopCalibration)
        case nil:
            break
        }
        if coach.phase == .finished { result = m }
    }

    private var targetBinding: Binding<Double> {
        Binding(get: { coach.targetSpeed }, set: { value in
            coach.targetSpeed = value
            coach.armingSpeed = max(31.3, value - 0.7)
            coach.guardSpeed = min(31.0, coach.armingSpeed - 0.3)
            trainer.enterCalibrationMode(armingSpeed: coach.armingSpeed)
        })
    }

    private var targetText: String {
        "\(Format.speed(kph: coach.targetSpeed, settings.units)) \(Format.speedUnit(settings.units))"
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Warm up for about 10 minutes first so the tyre and resistance unit are at riding temperature.", systemImage: "thermometer.medium")
            Label("Ride up to \(targetText) and hold it for a second. Spindown will tell you when to stop pedalling.", systemImage: "speedometer")
            Label("Then stop pedalling completely and keep your legs still until the wheel stops. Don't brake.", systemImage: "hand.raised")
            Stepper(value: targetBinding, in: 32...36, step: 0.5) {
                LabeledValue("Target speed", targetText)
            }
            Text("The trainer times the coast from 30.5 km/h, so you need to be a little above that when you stop. 32.5 km/h only has to be reached briefly; raise the target if attempts keep getting cancelled. Spindown only accepts a genuine coast: if you were still pedalling, the attempt is cancelled and you can go again. Redo calibration after changing tyre, tyre pressure or roller tension.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var progress: some View {
        let speed = trainer.latest?.speedKPH ?? 0
        return VStack(spacing: 18) {
            Text(title).font(.largeTitle.weight(.heavy)).multilineTextAlignment(.center)
                .foregroundStyle(titleColor)
            Text(detail).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Text("\(Format.speed(kph: speed, settings.units)) \(Format.speedUnit(settings.units))")
                .font(.system(size: 64, weight: .bold, design: .rounded).monospacedDigit())
            if coach.phase == .accelerate {
                ProgressView(value: min(speed / coach.targetSpeed, 1))
                    .tint(speed >= coach.targetSpeed ? .green : .orange)
            }
            if let hint = coach.hint {
                Label(hint, systemImage: "arrow.uturn.backward.circle").font(.callout).foregroundStyle(.orange)
            }
        }
    }

    private var title: String {
        switch coach.phase {
        case .accelerate: return "Speed up"
        case .stopPedalling: return "STOP PEDALLING"
        case .measuring: return "Coasting…"
        case .finished: return "Finishing…"
        case .failed: return "Try again"
        }
    }

    private var titleColor: Color {
        switch coach.phase {
        case .stopPedalling: return .green
        case .measuring: return .blue
        default: return .primary
        }
    }

    private var detail: String {
        switch coach.phase {
        case .accelerate: return "Get above \(targetText) and hold it for a moment."
        case .stopPedalling: return "Stop pedalling now and let the wheel coast. Keep your legs still."
        case .measuring: return "The trainer is timing the run-down. Don't pedal."
        case .finished, .failed: return ""
        }
    }

    private func failedView(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "arrow.counterclockwise.circle.fill").font(.system(size: 56)).foregroundStyle(.orange)
            Text("Spindown cancelled").font(.title2.weight(.bold))
            Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
    }

    private func resultView(_ m: InRidePowerMeasurement) -> some View {
        VStack(spacing: 14) {
            Image(systemName: m.calibrationResult == .success ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 56))
                .foregroundStyle(m.calibrationResult == .success ? .green : .orange)
            Text(resultTitle(m.calibrationResult)).font(.title2.weight(.bold))
            Text(String(format: "Spindown time %.2f s%@", m.lastSpindownResultTime, m.proFlywheel ? " · Pro Flywheel detected" : ""))
                .font(.headline.monospacedDigit())
            Text(advice(m.calibrationResult)).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
    }

    private func resultTitle(_ r: InRideCalibrationResult) -> String {
        switch r {
        case .success: return "Calibration successful"
        case .tooFast: return "Roller too tight"
        case .tooSlow: return "Roller too loose"
        case .middle: return "Inconclusive"
        case .unknown: return "No result"
        }
    }

    /// Kinetic's guidance from the SDK documentation.
    private func advice(_ r: InRideCalibrationResult) -> String {
        switch r {
        case .success: return "Power is now corrected for your setup."
        case .tooFast: return "The wheel stopped too quickly. Loosen the roller slightly, warm up again and repeat."
        case .tooSlow: return "The wheel coasted too long. Tighten the roller slightly and repeat."
        case .middle: return "With a Pro Flywheel fitted, loosen the roller. Without one, tighten it. Then repeat."
        case .unknown: return "The sensor did not report a result. Try again."
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        if !running {
            Button {
                coach.reset()
                result = nil
                error = nil
                running = true
            } label: {
                Text("Start Calibration").font(.title3.weight(.bold)).frame(maxWidth: .infinity, minHeight: 56)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!trainer.state.isStreaming)
        } else if result != nil || isFailed {
            Button {
                coach.reset()
                result = nil
                error = nil
            } label: {
                Text("Calibrate Again").frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.bordered)
        }
    }

    private var isFailed: Bool {
        if case .failed = coach.phase { return true }
        return false
    }

    private func close() {
        switch coach.phase {
        case .stopPedalling, .measuring:
            try? trainer.send(.stopCalibration)
        default:
            break
        }
        dismiss()
    }
}
