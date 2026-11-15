// Port of ServiceTests.swift and AccountTests: Garmin and Strava clients against mocked servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GarminConnectClient, StravaClient, ServiceError, garminTicketFromRedirect, garminSignInURL, garminBridgeEvent,
} from '../src/core/services.js';

class MemoryStore {
  constructor() { this.items = new Map(); }
  load(k) { return this.items.get(k) ?? null; }
  save(k, v) { this.items.set(k, v); }
  delete(k) { this.items.delete(k); }
}

class MockTransport {
  constructor(responses) { this.responses = responses; this.sent = []; }
  async send(req) {
    this.sent.push(req);
    const [status, text] = this.responses.length ? this.responses.shift() : [500, 'no more responses'];
    return { status, text };
  }
}

const b64url = (s) => btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload) => `eyJhbGciOiJub25lIn0.${b64url(JSON.stringify(payload))}.sig`;
const form = (req) => Object.fromEntries(new URLSearchParams(req.body));
const bodyText = (req) => new TextDecoder().decode(req.body);
const NOW = 1_800_000_000_000;

test('captures the service ticket only from the expected redirect', () => {
  assert.equal(garminTicketFromRedirect('https://mobile.integration.garmin.com/gcm/ios?ticket=ST-0123-abc'), 'ST-0123-abc');
  assert.equal(garminTicketFromRedirect('https://evil.example.com/gcm/ios?ticket=ST-1'), null);
  assert.equal(garminTicketFromRedirect('https://mobile.integration.garmin.com/gcm/ios?ticket=XX'), null);
  assert.ok(garminSignInURL().includes('clientId=GCM_IOS_DARK'));
});

test("reads the ticket and messages from the sign-in page's native bridge", () => {
  const e = garminBridgeEvent({ eventType: 'USER_AUTHENTICATED', flowName: 'signIn', logMessage: '',
    data: { serviceTicket: 'ST-123-abc', serviceUrl: 'https://mobile.integration.garmin.com/gcm/ios' } });
  assert.equal(e.type, 'USER_AUTHENTICATED');
  assert.equal(e.ticket, 'ST-123-abc');
  assert.equal(e.serviceURL, 'https://mobile.integration.garmin.com/gcm/ios');
  assert.equal(garminBridgeEvent('{"eventType":"USER_AUTHENTICATED","data":{"serviceTicket":"ST-9"}}').ticket, 'ST-9');
  const pageLoad = { eventType: 'PAGE_LOAD', flowName: 'signIn', data: { title: 'Sign In' } };
  assert.equal(garminBridgeEvent(pageLoad).ticket, null);
  assert.equal(garminBridgeEvent(pageLoad).title, 'Sign In');
  assert.equal(garminBridgeEvent({ eventType: 'USER_AUTHENTICATED', data: { serviceTicket: 'bogus' } }).ticket, null);
  assert.equal(garminBridgeEvent(42), null);
  const comm = garminBridgeEvent({ eventType: 'COMMUNICATION', flowName: 'AUTHENTICATION',
    data: { communication: { type: 'ERROR', message: 'Invalid sign in. (Passwords are case sensitive.)', confirmationText: 'OK' } } });
  assert.equal(comm.message, 'Invalid sign in. (Passwords are case sensitive.)');
  assert.equal(comm.messageType, 'ERROR');
  assert.equal(comm.ticket, null);
});

