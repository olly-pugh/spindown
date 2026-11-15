// Guided spindown. The inRide measures how long the flywheel takes to coast from ~31 to ~21 km/h and uses
// it to correct the power curve for roller pressure (and to detect a Pro Flywheel). SpindownCoach decides
// when to arm the sensor and cancels attempts where the rider was still pedalling. Port of CalibrationView.swift.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Modal, Stepper, Progress } from '../components.js';
import { SpindownCoach, CoachAction } from '../../core/coach.js';
import { Command } from '../../core/commands.js';
import { CalibrationResult } from '../../core/decoder.js';
import * as Format from '../../core/format.js';
import { isStreaming } from '../ble/trainer.js';

const RESULT_TITLE = {
  [CalibrationResult.success]: 'Calibration successful',
  [CalibrationResult.tooFast]: 'Roller too tight',
  [CalibrationResult.tooSlow]: 'Roller too loose',
  [CalibrationResult.middle]: 'Inconclusive',
  [CalibrationResult.unknown]: 'No result',
};

/** Kinetic's guidance from the SDK documentation. */
const ADVICE = {
  [CalibrationResult.success]: 'Power is now corrected for your setup.',
  [CalibrationResult.tooFast]: 'The wheel stopped too quickly. Loosen the roller slightly, warm up again and repeat.',
  [CalibrationResult.tooSlow]: 'The wheel coasted too long. Tighten the roller slightly and repeat.',
  [CalibrationResult.middle]: 'With a Pro Flywheel fitted, loosen the roller. Without one, tighten it. Then repeat.',
  [CalibrationResult.unknown]: 'The sensor did not report a result. Try again.',
};

