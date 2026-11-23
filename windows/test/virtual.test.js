// Rides in Spindown World: the GPS track on the real course, the virtual-ride FIT file, the Strava upload as a
// Virtual Ride with its picture, and that no other rider's name ever leaves the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worldToLatLon, latLonToWorld, routeLatLon } from '../src/core/world/geo.js';
import { makeDales, makeYork } from '../src/core/world/worlds.js';
import { WorldSim, RACE_PRESETS } from '../src/core/world/sim.js';
import * as Content from '../src/core/world/content.js';
import * as P from '../src/core/world/progression.js';
import { RideRecorder, Journal, replayJournal, newRideID, hasPositions } from '../src/core/recorder.js';
import { exportFIT, exportTCX, semicircles } from '../src/core/fit.js';
import { worldRideInfo, worldRideName, uploadText } from '../src/core/worldride.js';
import { StravaClient } from '../src/core/services.js';
import { RideStore, SecretStore, EventLog } from '../src/main/storage.js';
import { UploadCoordinator } from '../src/main/uploads.js';

const load = (id) => JSON.parse(fs.readFileSync(new URL(`../src/renderer/game3d/data/${id}.json`, import.meta.url), 'utf8'));
const dalesData = load('dales');
const yorkData = load('york');
const START = Date.parse('2026-11-01T09:00:00Z');

