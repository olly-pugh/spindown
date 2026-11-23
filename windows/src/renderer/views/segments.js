// Segments in Spindown World: the banner before a segment, the live timer and delta against your PR while
// you ride it, the result card at the end, and the Segments page that compares every attempt (World menu,
// and from a ride in History). The history itself lives in the game profile (core/world/efforts.js).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Modal, Section } from '../components.js';
import * as E from '../../core/world/efforts.js';
import { makeDales, makeYork } from '../../core/world/worlds.js';
import * as P from '../../core/world/progression.js';
import yorkData from '../game3d/data/york.json';
import dalesData from '../game3d/data/dales.json';

const ICON = { segment: '⏱', kom: '▲', zone: '⚡', lap: '🔁' };
const COURSES = [['york', 'York'], ['dales', 'Malham']];
/** Kinds with the banner, live timer and result card while riding (zones are short sprints with toasts). */
const LIVE_KINDS = ['segment', 'kom'];
const RESULT_SECONDS = 10;

// ---- Styles (kept here so the feature is self-contained) ---------------------------------------------------

const CSS = `
.seg-hud { display: flex; flex-direction: column; gap: 6px; align-items: center; width: 100%; max-width: 560px; pointer-events: none; }
.seg-card { width: 100%; background: rgba(16, 18, 22, 0.8); border-radius: 12px; border-left: 5px solid var(--green); padding: 8px 16px 10px; animation: slidein 0.25s ease-out; }
.seg-card.kom { border-color: var(--red); }
.seg-card .kicker { font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--green); }
.seg-card.kom .kicker { color: #ff7b72; }
.seg-card .name { font-size: 21px; font-weight: 800; line-height: 1.2; }
.seg-card .meta { font-size: 15px; color: #d8d8de; margin-top: 2px; }
.seg-card .row { display: flex; align-items: baseline; gap: 14px; }
.seg-card .clock { font-size: 38px; font-weight: 850; line-height: 1.05; }
.seg-card .delta { font-size: 30px; font-weight: 850; }
.seg-card .delta.ahead { color: var(--green); } .seg-card .delta.behind { color: var(--red); }
.seg-card .bar { height: 6px; border-radius: 999px; background: rgba(255,255,255,0.16); overflow: hidden; margin-top: 6px; }
.seg-card .bar > div { height: 100%; background: var(--green); }
.seg-card.kom .bar > div { background: var(--red); }
.seg-card.compact { padding: 5px 14px; }
.seg-card.compact .name { font-size: 16px; }
.seg-card.compact .clock, .seg-card.compact .delta { font-size: 18px; }
.seg-card.result { border-color: var(--blue); background: rgba(10, 24, 44, 0.88); }
.seg-card.result.pr { border-color: var(--yellow); background: rgba(60, 46, 0, 0.88); }
.seg-card.result .kicker { color: var(--cyan); } .seg-card.result.pr .kicker { color: var(--yellow); }
.seg-card .stats { font-size: 26px; font-weight: 800; margin-top: 2px; }
.seg-card .stats small { font-size: 15px; color: #c8c8ce; font-weight: 650; margin-left: 2px; }
.seg-card .cmp { font-size: 17px; font-weight: 750; margin-top: 2px; }
.seg-card .cmp.ahead { color: var(--green); } .seg-card .cmp.behind { color: #ff8a80; }
.seg-card .last { font-size: 14px; color: #c8c8ce; }

.segs .tabs2 { display: flex; gap: 6px; margin-bottom: 14px; }
.segs .group { font-size: 13px; font-weight: 750; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin: 14px 4px 6px; }
.segs .seg-row { display: grid; grid-template-columns: 30px 1fr 110px 90px 18px; gap: 10px; align-items: center; }
.segs .seg-row .ic { font-size: 18px; text-align: center; }
.segs .seg-row .nm { font-weight: 700; }
.segs .seg-row .pr { text-align: right; font-size: 20px; font-weight: 800; }
.segs .seg-row .n { text-align: right; }
.segs .head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 12px; }
.segs .stat4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
.segs .stat4 .card .v { font-size: 24px; font-weight: 800; }
.segs table { width: 100%; border-collapse: collapse; font-size: 15px; }
.segs th { text-align: left; color: var(--muted); font-weight: 600; padding: 6px 10px; font-size: 13px; }
.segs th.r, .segs td.r { text-align: right; }
.segs td { padding: 8px 10px; border-top: 1px solid var(--line); }
.segs tr.pr td { background: rgba(255, 214, 10, 0.14); font-weight: 750; }
.segs .badge-pr { display: inline-block; background: var(--yellow); color: #000; font-size: 11px; font-weight: 850; border-radius: 6px; padding: 1px 6px; margin-left: 8px; vertical-align: 2px; }
.segs .close { color: var(--green); } .segs .near { color: var(--orange); } .segs .far { color: var(--red); }
.segs .spark { width: 100%; height: 70px; display: block; }
.segs .legend { font-size: 13px; color: var(--muted); margin: 8px 4px 0; }
.ride-segs td.name { font-weight: 650; }

.seg-board { margin-top: 8px; padding: 8px 10px 9px; border-left: 4px solid var(--green); animation: slidein 0.25s ease-out; pointer-events: none; }
.seg-board.kom { border-left-color: var(--red); }
.seg-board.done { border-left-color: var(--blue); }
.seg-board .t { font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--green); }
.seg-board.kom .t { color: #ff7b72; } .seg-board.done .t { color: var(--cyan); }
.seg-board .n { font-size: 15px; font-weight: 800; line-height: 1.2; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seg-board .r { display: grid; grid-template-columns: 22px 1fr auto auto; gap: 8px; align-items: baseline; font-size: 15px; font-weight: 700; padding: 2px 4px; border-radius: 6px; }
.seg-board .r .p { color: var(--muted); text-align: right; font-size: 13px; }
.seg-board .r .d { white-space: nowrap; }
.seg-board .r .d .pr { display: inline-block; background: var(--yellow); color: #000; font-size: 10px; font-weight: 850; border-radius: 5px; padding: 0 5px; margin-left: 6px; vertical-align: 1px; }
.seg-board .r .tm { text-align: right; min-width: 40px; }
.seg-board .r .g { text-align: right; min-width: 50px; font-size: 14px; }
.seg-board .r .g.ahead { color: var(--green); } .seg-board .r .g.behind { color: #ff8a80; }
.seg-board .r.you { background: rgba(255, 214, 10, 0.92); color: #000; }
.seg-board .r.you .p { color: #000; }
.seg-board .gap-row { font-size: 12px; color: var(--muted); text-align: center; line-height: 1.1; }
.seg-board .foot { font-size: 12px; color: var(--muted); margin-top: 5px; }
`;

