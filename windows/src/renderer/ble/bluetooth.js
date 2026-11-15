// Web Bluetooth device discovery for the whole app. Chromium allows one device chooser at a time; the main
// process answers it with whichever device this module selects.
//
// - Background "finder": while the trainer or strap remembered from last time has no device object yet (app
//   just opened, or the sensor was asleep), a chooser runs and auto-selects it the moment it advertises.
// - Foreground "picker": the Sensors screen lists what is found and the rider chooses.
// A chooser's scan ends after about a minute, so both restart every 45 s while still needed.
import { InRideGATT, HeartRateGATT, webUUID } from '../../core/gatt.js';
import { changed, sleep } from '../model.js';

const POWER = webUUID(InRideGATT.powerService);
export const OPTIONAL_SERVICES = [POWER, 0x180a, 0x180f, 0x180d, 0x1800, 0x1801, 0xfe59];
const TRAINER_FILTERS = [{ services: [POWER] }, { namePrefix: 'inRide' }, { namePrefix: 'InRide' }, { namePrefix: 'INRIDE' }];
const HR_FILTERS = [{ services: [webUUID(HeartRateGATT.service)] }];
const RESTART_MS = 45000;

function optionsFor(kind) {
  switch (kind) {
    case 'trainer': return { filters: TRAINER_FILTERS, optionalServices: OPTIONAL_SERVICES };
    case 'hr': return { filters: HR_FILTERS, optionalServices: OPTIONAL_SERVICES };
    case 'all': return { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES };
    default: return { filters: [...TRAINER_FILTERS, ...HR_FILTERS], optionalServices: OPTIONAL_SERVICES };
  }
}

export function friendlyBluetoothError(message) {
  const m = String(message || '');
  if (/adapter not available|adapter is not available|no bluetooth adapter|bluetooth adapter/i.test(m)) {
    return 'Bluetooth is off, or this computer has no Bluetooth. Turn it on in Windows Settings › Bluetooth & devices.';
  }
  if (/globally disabled|not supported|unsupported/i.test(m)) return 'Bluetooth is not available on this computer.';
  return null;
}

export class Bluetooth {
  constructor(api, log) {
    this.api = api;
    this.log = log;
    this.seq = 0;
    this.current = null; // the live chooser request
    this.wants = new Map(); // chooser device id -> deliver(result)
    this.picker = null; // {kind, devices: Map, onPick, choice}
    this.looping = false;
    this.unavailable = null; // message when the adapter is missing or off
    window.__spindownBleStart = (token) => this.startRequest(token);
    api.ble.onDevices((list) => this.onDevices(list));
    navigator.bluetooth?.addEventListener?.('availabilitychanged', (e) => {
      this.log.log(`Bluetooth ${e.value ? 'available' : 'unavailable'}`);
      if (e.value) {
        this.unavailable = null;
        this.pump();
      }
      changed();
    });
  }

  get isPicking() {
    return !!this.picker;
  }

  // ---- Background finder ---------------------------------------------------------------------------

  want(id, deliver) {
    this.wants.set(id, deliver);
    this.pump();
  }

  unwant(id) {
    this.wants.delete(id);
    if (!this.wants.size && this.current?.purpose === 'find') this.settle(this.current, { ok: false, error: 'not needed' });
  }

  // ---- Foreground picker ---------------------------------------------------------------------------

  /** Starts listing devices of `kind` ('trainer' | 'hr' | 'all'). onPick(result) runs when one is chosen. */
  startPicker(kind, onPick) {
    this.stopPicker();
    this.picker = { kind, devices: new Map(), onPick, choice: null, startedAt: Date.now() };
    if (this.current) this.settle(this.current, { ok: false, error: 'preempted' });
    this.pump();
    changed();
  }

  stopPicker() {
    if (!this.picker) return;
    this.picker = null;
    if (this.current?.purpose === 'pick') this.cancelCurrent();
    changed();
    this.pump();
  }

  /** The rider chose a device in the list. */
  choose(id) {
    if (!this.picker) return;
    this.picker.choice = id;
    const req = this.current;
    if (req?.purpose === 'pick' && !req.settled && req.lastIds?.has(id)) {
      req.selectedId = id;
      this.api.ble.select(id);
    }
    changed();
  }

  get pickerDevices() {
    if (!this.picker) return [];
    return [...this.picker.devices.values()].sort((a, b) => b.lastSeen - a.lastSeen || a.name.localeCompare(b.name));
  }

  // ---- Chooser plumbing ----------------------------------------------------------------------------

  pump() {
    if (!this.looping) this.loop();
  }