export function CalibrationView({ app, onClose }) {
  const { trainer, settings } = app;
  const coachRef = useRef(new SpindownCoach());
  const coach = coachRef.current;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [, force] = useState(0);
  const runningRef = useRef(false);
  const resultRef = useRef(null);
  runningRef.current = running;
  resultRef.current = result;
  const u = settings.get('units');

  useEffect(() => {
    trainer.enterCalibrationMode(coach.armingSpeed);
    // Feed every new packet to the coach.
    const listener = (m, at) => {
      if (!runningRef.current || resultRef.current) return;
      const action = coach.ingest(m.speedKPH, m.state, at / 1000);
      if (action === CoachAction.sendStart) trainer.send(Command.startCalibration()).catch((e) => setError(`Could not start: ${e.message}`));
      if (action === CoachAction.sendStop) trainer.send(Command.stopCalibration()).catch(() => {});
      if (coach.phase.kind === 'finished') setResult(m);
      force((n) => n + 1);
    };
    trainer.measurementListeners.add(listener);
    return () => {
      trainer.measurementListeners.delete(listener);
      trainer.exitCalibrationMode();
    };
  }, []);

  const target = `${Format.speed(coach.targetSpeed, u)} ${Format.speedUnit(u)}`;
  const close = () => {
    if (['stopPedalling', 'measuring'].includes(coach.phase.kind)) trainer.send(Command.stopCalibration()).catch(() => {});
    onClose();
  };
  const restart = () => {
    coach.reset();
    setResult(null);
    setError(null);
    force((n) => n + 1);
  };

  let body;
  if (!running) {
    body = html`<div style="display:flex;flex-direction:column;gap:14px" class="welcome-big">
      <div>🌡 Warm up for about 10 minutes first so the tyre and resistance unit are at riding temperature.</div>
      <div>🚴 Ride up to ${target} and hold it for a second. Spindown will tell you when to stop pedalling.</div>
      <div>✋ Then stop pedalling completely and keep your legs still until the wheel stops. Don't brake.</div>
      <div class="list"><${Stepper} label="Target speed" value=${coach.targetSpeed} display=${target} min=${32} max=${36} step=${0.5}
        onChange=${(v) => {
          coach.targetSpeed = v;
          coach.armingSpeed = Math.max(31.3, v - 0.7);
          coach.guardSpeed = Math.min(31.0, coach.armingSpeed - 0.3);
          trainer.enterCalibrationMode(coach.armingSpeed);
          force((n) => n + 1);
        }} /></div>
      <div class="small muted">The trainer times the coast from 30.5 km/h, so you need to be a little above that when you stop. 32.5 km/h only has to be reached briefly; raise the target if attempts keep getting cancelled. Spindown only accepts a genuine coast: if you were still pedalling, the attempt is cancelled and you can go again. Redo calibration after changing tyre, tyre pressure or roller tension.</div>
    </div>`;
  } else if (result) {
    const ok = result.calibrationResult === CalibrationResult.success;
    body = html`<div class="center" style="display:flex;flex-direction:column;gap:12px;padding:20px 0">
      <div style="font-size:60px" class=${ok ? 'green' : 'orange'}>${ok ? '✔' : '⚠'}</div>
      <div style="font-size:26px;font-weight:700">${RESULT_TITLE[result.calibrationResult]}</div>
      <div class="num" style="font-size:18px;font-weight:600">Spindown time ${result.lastSpindownResultTime.toFixed(2)} s${result.proFlywheel ? ' · Pro Flywheel detected' : ''}</div>
      <div class="muted welcome-big">${ADVICE[result.calibrationResult]}</div>
    </div>`;
  } else if (coach.phase.kind === 'failed') {
    body = html`<div class="center" style="display:flex;flex-direction:column;gap:12px;padding:20px 0">
      <div style="font-size:60px" class="orange">↺</div>
      <div style="font-size:26px;font-weight:700">Spindown cancelled</div>
      <div class="muted welcome-big">${coach.phase.message}</div>
    </div>`;
  } else {
    const speed = trainer.latest?.speedKPH ?? 0;
    const titles = { accelerate: 'Speed up', stopPedalling: 'STOP PEDALLING', measuring: 'Coasting…', finished: 'Finishing…' };
    const details = {
      accelerate: `Get above ${target} and hold it for a moment.`,
      stopPedalling: 'Stop pedalling now and let the wheel coast. Keep your legs still.',
      measuring: "The trainer is timing the run-down. Don't pedal.",
      finished: '',
    };
    const color = coach.phase.kind === 'stopPedalling' ? 'green' : coach.phase.kind === 'measuring' ? 'blue' : '';
    body = html`<div class="center" style="display:flex;flex-direction:column;gap:16px;padding:10px 0">
      <div class=${color} style="font-size:44px;font-weight:850">${titles[coach.phase.kind]}</div>
      <div class="muted welcome-big">${details[coach.phase.kind]}</div>
      <div class="num" style="font-size:80px;font-weight:750">${Format.speed(speed, u)} <span style="font-size:28px" class="muted">${Format.speedUnit(u)}</span></div>
      ${coach.phase.kind === 'accelerate' ? html`<${Progress} value=${speed / coach.targetSpeed} color=${speed >= coach.targetSpeed ? 'var(--green)' : 'var(--orange)'} />` : null}
      ${coach.hint ? html`<div class="orange">↩ ${coach.hint}</div>` : null}
    </div>`;
  }

  const footer = !running
    ? html`<button class="btn primary" style="min-width:220px;min-height:48px;font-size:17px" disabled=${!isStreaming(trainer.state)}
        onClick=${() => { coach.reset(); setResult(null); setError(null); setRunning(true); }}>Start Calibration</button>`
    : result || coach.phase.kind === 'failed'
      ? html`<button class="btn" onClick=${restart}>Calibrate Again</button>`
      : null;

  return html`<${Modal} title="Spindown Calibration" onClose=${close} closeLabel=${result ? 'Done' : 'Cancel'} footer=${footer}>
    ${body}
    ${error ? html`<div class="red small">${error}</div>` : null}
  </${Modal}>`;
}
