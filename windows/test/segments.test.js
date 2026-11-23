// Spindown World segments: the timed segments on each course, attempt history (time, power, heart rate,
// date), PRs and comparisons, migration from the old best-only PRs, and what does not count as an attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDales, makeYork, rideTime, SEGMENT_TARGET } from '../src/core/world/worlds.js';
import { WorldSim } from '../src/core/world/sim.js';
import * as P from '../src/core/world/progression.js';
import * as E from '../src/core/world/efforts.js';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`../src/renderer/game3d/data/${n}.json`, import.meta.url), 'utf8'));
const york = makeYork(load('york'));
const dales = makeDales(load('dales'));

function profile80() {
  const p = P.newProfile();
  p.settings.riderMass = 80;
  return p;
}

/** A free ride on York for the 80 kg rider. */
function yorkSim(p = profile80()) {
  return new WorldSim({ route: york, profile: p, mode: 'free', ftp: 210, seed: 5, botCount: 0 });
}

/** Rides until `pred(events)` or `seconds`, at `input`; returns every event. */
function ride(sim, seconds, input, pred = () => false, dt = 0.25) {
  const events = [];
  for (let t = 0; t < seconds; t += dt) {
    const ev = sim.step(dt, typeof input === 'function' ? input(sim) : input);
    events.push(...ev);
    if (pred(ev)) break;
  }
  return events;
}

test('segments: at least 3 timed segments per course, each 1–5 minutes at 190 W and 80 kg', () => {
  const table = [];
  for (const route of [york, dales]) {
    const timed = route.segments.filter((s) => s.kind === 'segment');
    assert.ok(timed.length >= 3 && timed.length <= 5, `${route.id}: ${timed.length} timed segments`);
    assert.equal(new Set(route.segments.map((s) => s.id)).size, route.segments.length, 'ids are unique');
    for (const s of timed) {
      // By the game's own physics: steady 190 W, 80 kg, on the starter bike and wheels (the slowest kit).
      const t = rideTime(route, s.from, s.to, SEGMENT_TARGET.power);
      table.push(`${route.id.padEnd(6)} ${s.name.padEnd(36)} ${String(Math.round(s.length)).padStart(5)} m ${(s.grade * 100).toFixed(1).padStart(5)}%  ${E.clock(t)}`);
      assert.ok(t <= 300, `${s.name} takes ${E.clock(t)} at 190 W (max 5:00)`);
      assert.ok(t >= 60, `${s.name} takes ${E.clock(t)}: too short to be a real segment`);
      assert.ok(s.length > 200 && s.length < route.length / 2, `${s.name} length ${s.length}`);
      assert.ok(!s.medals, 'timed segments have no medals (zones and the KOM keep theirs)');
    }
    // A spread: something up, something down, something flatter.
    if (route.id === 'dales') {
      assert.ok(timed.some((s) => s.grade > 0.08), 'a climb');
      assert.ok(timed.some((s) => s.grade < -0.06), 'a descent');
      assert.ok(timed.some((s) => Math.abs(s.grade) < 0.02), 'a flatter stretch');
    }
    // The existing speed zones and KOM still have their medals.
    for (const z of route.zones) assert.ok(z.medals.gold < z.medals.bronze);
  }
  console.log(`\n${table.join('\n')}`);
  const ramp = dales.segments.find((s) => s.id === 'cove-ramp');
  assert.ok(ramp.from >= dales.segments.find((s) => s.id === 'cove').from && ramp.to <= dales.course.climb.top, 'the ramp is on Cove Road');
});

test('segments: an attempt is recorded with time, average power, heart rate, date and world', () => {
  const p = profile80();
  const sim = yorkSim(p);
  const seg = york.segments.find((s) => s.id === 'lendal-micklegate');
  // 190 W for the first half of the ride in, then 210 W; heart rate 150.
  const events = ride(sim, 600, (s) => ({ power: s.player.d < (seg.from + seg.to) / 2 ? 190 : 210, heartRate: 150 }), (ev) => ev.some((e) => e.type === 'segment-end' && e.segment.id === seg.id));
  const end = events.find((e) => e.type === 'segment-end' && e.segment.id === seg.id);
  assert.ok(end, 'finished the segment');
  const a = end.result.attempt;
  assert.ok(Math.abs(a.time - end.time) < 0.06);
  // About the physics time at ~200 W (a little drafting is possible).
  const expected = rideTime(york, seg.from, seg.to, 200);
  assert.ok(a.time > expected * 0.85 && a.time < expected * 1.1, `${a.time} vs ${expected}`);
  assert.ok(a.power > 190 && a.power < 210, `power ${a.power}`);
  assert.equal(a.hr, 150);
  assert.equal(a.world, 'york');
  assert.ok(Math.abs(Date.parse(a.date) - Date.now()) < 60000);
  assert.ok(end.result.isPR && end.result.previousBest == null);
  // Kept in the profile, with splits for the live delta next time.
  const stored = E.effortsFor(p, 'york', seg);
  assert.equal(stored.attempts.length, 1);
  assert.equal(stored.best.splits.length, E.SPLITS);
  assert.ok(Math.abs(stored.best.splits[E.SPLITS - 1] - a.time) < 0.2);
  for (let i = 1; i < E.SPLITS; i++) assert.ok(stored.best.splits[i] > stored.best.splits[i - 1]);
  // The old best-only PR is still kept for the zones' and Progress page's sake.
  assert.ok(Math.abs(p.prs.york[seg.id].time - a.time) < 0.06);
  // Saved and loaded again intact.
  const again = P.migrateProfile(JSON.parse(P.serialiseProfile(p)));
  assert.deepEqual(again.efforts.york[seg.id], JSON.parse(JSON.stringify(stored)));
});

