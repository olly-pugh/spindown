// The Ride tab. Port of RideView.swift.
import { useState } from 'preact/hooks';
import { html, Tile, Confirm } from '../components.js';
import * as Format from '../../core/format.js';
import { linkTitle, linkColor, isStreaming } from '../ble/trainer.js';
import { zoneFor, zoneDecimal, ZONE_COLORS, ZONE_NAMES } from '../../core/hrzones.js';

/** The heart-rate zone for the settings' max HR and zones: {zone 0..5, decimal, color, name}, or null. */
export function liveZone(settings, hr) {
  const max = settings.get('maxHeartRate');
  const pcts = settings.get('hrZonePercents');
  const zone = zoneFor(hr, max, pcts);
  if (zone == null) return null;
  return { zone, decimal: zoneDecimal(hr, max, pcts), color: zone ? ZONE_COLORS[zone - 1] : null, name: zone ? ZONE_NAMES[zone - 1] : 'Below zone 1' };
}

export function StatusBar({ app, onClick }) {
  const { trainer, heartRate, session } = app;
  const now = Date.now();
  const hr = heartRate.freshHeartRate(now);
  const battery = trainer.info.battery;
  return html`<button class="statusbar" onClick=${onClick} title="Trainer and heart-rate strap">
    <span class="dot ${linkColor(trainer.state)}"></span>
    <span style="font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${linkTitle(trainer.state)}</span>
    ${isStreaming(trainer.state) && trainer.stats.measuredHz > 0 ? html`<span class="muted small num">${Math.round(trainer.stats.measuredHz)} Hz</span>` : null}
    <span class=${hr != null ? 'red pulse' : heartRate.state.kind === 'idle' ? 'gray' : 'orange'} title=${hr != null ? 'Heart rate connected' : 'Heart rate not connected'}>${hr != null ? '♥' : '♡'}</span>
    ${battery != null ? html`<span class="small num ${battery < 20 ? 'red' : 'muted'}">🔋 ${battery}%</span>` : null}
    ${session.phase !== 'idle' ? html`<span class="badge ${session.phase === 'paused' ? 'paused' : 'rec'}">${session.phase === 'paused' ? 'PAUSED' : 'REC'}</span>` : null}
    <span class="muted small">Sensors ›</span>
  </button>`;
}

/** Start / Pause / Resume / Finish, shared by the Ride and Lakes tabs. */
export function useRideControls(app, { onSaved } = {}) {
  const [confirm, setConfirm] = useState(null);
  const { session } = app;
  const finish = () => setConfirm('finish');
  const dialogs = confirm === 'finish'
    ? html`<${Confirm} title="Finish ride?" message="Save this ride to your history? It uploads to Garmin Connect automatically."
        onCancel=${() => setConfirm(null)}
        buttons=${[
          { label: 'Discard Ride', kind: 'danger', onClick: () => setConfirm('discard') },
          { label: 'Keep Riding', onClick: () => setConfirm(null) },
          { label: 'Save Ride', kind: 'primary', onClick: async () => { setConfirm(null); const r = await app.finishRide(); if (r) onSaved?.(r); } },
        ]} />`
    : confirm === 'discard'
      ? html`<${Confirm} title="Discard this ride?" message="The recording will be deleted and cannot be recovered."
          onCancel=${() => setConfirm(null)}
          buttons=${[
            { label: 'Cancel', onClick: () => setConfirm(null) },
            { label: 'Discard', kind: 'danger', onClick: () => { setConfirm(null); session.discard(); } },
          ]} />`
      : null;
  const buttons = (extra = null) => {
    switch (session.phase) {
      case 'recording':
        return html`${extra}<button class="btn big yellow" onClick=${() => session.pause()}>❚❚ Pause</button><button class="btn big red" onClick=${finish}>■ Finish</button>`;
      case 'paused':
        return html`${extra}<button class="btn big green" onClick=${() => session.resume()}>▶ Resume</button><button class="btn big red" onClick=${finish}>■ Finish</button>`;
      default:
        return html`${extra}<button class="btn big green" onClick=${() => session.start()}>▶ Start Ride</button>`;
    }
  };
  return { buttons, dialogs, finish };
}

