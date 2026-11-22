// Settings, secrets, the event log and ride storage, all as plain files under the app's data folder
// (%APPDATA%\Spindown on Windows). Ports of AppSettings.swift, Keychain.swift, DiagnosticsLog.swift
// (file part) and RideStore.swift.
//
//   Rides/<uuid>/record.json   metadata + summary + upload states
//   Rides/<uuid>/track.json    1 Hz samples and timer events
//   Rides/<uuid>/packets.jsonl raw BLE capture (optional)
//   ActiveRide/                crash journal of the ride in progress
//   Logs/events.log            event log (rotated at 2 MB)
import fs from 'node:fs';
import path from 'node:path';

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---- Settings ------------------------------------------------------------------------------------

export const SETTINGS_DEFAULTS = {
  units: 'metric',
  powerSmoothing: 3,
  keepScreenOn: true,
  /** 0 = leave the sensor's own setting alone (what Kinetic Fit did). */
  updateRate: 0,
  autoConnect: true,
  autoUploadGarmin: true,
  // Off by default: Garmin forwards uploads to Strava for most riders, so both would duplicate.
  autoUploadStrava: false,
  captureRawPackets: true,
  simulator: false,
  trainerID: null,
  trainerName: null,
  hrmID: null,
  hrmName: null,
  ftp: 170,
  /** Heart-rate zones as % of max HR, as on a Garmin. No zones are shown until a max HR is entered. */
  maxHeartRate: null,
  hrZonePercents: [50, 60, 70, 80, 90],
  onboarded: false,
};

/** The 3D game's profile (XP, kit, PRs, ghosts), kept apart from the app's settings and rides. */
export class GameStore {
  constructor(dir) {
    this.file = path.join(dir, 'game.json');
  }
  load() {
    return readJSON(this.file, null);
  }
  save(text) {
    if (typeof text !== 'string' || text.length > 5_000_000) return false;
    JSON.parse(text); // only valid JSON is written
    writeAtomic(this.file, text);
    return true;
  }
}

export class Settings {
  constructor(dir, { imperial = false } = {}) {
    this.file = path.join(dir, 'settings.json');
    this.values = { ...SETTINGS_DEFAULTS, units: imperial ? 'imperial' : 'metric', ...readJSON(this.file, {}) };
  }
  get(key) {
    return this.values[key];
  }
  all() {
    return { ...this.values };
  }
  set(key, value) {
    if (!(key in SETTINGS_DEFAULTS)) throw new Error(`Unknown setting ${key}`);
    this.values[key] = value;
    writeAtomic(this.file, JSON.stringify(this.values, null, 2));
  }
}

// ---- Secrets (DPAPI-encrypted on Windows via Electron safeStorage) ---------------------------------

export class SecretStore {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'secrets.json');
    this.safe = safeStorage;
    this.items = readJSON(this.file, {});
  }
  encryptionAvailable() {
    try {
      return !!this.safe?.isEncryptionAvailable();
    } catch {
      return false;
    }
  }
  load(key) {
    const v = this.items[key];
    if (v == null) return null;
    try {
      if (v.startsWith('enc:')) return this.safe.decryptString(Buffer.from(v.slice(4), 'base64'));
      if (v.startsWith('raw:')) return v.slice(4);
    } catch {
      return null;
    }
    return null;
  }
  save(key, value) {
    this.items[key] = this.encryptionAvailable()
      ? 'enc:' + this.safe.encryptString(value).toString('base64')
      : 'raw:' + value;
    writeAtomic(this.file, JSON.stringify(this.items, null, 2));
  }
  delete(key) {
    delete this.items[key];
    writeAtomic(this.file, JSON.stringify(this.items, null, 2));
  }
}

// ---- Event log -----------------------------------------------------------------------------------

export class EventLog {
  static capacity = 2000;
  static maxBytes = 2_000_000;

  constructor(dir) {
    this.dir = path.join(dir, 'Logs');
    this.file = path.join(this.dir, 'events.log');
    this.events = [];
    this.listeners = new Set();
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      if (fs.statSync(this.file).size > EventLog.maxBytes) fs.renameSync(this.file, path.join(this.dir, 'events.1.log'));
    } catch {
      // no file yet
    }
  }

  log(message, level = 'info') {
    const event = { date: Date.now(), level, message: String(message) };
    this.events.push(event);
    if (this.events.length > EventLog.capacity) this.events.splice(0, this.events.length - EventLog.capacity);
    try {
      fs.appendFileSync(this.file, `${new Date(event.date).toISOString()} [${level}] ${event.message}\n`);
    } catch {
      // logging must never break the app
    }
    for (const l of this.listeners) l(event);
    return event;
  }

  onEvent(fn) {
    this.listeners.add(fn);
  }
}

// ---- Rides ---------------------------------------------------------------------------------------

export class RideStore {
  constructor(dir, log) {
    this.ridesDir = path.join(dir, 'Rides');
    this.activeDir = path.join(dir, 'ActiveRide');
    this.root = dir;
    this.log = log;
    this.records = [];
    this.loadErrors = [];
    this.listeners = new Set();
    fs.mkdirSync(this.ridesDir, { recursive: true });
    this.journalFD = null;
    this.packetsFD = null;
    this.linesSinceSync = 0;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  changed() {
    for (const l of this.listeners) l(this.records);
  }

  load() {
    const loaded = [];
    const errors = [];
    for (const name of fs.readdirSync(this.ridesDir)) {
      const folder = path.join(this.ridesDir, name);
      try {
        if (!fs.statSync(folder).isDirectory()) continue;
        loaded.push(JSON.parse(fs.readFileSync(path.join(folder, 'record.json'), 'utf8')));
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }
    this.records = loaded.sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate));
    this.loadErrors = errors;
    this.changed();
  }