test('segments: no heart rate strap gives no HR; the second attempt compares with the PR, live and at the end', () => {
  const p = profile80();
  const seg = york.segments.find((s) => s.id === 'lendal-micklegate');
  const isEnd = (ev) => ev.some((e) => e.type === 'segment-end' && e.segment.id === seg.id);
  ride(yorkSim(p), 600, { power: 190 }, isEnd);
  const first = E.prFor(p, 'york', seg);
  assert.equal(first.hr, null);
  // Faster: the live delta goes negative part way through, and it is a PR.
  const sim = yorkSim(p);
  let delta = null;
  const ev = ride(sim, 600, (s) => {
    const live = s.segmentStatus(300, ['segment']).active.find((x) => x.segment.id === seg.id);
    if (live && live.fraction > 0.5 && delta == null) delta = live.delta;
    return { power: 260, heartRate: 160 };
  }, isEnd);
  assert.ok(delta < 0, `ahead of the PR half way (${delta})`);
  const end = ev.find((e) => e.type === 'segment-end' && e.segment.id === seg.id);
  assert.ok(end.result.isPR);
  assert.equal(end.result.previousBest.time, first.time);
  assert.equal(end.result.last.time, first.time);
  assert.match(E.comparison(end.result).pr, /^PR by 0:\d\d$/);
  // Slower: behind live, and the result says by how much against the PR and the last time.
  const sim3 = yorkSim(p);
  let behind = null;
  const ev3 = ride(sim3, 600, (s) => {
    const live = s.segmentStatus(300, ['segment']).active.find((x) => x.segment.id === seg.id);
    if (live && live.fraction > 0.5 && behind == null) behind = live.delta;
    return { power: 170 };
  }, isEnd);
  assert.ok(behind > 0, `behind the PR half way (${behind})`);
  const end3 = ev3.find((e) => e.type === 'segment-end' && e.segment.id === seg.id).result;
  assert.ok(!end3.isPR);
  assert.match(E.comparison(end3).pr, /^\+\d:\d\d on PR \(\d:\d\d, \d\d\/\d\d\)$/);
  assert.equal(E.attemptCount(p, 'york', seg), 3);
  const list = E.attemptList(p, 'york', seg);
  assert.equal(list.filter((a) => a.isPR).length, 1);
  assert.ok(list[0].time === end3.attempt.time, 'newest first');
});

