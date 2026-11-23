// "World" tab: Spindown World, a 3D cycling game in York and the Yorkshire Dales.
// Like the Lakes tab it replaces, it is only a different view of the same ride: it reads the trainer and heart
// rate and offers the same Start/Pause/Finish, so recording, saving and Garmin upload are unchanged. Anything
// that goes wrong in the 3D world is caught here and never reaches the ride session.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Modal, Stepper, Progress, Select, Toggle } from '../components.js';
import { useRideControls, liveZone, ZoneBadge } from './ride.js';
import { linkTitle, isStreaming } from '../ble/trainer.js';
import * as Format from '../../core/format.js';
import * as Lakes from '../../core/lakes.js';
import { WorldScene } from '../game3d/scene.js';
import { GameAudio } from '../game3d/audio.js';
import { makeDales, makeYork } from '../../core/world/worlds.js';
import { WorldSim, RACE_PRESETS, raceFieldSize } from '../../core/world/sim.js';
import * as P from '../../core/world/progression.js';
import { ITEMS, ACHIEVEMENTS, CHALLENGES, POWERUPS, TIERS, MAX_LEVEL, PACERS } from '../../core/world/content.js';
import { riderParams, steadySpeed } from '../../core/world/physics.js';
import { routeLatLon } from '../../core/world/geo.js';
import { worldRideInfo } from '../../core/worldride.js';
import yorkData from '../game3d/data/york.json';
import dalesData from '../game3d/data/dales.json';

// ---- Long-lived game state (kept across tab switches) ---------------------------------------------------
const G = {
  canvas: null,
  scene: null,
  sim: null,
  profile: null,
  routes: {},
  audio: new GameAudio(),
  stats: { fps: 0, frames: 0, frameMs: 0 },
  timeScale: 1,
  failure: null,
  toasts: [],
  workout: null,
  workoutElapsed: 0,
  rideClock: 0,
  startD: 0,
  raceXP: 0,
  forceError: false,
  eventLog: [],
  qualityChecked: false,
};
if (typeof window !== 'undefined') window.__spindownWorld = G;

function route(id) {
  if (!G.routes[id]) G.routes[id] = id === 'york' ? makeYork(yorkData) : makeDales(dalesData);
  return G.routes[id];
}

let toastID = 1;
function toast(kind, title, text = '', ttl = 4.5) {
  G.toasts.push({ id: toastID++, kind, title, text, until: performance.now() + ttl * 1000 });
  if (G.toasts.length > 5) G.toasts.splice(0, G.toasts.length - 5);
}

let saveTimer = null;
function scheduleSave(api, now = false) {
  clearTimeout(saveTimer);
  const save = () => {
    if (G.profile) api.game.save(P.serialiseProfile(G.profile)).catch(() => {});
  };
  if (now) save();
  else saveTimer = setTimeout(save, 3000);
}

function qualityFor(profile) {
  const q = profile.settings.quality;
  return q === 'auto' ? G.autoQuality ?? 'medium' : q;
}

/** Creates the renderer and world (once), or rebuilds them for a new route or quality. */
function ensureScene(routeId) {
  const q = qualityFor(G.profile);
  if (G.scene && G.scene.qualityName !== q) {
    if (G.canvas) G.canvas.disposed = true;
    G.scene.dispose();
    G.scene = null;
    G.canvas?.remove();
    G.canvas = null;
  }
  if (!G.scene) {
    const canvas = document.createElement('canvas');
    G.canvas = canvas;
    canvas.className = 'world-canvas';
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      // Ignore the context we release on purpose when rebuilding the world.
      if (!canvas.disposed && canvas === G.canvas) G.failure = 'The graphics card reset the 3D view.';
    });
    G.scene = new WorldScene(G.canvas, { quality: q });
    G.scene.cameraMode = G.profile.settings.camera ?? 'chase';
  }
  const r = route(routeId);
  if (G.scene.route !== r) {
    G.scene.setWorld(r, r.world === 'york' ? yorkData : dalesData);
    G.scene.setAtmosphere(G.profile.settings.timeOfDay, G.profile.settings.weather);
  }
  return r;
}

/** The FTP the game sets bots by: what your riding shows once there is enough of it, else your setting. */
function effectiveFtp(app) {
  return G.profile?.ftpEstimate ?? app.settings.get('ftp');
}

function newSim(app, { routeId, mode = 'free', race = null, startPacer = null }) {
  const r = ensureScene(routeId);
  G.sim = new WorldSim({
    route: r,
    profile: G.profile,
    mode,
    race,
    ftp: effectiveFtp(app),
    seed: Math.floor(Math.random() * 1e6),
    botCount: qualityFor(G.profile) === 'low' ? 12 : 22,
    startPacer,
  });
  G.startD = G.sim.player.d;
  G.rideClock = 0;
  G.raceXP = 0;
  G.profile.lastRoute = routeId;
  for (const e of P.noteRideDay(G.profile)) handleEvent(app, e);
  scheduleSave(app.api);
}

// ---- Events from the simulation ---------------------------------------------------------------------------