let styled = false;
function ensureStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.spindown = 'segments';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ---- Live: events from the simulation ---------------------------------------------------------------------

const live = { results: [] };

/**
 * Called for every World event. Keeps the result cards, and adds finished efforts to the ride being recorded.
 * Returns true when the segment HUD shows this event (so no toast is needed).
 */
export function noteSegmentEvent(app, e) {
  if (e.type === 'segment-end' && e.result) {
    const s = e.segment;
    const a = e.result.attempt;
    const session = app?.session;
    if (session && session.phase !== 'idle' && Array.isArray(session.segmentEfforts)) {
      session.segmentEfforts.push({
        id: s.id, name: s.name, kind: s.kind, world: a.world, date: a.date, time: a.time, power: a.power, hr: a.hr,
        length: Math.round(s.to - s.from), isPR: e.result.isPR, prGap: e.result.previousBest ? Math.round((a.time - e.result.previousBest.time) * 10) / 10 : null,
      });
    }
    if (LIVE_KINDS.includes(s.kind)) {
      live.results = [{ key: `${s.id}-${a.date}`, segment: s, result: e.result, medal: e.medal ?? null, until: performance.now() + RESULT_SECONDS * 1000 }];
      return true;
    }
    return false;
  }
  return (e.type === 'segment-start' || e.type === 'segment-void') && LIVE_KINDS.includes(e.segment?.kind);
}

/** Forget any result card (a new ride or course). */
export function resetSegmentHud() {
  live.results = [];
}