test('segments: PR and comparison logic, wording and the cap on history', () => {
  const p = P.newProfile();
  const seg = { id: 'cove-ramp', name: 'Cove Road Ramp', kind: 'segment', from: 1310, to: 1640 };
  const at = (iso) => new Date(iso);
  const r1 = E.recordAttempt(p, 'dales', seg, { time: 218, power: 190, hr: 148 }, at('2026-11-12T09:00:00'));
  assert.deepEqual(E.comparison(r1, at('2026-11-23T09:00:00')), { pr: 'First time', vsLast: null });
  const r2 = E.recordAttempt(p, 'dales', seg, { time: 222.2, power: 186, hr: 150 }, at('2026-11-20T09:00:00'));
  assert.ok(!r2.isPR);
  assert.deepEqual(E.comparison(r2, at('2026-11-23T09:00:00')), { pr: '+0:04 on PR (3:38, 12/11)', vsLast: null });
  const r3 = E.recordAttempt(p, 'dales', seg, { time: 212, power: 205.4, hr: 152.4 }, at('2026-11-23T09:00:00'));
  assert.ok(r3.isPR);
  assert.equal(E.summaryLine(seg, r3, at('2026-11-23T10:00:00')), 'Cove Road Ramp — 3:32 · 205 W · 152 bpm · 23/11 · PR by 0:06');
  assert.equal(E.comparison(r3).vsLast, '−0:10 on last time (3:42, 20/11)');
  assert.equal(E.prFor(p, 'dales', seg).time, 212);
  // A tie is not a PR.
  assert.ok(!E.recordAttempt(p, 'dales', seg, { time: 212 }, at('2026-11-24T09:00:00')).isPR);
  // History keeps the last 50, plus the PR even when it is older.
  for (let i = 0; i < 60; i++) E.recordAttempt(p, 'dales', seg, { time: 230 + i, power: 180 }, new Date(Date.parse('2026-12-01T09:00:00') + i * 3600e3));
  const e = E.effortsFor(p, 'dales', seg);
  assert.equal(e.attempts.length, E.MAX_ATTEMPTS);
  assert.equal(e.best.time, 212);
  const list = E.attemptList(p, 'dales', seg);
  assert.equal(list.length, E.MAX_ATTEMPTS + 1);
  assert.ok(list.find((a) => a.isPR).time === 212);
  // Time formats: m:ss, gaps under a second in tenths.
  assert.equal(E.clock(222.4), '3:42');
  assert.equal(E.clock(59.6), '1:00');
  assert.equal(E.clock(3725), '1:02:05');
  assert.equal(E.signedGap(-6.2), '−0:06');
  assert.equal(E.signedGap(0.4), '+0:00.4');
  assert.equal(E.lengthAndGrade({ from: 0, to: 760, grade: 0.0071 }), '760 m · 0.7%');
  assert.equal(E.lengthAndGrade({ from: 0, to: 1829, grade: -0.092 }), '1.8 km · −9.2%');
});

test('segments: dates are DD/MM, with the year only when it is not this year', () => {
  const now = new Date(2026, 10, 23, 12);
  assert.equal(E.dayMonth(new Date(2026, 10, 23, 7, 5).toISOString(), now), '23/11');
  assert.equal(E.dayMonth(new Date(2026, 0, 3, 18).toISOString(), now), '03/01');
  assert.equal(E.dayMonth(new Date(2025, 11, 31, 18).toISOString(), now), '31/12/2025');
  assert.equal(E.dayMonth('not a date', now), '--');
});

test('segments: old profiles migrate their PRs as the first attempt, without power or heart rate', () => {
  const old = {
    xp: 1200,
    prs: { dales: { cove: { time: 655.3, date: '2026-11-16T10:00:00.000Z' }, lap: { time: 1900, date: '2026-11-16T10:30:00.000Z' } }, york: { 'walls-sprint': { time: 40.1, date: '2026-11-18T08:00:00.000Z' } } },
    medals: { york: { 'walls-sprint': 'bronze' } },
    courses: { dales: dales.version },
  };
  const p = P.migrateProfile(old);
  const cove = p.efforts.dales.cove;
  assert.equal(cove.attempts.length, 1);
  assert.deepEqual(cove.attempts[0], { date: '2026-11-16T10:00:00.000Z', time: 655.3, power: null, hr: null, world: 'dales' });
  assert.equal(cove.best.time, 655.3);
  assert.equal(cove.sig, null);
  assert.equal(p.prs.dales.cove.time, 655.3, 'the old PRs stay');
  // Migrating again (every load) changes nothing.
  assert.deepEqual(P.migrateProfile(JSON.parse(P.serialiseProfile(p))).efforts, p.efforts);
  // The first ride on the course adopts today's geometry, and the PR shows as the PR.
  new WorldSim({ route: dales, profile: p, mode: 'free', ftp: 200, botCount: 0 });
  assert.equal(p.efforts.dales.cove.sig, E.segmentSig(dales.segments.find((s) => s.id === 'cove')));
  assert.equal(E.prFor(p, 'dales', dales.segments.find((s) => s.id === 'cove')).time, 655.3);
  const list = E.attemptList(p, 'york', york.segments.find((s) => s.id === 'walls-sprint'));
  assert.equal(list.length, 1);
  assert.ok(list[0].isPR && list[0].power == null && list[0].hr == null);
  // Damaged entries are dropped, good ones kept.
  const mixed = P.migrateProfile({ efforts: { york: { a: { attempts: [{ time: -1, date: 'x' }] }, b: 7, c: { sig: '1:2', attempts: [{ time: 50, date: '2026-11-01T00:00:00Z', power: 180, hr: null, world: 'york' }] } } } });
  assert.deepEqual(Object.keys(mixed.efforts.york), ['c']);
  assert.equal(mixed.efforts.york.c.best.time, 50);
});

