// The ride in progress. Samples once per whole second, driven both by a timer and by incoming packets.
// Port of RideSession.swift. Every sample goes to the crash journal (kept by the main process), so a ride
// survives the window closing, a crash or a power cut.
import { RideRecorder, Journal, replayJournal, newRideID, defaultRideName } from '../core/recorder.js';
import { hex } from '../core/bytes.js';
import { changed } from './model.js';

export const RESUME_WINDOW = 15 * 60 * 1000;

export class RideSession {
  constructor({ api, trainer, heartRate, settings, log }) {
    this.api = api;
    this.trainer = trainer;
    this.heartRate = heartRate;
    this.settings = settings;
    this.log = log;
    this.phase = 'idle';
    this.recorder = null;
    this.rideID = null;
    this.lastError = null;
    this.lastRecordedSecond = 0;
    this.timer = null;
    this.powerWindow = [];
    this.worldVisible = false;
    /** Segment efforts ridden in World during this ride ({name, time, power, hr, …}), saved with the ride. */
    this.segmentEfforts = [];
  }

  get startDate() {
    return this.recorder?.startDate ?? null;
  }

  get stats() {
    return this.recorder?.stats ?? null;
  }

  /** Trainer details plus the heart-rate strap in use, saved with the ride. */
  get equipment() {
    const info = { ...this.trainer.trainerInfo };
    if (this.heartRate.isConnected && this.heartRate.deviceName) info.heartRateMonitor = this.heartRate.deviceName;
    return info;
  }

  elapsed(now = Date.now()) {
    return this.startDate == null ? 0 : Math.max(0, (now - this.startDate) / 1000);
  }

  /** Power for display, averaged over the chosen window. null when there is no fresh data. */
  displayPower(now = Date.now()) {
    if (!this.trainer.freshReading(now)) return null;
    const cutoff = now - (this.settings.get('powerSmoothing') + 0.25) * 1000;
    const values = this.powerWindow.filter(([d]) => d >= cutoff).map(([, p]) => p);
    if (!values.length) return this.trainer.latest?.power ?? null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }

  // ---- Trainer input ---------------------------------------------------------------------------------

  handle(m, date) {
    this.powerWindow.push([date, m.power]);
    this.powerWindow = this.powerWindow.filter(([d]) => date - d <= 12000);
    this.tick(date);
  }

  handlePacket(p) {
    if (this.phase === 'idle' || !this.settings.get('captureRawPackets')) return;
    this.api.journal.appendPacket(`{"t":${(p.date / 1000).toFixed(3)},"dir":"${p.direction}","c":"${p.characteristic}","hex":"${hex(p.bytes, '')}"}\n`);
  }

  // ---- Control -------------------------------------------------------------------------------------

  setPhase(phase) {
    this.phase = phase;
    this.api.app.setRidePhase(phase);
    this.updateKeepAwake();
    changed();
  }

  /** The screen stays on the whole time Spindown is open (the setting), and always in World. The main process
   *  only holds it while the window is on screen, or during a ride. */
  updateKeepAwake() {
    this.api.app.keepAwake(!!this.settings.get('keepScreenOn') || this.worldVisible);
  }

  async start() {
    if (this.phase !== 'idle') return;
    try {
      const id = newRideID();
      const start = Date.now();
      await this.api.journal.open(false);
      this.api.journal.append(Journal.header(id, start, this.equipment), true);
      this.rideID = id;
      this.recorder = new RideRecorder(start);
      this.segmentEfforts = [];
      this.lastRecordedSecond = 0;
      this.lastError = null;
      this.setPhase('recording');
      this.startTimer();
      this.log.log('Ride started');
    } catch (e) {
      this.lastError = `Could not start recording: ${e.message}`;
      this.log.log(this.lastError, 'error');
      changed();
    }
  }

  pause() {
    if (this.phase !== 'recording' || !this.recorder) return;
    const r = this.recorder;
    const t = (Date.now() - r.startDate) / 1000;
    const closing = r.pause(t, this.trainer.freshReading(), this.heartRate.freshHeartRate());
    if (closing) this.api.journal.append(Journal.sample(closing));
    this.api.journal.append(Journal.pause(t), true);
    this.setPhase('paused');
    this.log.log('Ride paused');
  }

  resume() {
    if (this.phase !== 'paused' || !this.recorder) return;
    const r = this.recorder;
    const t = (Date.now() - r.startDate) / 1000;
    r.resume(t);
    this.api.journal.append(Journal.resume(t), true);
    this.lastRecordedSecond = Math.floor(t);
    this.setPhase('recording');
    this.log.log('Ride resumed');
  }

