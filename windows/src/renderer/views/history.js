// History tab and the ride detail. Port of HistoryView.swift.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Tile, LV, Section, Confirm, LineChart } from '../components.js';
import * as Format from '../../core/format.js';
import { Destinations, destinationName, describeUpload } from '../../core/recorder.js';
import { GarminConnectClient, StravaClient } from '../../core/services.js';
import { ExportFormats } from '../../core/fit.js';
import { timeInZones, zoneBounds, ZONE_COLORS, ZONE_NAMES } from '../../core/hrzones.js';
import { RideSegments } from './segments.js';
import { ordinal } from '../../core/worldride.js';

/** The picture taken as a World ride finished, with ways to get it onto Strava by hand. */
function RidePicture({ app, record }) {
  const { api } = app;
  const [src, setSrc] = useState(null);
  const [note, setNote] = useState(null);
  useEffect(() => {
    if (record.picture) api.rides.picture(record.id).then(setSrc).catch(() => setSrc(null));
  }, [record.id, record.picture]);
  if (!record.picture || !src) return null;
  const strava = record.uploads?.strava;
  const stravaID = strava && (strava.status === 'uploaded' || strava.status === 'duplicate') ? strava.activityID : null;
  const footer = strava?.photo === 'attached'
    ? 'This picture is attached to the ride on Strava.'
    : 'Strava only lets its approved partner apps (such as Zwift) attach photos automatically, so add this one yourself: copy or save the picture, open the ride on Strava, and add it as a photo.';
  return html`<${Section} title="Picture" footer=${footer}>
    <div class="card">
      <img class="ride-picture" src=${src} alt="Your rider in Spindown World at the end of the ride" />
      <div class="ride-picture-actions">
        <button class="btn" onClick=${async () => setNote((await api.rides.copyPicture(record.id)) ? 'Picture copied. Paste it where you like.' : 'Could not copy the picture.')}>⧉ Copy picture</button>
        <button class="btn" onClick=${async () => { const p = await api.rides.savePicture(record.id); if (p) setNote(`Saved ${p}`); }}>⤓ Save picture…</button>
        ${stravaID ? html`<button class="btn" onClick=${() => api.app.openExternal(StravaClient.activityURL(stravaID))}>Open in Strava ↗</button>` : null}
      </div>
      ${note ? html`<div class="small muted selectable" style="margin-top:8px">${note}</div>` : null}
    </div>
  </${Section}>`;
}

/** "Virtual ride · York Grand Prix · 3rd of 21" for a World ride. */
function worldLine(w) {
  const parts = ['Virtual ride in Spindown World', w.course || w.title];
  if (w.mode === 'race' && w.race) parts.push(w.place ? `${w.race}: ${ordinal(w.place)}${w.field ? ` of ${w.field}` : ''}` : w.race);
  if (w.mode === 'workout' && w.workout) parts.push(w.workout);
  return parts.filter(Boolean).join(' · ');
}

function TimeInZones({ track, settings }) {
  const max = settings.get('maxHeartRate');
  const pcts = settings.get('hrZonePercents');
  const secs = useMemo(() => (track ? timeInZones(track.samples, max, pcts) : null), [track, max, pcts]);
  if (!secs) return null;
  const total = secs.reduce((a, b) => a + b, 0);
  if (total < 1) return null;
  const bounds = zoneBounds(max, pcts);
  const rows = [5, 4, 3, 2, 1].map((z) => ({ z, label: `Zone ${z}`, sub: `${bounds[z - 1].low}–${z === 5 ? max : bounds[z - 1].high - 1} bpm`, color: ZONE_COLORS[z - 1], name: ZONE_NAMES[z - 1], s: secs[z] }));
  if (secs[0] > 0) rows.push({ z: 0, label: 'Below zone 1', sub: `under ${bounds[0].low} bpm`, color: '#48484a', name: '', s: secs[0] });
  return html`<${Section} title="Time in heart rate zones" footer=${`Using your zones in Settings (max heart rate ${max} bpm).`}>
    <div class="card">
      ${rows.map((r) => html`<div class="zone-bar">
        <div><div style="font-weight:650">${r.label} <span class="small muted">${r.name}</span></div><div class="small muted num">${r.sub}</div></div>
        <div class="track"><div style=${{ width: `${(r.s / total) * 100}%`, background: r.color }}></div></div>
        <div class="num" style="text-align:right">${Format.duration(r.s)}</div>
        <div class="num muted small" style="text-align:right">${Math.round((r.s / total) * 100)}%</div>
      </div>`)}
    </div>
  </${Section}>`;
}