function handleEvent(app, e) {
  // Recent events, for Diagnostics and automated checks.
  G.eventLog.push({ type: e.type, at: Date.now(), name: e.achievement?.name ?? e.powerup?.name ?? e.segment?.name ?? e.challenge?.name ?? null, medal: e.medal ?? null, level: e.level ?? null, delta: e.delta ?? null, place: e.place ?? null });
  if (G.eventLog.length > 600) G.eventLog.splice(0, 100);
  const u = app.settings.get('units');
  const a = G.audio;
  switch (e.type) {
    case 'banner': toast('banner', e.text, '', 3.5); break;
    case 'pickup': toast('pickup', `${e.powerup.icon} ${e.powerup.name}`, 'Press Space or click to use', 3); a.chime(); break;
    case 'powerup': toast('powerup', `${e.powerup.icon} ${e.powerup.name}!`, e.powerup.text, 3); a.whoosh(); break;
    case 'achievement': toast('achievement', `🏆 ${e.achievement.name}`, e.achievement.text, 6); a.fanfare(); break;
    case 'challenge': toast('challenge', `✅ Challenge complete: ${e.challenge.name}`, `+${e.challenge.xp} XP`, 5); a.chime(); break;
    case 'level': {
      const unlocks = e.unlocks.map((x) => x.item.name).join(', ');
      toast('level', `⭐ Level ${e.level}!`, unlocks ? `Unlocked: ${unlocks}` : 'Keep riding for new kit', 7);
      a.fanfare();
      break;
    }
    case 'xp': if (G.sim?.mode === 'race') G.raceXP += e.amount; break;
    case 'segment-start':
      if (e.segment.kind !== 'lap') toast('segment', `${e.segment.kind === 'kom' ? '▲' : '⚡'} ${e.segment.name}`, e.pr ? `PR ${Format.shortDuration(e.pr)} · gold ${Format.shortDuration(e.segment.medals.gold)}` : `Gold under ${Format.shortDuration(e.segment.medals.gold)}`, 3.5);
      break;
    case 'segment-end': {
      const medal = e.medal ? { gold: '🥇', silver: '🥈', bronze: '🥉' }[e.medal] : '';
      const pr = e.improved && e.previous != null ? ` · new PR (−${(e.previous - e.time).toFixed(1)} s)` : e.previous != null ? ` · PR ${Format.shortDuration(e.previous)}` : '';
      const speed = e.speed ? ` · ${Format.speedMS(e.speed, u)} ${Format.speedUnit(u)}` : '';
      toast(e.medal ? 'medal' : 'segment', `${medal} ${e.segment.name}: ${Format.shortDuration(e.time)}`, `${speed}${pr}`.replace(/^ · /, ''), 5);
      if (e.medal) a.chime();
      break;
    }
    case 'checkpoint': toast(e.delta <= 0 ? 'ahead' : 'behind', `${e.delta <= 0 ? '▲' : '▼'} ${e.delta <= 0 ? '−' : '+'}${Math.abs(e.delta).toFixed(1)} s vs PR`, `${Format.distance(e.at, u)} ${Format.distanceUnit(u)} into the lap`, 3); break;
    case 'lap': if (e.lap > 0 && G.sim?.mode === 'free') toast('banner', `Lap ${e.lap} complete`, '', 3); break;
    case 'countdown': G.countdown = { n: e.n, at: performance.now() }; a.beep(false); break;
    case 'go': G.countdown = { n: 'GO!', at: performance.now() }; a.beep(true); break;
    case 'race-finish': G.showResults = true; a.cheer(); a.fanfare(); break;
    case 'ftp': toast('achievement', `💪 FTP estimate: ${e.ftp} W`, e.previous ? `Up from ${e.previous} W. Bots and races adjust to it.` : 'From your riding. Bots and races adjust to it.', 6); break;
    default:
  }
}

// ---- Small components -------------------------------------------------------------------------------------

/** Pacers' badge in the rider list: PACE in the ghost's colour. */
function RiderBadge({ rider }) {
  if (rider.pacer) return html`<span class="tier pace" style=${{ background: rider.pacer.color }} title=${`Pacer: holds ${rider.pacer.watts} W`}>PACE</span>`;
  return html`<${TierBadge} tier=${rider.tier} level=${rider.isPlayer ? P.level(G.profile) : rider.level} />`;
}

function TierBadge({ tier, level }) {
  return html`<span class="tier" style=${{ background: tier.color }} title=${`${tier.name} (${tier.wkg[0]}–${tier.wkg[1]} W/kg)`}>${tier.short}${level != null ? html`<b>${level}</b>` : null}</span>`;
}

function XPBar({ profile, compact }) {
  const lp = P.levelProgress(profile);
  return html`<div class="xpbar ${compact ? 'compact' : ''}">
    <span class="lvl">Lv ${lp.level}</span>
    <div class="track"><div class="fill" style=${{ width: `${Math.round(lp.fraction * 100)}%` }}></div></div>
    <span class="small num">${lp.level >= MAX_LEVEL ? 'MAX' : `${lp.toNext.toLocaleString()} XP to go`}</span>
  </div>`;
}

