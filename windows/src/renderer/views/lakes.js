// "Lakes" tab: ride a cartoon Lake District loop at your real speed. Purely a different view of the same ride:
// it reads the trainer and heart rate and uses the same Start/Pause/Finish as the Ride tab, so recording,
// saving and Garmin upload behave exactly the same. Port of GameView.swift.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Modal, Stepper, Progress } from '../components.js';
import { GameEngine, drawWorld } from '../game/world.js';
import * as Lakes from '../../core/lakes.js';
import * as Format from '../../core/format.js';
import { useRideControls } from './ride.js';
import { linkTitle, isStreaming } from '../ble/trainer.js';

// One engine for the app's lifetime, so switching tabs does not reset the odometer or sheep.
const engine = new GameEngine();

function HudValue({ value, unit, label, color, big }) {
  return html`<div class="glass hud-val">
    <div><span class="n num ${color || ''}" style=${{ fontSize: big ? '44px' : '26px' }}>${value}</span>${unit ? html` <span class="small muted" style="font-weight:600">${unit}</span>` : null}</div>
    <div class="l">${label}</div>
  </div>`;
}

function WorkoutPicker({ app, selected, onChoose, onClose }) {
  const { settings } = app;
  const row = (id, name, tagline, w) => html`<button class="item" onClick=${() => { onChoose(w); onClose(); }}>
    <div style="flex:1"><div style="font-weight:650">${name}</div><div class="small muted">${tagline}</div></div>
    ${(selected?.id ?? null) === id ? html`<span class="green">✔</span>` : null}
  </button>`;
  return html`<${Modal} title="Lake District Workouts" onClose=${onClose}>
    <div class="section">
      <div class="list"><${Stepper} label="Your FTP" value=${settings.get('ftp')} display=${`${settings.get('ftp')} W`} min=${80} max=${500} step=${5} onChange=${(v) => settings.set('ftp', v)} /></div>
      <div class="footer">Targets are set from your FTP (the power you could hold for about an hour). Choosing a workout starts the ride if it isn't already recording.</div>
    </div>
    <div class="section"><h3>Workouts</h3>
      <div class="list">
        ${row(null, 'Free Ride', 'Just ride the lakes', null)}
        ${Lakes.WORKOUTS.map((w) => row(w.id, w.name, w.tagline, w))}
      </div>
    </div>
  </${Modal}>`;
}