const SYMBOL = { garmin: '▲', strava: '🔥' };

function uploadColor(s) {
  if (!s) return 'muted';
  if (s.status === 'uploaded' || s.status === 'duplicate') return 'green';
  if (s.status === 'failed') return s.retryable ? 'orange' : 'red';
  return 'muted';
}

export function HistoryView({ app, selectedID, onSelect }) {
  const { records, loadErrors } = app.rides;
  const u = app.settings.get('units');
  const selected = selectedID ?? records[0]?.id ?? null;

  return html`<div class="history">
    <div class="rides">
      ${records.length === 0 ? html`<div class="empty"><div class="icon">🚲</div><div style="font-weight:650;font-size:18px">No rides yet</div><div>Finished rides are saved here automatically.</div></div>` : null}
      ${records.map((r) => html`<button class="ride-row ${r.id === selected ? 'selected' : ''}" onClick=${() => onSelect(r.id)}>
        <div class="row">
          <span class="name">${r.name}</span>
          ${r.recovered ? html`<span class="orange" title="Recovered">↺</span>` : null}
          <span class="spacer"></span>
          ${Destinations.filter((d) => r.uploads?.[d]).map((d) => html`<span class=${uploadColor(r.uploads[d])} title=${`${destinationName(d)}: ${describeUpload(r.uploads[d])}`}>${SYMBOL[d]}</span>`)}
        </div>
        <div class="small muted">${Format.dateTime(r.startDate)}</div>
        <div class="meta num">
          <span>⏱ ${Format.shortDuration(r.summary.timerTime)}</span>
          <span>${Format.distance(r.summary.distance, u)} ${Format.distanceUnit(u)}</span>
          <span>⚡ ${Format.watts(r.summary.averagePower)} W</span>
          ${r.summary.averageHeartRate != null ? html`<span>♥ ${Math.round(r.summary.averageHeartRate)} bpm</span>` : null}
        </div>
      </button>`)}
      ${loadErrors?.length ? html`<div class="section" style="margin-top:16px"><h3>Unreadable files</h3>${loadErrors.map((e) => html`<div class="small red">${e}</div>`)}</div>` : null}
    </div>
    <div class="detail">
      ${selected ? html`<${RideDetail} app=${app} rideID=${selected} key=${selected} />` : null}
    </div>
  </div>`;
}