/** Great-circle distance in metres. */
function metres(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function routeBox(route, origin) {
  const box = { s: 90, n: -90, w: 180, e: -180 };
  for (let d = 0; d < route.length; d += 5) {
    const p = routeLatLon(route, origin, d);
    box.s = Math.min(box.s, p.lat);
    box.n = Math.max(box.n, p.lat);
    box.w = Math.min(box.w, p.lon);
    box.e = Math.max(box.e, p.lon);
  }
  return box;
}

/** A FIT reader that knows signed fields, enough to check our own output. */
function readFIT(b) {
  let i = b[0];
  const end = b.length - 2;
  const defs = {};
  const out = [];
  while (i < end) {
    const h = b[i++];
    const local = h & 0x0f;
    if (h & 0x40) {
      const global = b[i + 2] | (b[i + 3] << 8);
      const n = b[i + 4];
      i += 5;
      const fields = [];
      for (let k = 0; k < n; k++, i += 3) fields.push([b[i], b[i + 1], b[i + 2]]);
      defs[local] = { global, fields };
    } else {
      const def = defs[local];
      const values = {};
      for (const [num, size, type] of def.fields) {
        let v = 0;
        for (let k = 0; k < size && size <= 4; k++) v += b[i + k] * 2 ** (8 * k);
        if (type === 0x85 && v >= 2 ** 31) v -= 2 ** 32;
        values[num] = v;
        i += size;
      }
      out.push({ global: def.global, fields: values });
    }
  }
  return out;
}

const INVALID_S32 = 0x7fffffff;
const fromSemi = (v) => (v * 180) / 2 ** 31;
/** The FIT file inside a multipart upload body. */
function fitIn(body) {
  const b = Buffer.from(body);
  const at = b.indexOf('.FIT') - 8;
  return b.subarray(at, at + 14 + b.readUInt32LE(at + 4) + 2);
}

// ---- Projection ------------------------------------------------------------------------------------

test('projection: world metres and lat/lon round-trip exactly', () => {
  for (const origin of [dalesData.origin, yorkData.origin]) {
    for (const [x, z] of [[0, 0], [1234.5, -987.6], [-4200, 3100], [17.3, 0.2]]) {
      const ll = worldToLatLon(origin, x, z);
      const back = latLonToWorld(origin, ll.lat, ll.lon);
      assert.ok(Math.abs(back.x - x) < 1e-6 && Math.abs(back.z - z) < 1e-6);
    }
    // North is −z, east is +x.
    assert.ok(worldToLatLon(origin, 0, -1000).lat > origin.lat);
    assert.ok(worldToLatLon(origin, 1000, 0).lon > origin.lon);
  }
});

test('projection: the courses land on the real places', () => {
  const york = makeYork(yorkData);
  const yb = routeBox(york, yorkData.origin);
  // York's inner ring sits inside the city walls area.
  assert.ok(yb.s > 53.950 && yb.n < 53.968 && yb.w > -1.096 && yb.e < -1.066, JSON.stringify(yb));
  // The course passes over Lendal and Skeldergate bridges and by Clifford's Tower (OpenStreetMap positions).
  for (const [lm, real] of [['lendalBridge', { lat: 53.95988, lon: -1.08740 }], ['skeldergateBridge', { lat: 53.95420, lon: -1.08122 }]]) {
    const at = york.landmarks.find((m) => m.name === (lm === 'lendalBridge' ? 'Lendal Bridge' : 'Skeldergate Bridge')).at;
    assert.ok(metres(routeLatLon(york, yorkData.origin, at), real) < 25, lm);
  }
  // York Minster (about 53.962 N, 1.082 W) is a couple of hundred metres from the ring road.
  const minster = latLonToWorld(yorkData.origin, 53.962, -1.082);
  assert.ok(york.nearest(minster.x, minster.z).distance < 300);

  const dales = makeDales(dalesData);
  const db = routeBox(dales, dalesData.origin);
  assert.ok(db.s > 54.055 && db.n < 54.10 && db.w > -2.20 && db.e < -2.13, JSON.stringify(db));
  // The loop starts in Malham village (the Buck Inn is at about 54.0613 N, 2.1527 W) and climbs past the Cove
  // (about 54.072 N, 2.158 W): Cove Road runs a few hundred metres west of the cliff.
  assert.ok(metres(routeLatLon(dales, dalesData.origin, 0), { lat: 54.0613, lon: -2.1527 }) < 150);
  const cove = latLonToWorld(dalesData.origin, 54.072, -2.158);
  assert.ok(dales.nearest(cove.x, cove.z).distance < 600);
  // Real heights: Malham about 190–200 m, the top of Cove Road nearly 400 m.
  assert.ok(Math.abs(routeLatLon(dales, dalesData.origin, 0).alt - 195) < 15);
  assert.ok(dales.maxY > 380 && dales.maxY < 420);
});

// ---- A ride in the world --------------------------------------------------------------------------

/** Rides a race (or free ride) in the sim, recording 1 Hz samples with positions, as the app does. */
function worldRide({ worldId = 'york', mode = 'race', preset = 'quick10', seconds = 2400 } = {}) {
  const data = worldId === 'york' ? yorkData : dalesData;
  const route = worldId === 'york' ? makeYork(data) : makeDales(data);
  const race = RACE_PRESETS.find((r) => r.id === preset) ?? RACE_PRESETS.find((r) => r.world === worldId);
  const sim = new WorldSim({ route, profile: P.newProfile(), mode, race: mode === 'race' ? race : null, ftp: 220, seed: 5 });
  if (mode === 'race') sim.startCountdown(5);
  const rec = new RideRecorder(START);
  let journal = Journal.header('A0000000-0000-0000-0000-000000000001', START, { model: 'inRide' });
  for (let t = 1; t <= seconds; t++) {
    sim.step(0.5, { power: 300 });
    sim.step(0.5, { power: 300 });
    const pos = routeLatLon(route, data.origin, sim.player.d, sim.player.lateral);
    const s = rec.record(t, { power: 300, speedKPH: 36, cadenceRPM: 90 }, 140, pos);
    journal += Journal.sample(s);
    if (mode === 'race' && sim.race.phase === 'finished' && t > 60) break;
  }
  const info = worldRideInfo(sim);
  journal += Journal.world(info);
  const end = rec.samples.at(-1).t;
  const record = {
    schemaVersion: 1, id: 'A0000000-0000-0000-0000-000000000001', name: worldRideName(info),
    startDate: new Date(START).toISOString(), endDate: new Date(START + end * 1000).toISOString(),
    summary: rec.summary(end), trainer: { model: 'inRide', heartRateMonitor: 'Polar H10 1234' }, recovered: false, uploads: {}, world: info,
  };
  return { sim, route, data, record, track: rec.track, journal, recorder: rec };
}

function plainRide(seconds = 300) {
  const r = new RideRecorder(START);
  for (let t = 1; t <= seconds; t++) r.record(t, { power: 200, speedKPH: 30, cadenceRPM: 90 }, 130);
  return {
    record: { id: newRideID(), name: 'Morning Indoor Ride', startDate: new Date(START).toISOString(), endDate: new Date(START + seconds * 1000).toISOString(),
      summary: r.summary(seconds), trainer: { model: 'inRide' }, recovered: false, uploads: {} },
    track: r.track,
  };
}

test('world samples carry lat/lon/alt and survive the crash journal; plain samples have no position fields', () => {
  const ride = worldRide({ mode: 'free', worldId: 'dales', seconds: 120 });
  assert.ok(ride.track.samples.every((s) => s.lat > 54 && s.lat < 54.1 && s.lon < -2.1 && s.alt > 150));
  const replay = replayJournal(ride.journal);
  assert.deepEqual(replay.recorder.samples, ride.track.samples);
  assert.deepEqual(replay.world, ride.record.world);
  assert.equal(replay.world.mode, 'free');

  const plain = plainRide(10);
  assert.ok(!hasPositions(plain.track.samples));
  assert.deepEqual(Object.keys(plain.track.samples[0]).sort(), ['cadence', 'distance', 'dt', 'heartRate', 'power', 'speed', 't']);
  assert.ok(!Journal.sample(plain.track.samples[0]).includes('"la"'));
});

test('FIT: a World ride is a virtual ride with GPS, start position and bounding box', () => {
  const ride = worldRide({ mode: 'free', worldId: 'york', seconds: 300 });
  const msgs = readFIT(exportFIT(ride));
  const session = msgs.find((m) => m.global === 18);
  const lap = msgs.find((m) => m.global === 19);
  assert.equal(session.fields[5], 2, 'sport cycling');
  assert.equal(session.fields[6], 58, 'sub-sport virtual activity');
  assert.equal(lap.fields[39], 58);
  const records = msgs.filter((m) => m.global === 20);
  assert.equal(records.length, 300);
  for (let k = 0; k < records.length; k++) {
    const f = records[k].fields, s = ride.track.samples[k];
    assert.equal(f[0], semicircles(s.lat));
    assert.equal(f[1], semicircles(s.lon));
    assert.ok(Math.abs(f[2] / 5 - 500 - s.alt) <= 0.1);
    assert.equal(f[78], f[2]);
  }
  const first = ride.track.samples[0];
  assert.equal(session.fields[3], semicircles(first.lat));
  assert.equal(session.fields[4], semicircles(first.lon));
  assert.equal(lap.fields[3], semicircles(first.lat));
  const lats = ride.track.samples.map((s) => s.lat), lons = ride.track.samples.map((s) => s.lon);
  assert.equal(fromSemi(session.fields[29]).toFixed(6), Math.max(...lats).toFixed(6));
  assert.equal(fromSemi(session.fields[31]).toFixed(6), Math.min(...lats).toFixed(6));
  assert.equal(fromSemi(session.fields[30]).toFixed(6), Math.max(...lons).toFixed(6));
  assert.equal(fromSemi(session.fields[32]).toFixed(6), Math.min(...lons).toFixed(6));
  assert.ok(session.fields[22] >= 0 && session.fields[22] < 200, 'total ascent in metres');
  // The track is on York's streets.
  for (const f of records.map((m) => m.fields)) {
    assert.ok(fromSemi(f[0]) > 53.95 && fromSemi(f[0]) < 53.97 && fromSemi(f[1]) > -1.10 && fromSemi(f[1]) < -1.06);
  }
  // TCX also carries the track.
  assert.ok(new TextDecoder().decode(exportTCX(ride)).includes('<LatitudeDegrees>53.96'));
});

test('FIT: a plain ride is unchanged: indoor cycling with no GPS fields', () => {
  const msgs = readFIT(exportFIT(plainRide()));
  const session = msgs.find((m) => m.global === 18);
  assert.equal(session.fields[6], 6);
  assert.equal(msgs.find((m) => m.global === 19).fields[39], 6);
  for (const m of msgs.filter((x) => x.global === 20)) for (const n of [0, 1, 2, 78]) assert.ok(!(n in m.fields));
  for (const n of [3, 4, 29, 30, 31, 32]) assert.ok(!(n in session.fields));
});

test('FIT: a World sample without a position (world off screen) gets invalid GPS values, not zeros', () => {
  const ride = worldRide({ mode: 'free', seconds: 20 });
  delete ride.track.samples[5].lat;
  delete ride.track.samples[5].lon;
  const records = readFIT(exportFIT(ride)).filter((m) => m.global === 20);
  assert.equal(records[5].fields[0], INVALID_S32);
  assert.equal(records[5].fields[1], INVALID_S32);
});

test('names and descriptions of World rides', () => {
  assert.equal(worldRideName({ world: 'dales', course: 'Malham Cove and Tarn', mode: 'free' }), 'Spindown – Malham Cove and Tarn loop');
  assert.equal(worldRideName({ world: 'york', course: 'York Inner Ring', mode: 'free' }), 'Spindown – York Inner Ring');
  assert.equal(worldRideName({ world: 'york', course: 'York Inner Ring', mode: 'race', race: 'York Grand Prix', place: 3, field: 21 }), 'Spindown – York Grand Prix');
  const t = uploadText({ name: 'Spindown – York Grand Prix', world: { world: 'york', course: 'York Inner Ring', mode: 'race', race: 'York Grand Prix', place: 3, field: 21 } });
  assert.match(t.description, /York Grand Prix: finished 3rd of 21\./);
  assert.match(t.description, /^Virtual ride in Spindown World/);
  assert.equal(uploadText({ name: 'Morning Indoor Ride' }).description, 'Indoor ride on a Kinetic Road Machine (inRide), recorded with Spindown.');
});

// ---- Uploads -------------------------------------------------------------------------------------

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 2000 }, (_, i) => i & 0xff), 0xff, 0xd9]);

