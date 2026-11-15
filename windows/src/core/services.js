// Garmin Connect and Strava upload clients. Ports of HTTP.swift, GarminConnectClient.swift and StravaClient.swift.
//
// Garmin offers no public activity-upload API, so this uses the same path as Garmin Connect Mobile,
// following the maintained open-source python-garminconnect (0.3.x):
// 1. The user signs in on Garmin's own mobile SSO page in a web window (the app never sees the password).
// 2. The page hands a service ticket to its native host over the GMNEventHandler bridge (or redirects with it).
// 3. The ticket is exchanged at diauth.garmin.com for DI OAuth2 access and refresh tokens.
// 4. FIT files are POSTed to connectapi.garmin.com/upload-service/upload/.fit.
// All identifiers live in GARMIN_CONFIG so a fix is a one-line change.
//
// transport.send({url, method, headers, body, timeoutMs}) -> {status, text}
// store: {load(key) -> string|null, save(key, string), delete(key)}

export class ServiceError extends Error {
  /** kind: notSignedIn | reauthenticationRequired | rateLimited | http | invalidResponse | rejected | misconfigured */
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
  /** Network trouble and rate limits are retried; a rejected file or a revoked login is not. */
  get isRetryable() {
    switch (this.kind) {
      case 'rateLimited':
      case 'invalidResponse':
        return true;
      case 'http':
        return this.status >= 500 || this.status === 408;
      default:
        return false;
    }
  }
}

const notSignedIn = () => new ServiceError('notSignedIn', 'Not signed in.');
const reauth = (why) => new ServiceError('reauthenticationRequired', `Please sign in again. ${why}`);
const rateLimited = () => new ServiceError('rateLimited', 'The service is rate limiting requests. Will retry.');
const httpError = (status, message) => new ServiceError('http', `HTTP ${status}: ${message}`, status);
const invalid = (why) => new ServiceError('invalidResponse', `Unexpected response: ${why}`);
const rejected = (why) => new ServiceError('rejected', why);

export function formEncode(fields) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return fields.map(([k, v]) => `${k}=${enc(v)}`).join('&');
}

