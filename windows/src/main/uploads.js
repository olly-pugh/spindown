// Sends saved rides to Garmin Connect (first) and Strava, and keeps retrying until each destination either
// accepts the ride or rejects it for good. Upload state lives in each ride's record.json, so pending uploads
// survive restarts. Port of UploadCoordinator.swift.
import { GarminConnectClient, StravaClient, ServiceError } from '../core/services.js';
import { exportFIT, exportFileName } from '../core/fit.js';
import { Destinations, destinationName, uploadNeedsWork, describeUpload } from '../core/recorder.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UploadCoordinator {
  constructor({ store, log, transport, secrets, isOnline = () => true }) {
    this.store = store;
    this.isOnline = isOnline;
    this.log = log;
    this.secrets = secrets;
    this.garmin = new GarminConnectClient({ transport, store: secrets });
    this.strava = new StravaClient({ transport, store: secrets, config: this.stravaConfig() });
    this.state = {
      garminSignedIn: this.garmin.isSignedIn,
      garminAccountName: null,
      garminNeedsSignIn: false,
      garminVerification: null,
      stravaSignedIn: this.strava.isSignedIn,
      stravaAccountName: this.strava.tokens?.athleteName ?? null,
      stravaNeedsSignIn: false,
      stravaVerification: null,
      stravaHasCredentials: this.strava.isComplete,
      isProcessing: false,
    };
    this.attempts = new Map();
    this.notBefore = new Map();
    this.processAgain = false;
    this.listeners = new Set();
  }

  onState(fn) {
    this.listeners.add(fn);
  }

  setState(patch) {
    Object.assign(this.state, patch);
    for (const l of this.listeners) l({ ...this.state });
  }

  stravaConfig() {
    return { clientID: (this.secrets.load('strava.clientID') ?? '').trim(), clientSecret: (this.secrets.load('strava.clientSecret') ?? '').trim() };
  }

  updateStravaCredentials(clientID, secret) {
    for (const [k, v] of [['strava.clientID', clientID], ['strava.clientSecret', secret]]) {
      if (v) this.secrets.save(k, v);
      else this.secrets.delete(k);
    }
    this.strava.config = this.stravaConfig();
    this.setState({ stravaHasCredentials: this.strava.isComplete });
  }

  async refreshAccounts() {
    this.setState({
      garminSignedIn: this.garmin.isSignedIn,
      stravaSignedIn: this.strava.isSignedIn,
      stravaAccountName: this.strava.tokens?.athleteName ?? null,
    });
    if (this.state.garminSignedIn && !this.state.garminAccountName) {
      try {
        this.setState({ garminAccountName: await this.garmin.profileName() });
      } catch {
        // shown when the user verifies
      }
    }
  }

  // ---- Accounts --------------------------------------------------------------------------------

  async completeGarminSignIn(ticket) {
    await this.garmin.signIn(ticket);
    this.setState({ garminNeedsSignIn: false, garminAccountName: null });
    await this.refreshAccounts();
    await this.testGarmin();
    this.log.log(`Signed in to Garmin Connect${this.state.garminAccountName ? ` as ${this.state.garminAccountName}` : ''}`);
    this.notBefore.clear();
    this.process();
  }

  async testGarmin() {
    let result;
    try {
      const name = await this.garmin.profileName();
      this.setState({ garminAccountName: name, garminNeedsSignIn: false });
      result = { ok: true, message: `Connected as ${name}`, date: Date.now() };
    } catch (e) {
      if (e instanceof ServiceError && e.kind === 'reauthenticationRequired') this.setState({ garminNeedsSignIn: true });
      result = { ok: false, message: e.message, date: Date.now() };
    }
    this.setState({ garminVerification: result });
    this.log.log(`Garmin check: ${result.message}`, result.ok ? 'info' : 'warning');
    return result;
  }

  async signOutGarmin() {
    this.garmin.signOut();
    this.setState({ garminVerification: null, garminAccountName: null });
    await this.refreshAccounts();
    this.log.log('Signed out of Garmin Connect');
  }

  async completeStravaSignIn(callbackURL, state) {
    await this.strava.handleCallback(callbackURL, state);
    this.setState({ stravaNeedsSignIn: false });
    await this.refreshAccounts();
    await this.verifyStrava();
    this.log.log(`Signed in to Strava${this.state.stravaAccountName ? ` as ${this.state.stravaAccountName}` : ''}`);
    this.notBefore.clear();
    this.process();
  }

  async verifyStrava() {
    let v;
    try {
      const name = await this.strava.verify();
      this.setState({ stravaAccountName: name, stravaNeedsSignIn: false });
      v = { ok: true, message: `Connected as ${name}`, date: Date.now() };
    } catch (e) {
      if (e instanceof ServiceError && e.kind === 'reauthenticationRequired') this.setState({ stravaNeedsSignIn: true });
      v = { ok: false, message: e.message, date: Date.now() };
    }
    this.setState({ stravaVerification: v });
    this.log.log(`Strava check: ${v.message}`, v.ok ? 'info' : 'warning');
    return v;
  }

  async signOutStrava() {
    await this.strava.signOut();
    this.setState({ stravaVerification: null });
    await this.refreshAccounts();
    this.log.log('Signed out of Strava');
  }

  // ---- Queue -------------------------------------------------------------------------------------

  key(id, d) {
    return `${id}/${d}`;
  }

  async enqueue(id, destinations) {
    for (const d of destinations) {
      this.store.setUpload(id, d, { status: 'pending' });
      this.attempts.set(this.key(id, d), 0);
      this.notBefore.delete(this.key(id, d));
    }
    await this.process();
  }

  get hasOutstandingWork() {
    return this.store.records.some((r) => Object.values(r.uploads ?? {}).some(uploadNeedsWork));
  }

  /** Uploads everything outstanding, Garmin before Strava, oldest ride first. */
  async process() {
    if (this.state.isProcessing) {
      this.processAgain = true;
      return;
    }
    if (!this.isOnline()) return; // no Wi-Fi: networkRegained() picks the queue up again
    this.setState({ isProcessing: true });
    try {
      do {
        this.processAgain = false;
        const records = [...this.store.records].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
        for (const record of records) {
          for (const destination of Destinations) {
            const state = this.store.record(record.id)?.uploads?.[destination];
            if (!uploadNeedsWork(state)) continue;
            const wait = this.notBefore.get(this.key(record.id, destination));
            if (wait && wait > Date.now()) continue;
            await this.upload(record.id, destination, state);
          }
        }
      } while (this.processAgain);
    } finally {
      this.setState({ isProcessing: false });
    }
  }

  async upload(id, destination, state) {
    if (destination === 'garmin' && (!this.garmin.isSignedIn || this.state.garminNeedsSignIn)) return; // stays pending until sign-in
    if (destination === 'strava' && (!this.strava.isSignedIn || this.state.stravaNeedsSignIn)) return;
    const k = this.key(id, destination);
    try {
      let outcome;
      if (state.status === 'processing' && destination === 'strava') {
        outcome = await this.pollStrava(state.ref);
      } else {
        const ride = this.store.exportable(id);
        const fit = exportFIT(ride);
        this.store.setUpload(id, destination, { status: 'uploading' });
        this.log.log(`Uploading ${ride.record.name} to ${destinationName(destination)} (${fit.length} bytes)`);
        if (destination === 'garmin') {
          outcome = await this.garmin.upload(fit, exportFileName(ride, 'fit'));
        } else {
          const first = await this.strava.upload(fit, ride.record.name, 'Indoor ride on a Kinetic Road Machine (inRide), recorded with Spindown.', id);
          if (first.status === 'processing') {
            this.store.setUpload(id, destination, first);
            outcome = await this.pollStrava(first.ref);
          } else {
            outcome = first;
          }
        }
      }
      this.store.setUpload(id, destination, outcome);
      this.attempts.set(k, 0);
      this.notBefore.delete(k);
      this.log.log(`${destinationName(destination)}: ${describeUpload(outcome)}`);
    } catch (e) {
      const attempt = (this.attempts.get(k) ?? 0) + 1;
      this.attempts.set(k, attempt);
      const serviceError = e instanceof ServiceError ? e : null;
      if (serviceError?.kind === 'reauthenticationRequired') {
        this.setState(destination === 'garmin' ? { garminNeedsSignIn: true } : { stravaNeedsSignIn: true });
        this.store.setUpload(id, destination, { status: 'pending' });
        this.log.log(`${destinationName(destination)} needs you to sign in again; upload will resume afterwards`, 'warning');
        return;
      }
      const retryable = serviceError ? serviceError.isRetryable : true; // network errors are retryable
      const message = friendlyNetworkMessage(e);
      this.store.setUpload(id, destination, { status: 'failed', message, retryable });
      if (retryable) {
        // Connection trouble never reached Garmin, so retry soon (Wi-Fi is often still settling after it
        // reconnects). Errors from the service itself back off up to 30 minutes.
        const delay = serviceError
          ? Math.min(1800, 30 * Math.pow(2, Math.min(attempt - 1, 6)))
          : Math.min(60, 15 * Math.pow(2, Math.min(attempt - 1, 2)));
        this.notBefore.set(k, Date.now() + delay * 1000);
        this.log.log(`${destinationName(destination)} upload failed (attempt ${attempt}): ${message}. Retrying in ${delay} s`, 'warning');
      } else {
        this.log.log(`${destinationName(destination)} upload failed permanently: ${message}`, 'error');
      }
    }
  }

  async pollStrava(ref) {
    let outcome = { status: 'processing', ref };
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      outcome = await this.strava.checkUpload(ref);
      if (outcome.status !== 'processing') break;
    }
    return outcome;
  }

  /** Network came back: retry everything now rather than waiting out the back-off. */
  networkRegained() {
    if (!this.hasOutstandingWork) return;
    this.log.log('Network available; retrying uploads');
    this.notBefore.clear();
    this.attempts.clear();
    this.process();
  }
}

function friendlyNetworkMessage(e) {
  if (e instanceof ServiceError) return e.message;
  const m = String(e?.message ?? e);
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_NETWORK_CHANGED/i.test(m)) return 'No internet connection.';
  if (/timed? ?out|TIMEOUT/i.test(m)) return 'The connection timed out.';
  return m;
}