function UpcomingCard({ up, compact, units }) {
  const s = up.segment;
  return html`<div class="seg-card ${s.kind} ${compact ? 'compact' : ''}">
    <div class="kicker">${ICON[s.kind]} Segment ahead · ${up.distance < 15 ? 'now' : `in ${Math.round(up.distance / 10) * 10} m`}</div>
    <div class="name">${s.name}</div>
    ${compact ? null : html`<div class="meta num">${E.lengthAndGrade(s, units)} · ${up.pr ? `PR ${E.clock(up.pr.time)} (${E.dayMonth(up.pr.date)})` : 'No PR yet: set one!'}</div>`}
  </div>`;
}

function LiveCard({ a, compact }) {
  const s = a.segment;
  const delta = a.delta;
  const deltaEl = delta == null ? null : html`<span class="delta num ${delta <= 0 ? 'ahead' : 'behind'}">${E.signedGap(delta)}</span>`;
  if (compact) {
    return html`<div class="seg-card ${s.kind} compact"><div class="row">
      <span class="name" style="flex:1">${ICON[s.kind]} ${s.name}</span><span class="clock num">${E.clock(a.elapsed)}</span>${deltaEl}
    </div></div>`;
  }
  return html`<div class="seg-card ${s.kind}">
    <div class="kicker">${ICON[s.kind]} ${s.name}</div>
    <div class="row">
      <span class="clock num">${E.clock(a.elapsed)}</span>
      ${deltaEl}
      <span class="spacer" style="flex:1"></span>
      <span class="meta num">${a.pr ? `PR ${E.clock(a.pr.time)}` : 'First attempt'} · ${a.remaining >= 1000 ? `${(a.remaining / 1000).toFixed(1)} km` : `${Math.round(a.remaining / 10) * 10} m`} to go</span>
    </div>
    <div class="bar"><div style=${{ width: `${Math.round(a.fraction * 100)}%` }}></div></div>
  </div>`;
}

function ResultCard({ r }) {
  const { segment: s, result, medal } = r;
  const a = result.attempt;
  const c = E.comparison(result);
  const medalIcon = medal ? { gold: '🥇', silver: '🥈', bronze: '🥉' }[medal] : '';
  const cls = !result.previousBest ? '' : result.isPR ? 'ahead' : 'behind';
  return html`<div class="seg-card result ${result.isPR && result.previousBest ? 'pr' : ''}">
    <div class="kicker">${result.isPR && result.previousBest ? '🏆 New PR' : '✓ Segment complete'} · ${E.dayMonth(a.date)} ${medalIcon}</div>
    <div class="name">${s.name}</div>
    <div class="stats num">${E.clock(a.time)}${a.power != null ? html` · ${a.power}<small>W</small>` : null}${a.hr != null ? html` · ${a.hr}<small>bpm</small>` : null}</div>
    <div class="cmp ${cls}">${c.pr}</div>
    ${c.vsLast ? html`<div class="last">${c.vsLast}</div>` : null}
  </div>`;
}

/** The segment HUD: result card, live timers, and the banner for the segment ahead. */
export function SegmentHud({ sim, units }) {
  ensureStyles();
  if (!sim) return null;
  const now = performance.now();
  live.results = live.results.filter((r) => r.until > now);
  const lookahead = Math.min(320, Math.max(70, sim.player.v * 30));
  const status = sim.segmentStatus(lookahead, LIVE_KINDS);
  // Timed segments before the KOM, the most recently started first.
  const active = status.active.sort((x, y) => (x.segment.kind === 'segment' ? 0 : 1) - (y.segment.kind === 'segment' ? 0 : 1) || x.elapsed - y.elapsed).slice(0, 2);
  const up = status.upcoming;
  if (!live.results.length && !active.length && !up) return null;
  return html`<div class="seg-hud">
    ${live.results.map((r) => html`<${ResultCard} key=${r.key} r=${r} />`)}
    ${active.map((a, i) => html`<${LiveCard} key=${a.segment.id} a=${a} compact=${i > 0 || live.results.length > 0} />`)}
    ${up ? html`<${UpcomingCard} key=${`up-${up.segment.id}`} up=${up} units=${units} compact=${active.length > 0 || live.results.length > 0} />` : null}
  </div>`;
}

/**
 * The segment leaderboard on the left of the HUD: while riding a timed segment (or the KOM) it ranks you now
 * against every dated attempt at the same point, and for a few seconds after it shows where the attempt finished.
 */