  async loop() {
    this.looping = true;
    try {
      for (;;) {
        if (this.picker) {
          await this.runPick();
        } else if (this.wants.size) {
          await this.runFind();
        } else {
          break;
        }
      }
    } catch (e) {
      this.log.log(`Bluetooth search stopped: ${e.message}`, 'error');
    } finally {
      this.looping = false;
    }
  }

  async runFind() {
    const wanted = new Set(this.wants.keys());
    const result = await this.request('find', optionsFor('remembered'), wanted);
    if (result.ok) {
      const deliver = this.wants.get(result.chooserId);
      this.wants.delete(result.chooserId);
      deliver?.(result);
      return;
    }
    await this.afterFailure(result);
  }

  async runPick() {
    const picker = this.picker;
    const wanted = picker.choice ? new Set([picker.choice]) : null;
    const result = await this.request('pick', optionsFor(picker.kind), wanted);
    if (this.picker !== picker) return; // stopped or replaced
    if (result.ok) {
      this.picker = null;
      changed();
      picker.onPick?.(result);
      return;
    }
    await this.afterFailure(result);
  }

  async afterFailure(result) {
    const friendly = friendlyBluetoothError(result.error);
    if (friendly) {
      if (this.unavailable !== friendly) this.log.log(`Bluetooth unavailable: ${result.error}`, 'warning');
      this.unavailable = friendly;
      changed();
      await sleep(5000);
    } else if (!['restart', 'preempted', 'not needed', 'cancelled'].includes(result.error)) {
      if (!/cancelled|User cancelled/i.test(result.error || '')) this.log.log(`Bluetooth search: ${result.error}`, 'warning');
      await sleep(1500);
    }
  }

  /** One chooser run. Resolves {ok, device, chooserId, name} or {ok: false, error}. */
  request(purpose, options, wanted) {
    return new Promise((resolve) => {
      const req = { token: ++this.seq, purpose, options, wanted, resolve, settled: false, selectedId: null, lastIds: new Set() };
      if (this.current && !this.current.settled) this.settle(this.current, { ok: false, error: 'superseded' });
      this.current = req;
      this.scheduleRestart(req);
      this.api.ble.start(req.token).catch((e) => this.settle(req, { ok: false, error: e.message }));
    });
  }

  /**
   * Chromium stops scanning about a minute after the last new device turns up, so a chooser that has listed
   * devices is restarted to keep looking. One that has found nothing keeps rescanning by itself.
   */
  scheduleRestart(req) {
    req.timer = setTimeout(() => {
      if (req.settled) return;
      if (req.lastIds.size === 0) this.scheduleRestart(req);
      else this.cancelCurrent('restart');
    }, RESTART_MS);
  }

  /** Called by the main process (with a user gesture) to open the chooser for request `token`. */
  startRequest(token) {
    const req = this.current;
    if (!req || req.token !== token || req.settled) return;
    if (!navigator.bluetooth) {
      this.settle(req, { ok: false, error: 'Bluetooth adapter not available' });
      return;
    }
    navigator.bluetooth
      .requestDevice(req.options)
      .then((device) => {
        const chooserId = req.selectedId;
        const known = this.picker?.devices.get(chooserId);
        this.settle(req, { ok: true, device, chooserId, name: device.name || known?.name || 'Bluetooth device' });
      })
      .catch((e) => this.settle(req, { ok: false, error: e?.message || String(e) }));
  }

  onDevices(list) {
    const req = this.current;
    if (!req || req.settled) {
      this.api.ble.select(''); // a chooser nobody is waiting for: close it
      return;
    }
    req.lastIds = new Set(list.map((d) => d.id));
    if (this.unavailable) {
      this.unavailable = null;
      changed();
    }
    if (req.purpose === 'pick' && this.picker) {
      const now = Date.now();
      for (const d of list) {
        const prev = this.picker.devices.get(d.id);
        this.picker.devices.set(d.id, { id: d.id, name: d.name || prev?.name || 'Unnamed device', lastSeen: now });
      }
      changed();
      const choice = this.picker.choice;
      if (choice && req.lastIds.has(choice)) {
        req.selectedId = choice;
        this.api.ble.select(choice);
        return;
      }
    }
    if (req.wanted) {
      const hit = list.find((d) => req.wanted.has(d.id));
      if (hit) {
        req.selectedId = hit.id;
        this.api.ble.select(hit.id);
      }
    }
  }

  cancelCurrent(reason = 'cancelled') {
    const req = this.current;
    if (!req || req.settled) return;
    this.api.ble.select('');
    this.settle(req, { ok: false, error: reason });
  }

  settle(req, result) {
    if (req.settled) return;
    req.settled = true;
    clearTimeout(req.timer);
    if (this.current === req) this.current = null;
    req.resolve(result);
  }
}
