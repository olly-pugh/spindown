// Settings tab. Port of SettingsView.swift.
import { useEffect, useState } from 'preact/hooks';
import { html, LV, Section, Toggle, Select, Spinner } from '../components.js';
import { linkTitle, linkColor } from '../ble/trainer.js';
import { UPDATE_RATES, rateLabel } from '../../core/commands.js';
import * as Z from '../../core/hrzones.js';

/** A number box that only applies its value when you press Enter or click away, so typing "1" on the way to "176" changes nothing. */
function NumberBox({ value, onCommit, label, width = 90 }) {
  const shown = value == null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const n = Number(draft.trim().replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(n) || !onCommit(n)) setDraft(shown);
  };
  return html`<input type="text" inputmode="decimal" class="num zone-box" style=${{ width: `${width}px` }} aria-label=${label} value=${draft}
    onInput=${(e) => setDraft(e.target.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} />`;
}

const pct = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function HeartRateZonesSection({ app }) {
  const { settings } = app;
  const maxHR = settings.get('maxHeartRate');
  const percents = Z.validPercents(settings.get('hrZonePercents')) ? settings.get('hrZonePercents') : Z.DEFAULT_ZONE_PERCENTS;
  const hasMax = Z.validMaxHR(maxHR);
  const highestRidden = app.rides.records.reduce((m, r) => Math.max(m, r.summary?.maxHeartRate ?? 0), 0);
  const setMax = (n) => {
    const v = Math.round(n);
    if (!Z.validMaxHR(v)) return false;
    settings.set('maxHeartRate', v);
    return true;
  };
  const setBoundary = (i, change) => {
    const next = Z.setBoundary(percents, i, change, maxHR);
    settings.set('hrZonePercents', next);
    return true;
  };
  const isDefault = percents.every((p, i) => p === Z.DEFAULT_ZONE_PERCENTS[i]);
  return html`<${Section} title="Heart rate zones"
    footer=${`Based on % of max heart rate, like a Garmin. Change a zone by typing either its bpm or its %; the other works itself out, and changing your max heart rate moves every zone with it. Garmin's defaults are 50, 60, 70, 80 and 90 %. Zones show on the Ride and World screens and in each ride's history. Between ${Z.MIN_MAX_HR} and ${Z.MAX_MAX_HR} bpm.`}>
    <div class="list">
      <div class="item">
        <span style="flex:1">Max heart rate</span>
        <${NumberBox} label="Max heart rate" value=${hasMax ? maxHR : null} onCommit=${setMax} /><span class="muted" style="width:34px">bpm</span>
      </div>
      ${!hasMax ? html`<div class="item small muted" style="display:block;line-height:1.5">
        Enter your max heart rate to see your zones. If you don't know it, the highest heart rate from a really hard ride is a good guide.
        ${highestRidden >= Z.MIN_MAX_HR ? html` <button class="btn link" onClick=${() => setMax(highestRidden)}>Use ${highestRidden} bpm, the highest in your rides</button>` : null}
      </div>` : html`<div class="item" style="display:block">
        <div class="zone-grid">
          <span></span><span></span><span class="muted center small">BPM</span><span class="muted center small">%</span>
          ${percents.map((p, i) => html`
            <span class="zone-name"><span class="zone-dot" style=${{ background: Z.ZONE_COLORS[i] }}></span>Zone ${i + 1} <span class="muted small">${Z.ZONE_NAMES[i]}</span></span>
            <span class="muted small" style="text-align:right">from</span>
            <${NumberBox} label=${`Zone ${i + 1} bpm`} value=${Z.bpmFor(maxHR, p)} onCommit=${(n) => setBoundary(i, { bpm: n })} />
            <${NumberBox} label=${`Zone ${i + 1} percent`} value=${pct(p)} onCommit=${(n) => setBoundary(i, { percent: n })} />`)}
          <span class="zone-name" style="font-weight:650">Max Heart Rate</span><span></span>
          <${NumberBox} label="Max heart rate" value=${maxHR} onCommit=${setMax} />
          <span class="muted center num">100</span>
        </div>
        ${!isDefault ? html`<button class="btn" style="margin-top:12px" onClick=${() => settings.set('hrZonePercents', [...Z.DEFAULT_ZONE_PERCENTS])}>Reset to Garmin's default zones</button>` : null}
      </div>`}
    </div>
  </${Section}>`;
}

function Verification({ v }) {
  if (!v) return null;
  return html`<div class="item">
    <span class=${v.ok ? 'green' : 'red'} style="font-size:18px">${v.ok ? '✔' : '✖'}</span>
    <div><div>${v.message}</div><div class="small muted">Checked ${new Date(v.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div></div>
  </div>`;
}

