// Connects to a standard Bluetooth heart-rate strap (Polar H9, H10, Garmin HRM-Dual, Wahoo TICKR…).
// Port of HeartRateMonitor.swift: remember the strap and keep reconnecting so it comes back as soon as it is
// worn again.
import { HeartRateGATT, InRideGATT, shortUUID } from '../../core/gatt.js';
import { parseHeartRate } from '../../core/sensors.js';
import { changed, sleep, withTimeout } from '../model.js';

const bytesOf = (dv) => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
const textOf = (bytes) => new TextDecoder().decode(new Uint8Array(bytes)).replace(/[\x00-\x1f]+/g, '').trim() || null;

export class HeartRateMonitor {
  constructor({ settings, log, bluetooth }) {
    this.settings = settings;
    this.log = log;
    this.bluetooth = bluetooth;
    this.state = { kind: 'idle' };
    this.bpm = null;
    this.lastAt = null;
    this.sensorContact = null;
    this.lastRRIntervals = [];
    this.battery = null;
    this.rssi = null;
    this.packets = 0;
    this.connects = 0;
    this.disconnects = 0;
    this.lastPacket = null;
    this.deviceName = null;
    this.deviceID = null;
    this.manufacturer = null;
    this.firmware = null;
    /** (bpm, dateMs) for every fresh reading. */
    this.onHeartRate = null;
    this.device = null;
    this.wantsConnection = false;
    this.connectLoopRunning = false;
    this.queue = Promise.resolve();
  }

  setState(s) {
    this.state = s;
    changed();
  }

  get isConnected() {
    return this.state.kind === 'connected';
  }

  /** Latest heart rate if it is recent and the strap reports skin contact. */
  freshHeartRate(now = Date.now()) {
    if (!(this.bpm > 0) || this.lastAt == null || now - this.lastAt >= 3000 || this.sensorContact === false) return null;
    return this.bpm;
  }

  statusLine(now = Date.now()) {
    const s = this.state;
    switch (s.kind) {
      case 'connected': {
        const hr = this.freshHeartRate(now);
        if (hr != null) return `${s.name} · ${hr} bpm`;
        if (this.sensorContact === false) return `${s.name} · no skin contact — moisten the strap`;
        return `${s.name} · connected, waiting for data`;
      }
      case 'waiting': return `Waiting for ${s.name} — put the strap on`;
      case 'connecting': return `Connecting to ${s.name}…`;
      case 'scanning': return 'Searching for heart-rate monitors…';
      case 'unavailable': return s.message;
      default: return 'No heart-rate monitor';
    }
  }

  connectTo(result) {
    if (this.settings.get('hrmID')) this.bluetooth.unwant(this.settings.get('hrmID'));
    this.dropDevice();
    this.settings.set('hrmID', result.chooserId);
    this.settings.set('hrmName', result.name);
    this.wantsConnection = true;
    this.attach(result.device, result.chooserId, result.name);
    this.connectLoop();
  }

  disconnect(forget) {
    this.wantsConnection = false;
    if (this.deviceID) this.bluetooth.unwant(this.deviceID);
    try {
      this.device?.gatt?.disconnect();
    } catch {
      // ignore
    }
    if (forget) {
      this.settings.set('hrmID', null);
      this.settings.set('hrmName', null);
      this.dropDevice();
      this.deviceName = null;
      this.deviceID = null;
    }
    this.clear();
    this.setState({ kind: 'idle' });
    this.log.log(forget ? 'Forgot heart-rate monitor' : 'Disconnected heart-rate monitor');
  }

  reconnectRemembered() {
    const id = this.settings.get('hrmID');
    if (!id || this.isConnected) return;
    this.wantsConnection = true;
    this.deviceID = id;
    this.deviceName = this.settings.get('hrmName') || 'Heart-rate monitor';
    if (this.device) {
      this.connectLoop();
      return;
    }
    this.setState({ kind: 'waiting', name: this.deviceName });
    this.bluetooth.want(id, (r) => this.found(r));
  }

  found(result) {
    if (!this.wantsConnection || result.chooserId !== this.settings.get('hrmID') || this.device?.gatt?.connected) return;
    this.dropDevice();
    this.attach(result.device, result.chooserId, result.name);
    this.connectLoop();
  }