export function SegmentBoard({ sim }) {
  ensureStyles();
  if (!sim) return null;
  const now = performance.now();
  const routeId = sim.route.id;
  const active = sim.segmentStatus(0, LIVE_KINDS).active.sort((x, y) => (x.segment.kind === 'segment' ? 0 : 1) - (y.segment.kind === 'segment' ? 0 : 1) || x.elapsed - y.elapsed)[0];
  const done = !active ? live.results.find((r) => r.until > now) : null;
  const seg = active?.segment ?? done?.segment;
  if (!seg) return null;
  const board = active
    ? E.segmentBoard(sim.profile, routeId, seg, { elapsed: active.elapsed, fraction: active.fraction })
    : E.segmentBoard(sim.profile, routeId, seg, null, done.result.attempt);
  if (!board.rows.length) return null;
  const today = new Date();
  const first = board.total === 1;
  return html`<div class="glass seg-board ${seg.kind} ${done ? 'done' : ''}">
    <div class="t">${done ? '✓ Finished' : '⏱ Segment'} · ${board.place} of ${board.total}</div>
    <div class="n">${seg.name}</div>
    ${board.rows.map((r) => r.skipped ? html`<div class="gap-row">⋯ ${r.skipped} more</div>` : html`<div class="r ${r.you ? 'you' : ''}">
      <span class="p num">${r.place}</span>
      <span class="d num">${r.you ? (done ? `You · ${E.dayMonth(r.date, today)}` : 'You now') : E.dayMonth(r.date, today)}${r.isPR && !r.you ? html`<span class="pr">PR</span>` : null}</span>
      <span class="tm num">${r.you && !done ? E.clock(r.at) : E.clock(r.time)}</span>
      <span class="g num ${r.gap < 0 ? 'ahead' : r.gap > 0 ? 'behind' : ''}">${r.you ? '' : E.signedGap(r.gap)}</span>
    </div>`)}
    ${first ? html`<div class="foot">${done ? 'Your first time: next time you race this one.' : 'First attempt: this sets the time to beat.'}</div>`
      : html`<div class="foot">${done ? 'Final times, with the gap to you.' : 'Gaps at this point: green ahead of you, red behind.'}</div>`}
  </div>`;
}

// ---- The Segments page --------------------------------------------------------------------------------------

const builtRoutes = {};
/** The courses (built once here when World has not built them). */
export function courseRoute(id) {
  builtRoutes[id] ??= id === 'york' ? makeYork(yorkData) : makeDales(dalesData);
  return builtRoutes[id];
}

/** Order on the page: timed segments along the road, then the KOM and sprints, then the lap. */
function grouped(route) {
  const along = (a, b) => a.from - b.from;
  return [
    ['Timed segments', route.segments.filter((s) => s.kind === 'segment').sort(along)],
    ['KOM and sprints', route.segments.filter((s) => s.kind === 'kom' || s.kind === 'zone').sort(along)],
    ['Full lap', route.segments.filter((s) => s.kind === 'lap')],
  ].filter(([, list]) => list.length);
}

/** Colour for a time against the PR: close (within 2%), near (within 6%) or far. */
function closeness(time, pr) {
  const r = time / pr - 1;
  return r <= 0.02 ? 'close' : r <= 0.06 ? 'near' : 'far';
}