function Minimap({ sim }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      if (!c || !G.sim) return;
      const s = G.sim, r = s.route;
      const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (!r.minimap) {
        const b = r.bounds();
        const scale = Math.min((W - 24) / (b.maxX - b.minX), (H - 24) / (b.maxZ - b.minZ));
        const ox = (W - (b.maxX - b.minX) * scale) / 2 - b.minX * scale, oz = (H - (b.maxZ - b.minZ) * scale) / 2 - b.minZ * scale;
        const path = new Path2D();
        for (let i = 0; i <= r.count; i += 3) {
          const x = r.xs[i] * scale + ox, y = r.zs[i] * scale + oz;
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        }
        path.closePath();
        r.minimap = { scale, ox, oz, path, W, H };
      }
      const m = r.minimap;
      const pt = (d) => {
        const p = r.rawPoint(d);
        return [p.x * m.scale + m.ox, p.z * m.scale + m.oz];
      };
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 7;
      g.stroke(m.path);
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 3;
      g.stroke(m.path);
      // Zones in colour.
      for (const z of r.zones) {
        g.strokeStyle = z.kind === 'kom' ? '#ff453a' : '#0a84ff';
        g.lineWidth = 4;
        g.beginPath();
        for (let d = z.from; d <= z.to; d += 10) {
          const [x, y] = pt(d);
          if (d === z.from) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
      // Start/finish chequer.
      const [fx, fy] = pt(0);
      g.fillStyle = '#fff';
      g.fillRect(fx - 5, fy - 5, 10, 10);
      g.fillStyle = '#000';
      g.fillRect(fx - 5, fy - 5, 5, 5);
      g.fillRect(fx, fy, 5, 5);
      for (const rider of s.riders) {
        if (rider.isPlayer || rider.hidden) continue;
        const [x, y] = pt(rider.d);
        g.beginPath();
        g.arc(x, y, rider.isGhost || rider.pacer ? 4 : 3.2, 0, Math.PI * 2);
        if (rider.isGhost || rider.pacer) {
          g.strokeStyle = rider.pacer?.color ?? '#5ad1ff';
          g.lineWidth = 2;
          g.stroke();
        } else {
          g.fillStyle = rider.tier.color;
          g.fill();
        }
      }
      const [px, py] = pt(s.player.d);
      const pulse = 6 + Math.sin(performance.now() / 180) * 1.5;
      g.beginPath();
      g.arc(px, py, pulse, 0, Math.PI * 2);
      g.fillStyle = '#ffd60a';
      g.fill();
      g.lineWidth = 2.5;
      g.strokeStyle = '#000';
      g.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  void sim;
  return html`<canvas class="minimap" ref=${ref}></canvas>`;
}

function ElevationProfile({ sim }) {
  const r = sim.route;
  if (!r.profilePath) {
    let d = '';
    const n = 240;
    for (let i = 0; i <= n; i++) {
      const y = r.elevation((i / n) * r.length);
      const yy = 38 - ((y - r.minY) / Math.max(10, r.maxY - r.minY)) * 32;
      d += `${i === 0 ? 'M' : 'L'}${((i / n) * 1000).toFixed(1)},${yy.toFixed(1)}`;
    }
    r.profilePath = d;
  }
  const lap = r.wrap(sim.player.d) / r.length;
  const ghost = sim.ghost && !sim.ghost.hidden ? r.wrap(sim.ghost.d) / r.length : null;
  return html`<svg class="elevation" viewBox="0 0 1000 40" preserveAspectRatio="none">
    ${r.zones.map((z) => html`<rect x=${(z.from / r.length) * 1000} y="0" width=${((z.to - z.from) / r.length) * 1000} height="40" fill=${z.kind === 'kom' ? 'rgba(255,69,58,0.25)' : 'rgba(10,132,255,0.25)'} />`)}
    <path d=${`${r.profilePath} L1000,40 L0,40 Z`} fill="rgba(255,255,255,0.18)" />
    <path d=${r.profilePath} fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    ${ghost != null ? html`<line x1=${ghost * 1000} x2=${ghost * 1000} y1="0" y2="40" stroke="#5ad1ff" stroke-width="2" vector-effect="non-scaling-stroke" />` : null}
    <line x1=${lap * 1000} x2=${lap * 1000} y1="0" y2="40" stroke="#ffd60a" stroke-width="3" vector-effect="non-scaling-stroke" />
  </svg>`;
}

function RiderList({ sim, units }) {
  const p = sim.player;
  let rows;
  if (sim.mode === 'race') {
    const order = sim.standings();
    const me = order.indexOf(p);
    const from = Math.max(0, Math.min(order.length - 8, me - 3));
    rows = order.slice(from, from + 8).map((r, i) => ({ r, place: from + i + 1, gap: (r.d - p.d) / Math.max(3, p.v) }));
    // Pacers and Mark Potts take no place: shown among the riders round them, without a number.
    const live = rows.filter((x) => !x.r.finished);
    if (live.length) {
      const hi = Math.max(...live.map((x) => x.r.d)) + 15, lo = Math.min(...live.map((x) => x.r.d)) - 15;
      const extra = sim.riders.filter((r) => r.unplaced && r.d <= hi && r.d >= lo).map((r) => ({ r, place: '', gap: (r.d - p.d) / Math.max(3, p.v) }));
      if (extra.length) {
        rows = [...rows.filter((x) => x.r.finished), ...[...live, ...extra].sort((a, b) => b.r.d - a.r.d)];
        const start = Math.max(0, Math.min(rows.length - 9, rows.findIndex((x) => x.r === p) - 4));
        rows = rows.slice(start, start + 9);
      }
    }
  } else {
    const L = sim.route.length;
    rows = sim.riders.filter((r) => !r.isGhost).map((r) => {
      let rel = ((r.d - p.d) % L + L) % L;
      if (rel > L / 2) rel -= L;
      return { r, rel };
    }).filter((x) => Math.abs(x.rel) < 600).sort((a, b) => b.rel - a.rel).slice(0, 8);
    const me = rows.findIndex((x) => x.r === p);
    if (me > 5) rows = rows.slice(me - 5, me + 3);
  }
  return html`<div class="riderlist glass">
    ${rows.map((x) => html`<div class="row ${x.r.isPlayer ? 'me' : ''}">
      ${x.place != null ? html`<span class="place num">${x.place}</span>` : null}
      <${RiderBadge} rider=${x.r} />
      <span class="name">${x.r.flames ? '🔥 ' : ''}${x.r.name}</span>
      <span class="gap num">${x.r.isPlayer ? `${(x.r.power / x.r.mass).toFixed(1)} W/kg` : x.place != null ? (x.r.finished ? 'FIN' : `${x.gap > 0 ? '+' : '−'}${Math.abs(x.gap).toFixed(0)}s`) : `${x.rel > 0 ? '+' : '−'}${Format.distance(Math.abs(x.rel), units) === '0.00' ? Math.round(Math.abs(x.rel)) + ' m' : Format.distance(Math.abs(x.rel), units) + ' ' + Format.distanceUnit(units)}`}</span>
    </div>`)}
  </div>`;
}

function PowerupSlot({ sim, onUse }) {
  const p = sim.player;
  const held = p.held.map((id) => POWERUPS.find((x) => x.id === id));
  const active = p.effects.map((e) => ({ ...e, def: POWERUPS.find((x) => x.id === e.id) }));
  return html`<div class="powerups">
    ${(held.length ? held : [null]).map((h) => html`<button class="slot glass ${h ? 'full' : ''}" onClick=${onUse} disabled=${!h} title=${h ? h.text : 'Ride through a gift to collect a power-up'}>
      <span class="icon">${h ? h.icon : '🎁'}</span>
      <span class="small">${h ? h.name : 'Empty'}</span>
      ${h ? html`<span class="key">SPACE</span>` : null}
    </button>`)}
    ${active.map((e) => html`<div class="effect glass"><span>${e.def.icon} ${e.def.name}</span>
      <${Progress} value=${Math.max(0, (e.until - sim.time) / e.duration)} color=${e.def.color} /></div>`)}
  </div>`;
}

function Toasts() {
  const now = performance.now();
  G.toasts = G.toasts.filter((t) => t.until > now);
  return html`<div class="toasts">${G.toasts.map((t) => html`<div class="toast ${t.kind}" key=${t.id}><div class="t">${t.title}</div>${t.text ? html`<div class="s">${t.text}</div>` : null}</div>`)}</div>`;
}

// ---- Menus ------------------------------------------------------------------------------------------------

function MainMenu({ app, onFreeRide, onRace, onWorkouts, open }) {
  const prof = G.profile;
  const [pacer, setPacer] = useState(prof.settings.startPacer ?? null);
  const pick = (w) => {
    setPacer(w);
    prof.settings.startPacer = w;
    scheduleSave(app.api);
  };
  const york = route('york'), dales = route('dales');
  const u = app.settings.get('units');
  const card = (r, img) => html`<button class="mcard" onClick=${() => onFreeRide(r.id)}>
    <div class="art ${img}"></div>
    <div class="body"><div class="title">Free Ride · ${r.title}</div><div class="small muted">${r.blurb}</div>
    <div class="small num">${Format.distance(r.length, u)} ${Format.distanceUnit(u)} lap · ${Math.round(r.climb)} m climbing</div></div>
  </button>`;
  return html`<div class="world-menu">
    <div class="menu-head">
      <div><div class="brand-title">Spindown World</div><div class="muted">Ride York's real streets and the Yorkshire Dales. Your trainer is your engine.</div></div>
      <div class="spacer"></div>
      <div style="min-width:320px"><${XPBar} profile=${prof} /></div>
    </div>
    <div class="menu-grid">
      ${card(york, 'york')}
      ${card(dales, 'dales')}
    </div>
    <div class="pacer-pick">
      <span class="small muted">Start next to a pacer:</span>
      <button class=${pacer == null ? 'on' : ''} onClick=${() => pick(null)}>None</button>
      ${PACERS.map((p) => html`<button class=${pacer === p.watts ? 'on' : ''} style=${{ '--pc': p.color }} onClick=${() => pick(p.watts)} title=${`Start your free ride beside the ${p.watts} W pacer`}>${p.watts} W</button>`)}
    </div>
    <h3 style="margin:18px 4px 8px">Races</h3>
    <div class="menu-grid three">
      ${RACE_PRESETS.map((rp) => html`<button class="mcard race" onClick=${() => onRace(rp)}>
        <div class="body"><div class="title">🏁 ${rp.name}</div><div class="small muted">${rp.blurb}</div>
        <div class="small num">${rp.minutes} min · ${raceFieldSize(rp) + 1} riders · ${route(rp.world).title}</div></div>
      </button>`)}
    </div>
    <div class="menu-row">
      <button class="btn big white" onClick=${onWorkouts}>🎯 Workouts</button>
      <button class="btn big white" onClick=${() => open('garage')}>🚲 Garage</button>
      <button class="btn big white" onClick=${() => open('progress')}>🏆 Progress</button>
      <button class="btn big white" onClick=${() => open('options')}>⚙️ World settings</button>
    </div>
    <div class="small muted" style="margin-top:10px">Tip: just start pedalling to ride. Space uses a power-up · 1–6 change camera · ← → change lane · M menu. Map data © OpenStreetMap contributors (ODbL). Terrain: Environment Agency LIDAR (© Environment Agency, Open Government Licence v3.0) and Mapzen/AWS Terrain Tiles. Imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0. Photo textures: Poly Haven (CC0).</div>
  </div>`;
}

function Garage({ app, onClose }) {
  const prof = G.profile;
  const [slot, setSlot] = useState('bike');
  const eq = P.equipment(prof);
  const u = app.settings.get('units');
  const speedLine = (bike, wheels) => {
    const p = riderParams({ riderMass: prof.settings.riderMass, bike, wheels });
    return `${Format.speedMS(steadySpeed(200, 0, p), u)} ${Format.speedUnit(u)} flat · ${Format.speedMS(steadySpeed(200, 0.06, p), u)} on 6% at 200 W`;
  };
  const equip = (id) => {
    if (P.equip(prof, slot, id)) {
      if (G.sim) G.sim.player.kit = { ...P.equipment(prof) };
      scheduleSave(app.api);
    }
  };
  return html`<div class="side-panel glass">
    <div class="row"><h2 style="margin:0">Garage</h2><span class="spacer"></span><button class="btn" onClick=${onClose}>Done</button></div>
    <div class="segmented">${[['bike', 'Bikes'], ['wheels', 'Wheels'], ['jersey', 'Jerseys'], ['helmet', 'Helmets']].map(([k, l]) => html`<button class=${slot === k ? 'on' : ''} onClick=${() => setSlot(k)}>${l}</button>`)}</div>
    <div class="items">
      ${ITEMS[slot].map((it) => {
        const unlocked = P.isUnlocked(prof, slot, it.id);
        const on = prof.equipped[slot] === it.id;
        return html`<button class="item-card ${on ? 'on' : ''} ${unlocked ? '' : 'locked'}" disabled=${!unlocked} onClick=${() => equip(it.id)}>
          <div class="sw" style=${{ background: it.body ?? it.color ?? '#333', borderColor: it.accent ?? it.sleeve ?? '#000' }}></div>
          <div style="flex:1;text-align:left">
            <div style="font-weight:700">${it.name} ${on ? html`<span class="green">✔</span>` : null}</div>
            ${slot === 'bike' ? html`<div class="small muted">${it.mass} kg · aero ×${it.cda} · ${it.perk.name}: ${it.perk.text}</div><div class="small num">${speedLine(it, eq.wheels)}</div>` : null}
            ${slot === 'wheels' ? html`<div class="small muted">${it.mass} kg · ${Math.round(it.depth * 1000)} mm rims · aero ×${it.cda}</div><div class="small num">${speedLine(eq.bike, it)}</div>` : null}
            ${slot === 'helmet' && it.aero < 1 ? html`<div class="small muted">Aero helmet: ${Math.round((1 - it.aero) * 100)}% less drag</div>` : null}
            ${!unlocked ? html`<div class="small orange">🔒 ${it.achievement ? ACHIEVEMENTS.find((a) => a.id === it.achievement)?.text : `Unlocks at level ${it.level}`}</div>` : null}
          </div>
        </button>`;
      })}
    </div>
    <div class="small muted">Your rider is shown on the left with the kit you choose.</div>
  </div>`;
}

function ProgressPanel({ app, onClose }) {
  const prof = G.profile;
  const u = app.settings.get('units');
  const s = prof.stats;
  const routes = ['york', 'dales'].map(route);
  return html`<${Modal} title="Progress" size="wide" onClose=${onClose}>
    <${XPBar} profile=${prof} />
    <div class="stat-grid">
      ${[['Distance', `${Format.distance(s.distance, u)} ${Format.distanceUnit(u)}`], ['Time', Format.duration(s.time)], ['Climbed', `${Math.round(s.climb)} m`], ['Races', s.races], ['Wins', s.wins], ['Podiums', s.podiums],
        ['Medals', s.medals], ['Power-ups used', s.powerupsUsed], ['Overtakes', s.overtakes], ['Top speed', `${Format.speedMS(s.maxSpeed, u)} ${Format.speedUnit(u)}`]].map(([k, v]) => html`<div class="card"><div class="small muted">${k}</div><div style="font-size:22px;font-weight:700" class="num">${v}</div></div>`)}
    </div>
    <div class="section"><h3>Challenges</h3><div class="list">
      ${prof.challenges.active.map((a) => {
        const c = CHALLENGES.find((x) => x.id === a.id);
        const unit = c.metric === 'distance' ? (v) => `${Format.distance(v, u)} ${Format.distanceUnit(u)}` : c.metric === 'time' || c.metric === 'draftTime' ? (v) => Format.duration(v) : c.metric === 'climb' ? (v) => `${Math.round(v)} m` : (v) => Math.floor(v);
        return html`<div class="item" style="display:block"><div class="row"><b>${c.name}</b><span class="spacer"></span><span class="small num">${unit(a.progress)} / ${unit(c.goal)} · +${c.xp} XP</span></div><${Progress} value=${a.progress / c.goal} color="var(--yellow)" /></div>`;
      })}
    </div></div>
    <div class="section"><h3>Achievements (${Object.keys(prof.achievements).length}/${ACHIEVEMENTS.length})</h3>
      <div class="ach-grid">${ACHIEVEMENTS.map((a) => html`<div class="ach ${prof.achievements[a.id] ? 'got' : ''}"><div class="t">${prof.achievements[a.id] ? '🏆' : '🔒'} ${a.name}</div><div class="small muted">${a.text}</div></div>`)}</div>
    </div>
    ${routes.map((r) => html`<div class="section"><h3>${r.title}: PRs and medals</h3><div class="list">
      ${r.segments.map((seg) => {
        const pr = prof.prs[r.id]?.[seg.id];
        const medal = prof.medals[r.id]?.[seg.id];
        return html`<div class="item"><span style="flex:1">${seg.kind === 'kom' ? '▲' : seg.kind === 'zone' ? '⚡' : '🔁'} ${seg.name}</span>
          ${seg.medals ? html`<span class="small muted num">🥇 ${Format.shortDuration(seg.medals.gold)} 🥈 ${Format.shortDuration(seg.medals.silver)} 🥉 ${Format.shortDuration(seg.medals.bronze)}</span>` : null}
          <span class="num" style="min-width:90px;text-align:right">${medal ? { gold: '🥇', silver: '🥈', bronze: '🥉' }[medal] : ''} ${pr ? Format.shortDuration(pr.time) : '—'}</span></div>`;
      })}
    </div></div>`)}
  </${Modal}>`;
}

function OptionsPanel({ app, onClose, onQuality }) {
  const prof = G.profile;
  const s = prof.settings;
  const set = (k, v) => {
    s[k] = v;
    if ((k === 'timeOfDay' || k === 'weather') && G.scene) G.scene.setAtmosphere(s.timeOfDay, s.weather);
    if (k === 'sound') G.audio.setEnabled(v);
    if (k === 'camera' && G.scene) G.scene.cameraMode = v;
    if (k === 'riderMass' && G.sim) G.sim.player.mass = v;
    if (k === 'quality') onQuality();
    scheduleSave(app.api);
  };
  return html`<${Modal} title="World settings" onClose=${onClose}>
    <div class="section"><div class="list">
      <${Select} label="Graphics quality" value=${s.quality} options=${[['auto', 'Automatic'], ['low', 'Low (older laptops)'], ['medium', 'Medium'], ['high', 'High']]} onChange=${(v) => set('quality', v)} />
      <${Select} label="Time of day" value=${s.timeOfDay} options=${[['morning', 'Morning'], ['midday', 'Midday'], ['evening', 'Golden evening']]} onChange=${(v) => set('timeOfDay', v)} />
      <${Select} label="Weather" value=${s.weather} options=${[['fair', 'Fair'], ['overcast', 'Overcast'], ['rain', 'Yorkshire drizzle']]} onChange=${(v) => set('weather', v)} />
      <${Select} label="Camera" value=${s.camera} options=${[['chase', 'Chase'], ['close', 'Close'], ['first', 'First person'], ['side', 'Side'], ['aerial', 'Aerial'], ['cinematic', 'Cinematic (TV)']]} onChange=${(v) => set('camera', v)} />
      <${Toggle} label="Sound" checked=${s.sound} onChange=${(v) => set('sound', v)} />
      <${Stepper} label="Your weight" value=${s.riderMass} display=${`${s.riderMass} kg`} min=${40} max=${150} step=${1} onChange=${(v) => set('riderMass', v)} />
      <${Stepper} label="Your FTP" value=${app.settings.get('ftp')} display=${`${app.settings.get('ftp')} W`} min=${80} max=${500} step=${5} onChange=${(v) => app.settings.set('ftp', v)} />
      <div class="item row"><span>FTP from your riding</span><span class="spacer"></span><span class="num">${prof.ftpEstimate ? `${prof.ftpEstimate} W` : 'not yet (ride 5+ minutes hard)'}</span>
        ${prof.ftpEstimate ? html`<button class="btn" style="margin-left:10px" onClick=${() => { prof.ftpEstimate = null; scheduleSave(app.api); }}>Reset</button>` : null}</div>
    </div>
    <div class="footer">Bots and races are set from your FTP: the estimate from your riding once there is one, otherwise the number above. They also adjust as you ride, so nobody is ever miles too fast or too slow. Weight sets how fast you climb (power-to-weight). Your ride recording always uses the trainer's own speed and power; the game never changes it.</div></div>
  </${Modal}>`;
}

function WorkoutPicker({ app, onChoose, onClose }) {
  return html`<${Modal} title="Workouts" onClose=${onClose}>
    <div class="section"><div class="list"><${Stepper} label="Your FTP" value=${app.settings.get('ftp')} display=${`${app.settings.get('ftp')} W`} min=${80} max=${500} step=${5} onChange=${(v) => app.settings.set('ftp', v)} /></div>
      <div class="footer">Targets come from your FTP. Choosing a workout starts recording if it isn't already, and you ride it in the Dales.</div></div>
    <div class="section"><div class="list">
      ${Lakes.WORKOUTS.map((w) => html`<button class="item" onClick=${() => onChoose(w)}><div style="flex:1"><div style="font-weight:650">${w.name}</div><div class="small muted">${w.tagline}</div></div></button>`)}
    </div></div>
  </${Modal}>`;
}

function Results({ app, onRideOn, onAgain, onMenu, onFinish }) {
  const sim = G.sim;
  const board = sim.leaderboard();
  const winner = board[0].time;
  const me = sim.race.playerPlace;
  return html`<${Modal} title=${`🏁 ${sim.race.preset.name}: ${me ? `you finished ${ordinal(me)}` : 'results'}`} size="wide" hideClose onClose=${onRideOn} footer=${html`<button class="btn" onClick=${onMenu}>Menu</button>
      <button class="btn" onClick=${onAgain}>Race again</button>
      <span class="spacer"></span>
      ${app.session.phase !== 'idle' ? html`<button class="btn big red" onClick=${onFinish}>■ Finish ride</button>` : null}
      <button class="btn big green" onClick=${onRideOn}>Keep riding ▸</button>`}>
    <div class="row" style="gap:16px;margin-bottom:10px">
      <div class="card" style="flex:1"><div class="small muted">Your time</div><div style="font-size:28px;font-weight:800" class="num">${Format.duration(sim.player.finishTime ?? 0)}</div></div>
      <div class="card" style="flex:1"><div class="small muted">Place</div><div style="font-size:28px;font-weight:800">${me ? `${ordinal(me)} of ${board.length}` : '—'}</div></div>
      <div class="card" style="flex:1"><div class="small muted">XP earned</div><div style="font-size:28px;font-weight:800" class="yellow">+${G.raceXP}</div></div>
    </div>
    ${sim.riders.some((r) => r.unplaced && !r.pacer) ? html`<div class="small muted" style="margin:0 2px 8px">${sim.riders.filter((r) => r.unplaced && !r.pacer).map((r) => `🔥 ${r.name}`).join(', ')} rode as a guest at a constant ${sim.riders.find((r) => r.unplaced && !r.pacer).fixedPower} W and takes no place. Pacers take no place either.</div>` : null}
    <table class="leaderboard">
      <thead><tr><th>#</th><th></th><th>Rider</th><th>W/kg</th><th>Time</th><th>Gap</th></tr></thead>
      <tbody>${board.map((b, i) => html`<tr class=${b.rider.isPlayer ? 'me' : ''}>
        <td class="num">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
        <td><${TierBadge} tier=${b.rider.tier} level=${b.rider.isPlayer ? P.level(G.profile) : b.rider.level} /></td>
        <td>${b.rider.name}</td>
        <td class="num">${b.rider.wkg.toFixed(1)}</td>
        <td class="num">${Format.duration(b.time)}${b.projected ? html` <span class="muted small">(riding)</span>` : ''}</td>
        <td class="num muted">${i === 0 ? '' : `+${Format.shortDuration(b.time - winner)}`}</td>
      </tr>`)}</tbody>
    </table>
  </${Modal}>`;
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// ---- The view -----------------------------------------------------------------------------------------------

export function WorldView({ app, openSensors }) {
  const { trainer, heartRate, session, settings } = app;
  const holder = useRef(null);
  const plates = useRef(null);
  const [, setTick] = useState(0);
  const [panel, setPanel] = useState(() => {
    if (G.sim) return null;
    G.welcomeMenu = true;
    G.pedalling = 0;
    return 'menu';
  });
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [ready, setReady] = useState(!!G.profile);
  const [failure, setFailure] = useState(G.failure);
  const { buttons, dialogs, finish } = useRideControls(app);

  // Load the game profile once.
  useEffect(() => {
    if (G.profile) return;
    app.api.game.load().then((raw) => {
      G.profile = P.migrateProfile(raw);
      G.audio.setEnabled(G.profile.settings.sound);
      setReady(true);
    }).catch(() => {
      G.profile = P.newProfile();
      setReady(true);
    });
  }, []);

  const fail = (e) => {
    const message = String(e?.message ?? e);
    G.failure = message;
    app.log.log(`World: ${message}`, 'error');
    setFailure(message);
  };

  // Start the world and the render loop.
  useEffect(() => {
    if (!ready || failure) return;
    let raf = 0, last = performance.now(), hudAt = 0, frames = 0, fpsAt = performance.now(), slowSince = null;
    try {
      if (!G.sim) newSim(app, { routeId: G.profile.lastRoute === 'dales' ? 'dales' : 'york' });
      else ensureScene(G.sim.route.id);
      holder.current.appendChild(G.canvas);
    } catch (e) {
      fail(e);
      return undefined;
    }
    session.worldVisible = true;
    session.updateKeepAwake();
    const link = worldLink(app, () => holder.current?.parentNode);
    session.world = link;
    const frame = (t) => {
      raf = requestAnimationFrame(frame);
      try {
        if (G.forceError) {
          G.forceError = false;
          throw new Error('Test: forced error in the 3D world');
        }
        if (G.failure) throw new Error(G.failure);
        const now = Date.now();
        const real = Math.min(0.1, Math.max(0, (t - last) / 1000));
        last = t;
        const reading = trainer.freshReading(now);
        const power = session.displayPower(now);
        const sim = G.sim;
        let remaining = real * G.timeScale;
        const events = [];
        while (remaining > 1e-6) {
          const dt = Math.min(0.25, remaining);
          events.push(...sim.step(dt, { power, cadence: reading?.cadenceRPM ?? null }));
          remaining -= dt;
        }
        if (power != null) G.rideClock += real * G.timeScale;
        if (G.workout && session.phase === 'recording') G.workoutElapsed += real * G.timeScale;
        for (const e of events) handleEvent(app, e);
        if (events.some((e) => e.type !== 'xp')) scheduleSave(app.api);
        const scene = G.scene;
        scene.resize();
        scene.syncRiders(sim);
        const open = panelRef.current;
        scene.cameraMode = G.shotCamera ?? (open === 'garage' ? 'side' : open === 'menu' ? 'cinematic' : G.profile.settings.camera);
        scene.updateCamera(sim, real);
        scene.updateTokens(sim, real * G.timeScale);
        scene.render();
        G.audio.update(real, sim.player.v, sim.player.cadence);
        G.lastFrameAt = performance.now();
        updatePlates(sim, scene, plates.current);
        // Auto-close the menu once you start riding.
        // Only the welcome menu shown on arrival closes by itself; a menu you opened stays until you choose.
        if (open === 'menu' && G.welcomeMenu && power != null && power > 40) {
          G.pedalling = (G.pedalling ?? 0) + real;
          if (G.pedalling > 4) {
            G.pedalling = 0;
            G.welcomeMenu = false;
            setPanel(null);
          }
        } else if (open !== 'menu') G.welcomeMenu = false;
        // Frame rate, and automatic quality.
        frames++;
        if (t - fpsAt >= 1000) {
          G.stats.fps = (frames * 1000) / (t - fpsAt);
          G.stats.frames += frames;
          frames = 0;
          fpsAt = t;
          if (G.profile.settings.quality === 'auto' && (G.autoQuality ?? 'medium') !== 'low') {
            if (G.stats.fps < 28) slowSince ??= t;
            else slowSince = null;
            if (slowSince != null && t - slowSince > 6000) {
              G.autoQuality = 'low';
              toast('banner', 'Switched to low graphics for a smoother ride', 'Change it in World settings', 5);
              rebuild();
            }
          }
        }
        if (t - hudAt > 150) {
          hudAt = t;
          setTick((n) => n + 1);
        }
      } catch (e) {
        cancelAnimationFrame(raf);
        fail(e);
      }
    };
    raf = requestAnimationFrame(frame);
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT') return;
      const sim = G.sim;
      if (!sim) return;
      G.audio.start();
      if (e.code === 'Space') {
        e.preventDefault();
        sim.usePowerup();
      } else if (e.key >= '1' && e.key <= '6') {
        const modes = ['chase', 'close', 'first', 'side', 'aerial', 'cinematic'];
        G.profile.settings.camera = modes[Number(e.key) - 1];
      } else if (e.key === 'ArrowLeft') sim.player.steerTarget = Math.max(-2.2, (sim.player.steerTarget ?? 0.6) - 0.8);
      else if (e.key === 'ArrowRight') sim.player.steerTarget = Math.min(2.2, (sim.player.steerTarget ?? 0.6) + 0.8);
      else if (e.key === 'm' || e.key === 'M') setPanel((p) => (p === 'menu' ? null : 'menu'));
      else if (e.key === 'Escape') setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      G.canvas?.remove();
      if (session.world === link) session.world = null;
      session.worldVisible = false;
      session.updateKeepAwake();
      scheduleSave(app.api, true);
    };
  }, [ready, failure]);

  const rebuild = () => {
    const id = G.sim?.route.id ?? 'york';
    try {
      G.canvas?.remove();
      ensureScene(id);
      holder.current?.appendChild(G.canvas);
    } catch (e) {
      fail(e);
    }
  };

  const restartWorld = () => {
    try {
      if (G.canvas) G.canvas.disposed = true;
      G.scene?.dispose();
    } catch {
      // already broken
    }
    G.scene = null;
    G.canvas = null;
    G.sim = null;
    G.failure = null;
    setFailure(null);
  };

  const now = Date.now();
  const u = settings.get('units');

  if (failure) {
    return html`<div class="world-fail">
      <div class="card" style="max-width:640px">
        <h2 style="margin-top:0">The 3D world stopped</h2>
        <p>Your ride is not affected: recording carries on as normal and you can use the Ride tab.</p>
        <p class="small muted mono">${failure}</p>
        <div class="row" style="gap:10px"><button class="btn primary" onClick=${restartWorld}>Restart the 3D world</button></div>
      </div>
      <div class="controls" style="max-width:700px;width:100%">${buttons()}</div>
      ${dialogs}
    </div>`;
  }
  if (!ready) return html`<div class="world-fail"><div class="muted">Loading Spindown World…</div></div>`;

  const sim = G.sim;
  const hr = heartRate.freshHeartRate(now);
  const power = session.displayPower(now);
  const reading = trainer.freshReading(now);
  const ftp = settings.get('ftp');
  const position = G.workout ? Lakes.workoutPosition(G.workout, G.workoutElapsed) : null;
  const powerColour = (() => {
    if (power == null || !position || position.isComplete) return '';
    const [lo, hi] = Lakes.targetWatts(position.step, ftp);
    return power < lo ? 'orange' : power > hi ? 'cyan' : 'green';
  })();

  const startFree = (routeId) => {
    G.audio.start();
    G.workout = null;
    newSim(app, { routeId, startPacer: G.profile.settings.startPacer ?? null });
    rebuildIfNeeded();
    setPanel(null);
  };
  const rebuildIfNeeded = () => {
    if (G.canvas && holder.current && G.canvas.parentNode !== holder.current) holder.current.appendChild(G.canvas);
  };
  const startRace = (preset) => {
    G.audio.start();
    G.workout = null;
    G.showResults = false;
    newSim(app, { routeId: preset.world, mode: 'race', race: preset });
    rebuildIfNeeded();
    setPanel(null);
  };
  const go = () => {
    G.audio.start();
    if (session.phase === 'idle') session.start();
    G.sim.startCountdown(10);
  };
  const chooseWorkout = (w) => {
    G.workout = w;
    G.workoutElapsed = 0;
    if (session.phase === 'idle') session.start();
    newSim(app, { routeId: 'dales' });
    rebuildIfNeeded();
    setPanel(null);
  };

  const race = sim?.mode === 'race' ? sim.race : null;
  const standings = race ? sim.standings() : null;
  const place = standings ? standings.indexOf(sim.player) + 1 : null;
  const grad = sim ? sim.route.gradient(sim.player.d) * 100 : 0;
  const countdown = G.countdown && performance.now() - G.countdown.at < 1100 ? G.countdown.n : null;
  const rideDistance = sim ? sim.player.d - G.startD : 0;

  return html`<div class="world">
    <div class="world-holder" ref=${holder}></div>
    <div class="plates" ref=${plates}></div>
    ${sim && panel !== 'menu' ? html`<div class="world-hud">
      <div class="hud-top">
        <div class="hud-left glass">
          <div class="big-num ${powerColour}"><span class="num">${Format.watts(power)}</span><small>W</small><small class="wkg num">${power == null ? '--' : (power / sim.player.mass).toFixed(1)} W/kg</small></div>
          <div class="hud-grid">
            <div><span class="num">${Format.speedMS(sim.player.v, u)}</span><small>${Format.speedUnit(u)}</small></div>
            <div><span class="num">${Format.rpm(reading?.cadenceRPM)}</span><small>rpm</small></div>
            <div class="hud-hr ${hr == null ? 'muted' : 'red'}" title="Heart rate"><span class="num">${hr ?? '--'}</span><small>bpm</small><${ZoneBadge} zone=${liveZone(settings, hr)} /></div>
          </div>
          ${sim.player.draft > 0.08 ? html`<div class="draft">🌬 Drafting · ${Math.round(sim.player.draft * 100)}% less drag</div>` : null}
        </div>
        <div class="hud-centre">
          ${race ? html`<div class="glass race-box">
            <div class="pos"><span class="num">${place}</span><small>/ ${standings.length}</small></div>
            <div class="small">${race.phase === 'racing' || race.phase === 'finished' ? `${Format.distance(Math.max(0, race.finishD - sim.player.d), u)} ${Format.distanceUnit(u)} to go · ${Format.duration(sim.time - race.start)}` : race.phase === 'grid' ? 'On the grid' : 'Get ready…'}</div>
            <${Progress} value=${Math.min(1, Math.max(0, (sim.player.d - race.startD) / race.distance))} color="var(--yellow)" />
          </div>` : html`<div class="glass mid-box">
            <span class="num">${Format.duration(session.phase === 'idle' ? G.rideClock : session.elapsed(now))}</span>
            <span class="num">${Format.distance(Math.max(0, rideDistance), u)} ${Format.distanceUnit(u)}</span>
            <span class="num ${grad > 3 ? 'red' : grad < -3 ? 'cyan' : ''}">${grad >= 0 ? '↗' : '↘'} ${grad.toFixed(1)}%</span>
          </div>`}
          <${Toasts} />
        </div>
        <div class="hud-right">
          <${Minimap} sim=${sim} />
          <${RiderList} sim=${sim} units=${u} />
        </div>
      </div>
      ${countdown != null ? html`<div class="countdown" key=${String(countdown)}>${countdown}</div>` : null}
      ${race?.phase === 'grid' && !panel ? html`<div class="grid-call glass">
        <div style="font-size:22px;font-weight:800">🏁 ${race.preset.name}</div>
        <div class="muted">${Format.distance(race.distance, u)} ${Format.distanceUnit(u)} · ${standings.length} riders · about ${race.preset.minutes} minutes</div>
        <button class="btn big green" onClick=${go}>Start the countdown</button>
        <div class="small muted">${session.phase === 'idle' ? 'Recording starts with the race, so it goes to Garmin like any ride.' : 'Your ride is already recording.'}</div>
      </div>` : null}
      ${position ? (() => {
        const [lo, hi] = Lakes.targetWatts(position.step, ftp);
        return html`<div class="glass workout-box">
          <div class="row"><b>${position.isComplete ? 'Workout complete 🎉' : position.step.label}</b><span class="spacer"></span><span class="num">${Format.duration(position.remainingInStep).replace(/^0:/, '')}</span></div>
          ${!position.isComplete ? html`<div class="row small"><span>Target ${lo}–${hi} W</span><span class="spacer"></span><span class=${powerColour}>${power == null ? '' : power < lo ? 'PUSH ↑' : power > hi ? 'EASE ↓' : 'ON TARGET ✓'}</span></div>` : null}
          <${Progress} value=${position.fractionOfWorkout} />
        </div>`;
      })() : null}
      <div class="hud-bottom">
        <${PowerupSlot} sim=${sim} onUse=${() => sim.usePowerup()} />
        <div class="bottom-mid">
          <div class="glass profile-box"><${ElevationProfile} sim=${sim} /></div>
          <${XPBar} profile=${G.profile} compact />
        </div>
        <div class="bottom-right">
          ${!isStreaming(trainer.state) ? html`<button class="glass pill" onClick=${openSensors}>📡 ${linkTitle(trainer.state)}</button>` : null}
          <div class="row" style="gap:8px">
            <button class="btn white" title="Camera (1–6)" onClick=${() => {
              const modes = ['chase', 'close', 'first', 'side', 'aerial', 'cinematic'];
              G.profile.settings.camera = modes[(modes.indexOf(G.profile.settings.camera) + 1) % modes.length];
              toast('banner', `Camera: ${G.profile.settings.camera}`, '', 1.5);
            }}>🎥</button>
            <button class="btn white" onClick=${() => setPanel('menu')}>☰ Menu</button>
          </div>
          <div class="controls">${buttons()}</div>
        </div>
      </div>
    </div>` : null}
    ${panel === 'menu' ? html`<div class="menu-backdrop"><${MainMenu} app=${app} onFreeRide=${startFree} onRace=${startRace} onWorkouts=${() => setPanel('workouts')} open=${setPanel} />
      ${sim ? html`<button class="btn big white close-menu" onClick=${() => { G.audio.start(); setPanel(null); }}>Ride ${sim.route.title} ▸</button>` : null}</div>` : null}
    ${panel === 'garage' ? html`<${Garage} app=${app} onClose=${() => setPanel(null)} />` : null}
    ${panel === 'progress' ? html`<${ProgressPanel} app=${app} onClose=${() => setPanel('menu')} />` : null}
    ${panel === 'options' ? html`<${OptionsPanel} app=${app} onClose=${() => setPanel('menu')} onQuality=${rebuild} />` : null}
    ${panel === 'workouts' ? html`<${WorkoutPicker} app=${app} onChoose=${chooseWorkout} onClose=${() => setPanel('menu')} />` : null}
    ${G.showResults && race ? html`<${Results} app=${app}
      onRideOn=${() => { G.showResults = false; setTick((n) => n + 1); }}
      onAgain=${() => startRace(race.preset)}
      onMenu=${() => { G.showResults = false; setPanel('menu'); }}
      onFinish=${() => { G.showResults = false; finish(); }} />` : null}
    ${dialogs}
  </div>`;
}

// ---- The ride recording's view of the world -----------------------------------------------------------------

/**
 * What the ride session reads from the world while it is on screen: the rider's real latitude, longitude and
 * altitude on the course (null if the world has not drawn a frame lately, e.g. the window is minimised), the
 * course details saved with the ride, and a picture for the ride's summary and Strava.
 */
function worldLink(app, root) {
  return {
    position() {
      const sim = G.sim;
      if (!sim || G.failure || !(performance.now() - (G.lastFrameAt ?? -1e9) < 2500)) return null;
      const data = sim.route.world === 'york' ? yorkData : dalesData;
      if (!data?.origin) return null;
      return routeLatLon(sim.route, data.origin, sim.player.d, sim.player.lateral ?? 0);
    },
    info() {
      return G.sim ? worldRideInfo(G.sim, { workout: G.workout }) : null;
    },
    capture: () => captureRidePicture(app, root()),
  };
}

/**
 * A clean picture of the 3D view: other riders' name tags, the rider list, results, toasts, menus, dialogs and
 * buttons are hidden (body.world-shot in styles.css), the camera is put behind your rider if it was in first
 * person, then the main process grabs the world's area of the window. Everything is restored afterwards.
 */
async function captureRidePicture(app, root) {
  if (!G.scene || !G.sim || !root?.isConnected) return null;
  const frame = () => Promise.race([new Promise((r) => requestAnimationFrame(() => r())), new Promise((r) => setTimeout(r, 250))]);
  document.body.classList.add('world-shot');
  if (G.profile?.settings.camera === 'first') {
    G.shotCamera = 'chase';
    G.scene.camInit = false;
  }
  try {
    for (let i = 0; i < 3; i++) await frame();
    const b = root.getBoundingClientRect();
    return await app.api.app.capturePicture({ x: b.left, y: b.top, width: b.width, height: b.height });
  } finally {
    document.body.classList.remove('world-shot');
    if (G.shotCamera) {
      G.shotCamera = null;
      if (G.scene) G.scene.camInit = false;
    }
  }
}

/** Floating name tags over nearby riders, positioned straight from the 3D camera every frame. */
function updatePlates(sim, scene, el) {
  if (!el) return;
  const L = sim.route.length;
  // Pacers carry their own big watts label in 3D (scene.js), so they need no plate.
  const list = sim.riders.filter((r) => !r.isPlayer && !r.hidden && !r.pacer).map((r) => {
    let rel = r.d - sim.player.d;
    if (sim.mode === 'free') {
      rel = ((rel % L) + L) % L;
      if (rel > L / 2) rel -= L;
    }
    return { r, rel };
  }).filter((x) => x.rel > -15 && x.rel < 90).sort((a, b) => Math.abs(a.rel) - Math.abs(b.rel)).slice(0, 10);
  while (el.children.length < 10) {
    const d = document.createElement('div');
    d.className = 'plate';
    el.appendChild(d);
  }
  const p = {};
  for (let i = 0; i < 10; i++) {
    const node = el.children[i];
    const x = list[i];
    const at = x && scene.project(sim, x.r, p);
    if (!at) {
      node.style.display = 'none';
      continue;
    }
    node.style.display = 'block';
    const s = Math.max(0.55, Math.min(1, 14 / Math.max(1, at.distance)));
    node.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%) scale(${s.toFixed(2)})`;
    const text = x.r.isGhost ? `<span class="ghost">👻 Your PR</span>` : `<span class="tb" style="background:${x.r.tier.color}">${x.r.tier.short}<b>${x.r.level}</b></span>${x.r.flames ? '🔥 ' : ''}${x.r.name}`;
    if (node.dataset.text !== text) {
      node.innerHTML = text;
      node.dataset.text = text;
    }
  }
}

export { TIERS };