test('segments: a changed segment drops its stale history, PR and medal; a rebuilt course clears all', () => {
  const p = P.newProfile();
  const seg = york.segments.find((s) => s.id === 'walls-sprint');
  E.recordAttempt(p, 'york', seg, { time: 40, power: 250 });
  P.recordSegment(p, 'york', seg, 40);
  p.medals.york = { 'walls-sprint': 'silver' };
  // Same geometry: kept.
  E.syncSegments(p, york);
  assert.ok(E.prFor(p, 'york', seg));
  // Moved by 50 m (a rebuilt map, or a segment redrawn): not comparable any more.
  const moved = { ...york, id: 'york', segments: york.segments.map((s) => (s.id === seg.id ? { ...s, from: s.from + 50, to: s.to + 50 } : s)) };
  assert.equal(E.prFor(p, 'york', moved.segments.find((s) => s.id === seg.id)), null, 'never compared with the old geometry');
  E.syncSegments(p, moved);
  assert.equal(p.efforts.york[seg.id], undefined);
  assert.equal(p.prs.york[seg.id], undefined);
  assert.equal(p.medals.york[seg.id], undefined);
  // A new course version clears the route's history along with its PRs.
  E.recordAttempt(p, 'dales', dales.segments[1], { time: 30 });
  P.syncCourse(p, 'dales', 'malham-new');
  assert.equal(p.efforts.dales, undefined);
});

test('segments: partial passes do not count (joined part way, a jump, no power)', () => {
  const seg = york.segments.find((s) => s.id === 'lendal-micklegate');
  const isEnd = (ev) => ev.some((e) => e.segment?.id === seg.id && (e.type === 'segment-end' || e.type === 'segment-void'));
  // Joined in the middle: never started, so riding out of the end records nothing.
  {
    const p = profile80();
    const sim = yorkSim(p);
    sim.step(0.25, { power: 190 });
    sim.player.d = (seg.from + seg.to) / 2;
    const ev = ride(sim, 300, { power: 190, heartRate: 140 }, () => sim.player.d > seg.to + 50);
    assert.ok(!ev.some((e) => e.type === 'segment-end' && e.segment.id === seg.id));
    assert.equal(E.effortsFor(p, 'york', seg), null);
  }
  // Started properly, then jumped forward (skipping part of it): voided.
  {
    const p = profile80();
    const sim = yorkSim(p);
    ride(sim, 600, { power: 190 }, () => sim.segmentState.has(seg.id));
    ride(sim, 5, { power: 190 });
    sim.player.d += 300;
    const ev = ride(sim, 300, { power: 190 }, isEnd);
    assert.ok(ev.some((e) => e.type === 'segment-void' && e.segment.id === seg.id));
    assert.ok(!ev.some((e) => e.type === 'segment-end' && e.segment.id === seg.id));
    assert.equal(E.effortsFor(p, 'york', seg), null);
  }
  // Ridden with the trainer's power missing most of the way (coasting in the game): not a real attempt.
  {
    const p = profile80();
    const sim = yorkSim(p);
    ride(sim, 600, { power: 190 }, () => sim.segmentState.has(seg.id));
    let n = 0;
    const ev = ride(sim, 900, () => ({ power: n++ % 10 === 0 ? 400 : null }), isEnd);
    assert.ok(ev.some((e) => e.type === 'segment-void' && e.segment.id === seg.id));
    assert.equal(E.effortsFor(p, 'york', seg), null);
  }
  // Riding through properly afterwards does count.
  {
    const p = profile80();
    const ev = ride(yorkSim(p), 600, { power: 190 }, isEnd);
    assert.ok(ev.some((e) => e.type === 'segment-end' && e.segment.id === seg.id));
    assert.equal(E.attemptCount(p, 'york', seg), 1);
  }
});

test('segments: the HUD sees the segment ahead before it starts, then the one in progress', () => {
  const sim = yorkSim();
  const seg = york.segments.find((s) => s.id === 'lendal-micklegate');
  ride(sim, 600, { power: 190 }, () => sim.player.d > seg.from - 150);
  const before = sim.segmentStatus(300, ['segment']);
  assert.equal(before.upcoming?.segment.id, seg.id);
  assert.ok(before.upcoming.distance > 100 && before.upcoming.distance < 160);
  assert.equal(before.upcoming.pr, null);
  ride(sim, 60, { power: 190 }, () => sim.player.d > seg.from + 100);
  const during = sim.segmentStatus(300, ['segment']);
  const a = during.active.find((x) => x.segment.id === seg.id);
  assert.ok(a.elapsed > 5 && a.fraction > 0.1 && a.fraction < 0.2);
  assert.equal(a.delta, null, 'no PR yet, so no delta');
});
