// Ride recording: running totals, the 1 Hz recorder, models and the crash journal.
// Ports of RideRecorder.swift, RideModels.swift and RideJournal.swift.

/** 2 km/h. Below this the roller is effectively stopped. */
export const MOVING_THRESHOLD = 2.0 / 3.6;
/** Longest gap credited between two samples (app suspended, clock jump). */
export const MAX_SAMPLE_GAP = 5.0;

/** Running totals: a pure fold over samples, so live screen, crash recovery and summary cannot disagree. */
export class RideStats {
  constructor() {
    this.timerTime = 0;
    this.movingTime = 0;
    this.distance = 0;
    this.work = 0;
    this.maxSpeed = 0;
    this.maxPower = null;
    this.maxCadence = null;
    this.powerSeconds = 0;
    this.powerIntegral = 0;
    this.cadenceSeconds = 0;
    this.cadenceIntegral = 0;
    this.maxHeartRate = null;
    this.heartRateSeconds = 0;
    this.heartRateIntegral = 0;
  }

  get averageSpeed() {
    return this.movingTime > 0 ? this.distance / this.movingTime : 0;
  }
  /** Time-weighted over moving time, including zeros while coasting (matches Strava and Garmin). */
  get averagePower() {
    return this.powerSeconds > 0 ? this.powerIntegral / this.powerSeconds : null;
  }
  /** Time-weighted, excluding zero cadence. */
  get averageCadence() {
    return this.cadenceSeconds > 0 ? this.cadenceIntegral / this.cadenceSeconds : null;
  }
  /** Time-weighted over recording time with heart-rate data, moving or not (as Garmin does). */
  get averageHeartRate() {
    return this.heartRateSeconds > 0 ? this.heartRateIntegral / this.heartRateSeconds : null;
  }

  add(s) {
    this.timerTime += s.dt;
    this.distance = s.distance;
    if (s.heartRate != null && s.heartRate > 0) {
      this.maxHeartRate = Math.max(this.maxHeartRate ?? 0, s.heartRate);
      this.heartRateSeconds += s.dt;
      this.heartRateIntegral += s.heartRate * s.dt;
    }
    if (s.speed == null) return;
    this.maxSpeed = Math.max(this.maxSpeed, s.speed);
    if (s.power != null) {
      this.work += s.power * s.dt;
      this.maxPower = Math.max(this.maxPower ?? 0, s.power);
    }
    if (s.cadence != null && s.cadence > 0) {
      this.maxCadence = Math.max(this.maxCadence ?? 0, s.cadence);
      this.cadenceSeconds += s.dt;
      this.cadenceIntegral += s.cadence * s.dt;
    }
    if (!(s.speed > MOVING_THRESHOLD)) return;
    this.movingTime += s.dt;
    if (s.power != null) {
      this.powerSeconds += s.dt;
      this.powerIntegral += s.power * s.dt;
    }
  }
}

/** A sample: {t, dt, power|null, speed (m/s)|null, cadence|null, distance, heartRate|null}. */
export function makeSample(t, dt, power, speed, cadence, distance, heartRate = null) {
  return { t, dt, power, speed, cadence, distance, heartRate };
}

/** Builds a ride one second at a time. Owns no clock and no I/O. */
export class RideRecorder {
  constructor(startDate) {
    /** Milliseconds since epoch. */
    this.startDate = startDate;
    this.samples = [];
    this.timerEvents = [{ t: 0, kind: 'start' }];
    this.stats = new RideStats();
    this.isPaused = false;
    this.lastT = 0;
  }

  /** Records a sample at `t` seconds after start. Pass null when there is no fresh trainer data. */
  record(t, reading, heartRate = null) {
    if (this.isPaused) return null;
    const dt = this.lastT == null ? 0 : Math.min(Math.max(t - this.lastT, 0), MAX_SAMPLE_GAP);
    this.lastT = t;
    const speed = reading ? Math.max(0, reading.speedKPH) / 3.6 : null;
    const last = this.samples[this.samples.length - 1];
    const distance = (last ? last.distance : 0) + (speed ?? 0) * dt;
    const sample = makeSample(
      t,
      dt,
      reading ? Math.max(0, reading.power) : null,
      speed,
      reading ? Math.max(0, reading.cadenceRPM) : null,
      distance,
      heartRate != null && heartRate > 0 ? heartRate : null,
    );
    this.apply(sample);
    return sample;
  }

  /** Pauses the timer, crediting time up to the pause. Returns the closing sample for the journal. */
  pause(t, reading = null, heartRate = null) {
    if (this.isPaused) return null;
    let closing = null;
    if (this.lastT != null && t > this.lastT) closing = this.record(t, reading, heartRate);
    this.isPaused = true;
    this.timerEvents.push({ t, kind: 'stop' });
    return closing;
  }

  /** Journal replay: marks a pause without a closing sample (it is already in the journal). */
  replayPause(t) {
    if (this.isPaused) return;
    this.isPaused = true;
    this.timerEvents.push({ t, kind: 'stop' });
  }

  resume(t) {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.lastT = t;
    this.timerEvents.push({ t, kind: 'start' });
  }

  /** Appends a sample produced earlier (journal replay). Keeps its stored dt and distance. */
  apply(sample) {
    this.samples.push(sample);
    this.stats.add(sample);
    this.lastT = sample.t;
  }