function Sparkline({ list, pr }) {
  // Oldest on the left; faster is higher.
  const pts = [...list].reverse();
  if (pts.length < 2) return null;
  const times = pts.map((a) => a.time);
  const lo = Math.min(...times), hi = Math.max(...times);
  const span = Math.max(1, hi - lo);
  const W = 1000, H = 70, pad = 8;
  const x = (i) => pad + (i * (W - 2 * pad)) / (pts.length - 1);
  const y = (t) => pad + ((t - lo) / span) * (H - 2 * pad);
  const d = pts.map((a, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(a.time).toFixed(1)}`).join(' ');
  return html`<svg class="spark" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Times, oldest to newest">
    <line x1="0" x2=${W} y1=${y(pr.time)} y2=${y(pr.time)} stroke="rgba(255,214,10,0.5)" stroke-dasharray="6 6" vector-effect="non-scaling-stroke" />
    <path d=${d} fill="none" stroke="#64d2ff" stroke-width="2.5" vector-effect="non-scaling-stroke" />
    ${pts.map((a, i) => html`<circle cx=${x(i)} cy=${y(a.time)} r=${a.isPR ? 6 : 3.5} fill=${a.isPR ? '#ffd60a' : '#64d2ff'} />`)}
  </svg>`;
}

function SegmentDetail({ profile, route, seg, units, onBack }) {
  const list = E.attemptList(profile, route.id, seg);
  const pr = list.find((a) => a.isPR) ?? null;
  const last = list[0] ?? null;
  const withPower = list.filter((a) => a.power != null);
  const now = new Date();
  const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return html`<div>
    <div class="head">
      <button class="btn" onClick=${onBack}>‹ All segments</button>
      <div style="flex:1">
        <div style="font-size:22px;font-weight:800">${ICON[seg.kind]} ${seg.name}</div>
        <div class="muted num">${route.title} · ${E.lengthAndGrade(seg, units)}${seg.about ? ` · ${seg.about}` : ''}</div>
      </div>
    </div>
    <div class="stat4">
      <div class="card"><div class="small muted">PR</div><div class="v num yellow">${pr ? E.clock(pr.time) : '--'}</div><div class="small muted num">${pr ? E.dayMonth(pr.date, now) : ''}</div></div>
      <div class="card"><div class="small muted">Last time</div><div class="v num">${last ? E.clock(last.time) : '--'}</div><div class="small muted num">${last ? E.dayMonth(last.date, now) : ''}</div></div>
      <div class="card"><div class="small muted">Attempts</div><div class="v num">${list.length}</div><div class="small muted">kept: last ${E.MAX_ATTEMPTS} + PR</div></div>
      <div class="card"><div class="small muted">Best avg power</div><div class="v num">${withPower.length ? `${Math.max(...withPower.map((a) => a.power))} W` : '--'}</div><div class="small muted">on this segment</div></div>
    </div>
    ${list.length >= 2 ? html`<div class="card" style="margin-bottom:12px;padding:8px 10px"><div class="small muted" style="margin:0 4px 2px">Your times, oldest to newest (higher is faster; dashed line is your PR)</div><${Sparkline} list=${list} pr=${pr} /></div>` : null}
    ${list.length ? html`<div class="list" style="padding:4px 6px">
      <table>
        <thead><tr><th>Date</th><th class="r">Time</th><th class="r">vs PR</th><th class="r">Avg power</th><th class="r">Avg HR</th></tr></thead>
        <tbody>${list.map((a) => html`<tr class=${a.isPR ? 'pr' : ''}>
          <td class="num">${E.dayMonth(a.date, now)} <span class="muted small">${a.date.startsWith('1970') ? '' : time(a.date)}</span>${a.isPR ? html`<span class="badge-pr">PR</span>` : null}</td>
          <td class="r num ${a.isPR ? 'yellow' : closeness(a.time, pr.time)}" style="font-weight:800">${E.clock(a.time)}</td>
          <td class="r num ${a.isPR ? 'muted' : closeness(a.time, pr.time)}">${a.isPR ? '—' : E.signedGap(a.time - pr.time)}</td>
          <td class="r num">${a.power != null ? `${a.power} W` : html`<span class="muted">--</span>`}</td>
          <td class="r num">${a.hr != null ? `${a.hr} bpm` : html`<span class="muted">--</span>`}</td>
        </tr>`)}</tbody>
      </table>
    </div>
    <div class="legend">Newest first. <span class="close">Green</span>: within 2% of your PR · <span class="near">amber</span>: within 6% · <span class="far">red</span>: further off. Average power is from your trainer; heart rate from your strap if one was connected.</div>`
    : html`<div class="card muted">No attempts yet. Ride through it in ${route.title} and your time, power and heart rate are kept here.</div>`}
  </div>`;
}

/**
 * The Segments page: every course's segments with your PR and number of attempts; open one to compare every
 * attempt. `profile` is the live game profile when opened from World; from History it is read from disk.
 */
export function SegmentsPanel({ app, profile: passed, routeFor = courseRoute, initial = null, onClose }) {
  ensureStyles();
  // From History, World's own profile when World has been opened (it is the freshest), else the saved one.
  const given = passed ?? (typeof window !== 'undefined' ? window.__spindownWorld?.profile : null) ?? null;
  const [profile, setProfile] = useState(given ?? null);
  const [course, setCourse] = useState(initial?.world ?? (given?.lastRoute === 'dales' ? 'dales' : 'york'));
  const [open, setOpen] = useState(initial?.id ?? null);
  const units = app.settings.get('units');
  useEffect(() => {
    if (given) return;
    app.api.game.load().then((raw) => setProfile(P.migrateProfile(raw))).catch(() => setProfile(P.newProfile()));
  }, []);
  const route = useMemo(() => routeFor(course), [course]);
  if (profile && !given) E.syncSegments(profile, route);
  const seg = open ? route.segments.find((s) => s.id === open) : null;
  return html`<${Modal} title="Segments" size="wide" onClose=${onClose}>
    <div class="segs">
      ${!profile ? html`<div class="muted">Loading…</div>` : seg ? html`<${SegmentDetail} profile=${profile} route=${route} seg=${seg} units=${units} onBack=${() => setOpen(null)} />` : html`
        <div class="segmented" style="max-width:340px;margin-bottom:6px">${COURSES.map(([id, label]) => html`<button class=${course === id ? 'on' : ''} onClick=${() => setCourse(id)}>${label}</button>`)}</div>
        ${grouped(route).map(([title, list]) => html`<div class="group">${title}</div><div class="list">
          ${list.map((s) => {
            const n = E.attemptCount(profile, route.id, s);
            const pr = E.prFor(profile, route.id, s);
            return html`<button class="item" onClick=${() => setOpen(s.id)}><div class="seg-row" style="width:100%">
              <span class="ic">${ICON[s.kind]}</span>
              <div><div class="nm">${s.name}</div><div class="small muted num">${E.lengthAndGrade(s, units)}${pr ? ` · PR set ${E.dayMonth(pr.date)}` : ''}</div></div>
              <span class="pr num ${pr ? 'yellow' : 'muted'}">${pr ? E.clock(pr.time) : '--'}</span>
              <span class="n small muted num">${n ? `${n} attempt${n === 1 ? '' : 's'}` : 'not ridden'}</span>
              <span class="muted">›</span>
            </div></button>`;
          })}
        </div>`)}
        <div class="legend">Every time you ride through a segment its time, average power and heart rate are kept, so you can see how you're going. Timed segments are a few minutes each at a steady pace.</div>`}
    </div>
  </${Modal}>`;
}

// ---- In a saved ride (History) ---------------------------------------------------------------------------------

/** The segment efforts ridden in World during a saved ride, with a way into the Segments page. */
export function RideSegments({ app, record }) {
  ensureStyles();
  const [panel, setPanel] = useState(null);
  const list = Array.isArray(record?.segments) ? record.segments : [];
  if (!list.length) return null;
  return html`<${Section} title="Segments" footer="Your efforts on World segments during this ride. Open one to compare it with every other time you've ridden it.">
    <div class="list segs ride-segs" style="padding:4px 6px">
      <table>
        <thead><tr><th>Segment</th><th class="r">Time</th><th class="r">Avg power</th><th class="r">Avg HR</th><th class="r">vs PR</th><th></th></tr></thead>
        <tbody>${list.map((s) => html`<tr class=${s.isPR && s.prGap != null ? 'pr' : ''}>
          <td class="name">${ICON[s.kind] ?? '⏱'} ${s.name}${s.isPR && s.prGap != null ? html`<span class="badge-pr">PR</span>` : null}</td>
          <td class="r num" style="font-weight:800">${E.clock(s.time)}</td>
          <td class="r num">${s.power != null ? `${s.power} W` : '--'}</td>
          <td class="r num">${s.hr != null ? `${s.hr} bpm` : '--'}</td>
          <td class="r num ${s.prGap == null ? 'muted' : s.prGap < 0 ? 'green' : 'red'}">${s.prGap == null ? 'first time' : s.prGap < 0 ? `PR by ${E.gap(-s.prGap)}` : E.signedGap(s.prGap)}</td>
          <td class="r"><button class="btn link" onClick=${() => setPanel({ world: s.world, id: s.id })}>Compare ›</button></td>
        </tr>`)}</tbody>
      </table>
    </div>
    ${panel ? html`<${SegmentsPanel} app=${app} initial=${panel} onClose=${() => setPanel(null)} />` : null}
  </${Section}>`;
}