export class MultipartForm {
  constructor() {
    this.boundary = `Spindown-${globalThis.crypto.randomUUID().toUpperCase()}`;
    this.parts = [];
  }
  add(name, value) {
    this.parts.push(new TextEncoder().encode(`--${this.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  addFile(name, fileName, mimeType, data) {
    this.parts.push(new TextEncoder().encode(`--${this.boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    this.parts.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    this.parts.push(new TextEncoder().encode('\r\n'));
  }
  get contentType() {
    return `multipart/form-data; boundary=${this.boundary}`;
  }
  finalized() {
    const all = [...this.parts, new TextEncoder().encode(`--${this.boundary}--\r\n`)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of all) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Reads the payload of a JWT without verifying it (only used to learn expiry and client id). */
export function jwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const snippet = (text, limit = 300) => String(text ?? '').slice(0, limit);
const parseJSON = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const idString = (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null);
const basic = (s) => 'Basic ' + btoa(s);

// ---- Garmin -------------------------------------------------------------------------------------

export const GARMIN_CONFIG = {
  ssoHost: 'https://sso.garmin.com',
  ssoClientID: 'GCM_IOS_DARK',
  serviceURL: 'https://mobile.integration.garmin.com/gcm/ios',
  tokenURL: 'https://diauth.garmin.com/di-oauth2-service/oauth/token',
  grantType: 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket',
  diClientIDs: [
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI',
    'GARMIN_CONNECT_MOBILE_IOS_DI',
  ],
  apiHost: 'https://connectapi.garmin.com',
  uploadPath: '/upload-service/upload/.fit',
  /** Mirrors the native app identity python-garminconnect uses for token and API calls. */
  nativeHeaders: {
    'User-Agent': 'GCM-Android-5.23',
    'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-App-Ver': '10861',
    'X-Lang': 'en',
    'X-GCExperience': 'GC5',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  /** Name of the native bridge Garmin's mobile sign-in page calls. */
  bridgeHandlerName: 'GMNEventHandler',
};

export function garminSignInURL(c = GARMIN_CONFIG) {
  const u = new URL(`${c.ssoHost}/mobile/sso/en_US/sign-in`);
  u.searchParams.set('clientId', c.ssoClientID);
  u.searchParams.set('service', c.serviceURL);
  return u.toString();
}

/** Returns the service ticket if `url` is a post-login redirect carrying one. */
export function garminTicketFromRedirect(url, c = GARMIN_CONFIG) {
  try {
    const u = new URL(url);
    if (u.host !== new URL(c.serviceURL).host) return null;
    const t = u.searchParams.get('ticket');
    return t && t.startsWith('ST-') ? t : null;
  } catch {
    return null;
  }
}

/**
 * Parses a bridge message. The page sends {eventType, flowName, logMessage, data}; on success eventType is
 * USER_AUTHENTICATED and data holds serviceTicket and serviceUrl. Older builds pass a JSON string.
 */
export function garminBridgeEvent(body) {
  let object = body;
  if (typeof body === 'string') object = parseJSON(body);
  if (!object || typeof object !== 'object' || typeof object.eventType !== 'string') return null;
  const data = object.data && typeof object.data === 'object' ? object.data : null;
  const t = data?.serviceTicket;
  const ticket = typeof t === 'string' && t.startsWith('ST-') ? t : null;
  const comm = data?.communication && typeof data.communication === 'object' ? data.communication : null;
  const message = typeof comm?.message === 'string' && comm.message ? comm.message : null;
  return {
    type: object.eventType,
    flow: typeof object.flowName === 'string' ? object.flowName : null,
    title: typeof data?.title === 'string' ? data.title : null,
    ticket,
    serviceURL: typeof data?.serviceUrl === 'string' ? data.serviceUrl : null,
    message,
    messageType: typeof comm?.type === 'string' ? comm.type : null,
  };
}

export class GarminConnectClient {
  static tokenKey = 'garmin.tokens';

  constructor({ transport, store, config = GARMIN_CONFIG, now = () => Date.now() }) {
    this.transport = transport;
    this.store = store;
    this.config = config;
    this.now = now;
  }

  /** {accessToken, refreshToken, clientID, expiresAt (ms)|null, obtainedAt (ms)} */
  get tokens() {
    const raw = this.store.load(GarminConnectClient.tokenKey);
    return raw ? parseJSON(raw) : null;
  }

  get isSignedIn() {
    return !!this.tokens;
  }

  signOut() {
    this.store.delete(GarminConnectClient.tokenKey);
  }

  save(t) {
    this.store.save(GarminConnectClient.tokenKey, JSON.stringify(t));
  }

  tokenRequest(clientID, form) {
    return {
      url: this.config.tokenURL,
      method: 'POST',
      headers: {
        ...this.config.nativeHeaders,
        Authorization: basic(`${clientID}:`),
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formEncode(form),
      timeoutMs: 30000,
    };
  }

  parseTokens(text, fallbackClientID, previousRefresh) {
    const json = parseJSON(text);
    if (!json || typeof json.access_token !== 'string') throw invalid('token response without access_token');
    const payload = jwtPayload(json.access_token);
    const clientID = typeof payload?.client_id === 'string' ? payload.client_id : fallbackClientID;
    let expiresAt = null;
    if (typeof payload?.exp === 'number') expiresAt = payload.exp * 1000;
    else if (typeof json.expires_in === 'number') expiresAt = this.now() + json.expires_in * 1000;
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : previousRefresh,
      clientID,
      expiresAt,
      obtainedAt: this.now(),
    };
  }

  /** Step 3: exchange the SSO service ticket for DI OAuth2 tokens. */
  async signIn(ticket) {
    const failures = [];
    for (const clientID of this.config.diClientIDs) {
      const res = await this.transport.send(
        this.tokenRequest(clientID, [
          ['client_id', clientID],
          ['service_ticket', ticket],
          ['grant_type', this.config.grantType],
          ['service_url', this.config.serviceURL],
        ]),
      );
      if (res.status === 429) throw rateLimited();
      if (!(res.status >= 200 && res.status < 300)) {
        failures.push(`${clientID}: HTTP ${res.status}`);
        continue;
      }
      this.save(this.parseTokens(res.text, clientID, null));
      return;
    }
    throw rejected(`Garmin did not accept the sign-in (${failures.join('; ')}).`);
  }

  async refresh() {
    const current = this.tokens;
    if (!current) throw notSignedIn();
    if (!current.refreshToken) throw reauth('Garmin did not issue a refresh token.');
    const res = await this.transport.send(
      this.tokenRequest(current.clientID, [
        ['grant_type', 'refresh_token'],
        ['client_id', current.clientID],
        ['refresh_token', current.refreshToken],
      ]),
    );
    if (res.status >= 200 && res.status < 300) {
      this.save(this.parseTokens(res.text, current.clientID, current.refreshToken));
    } else if (res.status === 429) {
      throw rateLimited();
    } else if ([400, 401, 403].includes(res.status)) {
      throw reauth(`Garmin refused the saved login (HTTP ${res.status}).`);
    } else {
      throw httpError(res.status, snippet(res.text));
    }
  }

  expiresSoon(t) {
    if (t.expiresAt == null) return this.now() - t.obtainedAt > 3000 * 1000;
    return t.expiresAt - this.now() < 300 * 1000;
  }

  async validAccessToken() {
    const t = this.tokens;
    if (!t) throw notSignedIn();
    if (this.expiresSoon(t)) {
      await this.refresh();
      const fresh = this.tokens;
      if (!fresh) throw notSignedIn();
      return fresh.accessToken;
    }
    return t.accessToken;
  }

  /** Step 4: upload a FIT file. Returns an upload state. */
  async upload(fit, fileName) {
    for (let attempt = 1; ; attempt++) {
      const token = await this.validAccessToken();
      const form = new MultipartForm();
      form.addFile('file', fileName, 'application/octet-stream', fit);
      const res = await this.transport.send({
        url: this.config.apiHost + this.config.uploadPath,
        method: 'POST',
        headers: { ...this.config.nativeHeaders, Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': form.contentType },
        body: form.finalized(),
        timeoutMs: 120000,
      });
      if (res.status === 401 && attempt === 1) {
        await this.refresh();
        continue;
      }
      return GarminConnectClient.interpretUpload(res.status, res.text);
    }
  }

  /** Display name of the signed-in account. Doubles as a connection test. */
  async profileName() {
    for (let attempt = 1; ; attempt++) {
      const token = await this.validAccessToken();
      const res = await this.transport.send({
        url: this.config.apiHost + '/userprofile-service/socialProfile',
        method: 'GET',
        headers: { ...this.config.nativeHeaders, Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeoutMs: 30000,
      });
      if (res.status >= 200 && res.status < 300) {
        const json = parseJSON(res.text);
        return json?.fullName || json?.displayName || 'Garmin user';
      }
      if (res.status === 401 && attempt === 1) {
        await this.refresh();
        continue;
      }
      if (res.status === 401 || res.status === 403) throw reauth(`Garmin refused the saved login (HTTP ${res.status}).`);
      if (res.status === 429) throw rateLimited();
      throw httpError(res.status, snippet(res.text));
    }
  }

  /** Garmin answers 201 (created), 202 (accepted, processing) or 409 (duplicate), with a detailedImportResult body. */
  static interpretUpload(status, text) {
    const json = parseJSON(text);
    const result = json?.detailedImportResult;
    const successes = Array.isArray(result?.successes) ? result.successes : [];
    const failures = Array.isArray(result?.failures) ? result.failures : [];
    const activityID = successes.length ? idString(successes[0].internalId) : null;
    const failureMessages = failures
      .flatMap((f) => (Array.isArray(f.messages) ? f.messages : []))
      .map((m) => m?.content)
      .filter((m) => typeof m === 'string');
    const failureID = failures.length ? idString(failures[0].internalId) : null;
    const isDuplicate = status === 409 || failureMessages.some((m) => m.toLowerCase().includes('duplicate'));

    if (status >= 200 && status < 300) {
      if (isDuplicate) return { status: 'duplicate', activityID: failureID };
      if (failureMessages.length && !successes.length) throw rejected(`Garmin rejected the file: ${failureMessages.join(' ')}`);
      return { status: 'uploaded', activityID };
    }
    if (status === 409) return { status: 'duplicate', activityID: failureID };
    if (status === 401 || status === 403) throw reauth(`Garmin refused the upload (HTTP ${status}).`);
    if (status === 429) throw rateLimited();
    throw httpError(status, failureMessages[0] ?? snippet(text));
  }

  static activityURL(id) {
    return `https://connect.garmin.com/modern/activity/${id}`;
  }
}

// ---- Strava -------------------------------------------------------------------------------------

/**
 * Each user registers their own (free) Strava API application with Authorization Callback Domain
 * "localhost". On the desktop the redirect goes to http://localhost/strava, which the sign-in window
 * intercepts before anything is loaded.
 */
export const STRAVA_REDIRECT = 'http://localhost/strava';
const STRAVA_API = 'https://www.strava.com/api/v3';

export class StravaClient {
  static tokenKey = 'strava.tokens';

  constructor({ transport, store, config, now = () => Date.now() }) {
    this.transport = transport;
    this.store = store;
    this.config = config; // {clientID, clientSecret}
    this.now = now;
  }

  get isComplete() {
    return !!(this.config.clientID && this.config.clientSecret);
  }

  /** {accessToken, refreshToken, expiresAt (ms), athleteName} */
  get tokens() {
    const raw = this.store.load(StravaClient.tokenKey);
    return raw ? parseJSON(raw) : null;
  }

  get isSignedIn() {
    return !!this.tokens;
  }

  save(t) {
    this.store.save(StravaClient.tokenKey, JSON.stringify(t));
  }

  authorizeURL(state) {
    if (!this.isComplete) throw new ServiceError('misconfigured', 'Add your Strava Client ID and Secret in Settings first.');
    const u = new URL('https://www.strava.com/oauth/authorize');
    u.searchParams.set('client_id', this.config.clientID);
    u.searchParams.set('redirect_uri', STRAVA_REDIRECT);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('approval_prompt', 'auto');
    u.searchParams.set('scope', 'read,activity:write');
    u.searchParams.set('state', state);
    return u.toString().replace('scope=read%2Cactivity%3Awrite', 'scope=read,activity:write');
  }

  async handleCallback(url, expectedState) {
    const u = new URL(url);
    const item = (n) => u.searchParams.get(n);
    if (item('error')) throw rejected(`Strava authorisation failed: ${item('error')}`);
    if (item('state') !== expectedState) throw rejected('Strava sign-in did not match this request.');
    const code = item('code');
    if (!code) throw invalid('no authorisation code');
    if (!(item('scope') ?? '').includes('activity:write')) throw rejected('Strava sign-in needs permission to upload activities. Please allow it.');
    await this.tokenRequest(
      [['client_id', this.config.clientID], ['client_secret', this.config.clientSecret], ['code', code], ['grant_type', 'authorization_code']],
      null,
    );
  }

  async tokenRequest(form, previous) {
    const res = await this.transport.send({
      url: 'https://www.strava.com/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(form),
      timeoutMs: 30000,
    });
    if (res.status === 429) throw rateLimited();
    if ([400, 401, 403].includes(res.status)) throw reauth(`Strava refused the login (HTTP ${res.status}).`);
    if (!(res.status >= 200 && res.status < 300)) throw httpError(res.status, snippet(res.text));
    const json = parseJSON(res.text);
    if (!json || typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string' || typeof json.expires_at !== 'number') {
      throw invalid('token response');
    }
    let name = previous?.athleteName ?? null;
    if (json.athlete && typeof json.athlete === 'object') {
      name = [json.athlete.firstname, json.athlete.lastname].filter((x) => typeof x === 'string').join(' ');
    }
    this.save({ accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_at * 1000, athleteName: name });
  }

  async validAccessToken() {
    const t = this.tokens;
    if (!t) throw notSignedIn();
    if (t.expiresAt - this.now() < 300 * 1000) {
      await this.tokenRequest(
        [['client_id', this.config.clientID], ['client_secret', this.config.clientSecret], ['grant_type', 'refresh_token'], ['refresh_token', t.refreshToken]],
        t,
      );
    }
    const fresh = this.tokens;
    if (!fresh) throw notSignedIn();
    return fresh.accessToken;
  }

  /** Confirms the saved login works by asking Strava who is signed in. Returns the athlete's name. */
  async verify() {
    const token = await this.validAccessToken();
    const res = await this.transport.send({ url: `${STRAVA_API}/athlete`, method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 30000 });
    if (res.status >= 200 && res.status < 300) {
      const json = parseJSON(res.text);
      const name = [json?.firstname, json?.lastname].filter((x) => typeof x === 'string').join(' ');
      const t = this.tokens;
      if (t && name) this.save({ ...t, athleteName: name });
      return name || 'Strava athlete';
    }
    if (res.status === 401 || res.status === 403) throw reauth(`Strava refused the saved login (HTTP ${res.status}).`);
    if (res.status === 429) throw rateLimited();
    throw httpError(res.status, snippet(res.text));
  }

  async signOut() {
    const t = this.tokens;
    if (t) {
      try {
        await this.transport.send({
          url: 'https://www.strava.com/oauth/deauthorize',
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formEncode([['access_token', t.accessToken]]),
          timeoutMs: 15000,
        });
      } catch {
        // best effort
      }
    }
    this.store.delete(StravaClient.tokenKey);
  }

  /** Uploads a FIT file flagged as an indoor trainer ride. `externalID` makes retries idempotent. */
  async upload(fit, name, description, externalID) {
    const token = await this.validAccessToken();
    const form = new MultipartForm();
    form.add('data_type', 'fit');
    form.add('name', name);
    if (description) form.add('description', description);
    form.add('trainer', '1');
    form.add('commute', '0');
    form.add('external_id', externalID);
    form.addFile('file', `${externalID}.fit`, 'application/octet-stream', fit);
    const res = await this.transport.send({
      url: `${STRAVA_API}/uploads`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': form.contentType },
      body: form.finalized(),
      timeoutMs: 120000,
    });
    return StravaClient.interpretUpload(res.status, res.text);
  }

  async checkUpload(ref) {
    const token = await this.validAccessToken();
    const res = await this.transport.send({ url: `${STRAVA_API}/uploads/${ref}`, method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 30000 });
    return StravaClient.interpretUpload(res.status, res.text);
  }

  static interpretUpload(status, text) {
    if (status === 401 || status === 403) throw reauth(`Strava refused the upload (HTTP ${status}).`);
    if (status === 429) throw rateLimited();
    if (!(status >= 200 && status < 300)) throw httpError(status, parseJSON(text)?.message ?? snippet(text));
    const json = parseJSON(text);
    if (!json || typeof json !== 'object') throw invalid('upload response');
    if (typeof json.error === 'string' && json.error) {
      if (json.error.toLowerCase().includes('duplicate')) return { status: 'duplicate', activityID: StravaClient.activityIDInDuplicateMessage(json.error) };
      throw rejected(`Strava rejected the file: ${json.error}`);
    }
    const activity = idString(json.activity_id);
    if (activity) return { status: 'uploaded', activityID: activity };
    const ref = typeof json.id_str === 'string' ? json.id_str : idString(json.id);
    if (!ref) throw invalid('upload response without id');
    return { status: 'processing', ref };
  }

  /** Strava reports e.g. "file.fit duplicate of <a href='/activities/123456'>Morning Ride</a>". */
  static activityIDInDuplicateMessage(message) {
    const m = /activities\/(\d+)/.exec(message);
    return m ? m[1] : null;
  }

  static activityURL(id) {
    return `https://www.strava.com/activities/${id}`;
  }
}