export function LakesView({ app, openSensors }) {
  const { trainer, heartRate, session, settings } = app;
  const canvasRef = useRef(null);
  const [workout, setWorkout] = useState(engine.workout);
  const [showWorkouts, setShowWorkouts] = useState(false);
  const celebrated = useRef(false);
  const { buttons, dialogs } = useRideControls(app, {
    onSaved: () => {
      engine.workout = null;
      setWorkout(null);
    },
  });

  // 60 fps render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas.getContext('2d');
    let raf;
    const frame = () => {
      const now = Date.now();
      const reading = trainer.freshReading(now);
      engine.step(now, (reading?.speedKPH ?? 0) / 3.6, reading?.cadenceRPM ?? 0, session.phase === 'recording');
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawWorld(g, w, h, engine);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    session.lakesVisible = true;
    session.updateKeepAwake();
    return () => {
      cancelAnimationFrame(raf);
      session.lakesVisible = false;
      session.updateKeepAwake();
    };
  }, []);

  const now = Date.now();
  const reading = trainer.freshReading(now);
  const hr = heartRate.freshHeartRate(now);
  const power = session.displayPower(now);
  const u = settings.get('units');
  const ftp = settings.get('ftp');
  const distance = session.phase === 'idle' ? engine.odometer : session.stats?.distance ?? 0;
  const position = workout ? Lakes.workoutPosition(workout, engine.workoutElapsed) : null;
  const lapDistance = Lakes.lapDistance(engine.odometer);
  const [next, gap] = Lakes.nextLandmark(engine.odometer);

  if (position?.isComplete && !celebrated.current) {
    celebrated.current = true;
    engine.celebrate('Workout complete! Great riding 🎉');
  }

  const powerColor = (() => {
    if (power == null || !position || position.isComplete) return '';
    const [lo, hi] = Lakes.targetWatts(position.step, ftp);
    return power < lo ? 'orange' : power > hi ? 'cyan' : 'green';
  })();

  const choose = (w) => {
    setWorkout(w);
    engine.workout = w;
    celebrated.current = false;
    if (w && session.phase === 'idle') session.start();
  };

  const banner = engine.banner && engine.time - engine.banner.at < 3.5 ? engine.banner.text : null;

  return html`<div class="lakes">
    <canvas ref=${canvasRef}></canvas>
    <div class="hud">
      <div class="hud-row">
        <${HudValue} value=${Format.watts(power)} unit="W" label="POWER" color=${powerColor} big />
        <${HudValue} value=${hr ?? '--'} unit="bpm" label="HEART" color=${hr == null ? 'muted' : 'red'} big />
        <${HudValue} value=${Format.speed(reading?.speedKPH, u)} unit=${Format.speedUnit(u)} label="SPEED" big />
        <${HudValue} value=${Format.duration(session.elapsed(now))} label="TIME" />
        <${HudValue} value=${Format.distance(distance, u)} unit=${Format.distanceUnit(u)} label="DISTANCE" />
        <${HudValue} value=${engine.sheepCount} unit="🐑" label="SHEEP" />
      </div>
      <div class="glass route">
        <div class="bar">
          <div class="track"></div>
          <div class="done" style=${{ width: `${(lapDistance / Lakes.LAP_LENGTH) * 100}%` }}></div>
          ${Lakes.LANDMARKS.map((l) => html`<div class="mark" title=${l.name} style=${{ left: `${(l.distance / Lakes.LAP_LENGTH) * 100}%`, background: l.kind === 'pass' ? 'var(--orange)' : '#fff' }}></div>`)}
          <div class="rider" style=${{ left: `${(lapDistance / Lakes.LAP_LENGTH) * 100}%` }}>🚴</div>
        </div>
        <div class="row small num" style="font-weight:600">
          <span>Lap ${Lakes.lap(engine.odometer)}</span><span class="spacer"></span>
          <span>Next: ${next.name} · ${Format.distance(gap, u)} ${Format.distanceUnit(u)}</span><span class="spacer"></span>
          <span>${Math.round(Lakes.elevation(engine.odometer))} m</span>
        </div>
      </div>
      ${workout && position ? (() => {
        const [lo, hi] = Lakes.targetWatts(position.step, ftp);
        const compliance = power == null ? '—' : power < lo ? 'PUSH ↑' : power > hi ? 'EASE ↓' : 'ON TARGET ✓';
        return html`<div class="glass workout">
          <div class="row"><span style="font-size:19px;font-weight:850">${position.isComplete ? 'Workout complete' : position.step.label}</span><span class="spacer"></span>
            <span class="num" style="font-size:22px;font-weight:700">${Format.duration(position.remainingInStep).replace(/^0:/, '')}</span></div>
          ${!position.isComplete ? html`
            <div class="row"><span style="font-weight:600">Target ${lo}–${hi} W</span><span class="spacer"></span><span class=${powerColor} style="font-weight:850">${compliance}</span></div>
            <${Progress} value=${position.elapsedInStep / Math.max(1, position.step.duration)} color="var(--yellow)" />
            ${position.next ? html`<div class="small muted">Next: ${position.next.label} · ${Math.trunc(position.next.duration / 60)} min @ ${Lakes.targetWatts(position.next, ftp).join('–')} W</div>` : null}
          ` : null}
          <${Progress} value=${position.fractionOfWorkout} />
          ${session.phase !== 'recording' ? html`<div class="small muted">Workout clock runs while the ride is recording.</div>` : null}
        </div>`;
      })() : null}
      <div class="spacer"></div>
      ${banner ? html`<div class="glass celebrate" key=${banner}>${banner}</div>` : null}
      <div class="spacer"></div>
      ${!isStreaming(trainer.state) ? html`<button class="glass pill" style="align-self:center" onClick=${openSensors}>📡 ${linkTitle(trainer.state)}</button>` : null}
      <div class="controls" style="max-width:900px;width:100%;align-self:center">
        ${buttons(html`<button class="btn big white" style="flex:0.7" onClick=${() => setShowWorkouts(true)}>${workout ? 'Change workout' : 'Workouts'}</button>`)}
      </div>
    </div>
    ${showWorkouts ? html`<${WorkoutPicker} app=${app} selected=${workout} onChoose=${choose} onClose=${() => setShowWorkouts(false)} />` : null}
    ${dialogs}
  </div>`;
}
