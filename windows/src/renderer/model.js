// Tiny change-notification hub. Screens re-render when anything in the app model changes.

const listeners = new Set();
let scheduled = false;
export let version = 0;

export function changed() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    version++;
    for (const l of listeners) l(version);
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, message = 'Timed out') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

/** In-memory event and packet logs for the diagnostics screens (events are persisted by the main process). */
export class DiagnosticsLog {
  static eventCapacity = 2000;
  static packetCapacity = 5000;

  constructor(api) {
    this.api = api;
    this.events = [];
    this.packets = [];
    this.packetLoggingPaused = false;
    api.log.onEvent((e) => {
      this.events.push(e);
      if (this.events.length > DiagnosticsLog.eventCapacity) this.events.splice(0, this.events.length - DiagnosticsLog.eventCapacity);
      changed();
    });
    api.log.recent().then((events) => {
      this.events = [...events, ...this.events.filter((e) => !events.some((x) => x.date === e.date && x.message === e.message))];
      changed();
    });
  }

  log(message, level = 'info') {
    this.api.log.write(message, level);
  }

  /** {date, direction: rx|tx, characteristic, bytes: number[], plain: number[]|null, summary} */
  record(packet) {
    if (this.packetLoggingPaused) return;
    this.packets.push(packet);
    if (this.packets.length > DiagnosticsLog.packetCapacity) this.packets.splice(0, this.packets.length - DiagnosticsLog.packetCapacity);
  }

  clear() {
    this.events = [];
    this.packets = [];
    changed();
  }
}

/** Reactive copy of the settings held by the main process. */
export class SettingsModel {
  constructor(api, initial) {
    this.api = api;
    this.values = initial;
  }
  get(key) {
    return this.values[key];
  }
  set(key, value) {
    this.values = { ...this.values, [key]: value };
    this.api.settings.set(key, value);
    changed();
  }
  get autoUploadDestinations() {
    const out = [];
    if (this.values.autoUploadGarmin) out.push('garmin');
    if (this.values.autoUploadStrava) out.push('strava');
    return out;
  }
}