  op(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  attach(device, id, name) {
    this.device = device;
    this.deviceID = id;
    this.deviceName = name || this.settings.get('hrmName') || 'Heart-rate monitor';
    this.onDisconnected = () => this.handleDisconnect(device);
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
  }

  dropDevice() {
    if (!this.device) return;
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      this.device.gatt?.disconnect();
    } catch {
      // ignore
    }
    this.device = null;
  }

  async connectLoop() {
    if (this.connectLoopRunning) return;
    this.connectLoopRunning = true;
    let failures = 0;
    try {
      while (this.wantsConnection && this.device && !this.device.gatt.connected) {
        const device = this.device;
        this.setState({ kind: failures === 0 ? 'connecting' : 'waiting', name: this.deviceName });
        try {
          await withTimeout(device.gatt.connect(), 20000, 'Connection attempt timed out');
          if (device !== this.device) continue;
          await this.setup(device);
          return;
        } catch (e) {
          failures++;
          if (failures === 1 || failures % 20 === 0) this.log.log(`Heart-rate monitor failed to connect: ${e.message}`, 'warning');
          try {
            device.gatt.disconnect();
          } catch {
            // ignore
          }
          if (failures === 6 && this.deviceID) this.bluetooth.want(this.deviceID, (r) => this.found(r));
          await sleep(Math.min(1500 * failures, 5000));
        }
      }
    } finally {
      this.connectLoopRunning = false;
    }
  }

  async setup(device) {
    this.connects++;
    this.log.log(`Heart-rate monitor connected: ${this.deviceName}`);
    if (this.deviceID) this.bluetooth.unwant(this.deviceID);
    const server = device.gatt;
    const service = await this.op(() => server.getPrimaryService(0x180d));
    const measurement = await this.op(() => service.getCharacteristic(0x2a37));
    if (!measurement.__spindownListener) {
      measurement.__spindownListener = (e) => this.handleMeasurement(bytesOf(e.target.value));
      measurement.addEventListener('characteristicvaluechanged', measurement.__spindownListener);
    }
    await this.op(() => measurement.startNotifications());
    if (device !== this.device) return;
    this.setState({ kind: 'connected', name: this.deviceName });
    this.log.log(`Receiving heart rate from ${this.deviceName}`);

    // Optional extras: battery, manufacturer, firmware.
    try {
      const battery = await this.op(() => server.getPrimaryService(0x180f));
      const level = await this.op(() => battery.getCharacteristic(0x2a19));
      this.battery = bytesOf(await this.op(() => level.readValue()))[0] ?? null;
      if (level.properties.notify) {
        level.addEventListener('characteristicvaluechanged', (e) => {
          this.battery = bytesOf(e.target.value)[0] ?? null;
          changed();
        });
        await this.op(() => level.startNotifications());
      }
    } catch {
      // not every strap has a battery service
    }
    try {
      const dis = await this.op(() => server.getPrimaryService(0x180a));
      for (const c of await this.op(() => dis.getCharacteristics())) {
        const id = shortUUID(c.uuid);
        if (id !== InRideGATT.manufacturerName && id !== InRideGATT.firmwareRevision) continue;
        const text = textOf(bytesOf(await this.op(() => c.readValue())));
        if (id === InRideGATT.manufacturerName) this.manufacturer = text;
        else this.firmware = text;
      }
    } catch {
      // optional
    }
    changed();
  }

  handleDisconnect(device) {
    if (device !== this.device) return;
    this.disconnects++;
    this.clear();
    this.log.log(`Heart-rate monitor disconnected`, this.wantsConnection ? 'warning' : 'info');
    if (!this.wantsConnection) {
      this.setState({ kind: 'idle' });
      return;
    }
    this.setState({ kind: 'waiting', name: this.deviceName });
    this.connectLoop();
  }

  handleMeasurement(bytes) {
    const now = Date.now();
    this.lastPacket = bytes;
    this.packets++;
    this.log.record({ date: now, direction: 'rx', characteristic: HeartRateGATT.measurement, bytes, plain: null, summary: 'heart rate' });
    let m;
    try {
      m = parseHeartRate(bytes);
    } catch {
      return;
    }
    this.bpm = m.bpm;
    this.lastAt = now;
    this.sensorContact = m.sensorContact;
    if (m.rrIntervals.length) this.lastRRIntervals = m.rrIntervals;
    const hr = this.freshHeartRate(now);
    if (hr != null) this.onHeartRate?.(hr, now);
    changed();
  }

  clear() {
    this.bpm = null;
    this.lastAt = null;
    this.sensorContact = null;
    this.lastRRIntervals = [];
    changed();
  }
}