function setup(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spindown-virtual-'));
  const log = new EventLog(dir);
  const store = new RideStore(dir, log);
  const secrets = new SecretStore(dir, null);
  secrets.save('strava.clientID', '1');
  secrets.save('strava.clientSecret', 's');
  secrets.save('strava.tokens', JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600e3, athleteName: 'Dad' }));
  secrets.save('garmin.tokens', JSON.stringify({ accessToken: 'g', refreshToken: 'r', clientID: 'C', expiresAt: Date.now() + 3600e3, obtainedAt: Date.now() }));
  const sent = [];
  const transport = {
    async send(req) {
      sent.push(req);
      const next = responses.shift() ?? [500, 'no more responses'];
      const [status, text] = typeof next === 'function' ? next(req) : next;
      return { status, text };
    },
  };
  const uploads = new UploadCoordinator({ store, log, transport, secrets });
  uploads.pollDelayMs = 1;
  return { dir, store, uploads, sent, log };
}

function saveWorldRide(store, ride, destinations, picture = JPEG) {
  const record = { ...ride.record, uploads: Object.fromEntries(destinations.map((d) => [d, { status: 'pending' }])) };
  store.journalOpen(false);
  store.saveFromJournal(record, ride.track, false, picture);
  return record.id;
}

const bodyText = (req) => (req.body == null ? '' : typeof req.body === 'string' ? req.body : Buffer.from(req.body).toString('latin1'));
const utf8 = (req) => (req.body == null ? '' : typeof req.body === 'string' ? req.body : Buffer.from(req.body).toString('utf8'));
const part = (req, name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(utf8(req))?.[1];
const PHOTO_URI = 'https://photos.example.invalid/upload/abc?X-Signature=1';

test('Strava: a World ride uploads as a Virtual Ride, named for the race, with the GPS track', async () => {
  const ride = worldRide();
  assert.equal(ride.record.world.mode, 'race');
  const { store, uploads, sent } = setup([
    [201, '{"id":555,"id_str":"555","error":null,"status":"Your activity is still being processed.","activity_id":null}'],
    [200, '{"id":555,"id_str":"555","error":null,"status":"Your activity is ready.","activity_id":98765}'],
    [200, '{"id":98765,"sport_type":"VirtualRide"}'],
  ]);
  const id = saveWorldRide(store, ride, ['strava']);
  await uploads.process();
  const upload = sent[0];
  assert.equal(upload.url, 'https://www.strava.com/api/v3/uploads');
  assert.equal(part(upload, 'name'), ride.record.name);
  assert.match(ride.record.name, /^Spindown – /);
  assert.equal(part(upload, 'trainer'), '0', 'not flagged as a trainer ride, so Strava shows the map');
  assert.match(part(upload, 'description'), /Virtual ride in Spindown World/);
  // The FIT inside the upload is a virtual activity with GPS.
  const fit = fitIn(upload.body);
  const session = readFIT(fit).find((m) => m.global === 18);
  assert.equal(session.fields[6], 58);
  assert.ok(session.fields[3] !== INVALID_S32);
  // Then the activity is set to VirtualRide.
  const put = sent.find((r) => r.method === 'PUT' && r.url.endsWith('/activities/98765'));
  assert.ok(put, 'PUT /activities/{id}');
  assert.deepEqual(JSON.parse(put.body), { sport_type: 'VirtualRide' });
  assert.equal(put.headers.Authorization, 'Bearer tok');
  const state = store.record(id).uploads.strava;
  assert.equal(state.status, 'uploaded');
  assert.equal(state.activityID, '98765');
  assert.equal(state.sportType, 'VirtualRide');
  // No photo_metadata (an ordinary API app): nothing else is sent, the picture is left for the rider to add.
  assert.equal(state.photo, 'manual');
  assert.equal(sent.length, 3);
  assert.ok(!JSON.stringify(store.record(id)).includes('photos.example'));
});

test('Strava: photo_metadata, when offered, is used to attach the picture (and never saved)', async () => {
  const ride = worldRide({ mode: 'free', seconds: 60 });
  const meta = JSON.stringify([{ uploaded_by_athlete_id: 1, uri: PHOTO_URI, header: { 'Content-Type': 'image/jpeg' }, method: 'PUT', max_size: 1600 }]);
  const { store, uploads, sent } = setup([
    [201, '{"id":556,"id_str":"556","error":null,"status":"Your activity is still being processed.","activity_id":null}'],
    [200, `{"id":556,"id_str":"556","error":null,"status":"Your activity is ready.","activity_id":4321,"photo_metadata":${meta}}`],
    [200, '{"id":4321,"sport_type":"VirtualRide"}'],
    [200, ''],
  ]);
  const id = saveWorldRide(store, ride, ['strava']);
  await uploads.process();
  const photo = sent.find((r) => r.url === PHOTO_URI);
  assert.ok(photo, 'the picture is PUT to the pre-signed URI');
  assert.equal(photo.method, 'PUT');
  assert.equal(photo.headers['Content-Type'], 'image/jpeg');
  assert.ok(!photo.headers.Authorization, 'no Strava token goes to the photo host');
  assert.deepEqual([...photo.body], [...JPEG]);
  const state = store.record(id).uploads.strava;
  assert.equal(state.photo, 'attached');
  assert.ok(!fs.readFileSync(path.join(store.folder(id), 'record.json'), 'utf8').includes('example.invalid'));

  // A failing photo host never fails the upload.
  const b = setup([
    [200, `{"id":557,"error":null,"activity_id":4322,"photo_metadata":${meta}}`],
    [200, '{}'],
    [403, 'denied'],
  ]);
  const id2 = saveWorldRide(b.store, { ...ride, record: { ...ride.record, id: 'B0000000-0000-0000-0000-000000000002' } }, ['strava']);
  await b.uploads.process();
  assert.equal(b.store.record(id2).uploads.strava.status, 'uploaded');
  assert.equal(b.store.record(id2).uploads.strava.photo, 'failed');
});

test('Strava: photo targets only from PUT + image/jpeg entries; a plain ride is untouched', async () => {
  const T = StravaClient.photoTargets;
  assert.deepEqual(T(undefined), []);
  assert.deepEqual(T(null), []);
  assert.deepEqual(T([{ uri: PHOTO_URI, method: 'POST', header: { 'Content-Type': 'image/jpeg' } }]), []);
  assert.deepEqual(T([{ uri: PHOTO_URI, method: 'PUT', header: { 'Content-Type': 'image/png' } }]), []);
  assert.deepEqual(T({ uri: 'http://insecure', method: 'PUT', header: { 'Content-Type': 'image/jpeg' } }), []);
  assert.deepEqual(T({ uri: PHOTO_URI, method: 'PUT', header: { 'Content-Type': 'image/jpeg' } }), [{ uri: PHOTO_URI, header: { 'Content-Type': 'image/jpeg' } }]);

  // A plain ride: trainer flag, the usual description, no PUT, no picture state.
  const plain = plainRide(120);
  const { store, uploads, sent } = setup([[200, '{"id":1,"error":null,"activity_id":77}']]);
  store.journalOpen(false);
  store.saveFromJournal({ ...plain.record, uploads: { strava: { status: 'pending' } } }, plain.track, false);
  await uploads.process();
  assert.equal(sent.length, 1);
  assert.equal(part(sent[0], 'trainer'), '1');
  assert.equal(part(sent[0], 'name'), 'Morning Indoor Ride');
  assert.deepEqual(store.record(plain.record.id).uploads.strava, { status: 'uploaded', activityID: '77' });
  assert.equal(store.picture(plain.record.id), null);
});

test('Garmin: a World ride uploads its GPS track as a virtual activity', async () => {
  const ride = worldRide({ mode: 'free', seconds: 60 });
  const { store, uploads, sent } = setup([[201, '{"detailedImportResult":{"successes":[{"internalId":1}],"failures":[]}}']]);
  saveWorldRide(store, ride, ['garmin']);
  await uploads.process();
  const fit = fitIn(sent[0].body);
  const msgs = readFIT(fit);
  assert.equal(msgs.find((m) => m.global === 18).fields[6], 58);
  assert.ok(msgs.filter((m) => m.global === 20).every((m) => m.fields[0] !== INVALID_S32));
});

// ---- No other rider's name leaves the app ------------------------------------------------------------

/** Every name a bot, regular or pacer can have: from the roster (whatever it holds now) and the sim itself. */
function rosterNames(sim) {
  const names = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim().length >= 3) names.add(v.trim());
  };
  for (const [key, value] of Object.entries(Content)) {
    if (!Array.isArray(value) || !/REGULAR|PACER|ROSTER|BOT|RIVAL|NAME/i.test(key)) continue;
    for (const item of value) {
      if (typeof item === 'string') {
        if (!/^BOT_(FIRST|LAST)$/.test(key)) add(item); // single first/last names are checked as full names below
      } else if (item && typeof item === 'object') {
        add(item.name);
        add(item.label);
        add(item.nickname);
      }
    }
  }
  for (const first of Content.BOT_FIRST ?? []) for (const last of Content.BOT_LAST ?? []) add(`${first} ${last}`);
  for (const r of sim.riders) if (!r.isPlayer && !r.isGhost) add(r.name);
  // Names being added to the roster, and pacers' labels.
  for (const n of ['Og Pog', 'Mark Potts', 'Deev', 'Roggus McPoggus', 'Bobby', 'Big Bird', 'Moggis', 'Mimi', 'The Wheezhog', 'Barrel Rider', '200 W']) add(n);
  return [...names];
}

