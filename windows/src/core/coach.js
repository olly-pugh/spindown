// Runs a spindown so that only a genuine coast is timed. Port of SpindownCoach.swift.
//
// The inRide's own state machine is speed-based: after the start command it arms above about 33 km/h
// and starts timing as soon as speed falls below about 30.5 km/h, whether or not the rider is still
// pedalling. The timed window (30.5 to 21 km/h) is what Kinetic's power model is built on, so it is never
// changed. The arming speed is lowered so the rider only needs to touch about 32.5 km/h, and the app guards
// the run: arm only after holding the target; cancel a slow (pedalling) sag before timing starts; while
// timing, the speed must keep falling like a freewheeling flywheel.
import { SensorState } from './decoder.js';

export const CoachAction = { sendStart: 'sendStart', sendStop: 'sendStop' };

const PEDALLING = 'Pedalling was detected during the spindown. Try again and keep your legs still until the wheel stops.';

export class SpindownCoach {
  constructor(targetSpeed = 32.5) {
    this.targetSpeed = targetSpeed;
    /** Speed at which the sensor arms (written as calibration "ready"). */
    this.armingSpeed = 31.8;
    /** Below this, a slow (pedalling) deceleration cancels before the sensor's ~30.5 km/h timing point. */
    this.guardSpeed = 31.0;
    /** Deceleration that counts as coasting, km/h per second (allows for a Pro Flywheel). */
    this.coastingDeceleration = 1.2;
    /** Seconds to hold the target speed before arming. */
    this.holdTime = 1.0;
    this.reset();
  }

  reset() {
    /** {kind: 'accelerate'|'stopPedalling'|'measuring'|'finished'|'failed', since?, message?} */
    this.phase = { kind: 'accelerate' };
    this.hint = null;
    this.samples = [];
    this.aboveTargetSince = null;
    this.measuringStart = null;
    this.lastT = null;
  }

  /** Average deceleration (km/h per second, positive when slowing) over roughly the last `window` seconds. */
  static deceleration(samples, window = 0.5) {
    const last = samples[samples.length - 1];
    if (!last) return null;
    let first = null;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (last.t - samples[i].t >= window * 0.8) {
        first = samples[i];
        break;
      }
    }
    if (!first) return null;
    const dt = last.t - first.t;
    if (!(dt > 0)) return null;
    return (first.speed - last.speed) / dt;
  }

  ingest(speedKPH, sensorState, t) {
    if (this.lastT !== null && t <= this.lastT) return null;
    const previous = this.samples[this.samples.length - 1] ?? null;
    this.lastT = t;
    this.samples.push({ t, speed: speedKPH });
    this.samples = this.samples.filter((s) => !(t - s.t > 3));

    switch (this.phase.kind) {
      case 'accelerate': {
        if (!(speedKPH >= this.targetSpeed)) {
          this.aboveTargetSince = null;
          return null;
        }
        if (this.aboveTargetSince === null) this.aboveTargetSince = t;
        if (t - this.aboveTargetSince >= this.holdTime) {
          this.phase = { kind: 'stopPedalling', since: t };
          this.hint = null;
          return CoachAction.sendStart;
        }
        return null;
      }
      case 'stopPedalling': {
        if (sensorState === SensorState.spindownActive) {
          this.phase = { kind: 'measuring' };
          this.measuringStart = { t, speed: speedKPH };
          return null;
        }
        if (speedKPH <= this.guardSpeed) {
          const decel = SpindownCoach.deceleration(this.samples) ?? 0;
          if (decel < this.coastingDeceleration) {
            return this.cancel(
              `You slowed down while still pedalling. Speed back up to ${Math.trunc(this.targetSpeed)} km/h, then stop pedalling completely.`,
            );
          }
        }
        // Command lost, or the sensor never saw arming speed.
        if (t - this.phase.since > 15 && sensorState === SensorState.normal) {
          this.phase = { kind: 'failed', message: "The trainer didn't respond to the calibration command. Check it is connected and try again." };
          return CoachAction.sendStop;
        }
        return null;
      }
      case 'measuring': {
        if (sensorState === SensorState.normal) {
          this.phase = { kind: 'finished' };
          return null;
        }
        if (sensorState === SensorState.spindownIdle) {
          // The sensor restarts its own process if it detects pedalling.
          this.phase = { kind: 'failed', message: PEDALLING };
          return CoachAction.sendStop;
        }
        if (previous && speedKPH > previous.speed + 0.3) {
          this.phase = { kind: 'failed', message: PEDALLING };
          return CoachAction.sendStop;
        }
        const start = this.measuringStart;
        if (start && t - start.t >= 1.0 && (start.speed - speedKPH) / (t - start.t) < this.coastingDeceleration) {
          this.phase = { kind: 'failed', message: PEDALLING };
          return CoachAction.sendStop;
        }
        return null;
      }
      default:
        return null;
    }
  }

  cancel(message) {
    this.phase = { kind: 'accelerate' };
    this.aboveTargetSince = null;
    this.hint = message;
    return CoachAction.sendStop;
  }
}