  /** Stops recording and saves. Returns the saved record, or null. */
  async finish() {
    if (this.phase === 'idle' || !this.recorder || !this.rideID) return null;
    const r = this.recorder;
    const endDate = Date.now();
    const endT = (endDate - r.startDate) / 1000;
    if (this.phase === 'recording') {
      const closing = r.pause(endT, this.trainer.freshReading(), this.heartRate.freshHeartRate());
      if (closing) this.api.journal.append(Journal.sample(closing));
    }
    this.api.journal.append(Journal.pause(endT), true);
    const record = {
      schemaVersion: 1,
      id: this.rideID,
      name: defaultRideName(r.startDate),
      startDate: new Date(r.startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      summary: r.summary(endT),
      trainer: this.equipment,
      recovered: false,
      uploads: Object.fromEntries(this.settings.autoUploadDestinations.map((d) => [d, { status: 'pending' }])),
    };
    if (this.segmentEfforts.length) record.segments = this.segmentEfforts.slice();
    try {
      await this.api.journal.save(record, r.track, !!this.settings.get('captureRawPackets'));
      this.reset();
      this.log.log(`Ride saved: ${Math.round(record.summary.distance)} m, ${Math.round(record.summary.timerTime)} s`);
      return record;
    } catch (e) {
      // Keep the journal: the ride will be recovered on next launch.
      this.lastError = `Could not save the ride (${e.message}). It is kept and will be recovered.`;
      this.log.log(this.lastError, 'error');
      changed();
      return null;
    }
  }

  async discard() {
    await this.api.journal.discard();
    this.reset();
    this.log.log('Ride discarded');
  }

  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    this.recorder = null;
    this.rideID = null;
    this.segmentEfforts = [];
    this.setPhase('idle');
  }

  // ---- Sampling ------------------------------------------------------------------------------------

  startTimer() {
    clearTimeout(this.timer);
    const loop = () => {
      if (!this.recorder) return;
      // Wake just after each whole second of ride time.
      const frac = ((Date.now() - this.recorder.startDate) / 1000) % 1;
      this.timer = setTimeout(() => {
        this.tick(Date.now());
        loop();
      }, Math.max(10, (1.02 - frac) * 1000));
    };
    loop();
  }

  tick(now = Date.now()) {
    if (this.phase !== 'recording' || !this.recorder) return;
    const r = this.recorder;
    const second = Math.floor((now - r.startDate) / 1000);
    if (!(second > this.lastRecordedSecond)) return;
    this.lastRecordedSecond = second;
    const sample = r.record(second, this.trainer.freshReading(now), this.heartRate.freshHeartRate(now));
    if (sample) this.api.journal.append(Journal.sample(sample));
    changed();
  }

  // ---- Crash recovery ------------------------------------------------------------------------------

  /** Call once at launch. Continues or saves a ride left by a previous run. Returns a message or null. */
  async recoverIfNeeded() {
    if (this.phase !== 'idle') return null;
    const text = await this.api.journal.read();
    if (!text) return null;
    try {
      const rec = replayJournal(text);
      const start = rec.recorder.startDate;
      const lastKnown = start + rec.lastT * 1000;
      this.log.log(`Found unfinished ride from ${new Date(start).toLocaleString()} (${rec.recorder.samples.length} samples, ${rec.skippedLines} unreadable lines)`, 'warning');

      if (Date.now() - lastKnown < RESUME_WINDOW) {
        await this.api.journal.open(true);
        this.rideID = rec.id;
        this.recorder = rec.recorder;
        this.lastRecordedSecond = Math.floor(rec.lastT);
        this.setPhase(rec.recorder.isPaused ? 'paused' : 'recording');
        this.startTimer();
        this.log.log('Resumed the unfinished ride');
        return 'Spindown was closed during your ride. Recording has resumed where it left off.';
      }

      const r = rec.recorder;
      if (!r.isPaused) r.pause(rec.lastT);
      const record = {
        schemaVersion: 1,
        id: rec.id,
        name: defaultRideName(start),
        startDate: new Date(start).toISOString(),
        endDate: new Date(lastKnown).toISOString(),
        summary: r.summary(rec.lastT),
        trainer: rec.trainer,
        recovered: true,
        uploads: Object.fromEntries(this.settings.autoUploadDestinations.map((d) => [d, { status: 'pending' }])),
      };
      await this.api.journal.save(record, r.track, true);
      this.log.log('Saved the unfinished ride as a recovered ride');
      return `Spindown was closed during a ride. It has been saved to your history as "${record.name}".`;
    } catch (e) {
      await this.api.journal.moveAside();
      this.log.log(`Could not recover unfinished ride: ${e.message}`, 'error');
      return 'An unfinished ride could not be recovered. Its raw files were kept in the Spindown data folder.';
    }
  }
}