function assertNoNames(names, label, text) {
  const hay = text.toLowerCase();
  const found = names.filter((n) => hay.includes(n.toLowerCase()));
  assert.deepEqual(found, [], `${label} mentions ${found.join(', ')}`);
}

test('no AI rider names in the saved ride, the FIT file or the Garmin and Strava uploads', async () => {
  const ride = worldRide();
  const names = rosterNames(ride.sim);
  assert.ok(names.length > 1000 && names.includes('Og Pog') && names.includes('Mark Potts'));
  assert.ok(ride.sim.riders.filter((r) => !r.isPlayer).every((r) => names.includes(r.name)));
  assert.equal(ride.sim.race.phase, 'finished');
  assert.ok(ride.record.world.place >= 1, 'a finished race records your place');

  const meta = JSON.stringify([{ uri: PHOTO_URI, header: { 'Content-Type': 'image/jpeg' }, method: 'PUT' }]);
  const { store, uploads, sent, dir } = setup([
    [201, '{"detailedImportResult":{"successes":[{"internalId":11}],"failures":[]}}'],
    [201, '{"id":9,"id_str":"9","error":null,"activity_id":null}'],
    [200, `{"id":9,"id_str":"9","error":null,"activity_id":12,"photo_metadata":${meta}}`],
    [200, '{"sport_type":"VirtualRide"}'],
    [200, ''],
  ]);
  const id = saveWorldRide(store, ride, ['garmin', 'strava']);
  await uploads.process();
  assert.equal(store.record(id).uploads.garmin.status, 'uploaded');
  assert.equal(store.record(id).uploads.strava.photo, 'attached');
  assert.equal(sent.length, 5);

  const latin1 = (b) => Buffer.from(b).toString('latin1');
  assertNoNames(names, 'the FIT file', latin1(exportFIT(ride)) + Buffer.from(exportFIT(ride)).toString('utf8'));
  assertNoNames(names, 'the TCX file', new TextDecoder().decode(exportTCX(ride)));
  for (const req of sent) assertNoNames(names, `${req.method} ${req.url}`, `${req.url}\n${JSON.stringify(req.headers)}\n${bodyText(req)}\n${Buffer.from(req.body ?? '').toString('utf8')}`);
  for (const f of fs.readdirSync(path.join(dir, 'Rides', id))) assertNoNames(names, f, fs.readFileSync(path.join(dir, 'Rides', id, f), 'latin1'));
  assertNoNames(names, 'the crash journal', ride.journal);
  // The race place is there.
  const description = part(sent[1], 'description');
  assert.match(description, new RegExp(`finished \\d+(st|nd|rd|th) of ${ride.record.world.field}\\.`));
});