test('exchanges the ticket, falling through client IDs', async () => {
  const access = jwt({ client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4', exp: 1_800_003_600 });
  const transport = new MockTransport([[401, '{}'], [200, JSON.stringify({ access_token: access, refresh_token: 'r1' })]]);
  const client = new GarminConnectClient({ transport, store: new MemoryStore(), now: () => NOW });
  await client.signIn('ST-1');
  const t = client.tokens;
  assert.equal(t.refreshToken, 'r1');
  assert.equal(t.clientID, 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4');
  assert.equal(t.expiresAt, 1_800_003_600_000);
  assert.equal(transport.sent.length, 2);
  assert.equal(form(transport.sent[1]).service_ticket, 'ST-1');
  assert.equal(form(transport.sent[1]).service_url, 'https://mobile.integration.garmin.com/gcm/ios');
  assert.equal(transport.sent[1].headers.Authorization, 'Basic ' + btoa('GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4:'));
});

test('refreshes an expiring token before uploading', async () => {
  const store = new MemoryStore();
  store.save(GarminConnectClient.tokenKey, JSON.stringify({ accessToken: 'old', refreshToken: 'r1', clientID: 'C', expiresAt: NOW + 60000, obtainedAt: NOW }));
  const fresh = jwt({ exp: 1_800_007_200 });
  const transport = new MockTransport([
    [200, JSON.stringify({ access_token: fresh, refresh_token: 'r2' })],
    [201, '{"detailedImportResult":{"uploadId":9,"successes":[{"internalId":123456}],"failures":[]}}'],
  ]);
  const client = new GarminConnectClient({ transport, store, now: () => NOW });
  const outcome = await client.upload(new Uint8Array([1, 2, 3]), 'a.fit');
  assert.deepEqual(outcome, { status: 'uploaded', activityID: '123456' });
  assert.equal(form(transport.sent[0]).grant_type, 'refresh_token');
  assert.equal(transport.sent[1].headers.Authorization, `Bearer ${fresh}`);
  assert.equal(transport.sent[1].url, 'https://connectapi.garmin.com/upload-service/upload/.fit');
  assert.ok(bodyText(transport.sent[1]).includes('filename="a.fit"'));
  assert.equal(client.tokens.refreshToken, 'r2');
});

test('interprets Garmin upload responses', () => {
  const I = GarminConnectClient.interpretUpload;
  assert.deepEqual(I(202, '{"detailedImportResult":{"successes":[],"failures":[]}}'), { status: 'uploaded', activityID: null });
  assert.deepEqual(I(409, '{"detailedImportResult":{"successes":[],"failures":[{"internalId":77,"messages":[{"code":202,"content":"Duplicate Activity."}]}]}}'), { status: 'duplicate', activityID: '77' });
  assert.deepEqual(I(200, '{"detailedImportResult":{"successes":[],"failures":[{"messages":[{"content":"Duplicate Activity."}]}]}}'), { status: 'duplicate', activityID: null });
  assert.throws(() => I(200, '{"detailedImportResult":{"successes":[],"failures":[{"messages":[{"content":"Invalid file"}]}]}}'), ServiceError);
  assert.throws(() => I(403, ''), (e) => e.kind === 'reauthenticationRequired' && e.message.includes('HTTP 403'));
  assert.throws(() => I(429, ''), (e) => e.kind === 'rateLimited' && e.isRetryable);
});

test('a refused refresh asks the user to sign in again (not retryable)', async () => {
  const store = new MemoryStore();
  store.save(GarminConnectClient.tokenKey, JSON.stringify({ accessToken: 'a', refreshToken: 'r', clientID: 'C', expiresAt: NOW, obtainedAt: NOW }));
  const client = new GarminConnectClient({ transport: new MockTransport([[401, '{}'], [401, '{}']]), store, now: () => NOW });
  await assert.rejects(client.upload(new Uint8Array(), 'a.fit'), (e) => e instanceof ServiceError && !e.isRetryable);
});

test('Strava: authorisation URL and callback', async () => {
  const transport = new MockTransport([[200, '{"access_token":"a","refresh_token":"r","expires_at":1800021600,"athlete":{"firstname":"Sam","lastname":"Rider"}}']]);
  const client = new StravaClient({ transport, store: new MemoryStore(), config: { clientID: '123', clientSecret: 's' }, now: () => NOW });
  const url = client.authorizeURL('xyz');
  assert.ok(url.startsWith('https://www.strava.com/oauth/authorize?'));
  assert.ok(url.includes('scope=read,activity:write'));
  assert.ok(url.includes('redirect_uri=http%3A%2F%2Flocalhost%2Fstrava'));
  await client.handleCallback('http://localhost/strava?state=xyz&code=c0de&scope=read,activity:write', 'xyz');
  assert.equal(client.tokens.athleteName, 'Sam Rider');
  assert.equal(form(transport.sent[0]).code, 'c0de');
});

test('Strava: rejects a callback with the wrong state or missing upload scope', async () => {
  const client = new StravaClient({ transport: new MockTransport([]), store: new MemoryStore(), config: { clientID: '1', clientSecret: 's' } });
  await assert.rejects(client.handleCallback('http://localhost/strava?state=bad&code=c&scope=read,activity:write', 'good'), ServiceError);
  await assert.rejects(client.handleCallback('http://localhost/strava?state=s&code=c&scope=read', 's'), ServiceError);
});

test('Strava: upload is flagged as a trainer ride with an external id; status interpretation', async () => {
  const store = new MemoryStore();
  store.save(StravaClient.tokenKey, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3600000 }));
  const transport = new MockTransport([[201, '{"id":555,"id_str":"555","error":null,"status":"Your activity is still being processed.","activity_id":null}']]);
  const client = new StravaClient({ transport, store, config: { clientID: '1', clientSecret: 's' }, now: () => NOW });
  assert.deepEqual(await client.upload(new Uint8Array([0]), 'Ride', null, 'abc'), { status: 'processing', ref: '555' });
  const body = bodyText(transport.sent[0]);
  assert.ok(body.includes('name="trainer"\r\n\r\n1\r\n'));
  assert.ok(body.includes('name="external_id"\r\n\r\nabc\r\n'));
  assert.ok(body.includes('name="data_type"\r\n\r\nfit\r\n'));

  const I = StravaClient.interpretUpload;
  assert.deepEqual(I(200, '{"id":1,"error":null,"activity_id":987}'), { status: 'uploaded', activityID: '987' });
  assert.deepEqual(I(200, `{"id":1,"error":"a.fit duplicate of <a href='/activities/4242'>Ride</a>","activity_id":null}`), { status: 'duplicate', activityID: '4242' });
  assert.throws(() => I(200, '{"id":1,"error":"Corrupt file"}'), ServiceError);
});

test('Strava: verify returns the athlete name and flags a revoked login', async () => {
  const store = new MemoryStore();
  store.save(StravaClient.tokenKey, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600000 }));
  const transport = new MockTransport([[200, '{"id":1,"firstname":"Sam","lastname":"Rider"}']]);
  const client = new StravaClient({ transport, store, config: { clientID: '1', clientSecret: 's' } });
  assert.equal(await client.verify(), 'Sam Rider');
  assert.equal(transport.sent[0].url, 'https://www.strava.com/api/v3/athlete');
  assert.equal(client.tokens.athleteName, 'Sam Rider');
  const revoked = new StravaClient({ transport: new MockTransport([[401, '{}']]), store, config: { clientID: '1', clientSecret: 's' } });
  await assert.rejects(revoked.verify(), (e) => e.kind === 'reauthenticationRequired' && e.message.includes('HTTP 401'));
});