const TILE = 'clamp(26px, 5.4vh, 46px)';

export function RideView({ app, openSensors, openCalibration }) {
  const { trainer, heartRate, session, settings } = app;
  const now = Date.now();
  const u = settings.get('units');
  const reading = trainer.freshReading(now);
  const stats = session.stats;
  const power = session.displayPower(now);
  const hr = heartRate.freshHeartRate(now);
  const zone = liveZone(settings, hr);
  const smoothing = settings.get('powerSmoothing');
  const { buttons, dialogs } = useRideControls(app);

  return html`<div class="page ride">
    <${StatusBar} app=${app} onClick=${openSensors} />
    <div class="hero">
      <div class="power">
        <div class="row" style="justify-content:center;align-items:baseline;gap:10px">
          <span class="bignum num">${Format.watts(power)}</span><span style="font-size:34px;font-weight:600" class="muted">W</span>
        </div>
        <div class="cap">${smoothing === 1 ? 'POWER' : `POWER · ${smoothing}s`}</div>
        ${trainer.latest?.coasting && power === 0 ? html`<div class="orange small">Coasting</div>` : null}
      </div>
      <div class="center" style="min-width:220px">
        <div class="row" style="justify-content:center;align-items:baseline;gap:8px">
          <span class="hrnum num ${hr != null ? 'red' : 'muted'}">${hr ?? '--'}</span><span class=${hr != null ? 'red' : 'muted'} style="font-size:28px">♥</span>
        </div>
        <div class="cap">${hr == null && heartRate.state.kind === 'idle' ? 'NO HR STRAP' : 'BPM'}</div>
        ${zone ? html`<div style="margin-top:6px">${zone.zone
          ? html`<span class="zone-chip num" style=${{ background: zone.color }}>ZONE ${zone.decimal.toFixed(1)}</span> <span class="small muted">${zone.name}</span>`
          : html`<span class="small muted">Below zone 1</span>`}</div>` : null}
      </div>
    </div>
    <div class="tiles" style="grid-template-columns:repeat(4,1fr)">
      <${Tile} title="Speed" value=${Format.speed(reading?.speedKPH, u)} unit=${Format.speedUnit(u)} size=${TILE} />
      <${Tile} title="Cadence" value=${Format.rpm(reading ? reading.cadenceRPM : null)} unit="rpm" size=${TILE} />
      <${Tile} title="Elapsed" value=${Format.duration(session.elapsed(now))} size=${TILE} />
      <${Tile} title="Moving" value=${Format.duration(stats?.movingTime ?? 0)} size=${TILE} />
      <${Tile} title="Distance" value=${Format.distance(stats?.distance ?? 0, u)} unit=${Format.distanceUnit(u)} size=${TILE} />
      <${Tile} title="Avg Power" value=${Format.watts(stats?.averagePower)} unit="W" size=${TILE} />
      <${Tile} title="Avg Speed" value=${Format.speedMS(stats && stats.movingTime > 0 ? stats.averageSpeed : null, u)} unit=${Format.speedUnit(u)} size=${TILE} />
      <${Tile} title="Max Power" value=${Format.watts(stats?.maxPower)} unit="W" size=${TILE} />
    </div>
    <div class="spacer"></div>
    ${session.lastError ? html`<div class="red center small">${session.lastError}</div>` : null}
    ${session.phase === 'idle' && !isStreaming(trainer.state)
      ? html`<div class="hint">You can start now; data is recorded as soon as the trainer connects.</div>`
      : null}
    <div class="controls">${buttons()}</div>
    <div class="row" style="justify-content:center;gap:16px">
      <button class="btn" onClick=${openSensors}>Trainer & heart-rate strap…</button>
      <button class="btn" onClick=${openCalibration} disabled=${!isStreaming(trainer.state)} title="Spindown calibration">Calibrate (spindown)…</button>
    </div>
    ${dialogs}
  </div>`;
}