export function GarminSection({ app }) {
  const { api, uploads, settings } = app;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    const r = await api.accounts.garminSignIn();
    setBusy(false);
    if (!r.ok && !r.cancelled) setError(`${r.message} Try signing in again.`);
  };
  return html`<${Section} title="Garmin Connect"
    footer="You sign in on Garmin's own page; Spindown never sees your password, only a token kept encrypted on this computer. Garmin has no public upload API for apps like this, so Spindown uses the same upload service as Garmin's app. It works today but Garmin could change it. Rides that cannot be sent are kept and retried, and can always be exported as FIT. Rides appear in Garmin Connect as Indoor Cycling, and are forwarded to Strava if you have linked the two.">
    <div class="list">
      ${uploads.garminSignedIn ? html`
        <${LV} k="Account" v=${uploads.garminAccountName ?? 'Signed in'} />
        ${uploads.garminNeedsSignIn ? html`<div class="item orange">⚠ Garmin needs you to sign in again <span class="spacer"></span><button class="btn primary" onClick=${signIn} disabled=${busy}>Sign In Again</button></div>` : null}
        <${Toggle} label="Upload rides automatically" checked=${settings.get('autoUploadGarmin')} onChange=${(v) => settings.set('autoUploadGarmin', v)} />
        <div class="item"><button class="btn" disabled=${busy} onClick=${async () => { setBusy(true); await api.accounts.garminTest(); setBusy(false); }}>✓ Verify Connection</button>${busy ? html`<${Spinner} />` : null}</div>
        <${Verification} v=${uploads.garminVerification} />
        <div class="item"><button class="btn danger" onClick=${() => api.accounts.garminSignOut()}>Sign Out</button></div>
      ` : html`
        <div class="item"><button class="btn primary" onClick=${signIn} disabled=${busy}>Sign In to Garmin Connect</button>${busy ? html`<${Spinner} /><span class="muted small">Waiting for the Garmin window…</span>` : null}</div>
        <${Toggle} label="Upload rides automatically" checked=${settings.get('autoUploadGarmin')} onChange=${(v) => settings.set('autoUploadGarmin', v)} />
      `}
      ${error ? html`<div class="item red">${error}</div>` : null}
    </div>
  </${Section}>`;
}

function StravaSection({ app }) {
  const { api, uploads, settings } = app;
  const [id, setID] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.accounts.stravaCredentials().then((c) => {
      setID(c.clientID);
      setSecret(c.clientSecret);
    });
  }, []);
  const connect = async () => {
    setBusy(true);
    setError(null);
    const r = await api.accounts.stravaSignIn();
    setBusy(false);
    if (!r.ok && !r.cancelled) setError(r.message);
  };
  const both = settings.get('autoUploadGarmin') && settings.get('autoUploadStrava');
  return html`<${Section} title="Strava"
    footer=${both
      ? 'Both Garmin and Strava uploads are on. If Garmin Connect is already linked to Strava you will get duplicates; turn one off.'
      : 'Only needed if your Garmin account is not linked to Strava. Create a free API application at strava.com/settings/api with the callback domain "localhost", then enter its Client ID and Secret. Uploads are marked as indoor trainer rides.'}>
    <div class="list">
      ${uploads.stravaSignedIn ? html`
        <${LV} k="Athlete" v=${uploads.stravaAccountName ?? 'Signed in'} />
        ${uploads.stravaNeedsSignIn ? html`<div class="item orange">⚠ Strava needs you to sign in again <span class="spacer"></span><button class="btn primary" onClick=${connect}>Connect Strava</button></div>` : null}
        <${Toggle} label="Upload rides automatically" checked=${settings.get('autoUploadStrava')} onChange=${(v) => settings.set('autoUploadStrava', v)} />
        <div class="item"><button class="btn" disabled=${busy} onClick=${async () => { setBusy(true); await api.accounts.stravaVerify(); setBusy(false); }}>✓ Verify Connection</button></div>
        <${Verification} v=${uploads.stravaVerification} />
        <div class="item"><button class="btn danger" onClick=${() => api.accounts.stravaSignOut()}>Disconnect Strava</button></div>
      ` : html`
        <div class="item row"><span style="width:110px">Client ID</span><input type="text" style="flex:1" value=${id} onInput=${(e) => setID(e.target.value)} /></div>
        <div class="item row"><span style="width:110px">Client Secret</span><input type="password" style="flex:1" value=${secret} onInput=${(e) => setSecret(e.target.value)} /></div>
        <div class="item row">
          <button class="btn" disabled=${!id || !secret} onClick=${() => api.accounts.stravaSetCredentials(id.trim(), secret.trim())}>Save API Credentials</button>
          <button class="btn primary" disabled=${busy || !uploads.stravaHasCredentials} onClick=${connect}>Connect Strava</button>
          ${busy ? html`<${Spinner} />` : null}
        </div>
        <${Verification} v=${uploads.stravaVerification} />
      `}
      ${error ? html`<div class="item red">${error}</div>` : null}
    </div>
  </${Section}>`;
}

