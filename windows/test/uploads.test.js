// The upload queue and ride storage of the main process, against a mocked Garmin server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RideStore, SecretStore, EventLog, Settings } from '../src/main/storage.js';
import { UploadCoordinator } from '../src/main/uploads.js';
import { RideRecorder, Journal, replayJournal } from '../src/core/recorder.js';

function setup(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spindown-test-'));
  const log = new EventLog(dir);
  const store = new RideStore(dir, log);
  const secrets = new SecretStore(dir, null);
  const sent = [];
  const transport = {
    async send(req) {
      sent.push(req);
      const [status, text] = responses.length ? responses.shift() : [500, 'no more responses'];
      if (status === 'network') throw new Error('net::ERR_INTERNET_DISCONNECTED');
      return { status, text };
    },
  };
  const uploads = new UploadCoordinator({ store, log, transport, secrets });
  return { dir, log, store, secrets, uploads, sent };
}

function saveRide(store, uploads = { garmin: { status: 'pending' } }) {
  const start = Date.parse('2026-11-01T09:00:00Z');
  const r = new RideRecorder(start);
  for (let t = 1; t <= 120; t++) r.record(t, { power: 200, speedKPH: 30, cadenceRPM: 90 }, 130);
  const id = '6F0A3D1E-1111-2222-3333-444455556666';
  // Through the crash journal, as a real ride is.
  store.journalOpen(false);
  store.journalAppend(Journal.header(id, start, { model: 'inRide' }), true);
  for (const s of r.samples) store.journalAppend(Journal.sample(s));
  store.journalAppendPacket('{"t":1,"dir":"rx","c":"E9410101","hex":"00"}\n');
  const record = { schemaVersion: 1, id, name: 'Morning Indoor Ride', startDate: new Date(start).toISOString(), endDate: new Date(start + 120000).toISOString(),
    summary: r.summary(120), trainer: { model: 'inRide' }, recovered: false, uploads };
  assert.equal(replayJournal(store.journalRead()).recorder.samples.length, 120);
  store.saveFromJournal(record, r.track, true);
  return id;
}

const signedIn = (secrets) => secrets.save('garmin.tokens', JSON.stringify({ accessToken: 'a', refreshToken: 'r', clientID: 'C', expiresAt: Date.now() + 3600e3, obtainedAt: Date.now() }));

test('a saved ride uploads to Garmin and records the activity id', async () => {
  const { store, secrets, uploads, sent, dir } = setup([[201, '{"detailedImportResult":{"successes":[{"internalId":987654}],"failures":[]}}']]);
  signedIn(secrets);
  const id = saveRide(store);
  assert.ok(fs.existsSync(path.join(dir, 'Rides', id, 'packets.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'ActiveRide')));
  await uploads.process();
  assert.deepEqual(store.record(id).uploads.garmin, { status: 'uploaded', activityID: '987654' });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.length > 1000, 'multipart body carries the FIT file');
  // The state survives a restart.
  const reloaded = new RideStore(dir, new EventLog(dir));
  reloaded.load();
  assert.equal(reloaded.record(id).uploads.garmin.status, 'uploaded');
});

test('offline: the upload is kept and retried later', async () => {
  const { store, secrets, uploads } = setup([['network'], [201, '{"detailedImportResult":{"successes":[{"internalId":1}],"failures":[]}}']]);
  signedIn(secrets);
  const id = saveRide(store);
  await uploads.process();
  const failed = store.record(id).uploads.garmin;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryable, true);
  assert.equal(failed.message, 'No internet connection.');
  await uploads.process(); // still backing off: nothing sent
  assert.equal(store.record(id).uploads.garmin.status, 'failed');
  uploads.networkRegained();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.record(id).uploads.garmin.status, 'uploaded');
});

test('no Wi-Fi: nothing is tried until the network comes back, then the ride uploads by itself', async () => {
  const { store, secrets, uploads, sent, log } = setup([[201, '{"detailedImportResult":{"successes":[{"internalId":2}],"failures":[]}}']]);
  let online = false;
  uploads.isOnline = () => online;
  signedIn(secrets);
  const id = saveRide(store);
  await uploads.process();
  assert.equal(sent.length, 0);
  assert.equal(store.record(id).uploads.garmin.status, 'pending');
  online = true;
  uploads.networkRegained();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.record(id).uploads.garmin.status, 'uploaded');
  assert.ok(log.events.some((e) => /Network available/.test(e.message)));
});

test('connection errors retry within a minute however many times they fail; reconnecting resets the count', async () => {
  const { store, secrets, uploads } = setup(Array.from({ length: 8 }, () => ['network']));
  signedIn(secrets);
  const id = saveRide(store);
  const key = `${id}/garmin`;
  for (let i = 0; i < 8; i++) {
    uploads.notBefore.clear();
    const before = Date.now();
    await uploads.process();
    assert.ok(uploads.notBefore.get(key) - before <= 61000, `attempt ${i + 1} waits at most a minute`);
  }
  assert.equal(uploads.attempts.get(key), 8);
  uploads.networkRegained();
  assert.equal(uploads.attempts.get(key) ?? 0, 0);
});

test('Garmin server errors still back off for longer', async () => {
  const { store, secrets, uploads } = setup([[503, 'busy'], [503, 'busy'], [503, 'busy']]);
  signedIn(secrets);
  const id = saveRide(store);
  for (let i = 0; i < 3; i++) {
    uploads.notBefore.clear();
    await uploads.process();
  }
  assert.ok(uploads.notBefore.get(`${id}/garmin`) - Date.now() > 100000);
});

test('not signed in: the ride waits; a refused login asks to sign in again', async () => {
  const a = setup([]);
  const id = saveRide(a.store);
  await a.uploads.process();
  assert.equal(a.store.record(id).uploads.garmin.status, 'pending');
  assert.equal(a.sent.length, 0);

  const b = setup([[401, '{}'], [401, '{}']]);
  signedIn(b.secrets);
  const id2 = saveRide(b.store);
  await b.uploads.process();
  assert.equal(b.store.record(id2).uploads.garmin.status, 'pending');
  assert.equal(b.uploads.state.garminNeedsSignIn, true);
});

test('settings persist and secrets are not stored as plain text when encryption is available', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spindown-test-'));
  const s = new Settings(dir);
  s.set('ftp', 250);
  assert.equal(new Settings(dir).get('ftp'), 250);
  assert.equal(new Settings(dir).get('autoUploadGarmin'), true);
  const fake = { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from([...Buffer.from(v)].reverse()), decryptString: (b) => Buffer.from([...b].reverse()).toString() };
  const secrets = new SecretStore(dir, fake);
  secrets.save('garmin.tokens', 'TOKEN-VALUE');
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('TOKEN-VALUE'));
  assert.equal(new SecretStore(dir, fake).load('garmin.tokens'), 'TOKEN-VALUE');
});