export function RideDetail({ app, rideID, compact }) {
  const { api, settings, uploads } = app;
  const record = app.rides.records.find((r) => r.id === rideID);
  const [track, setTrack] = useState(null);
  const [name, setName] = useState(record?.name ?? '');
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState(null);
  const u = settings.get('units');

  useEffect(() => {
    api.rides.track(rideID).then(setTrack).catch((e) => setError(`Could not read this ride's samples: ${e.message}`));
  }, [rideID]);
  useEffect(() => setName(record?.name ?? ''), [record?.name]);

  const charts = useMemo(() => {
    if (!track || track.samples.length < 2) return null;
    const step = Math.max(1, Math.floor(track.samples.length / 800));
    const pts = [];
    for (let i = 0; i < track.samples.length; i += step) pts.push(track.samples[i]);
    return {
      power: pts.map((s) => ({ x: s.t / 60, y: s.power })),
      hr: pts.some((s) => s.heartRate != null) ? pts.map((s) => ({ x: s.t / 60, y: s.heartRate })) : null,
    };
  }, [track]);

  if (!record) return html`<div class="empty">Ride not found</div>`;
  const s = record.summary;

  const rename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== record.name) api.rides.rename(rideID, trimmed);
  };

  const exportAs = async (format) => {
    const path = await api.rides.export(rideID, format);
    if (path) setMessage(`Saved ${path}`);
  };

  const statusText = (d, state) => {
    const signedIn = d === 'garmin' ? uploads.garminSignedIn : uploads.stravaSignedIn;
    const needs = d === 'garmin' ? uploads.garminNeedsSignIn : uploads.stravaNeedsSignIn;
    if (state?.status === 'pending' && (!signedIn || needs)) return 'Waiting for sign-in (Settings)';
    const extra = [];
    if (d === 'strava' && state?.sportType === 'VirtualRide') extra.push('Virtual Ride');
    if (d === 'strava' && state?.photo === 'attached') extra.push('picture attached');
    if (d === 'strava' && state?.photo === 'manual') extra.push('add the picture by hand');
    return [describeUpload(state), ...extra].join(' · ');
  };

  const activityURL = (d, state) => {
    const id = state && (state.status === 'uploaded' || state.status === 'duplicate') ? state.activityID : null;
    if (!id) return null;
    return d === 'garmin' ? GarminConnectClient.activityURL(id) : StravaClient.activityURL(id);
  };

  return html`<div class="page" style="max-width:980px">
    <div class="section">
      <input class="name-input" type="text" value=${name} onInput=${(e) => setName(e.target.value)} onBlur=${rename}
        onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} aria-label="Ride name" />
      <div class="muted" style="padding:2px 6px">${Format.dateTime(record.startDate)}</div>
      ${record.recovered ? html`<div class="orange small" style="padding:4px 6px">↺ Recovered after the app closed unexpectedly</div>` : null}
      ${record.world ? html`<div class="small" style="padding:4px 6px">🌍 ${worldLine(record.world)}</div>` : null}
    </div>

    <${RidePicture} app=${app} record=${record} />

    <${Section} title="Summary">
      <div class="tiles" style=${{ gridTemplateColumns: `repeat(${compact ? 3 : 4}, 1fr)` }}>
        <${Tile} title="Moving" value=${Format.duration(s.movingTime)} size=${26} />
        <${Tile} title="Elapsed" value=${Format.duration(s.elapsedTime)} size=${26} />
        <${Tile} title="Distance" value=${Format.distance(s.distance, u)} unit=${Format.distanceUnit(u)} size=${26} />
        <${Tile} title="Avg Speed" value=${Format.speedMS(s.averageSpeed, u)} unit=${Format.speedUnit(u)} size=${26} />
        <${Tile} title="Avg Power" value=${Format.watts(s.averagePower)} unit="W" size=${26} />
        <${Tile} title="Max Power" value=${Format.watts(s.maxPower)} unit="W" size=${26} />
        <${Tile} title="Norm. Power" value=${Format.watts(s.normalizedPower)} unit="W" size=${26} />
        <${Tile} title="Energy" value=${String(Math.round(s.work / 1000))} unit="kJ" size=${26} />
        <${Tile} title="Avg Cadence" value=${Format.rpm(s.averageCadence)} unit="rpm" size=${26} />
        <${Tile} title="Max Speed" value=${Format.speedMS(s.maxSpeed, u)} unit=${Format.speedUnit(u)} size=${26} />
        ${s.averageHeartRate != null ? html`
          <${Tile} title="Avg HR" value=${Format.rpm(s.averageHeartRate)} unit="bpm" tint="red" size=${26} />
          <${Tile} title="Max HR" value=${s.maxHeartRate ?? '--'} unit="bpm" tint="red" size=${26} />` : null}
      </div>
    </${Section}>

    ${charts ? html`<${Section} title=${charts.hr ? 'Power and heart rate' : 'Power'}>
      <div class="card">
        <${LineChart} points=${charts.power} color="#ffd60a" yLabel="W" height=${170} />
        ${charts.hr ? html`<div style="height:10px"></div><${LineChart} points=${charts.hr} color="#ff453a" yLabel="bpm" height=${130} includeZero=${false} />` : null}
      </div>
    </${Section}>` : null}

    <${TimeInZones} track=${track} settings=${settings} />

    <${RideSegments} app=${app} record=${record} />

    <${Section} title="Uploads" footer=${record.uploads?.garmin && record.uploads?.strava ? 'If Garmin Connect is linked to Strava, Garmin also forwards this ride there; uploading to both may create a duplicate.' : null}>
      <div class="list">
        ${Destinations.map((d) => {
          const state = record.uploads?.[d];
          const url = activityURL(d, state);
          const canUpload = !state || state.status === 'failed';
          return html`<div class="item">
            <span style="width:22px;text-align:center" class=${uploadColor(state)}>${SYMBOL[d]}</span>
            <div style="flex:1"><div style="font-weight:600">${destinationName(d)}</div><div class="small muted">${statusText(d, state)}</div></div>
            ${url ? html`<button class="btn" onClick=${() => api.app.openExternal(url)}>Open ↗</button>` : null}
            ${canUpload ? html`<button class="btn primary" onClick=${() => api.uploads.enqueue(rideID, [d])}>${state ? 'Retry' : 'Upload'}</button>` : null}
          </div>`;
        })}
      </div>
    </${Section}>

    <${Section} title="Export" footer="FIT is the most complete format and imports into Garmin Connect, Strava, TrainingPeaks and intervals.icu.">
      <div class="list">
        ${ExportFormats.map((f) => html`<button class="item" onClick=${() => exportAs(f.id)}>⤓ <span style="flex:1">${f.name}</span><span class="muted small">Save…</span></button>`)}
        <button class="item" onClick=${async () => { const p = await api.rides.exportRaw(rideID); setMessage(p ? `Saved ${p}` : 'No raw capture for this ride.'); }}>〰 <span style="flex:1">Raw Bluetooth capture (JSONL)</span><span class="muted small">Save…</span></button>
      </div>
      ${message ? html`<div class="small muted selectable" style="margin:8px 4px">${message}</div>` : null}
    </${Section}>

    ${record.trainer ? html`<${Section} title="Equipment">
      <div class="list">
        <${LV} k="Trainer sensor" v=${record.trainer.model ?? record.trainer.name} />
        <${LV} k="Firmware" v=${record.trainer.firmware} />
        <${LV} k="Spindown" v=${record.trainer.spindownTime != null ? `${record.trainer.spindownTime.toFixed(2)} s` : null} />
        <${LV} k="Pro Flywheel" v=${record.trainer.proFlywheel == null ? null : record.trainer.proFlywheel ? 'Yes' : 'No'} />
        <${LV} k="Heart-rate monitor" v=${record.trainer.heartRateMonitor ?? 'None'} />
      </div>
    </${Section}>` : null}

    ${error ? html`<div class="red">${error}</div>` : null}
    ${!compact ? html`<button class="btn danger" onClick=${() => setConfirmDelete(true)}>Delete ride…</button>` : null}
    ${confirmDelete ? html`<${Confirm} title="Delete ride?" message=${`"${record.name}" will be removed from this computer. Copies already uploaded are not affected.`}
      onCancel=${() => setConfirmDelete(false)}
      buttons=${[{ label: 'Cancel', onClick: () => setConfirmDelete(false) }, { label: 'Delete', kind: 'danger', onClick: () => { setConfirmDelete(false); api.rides.delete(rideID); } }]} />` : null}
  </div>`;
}