  summary(endT) {
    const st = this.stats;
    const last = this.samples[this.samples.length - 1];
    return {
      elapsedTime: Math.max(endT, last ? last.t : 0),
      timerTime: st.timerTime,
      movingTime: st.movingTime,
      distance: st.distance,
      averageSpeed: st.averageSpeed,
      maxSpeed: st.maxSpeed,
      averagePower: st.averagePower,
      maxPower: st.maxPower,
      normalizedPower: normalizedPower(this.samples),
      averageCadence: st.averageCadence,
      maxCadence: st.maxCadence,
      averageHeartRate: st.averageHeartRate,
      maxHeartRate: st.maxHeartRate,
      work: st.work,
    };
  }

  get track() {
    return { samples: this.samples, timerEvents: this.timerEvents };
  }
}

/** Coggan normalised power: 30 s rolling mean of 1 Hz power, fourth-power mean, fourth root. */
export function normalizedPower(samples) {
  const watts = samples.map((s) => s.power ?? 0);
  if (watts.length < 30) return null;
  let window = 0;
  for (let i = 0; i < 30; i++) window += watts[i];
  let sum4 = Math.pow(window / 30, 4);
  for (let i = 30; i < watts.length; i++) {
    window += watts[i] - watts[i - 30];
    sum4 += Math.pow(window / 30, 4);
  }
  const np = Math.pow(sum4 / (watts.length - 29), 0.25);
  return np > 0 ? np : null;
}

/** Kilocalories: roughly 1 kcal per kJ of work for cycling. */
export const calories = (summary) => summary.work / 1000;

export function defaultRideName(dateMs) {
  const hour = new Date(dateMs).getHours();
  let part;
  if (hour >= 5 && hour < 12) part = 'Morning';
  else if (hour >= 12 && hour < 17) part = 'Afternoon';
  else if (hour >= 17 && hour < 21) part = 'Evening';
  else part = 'Night';
  return `${part} Indoor Ride`;
}

export function newRideID() {
  return globalThis.crypto.randomUUID().toUpperCase();
}

// ---- Upload state -------------------------------------------------------------------------------

export const Destinations = ['garmin', 'strava'];
export const destinationName = (d) => (d === 'garmin' ? 'Garmin Connect' : 'Strava');

/** {status: pending|uploading|processing|uploaded|duplicate|failed, ref?, activityID?, message?, retryable?} */
export function uploadNeedsWork(state) {
  if (!state) return false;
  switch (state.status) {
    case 'pending':
    case 'processing':
    case 'uploading': // interrupted by the app being closed
      return true;
    case 'failed':
      return !!state.retryable;
    default:
      return false;
  }
}

export function describeUpload(state) {
  if (!state) return 'Not uploaded';
  switch (state.status) {
    case 'pending': return 'Waiting to upload';
    case 'uploading': return 'Uploading…';
    case 'processing': return 'Processing…';
    case 'uploaded': return 'Uploaded';
    case 'duplicate': return 'Already on the service';
    case 'failed': return state.retryable ? `Retrying: ${state.message}` : `Failed: ${state.message}`;
    default: return String(state.status);
  }
}

// ---- Crash journal --------------------------------------------------------------------------------
// One JSON object per line while riding; on the next launch the lines are replayed into a recorder.
// A torn final line (power loss mid-write) is ignored. Same format as the iPhone app.

function encodeSample(s) {
  const o = { t: s.t, dt: s.dt, d: s.distance };
  if (s.power != null) o.p = s.power;
  if (s.speed != null) o.v = s.speed;
  if (s.cadence != null) o.c = s.cadence;
  if (s.heartRate != null) o.h = s.heartRate;
  return o;
}

function decodeSample(o) {
  if (typeof o?.t !== 'number' || typeof o.dt !== 'number' || typeof o.d !== 'number') throw new Error('bad sample');
  return makeSample(o.t, o.dt, o.p ?? null, o.v ?? null, o.c ?? null, o.d, o.h ?? null);
}

export const Journal = {
  header: (id, startDateMs, trainer) => JSON.stringify(trainer ? { k: 'h', id, start: startDateMs / 1000, trainer } : { k: 'h', id, start: startDateMs / 1000 }) + '\n',
  sample: (s) => JSON.stringify({ k: 's', s: encodeSample(s) }) + '\n',
  pause: (t) => JSON.stringify({ k: 'p', t }) + '\n',
  resume: (t) => JSON.stringify({ k: 'r', t }) + '\n',
  trainer: (info) => JSON.stringify({ k: 'i', trainer: info }) + '\n',
};

export function replayJournal(text) {
  let header = null;
  let recorder = null;
  let trainer = null;
  let lastT = 0;
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
      if (e.k === 's') e.s = decodeSample(e.s);
      else if ((e.k === 'p' || e.k === 'r') && typeof e.t !== 'number') throw new Error('bad');
      else if (e.k === 'h' && (typeof e.id !== 'string' || typeof e.start !== 'number')) throw new Error('bad');
      else if (!['h', 's', 'p', 'r', 'i'].includes(e.k)) throw new Error('unknown');
    } catch {
      skipped++;
      continue;
    }
    switch (e.k) {
      case 'h':
        if (header) break;
        header = e;
        trainer = e.trainer ?? null;
        recorder = new RideRecorder(Math.round(e.start * 1000));
        break;
      case 's':
        recorder?.apply(e.s);
        lastT = Math.max(lastT, e.s.t);
        break;
      case 'p':
        recorder?.replayPause(e.t);
        lastT = Math.max(lastT, e.t);
        break;
      case 'r':
        recorder?.resume(e.t);
        lastT = Math.max(lastT, e.t);
        break;
      case 'i':
        trainer = e.trainer;
        break;
    }
  }
  if (!header || !recorder) throw new Error('missingHeader');
  return { id: header.id, trainer, recorder, lastT, skippedLines: skipped };
}
