import SwiftUI
import InRideKit

/// Guided spindown. The inRide measures how long the flywheel takes to coast from ~31 to ~18 km/h
/// and uses it to correct the power curve for roller pressure (and to detect a Pro Flywheel).
struct CalibrationView: View {
    @Environment(TrainerManager.self) private var trainer
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var started = false
    @State private var sawSpindown = false
    @State private var finished = false
    @State private var error: String?

    private var state: InRideSensorState { trainer.latest?.state ?? .normal }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                if !started {
                    intro
                } else if finished, let m = trainer.latest {
                    result(m)
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
                    Button(finished ? "Done" : "Cancel") { cancel() }
                }
            }
            .onChange(of: trainer.latest?.state) { _, new in
                guard started, let new else { return }
                if new == .spindownReady || new == .spindownActive { sawSpindown = true }
                if new == .normal, sawSpindown { finished = true }
            }
            .interactiveDismissDisabled(started && !finished)
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Warm up for about 10 minutes first so the tyre and resistance unit are at riding temperature.", systemImage: "thermometer.medium")
            Label("When asked, ride up to \(targetSpeedText) and then stop pedalling completely.", systemImage: "speedometer")
            Label("Let the wheel coast to a stop on its own. Don't touch the brakes.", systemImage: "hand.raised")
            Text("The result corrects power for your roller pressure and detects a Pro Flywheel. Redo it if you change tyre, tyre pressure or roller tension.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var targetSpeedText: String {
        "\(Format.speed(kph: InRideDecoder.calibrationReadySpeedKPH, settings.units)) \(Format.speedUnit(settings.units))"
    }

    private var progress: some View {
        let speed = trainer.latest?.speedKPH ?? 0
        return VStack(spacing: 18) {
            Text(stepTitle).font(.title.weight(.bold)).multilineTextAlignment(.center)
            Text(stepDetail).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Text("\(Format.speed(kph: speed, settings.units)) \(Format.speedUnit(settings.units))")
                .font(.system(size: 64, weight: .bold, design: .rounded).monospacedDigit())
            if state == .spindownIdle {
                ProgressView(value: min(speed / InRideDecoder.calibrationReadySpeedKPH, 1))
                    .tint(speed >= InRideDecoder.calibrationReadySpeedKPH ? .green : .orange)
            }
        }
    }

    private var stepTitle: String {
        switch state {
        case .spindownIdle: return "Speed up"
        case .spindownReady: return "Stop pedalling now"
        case .spindownActive: return "Coasting…"
        case .normal: return sawSpindown ? "Finishing…" : "Starting…"
        }
    }

    private var stepDetail: String {
        switch state {
        case .spindownIdle: return "Ride steadily above \(targetSpeedText)."
        case .spindownReady: return "Let the wheel coast. If you pedal, the sensor restarts the test."
        case .spindownActive: return "Keep still while the sensor times the run-down."
        case .normal: return "Waiting for the sensor."
        }
    }

    private func result(_ m: InRidePowerMeasurement) -> some View {
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
        if !started {
            Button {
                do {
                    try trainer.send(.startCalibration)
                    started = true
                    error = nil
                } catch {
                    self.error = "Could not start: \(error). Make sure the trainer is connected."
                }
            } label: {
                Text("Start Calibration").font(.title3.weight(.bold)).frame(maxWidth: .infinity, minHeight: 56)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!trainer.state.isStreaming)
        } else if finished {
            Button {
                started = false
                sawSpindown = false
                finished = false
            } label: {
                Text("Calibrate Again").frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.bordered)
        }
    }

    private func cancel() {
        if started && !finished { try? trainer.send(.stopCalibration) }
        dismiss()
    }
}