  folder(id) {
    return path.join(this.ridesDir, id);
  }

  record(id) {
    return this.records.find((r) => r.id === id) ?? null;
  }

  /** Saves a finished ride. Track first, record last, so a record never points at a missing track. */
  save(record, track, packetCapturePath) {
    const dir = this.folder(record.id);
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, 'track.json'), JSON.stringify(track));
    if (packetCapturePath && fs.existsSync(packetCapturePath)) {
      const dest = path.join(dir, 'packets.jsonl');
      fs.rmSync(dest, { force: true });
      try {
        fs.renameSync(packetCapturePath, dest);
      } catch {
        // capture is optional
      }
    }
    this.writeRecord(record);
    this.records = this.records.filter((r) => r.id !== record.id);
    this.records.push(record);
    this.records.sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate));
    this.changed();
  }

  writeRecord(record) {
    writeAtomic(path.join(this.folder(record.id), 'record.json'), JSON.stringify(record));
  }

  update(record) {
    try {
      this.writeRecord(record);
      const i = this.records.findIndex((r) => r.id === record.id);
      if (i >= 0) this.records[i] = record;
      this.changed();
    } catch (e) {
      this.loadErrors.push(`Could not update ${record.id}: ${e.message}`);
    }
  }

  rename(id, name) {
    const r = this.record(id);
    if (r && name && name !== r.name) this.update({ ...r, name });
  }

  setUpload(id, destination, state) {
    const r = this.record(id);
    if (!r) return;
    this.update({ ...r, uploads: { ...r.uploads, [destination]: state } });
  }

  delete(id) {
    fs.rmSync(this.folder(id), { recursive: true, force: true });
    this.records = this.records.filter((r) => r.id !== id);
    this.changed();
  }

  track(id) {
    return JSON.parse(fs.readFileSync(path.join(this.folder(id), 'track.json'), 'utf8'));
  }

  packetCapturePath(id) {
    const p = path.join(this.folder(id), 'packets.jsonl');
    return fs.existsSync(p) ? p : null;
  }

  exportable(id) {
    const record = this.record(id);
    if (!record) throw new Error('Ride not found');
    return { record, track: this.track(id) };
  }

  // ---- Crash journal of the ride in progress. Every line is a complete JSON object; the file is
  // fsync'd every few lines and at every pause, so at most a few seconds can be lost.

  journalPath() {
    return path.join(this.activeDir, 'journal.jsonl');
  }

  packetsPath() {
    return path.join(this.activeDir, 'packets.jsonl');
  }

  journalOpen(resume) {
    this.journalClose();
    if (!resume) fs.rmSync(this.activeDir, { recursive: true, force: true });
    fs.mkdirSync(this.activeDir, { recursive: true });
    this.journalFD = fs.openSync(this.journalPath(), 'a');
    this.packetsFD = fs.openSync(this.packetsPath(), 'a');
    this.linesSinceSync = 0;
  }

  journalAppend(line, sync) {
    if (this.journalFD == null) return;
    fs.writeSync(this.journalFD, line);
    this.linesSinceSync++;
    if (sync || this.linesSinceSync >= 5) this.journalFlush();
  }

  journalAppendPacket(line) {
    if (this.packetsFD == null) return;
    try {
      fs.writeSync(this.packetsFD, line);
    } catch {
      // capture is optional
    }
  }

  journalFlush() {
    for (const fd of [this.journalFD, this.packetsFD]) {
      if (fd == null) continue;
      try {
        fs.fsyncSync(fd);
      } catch {
        // ignore
      }
    }
    this.linesSinceSync = 0;
  }

  journalClose() {
    this.journalFlush();
    for (const key of ['journalFD', 'packetsFD']) {
      if (this[key] != null) {
        try {
          fs.closeSync(this[key]);
        } catch {
          // ignore
        }
        this[key] = null;
      }
    }
  }

  journalRead() {
    try {
      const text = fs.readFileSync(this.journalPath(), 'utf8');
      return text.length ? text : null;
    } catch {
      return null;
    }
  }

  journalDiscard() {
    this.journalClose();
    fs.rmSync(this.activeDir, { recursive: true, force: true });
  }

  /** Keeps unreadable files for diagnosis but moves them aside so they do not block new rides. */
  journalMoveAside() {
    this.journalClose();
    try {
      fs.renameSync(this.activeDir, path.join(this.root, `UnrecoverableRide-${Math.floor(Date.now() / 1000)}`));
    } catch {
      fs.rmSync(this.activeDir, { recursive: true, force: true });
    }
  }

  /** Saves the ride in progress (or a recovered one) and clears the journal. */
  saveFromJournal(record, track, includePackets) {
    this.journalClose();
    this.save(record, track, includePackets ? this.packetsPath() : null);
    fs.rmSync(this.activeDir, { recursive: true, force: true });
  }
}