export function SettingsView({ app, openSensors, openWelcome }) {
  const { settings, trainer, heartRate, api, info, update } = app;
  const [updateMsg, setUpdateMsg] = useState(null);
  const now = Date.now();
  return html`<div class="page" style="max-width:860px">
    <${Section} title="Sensors">
      <div class="list">
        <button class="item" onClick=${openSensors}>
          <div style="flex:1">
            <div class=${linkColor(trainer.state)}>🚲 ${linkTitle(trainer.state)}</div>
            <div class=${heartRate.freshHeartRate(now) != null ? 'green' : 'muted'}>♥ ${heartRate.statusLine(now)}</div>
          </div>
          <span class="muted">Manage ›</span>
        </button>
      </div>
    </${Section}>

    <${Section} title="Trainer">
      <div class="list">
        <${LV} k="Trainer" v=${settings.get('trainerName') ?? 'None'} />
        <${Toggle} label="Reconnect automatically" checked=${settings.get('autoConnect')} onChange=${(v) => settings.set('autoConnect', v)} />
        <${Select} label="Sensor update rate" value=${settings.get('updateRate')}
          options=${[[0, 'Sensor default'], ...UPDATE_RATES.map((r) => [r, rateLabel(r)])]}
          onChange=${(v) => { settings.set('updateRate', Number(v)); trainer.applyUpdateRateNow(); }} />
      </div>
    </${Section}>

    <${Section} title="Display">
      <div class="list">
        <${Select} label="Units" value=${settings.get('units')} options=${[['metric', 'Metric (km/h, km)'], ['imperial', 'Imperial (mph, mi)']]} onChange=${(v) => settings.set('units', v)} />
        <${Select} label="Power display" value=${settings.get('powerSmoothing')} options=${[[1, 'Instant'], [3, '3 s average'], [5, '5 s average'], [10, '10 s average']]}
          onChange=${(v) => settings.set('powerSmoothing', Number(v))} />
        <${Toggle} label="Keep the screen on while Spindown is open" checked=${settings.get('keepScreenOn')} onChange=${(v) => { settings.set('keepScreenOn', v); app.session.updateKeepAwake(); }} />
      </div>
    </${Section}>

    <${HeartRateZonesSection} app=${app} />

    <${GarminSection} app=${app} />
    <${StravaSection} app=${app} />

    <${Section} title="Recording" footer="About 100 KB per hour. Lets the decoder be improved later from your real trainer data.">
      <div class="list">
        <${Toggle} label="Save raw Bluetooth capture with rides" checked=${settings.get('captureRawPackets')} onChange=${(v) => settings.set('captureRawPackets', v)} />
        <button class="item" onClick=${() => api.app.openFolder('rides')}>📁 <span style="flex:1">Open the rides folder</span></button>
      </div>
    </${Section}>

    <${Section} title="About">
      <div class="list">
        <${LV} k="Version" v=${`${info.version}${info.isPackaged ? '' : ' (development)'}`} />
        <div class="item row">
          <span style="flex:1">${update.status === 'ready' ? `Version ${update.version} is ready. It installs the next time Spindown closes.`
            : update.status === 'downloading' ? `Downloading version ${update.version}…`
            : updateMsg ?? 'Spindown updates itself automatically.'}</span>
          ${update.status === 'ready'
            ? html`<button class="btn primary" disabled=${app.session.phase !== 'idle'} onClick=${() => api.app.installUpdate()}>Restart and update</button>`
            : html`<button class="btn" onClick=${async () => { setUpdateMsg('Checking…'); const r = await api.app.checkForUpdates(); setUpdateMsg(r.status === 'current' ? 'You have the latest version.' : r.status === 'dev' ? 'Updates are only checked in the installed app.' : r.status === 'error' ? `Could not check: ${r.message}` : null); }}>Check now</button>`}
        </div>
        <button class="item" onClick=${openWelcome}>👋 <span style="flex:1">Show the welcome guide again</span></button>
        <div class="item small muted" style="display:block;line-height:1.5">
          Spindown is an independent, open-source app for Kinetic Road Machine Smart trainers with the inRide sensor. Power, speed and cadence use Kinetic's published inRide algorithm. Not affiliated with Kinetic, Garmin or Strava.
          Rides are stored only on this computer unless you upload them.
        </div>
      </div>
    </${Section}>
  </div>`;
}
