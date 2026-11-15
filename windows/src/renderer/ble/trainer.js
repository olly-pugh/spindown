// The connection to one inRide sensor over Web Bluetooth. Port of TrainerManager.swift.
//
// Reliability rules (as on the iPhone):
// - Once the rider has chosen a trainer we keep trying to connect whenever we are not connected, so the app
//   reconnects as soon as the sensor wakes (the inRide sleeps when the roller stops and wakes when it turns).
// - If the device object goes stale, the background finder looks for the trainer's advertisements again.
// - A watchdog re-subscribes, then drops the link, if the sensor goes silent while connected.
// - GATT operations are queued one at a time; Windows rejects overlapping ones.
import { InRideGATT, gattName, shortUUID } from '../../core/gatt.js';
import { decodePower, parseConfiguration, CommandResult, commandResultName, calibrationResultName, sensorStateName } from '../../core/decoder.js';
import { deobfuscate } from '../../core/obfuscation.js';
import { Command, commandBytes, describeCommand, rateLabel, ticksForKPH, UpdateRate } from '../../core/commands.js';
import { CadenceSmoother, InRideSimulator } from '../../core/sensors.js';
import { hex } from '../../core/bytes.js';
import { changed, sleep, withTimeout } from '../model.js';
import { friendlyBluetoothError } from './bluetooth.js';

const POWER = InRideGATT.powerCharacteristic;
const CONFIG = InRideGATT.configCharacteristic;
const CONTROL = InRideGATT.controlPointCharacteristic;

export function linkTitle(state) {
  switch (state.kind) {
    case 'unavailable': return state.message;
    case 'idle': return 'No trainer connected';
    case 'scanning': return 'Searching for trainers…';
    case 'waiting': return `Waiting for ${state.name} — spin the pedals to wake it`;
    case 'connecting': return `Connecting to ${state.name}…`;
    case 'discovering': return `Setting up ${state.name}…`;
    case 'streaming': return state.name;
    case 'reconnecting': return `Reconnecting to ${state.name}…`;
    case 'simulated': return 'Simulated trainer';
    default: return '';
  }
}

export function linkColor(state) {
  switch (state.kind) {
    case 'streaming':
    case 'simulated':
      return 'green';
    case 'unavailable':
      return 'red';
    case 'idle':
      return 'gray';
    default:
      return 'orange';
  }
}

export const isConnected = (s) => ['discovering', 'streaming', 'simulated'].includes(s.kind);
export const isStreaming = (s) => s.kind === 'streaming' || s.kind === 'simulated';

export function firmwareIsOutdated(fw) {
  if (!fw) return false;
  const a = fw.split('.').map((x) => parseInt(x, 10) || 0);
  const b = InRideGATT.latestPublishedFirmware.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

const bytesOf = (dataView) => Array.from(new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength));
const textOf = (bytes) => new TextDecoder().decode(new Uint8Array(bytes)).replace(/[\x00-\x1f\s]+$/g, '').replace(/^\s+/, '') || null;

export class TrainerManager {
  constructor({ settings, log, bluetooth }) {
    this.settings = settings;
    this.log = log;
    this.bluetooth = bluetooth;

    this.state = { kind: 'idle' };
    this.latest = null;
    this.latestAt = null;
    this.latestPacket = null;
    this.smoothedCadence = 0;
    this.configuration = null;
    this.info = {};
    this.rssi = null; // not available through Web Bluetooth
    this.stats = this.freshStats();
    this.gatt = [];
    this.peripheralName = null;
    this.peripheralID = null;

    /** Called for every decoded power packet: (measurement, dateMs). */
    this.onMeasurement = null;
    /** Called for every packet received or sent, for raw ride captures. */
    this.onPacket = null;
    /** Extra per-measurement listeners (the calibration screen). */
    this.measurementListeners = new Set();

    this.device = null;
    this.chars = new Map();
    this.notifying = new Set();
    this.values = new Map();
    this.wantsConnection = false;
    this.connectLoopRunning = false;
    this.cadenceSmoother = new CadenceSmoother();
    this.lastPacketAt = null;
    this.simulatorTimer = null;
    this.pendingUpdateRateCheck = true;
    this.rateBeforeCalibration = null;
    this.queue = Promise.resolve();
    this.startWatchdog();
  }

  freshStats() {
    return { packets: 0, decodeErrors: 0, connects: 0, disconnects: 0, watchdogResubscribes: 0, watchdogDrops: 0, connectedSince: null, lastDisconnect: null, measuredHz: 0 };
  }

  setState(s) {
    this.state = s;
    changed();
  }

  // ---- Public API ----------------------------------------------------------------------------------

  /** Fresh enough to record? Allows for 1 Hz updates plus one dropped packet. */
  freshReading(now = Date.now()) {
    if (!this.latest || this.latestAt == null || now - this.latestAt >= 2500) return null;
    return { power: this.latest.power, speedKPH: this.latest.speedKPH, cadenceRPM: this.smoothedCadence };
  }

  get trainerInfo() {
    const i = this.info;
    const info = {
      name: this.peripheralName, identifier: this.peripheralID, manufacturer: i.manufacturer, model: i.model,
      firmware: i.firmware, hardware: i.hardware, systemID: i.systemID ? hex(i.systemID, '') : null,
      spindownTime: this.latest?.spindownTime ?? this.configuration?.currentSpindownTime ?? null,
      proFlywheel: this.latest?.proFlywheel ?? this.configuration?.proFlywheel ?? null,
    };
    for (const k of Object.keys(info)) if (info[k] == null) delete info[k];
    return info;
  }

  get hasRememberedTrainer() {
    return !!this.settings.get('trainerID');
  }

  /** The rider picked a trainer in the Sensors screen. */
  connectTo(result) {
    this.stopSimulator();
    if (this.settings.get('trainerID')) this.bluetooth.unwant(this.settings.get('trainerID'));
    this.dropDevice();
    this.settings.set('trainerID', result.chooserId);
    this.settings.set('trainerName', result.name);
    if (this.settings.get('simulator')) this.settings.set('simulator', false);
    this.wantsConnection = true;
    this.attach(result.device, result.chooserId, result.name);
    this.setState({ kind: 'connecting', name: this.peripheralName });
    this.connectLoop(true);
  }

  /** Disconnects. `forget` also stops automatic reconnection on future launches. */
  disconnect(forget) {
    this.wantsConnection = false;
    this.stopSimulator();
    if (this.peripheralID) this.bluetooth.unwant(this.peripheralID);
    try {
      this.device?.gatt?.disconnect();
    } catch {
      // ignore
    }
    if (forget) {
      if (this.settings.get('trainerID')) this.bluetooth.unwant(this.settings.get('trainerID'));
      this.settings.set('trainerID', null);
      this.settings.set('trainerName', null);
      this.dropDevice();
      this.peripheralName = null;
      this.peripheralID = null;
      this.gatt = [];
      this.info = {};
      this.configuration = null;
    }
    this.clearLiveData();
    this.setState({ kind: 'idle' });
    this.log.log(forget ? 'Disconnected and forgot trainer' : 'Disconnected by user');
  }

  /** Re-establishes the connection to the remembered trainer (app launch, or after Bluetooth returns). */
  reconnectRemembered() {
    const id = this.settings.get('trainerID');
    if (!this.settings.get('autoConnect') || this.settings.get('simulator') || !id || isConnected(this.state)) return;
    this.wantsConnection = true;
    this.peripheralID = id;
    this.peripheralName = this.settings.get('trainerName') || 'inRide';
    if (this.device) {
      this.connectLoop(false);
      return;
    }
    this.setState({ kind: 'waiting', name: this.peripheralName });
    this.log.log(`Looking for ${this.peripheralName}`);
    this.bluetooth.want(id, (result) => this.found(result));
  }

  /** The background finder saw the remembered trainer advertising. */
  found(result) {
    if (!this.wantsConnection || result.chooserId !== this.settings.get('trainerID')) return;
    if (this.device?.gatt?.connected) return;
    this.log.log(`Found ${result.name}`);
    this.dropDevice();
    this.attach(result.device, result.chooserId, result.name);
    this.connectLoop(true);
  }

  async send(command) {
    if (!this.info.systemID) throw new Error('System ID not read yet: the trainer is not fully connected.');
    const bytes = commandBytes(command, this.info.systemID);
    await this.write(bytes, CONTROL, true, describeCommand(command));
  }

  async write(bytes, characteristic, withResponse, label = 'write') {
    if (this.state.kind === 'simulated') {
      this.recordTx(bytes, characteristic, label);
      return;
    }
    const c = this.chars.get(characteristic.toUpperCase());
    if (!c) throw new Error('Characteristic not available');
    this.recordTx(bytes, characteristic, label);
    const name = gattName(characteristic) ?? characteristic;
    this.log.log(`Wrote ${bytes.length} bytes to ${name}${label ? ` (${label})` : ''}`);
    try {
      await this.op(() => (withResponse ? c.writeValueWithResponse(new Uint8Array(bytes)) : c.writeValueWithoutResponse(new Uint8Array(bytes))));
      this.log.log(`Write to ${name} acknowledged`);
    } catch (e) {
      this.log.log(`Write to ${name} failed: ${e.message}`, 'error');
      throw e;
    }
  }

  recordTx(bytes, characteristic, label) {
    const packet = { date: Date.now(), direction: 'tx', characteristic, bytes, plain: null, summary: label };
    this.log.record(packet);
    this.onPacket?.(packet);
  }

  async read(characteristic) {
    const c = this.chars.get(characteristic.toUpperCase());
    if (!c) return;
    try {
      const v = await this.op(() => c.readValue());
      this.handleValue(characteristic.toUpperCase(), bytesOf(v));
    } catch (e) {
      this.log.log(`Read of ${gattName(characteristic) ?? characteristic} failed: ${e.message}`, 'error');
    }
  }

  async setNotify(on, characteristic) {
    const c = this.chars.get(characteristic.toUpperCase());
    if (!c) return;
    const name = gattName(characteristic) ?? characteristic;
    try {
      await this.op(() => (on ? c.startNotifications() : c.stopNotifications()));
      if (on) this.notifying.add(characteristic.toUpperCase());
      else this.notifying.delete(characteristic.toUpperCase());
      this.log.log(`${on ? 'Subscribed to' : 'Unsubscribed from'} ${name}`);
      this.rebuildGATTSnapshot();
    } catch (e) {
      this.log.log(`Subscribe to ${name} failed: ${e.message}`, 'error');
    }
  }

  // ---- Simulator -----------------------------------------------------------------------------------

  startSimulator() {
    this.disconnect(false);
    this.state = { kind: 'simulated' };
    this.peripheralName = 'Simulated inRide';
    this.info = { manufacturer: 'Kinetic', model: 'inRide (simulated)', firmware: InRideGATT.latestPublishedFirmware, systemID: [0x10, 0x21, 0x32, 0x43, 0x54, 0x65], battery: 88 };
    this.configuration = parseConfiguration(InRideSimulator.configurationBytes());
    this.stats.connectedSince = Date.now();
    this.log.log('Simulator started');
    const sim = new InRideSimulator();
    let t = 0;
    this.simulatorTimer = setInterval(() => {
      t += 1;
      // A gentle interval session: 5 minutes steady, 1 minute hard, with a short coast.
      const phase = t % 360;
      const speed = phase < 300 ? 30 + 2 * Math.sin(t / 20) : phase < 350 ? 38 : 20;
      const cadence = phase >= 350 ? 0 : 88 + 4 * Math.sin(t / 7);
      this.handlePowerPacket(sim.nextPacket(speed, cadence), POWER);
    }, 1000);
    changed();
  }

  stopSimulator() {
    if (!this.simulatorTimer) return;
    clearInterval(this.simulatorTimer);
    this.simulatorTimer = null;
    if (this.state.kind === 'simulated') this.state = { kind: 'idle' };
    this.clearLiveData();
    this.log.log('Simulator stopped');
    changed();
  }

  // ---- Calibration support -------------------------------------------------------------------------

  /** 4 packets a second (so a coast can be told from pedalling quickly) and a lower arming speed. */
  async enterCalibrationMode(armingSpeed) {
    if (this.rateBeforeCalibration == null) {
      const current = this.configuration?.updateRateDefault;
      this.rateBeforeCalibration = [0x20, 0x10, 0x08].includes(current) ? current : UpdateRate.hz1;
    }
    const ticks = ticksForKPH(armingSpeed);
    try {
      await this.send(Command.configureCalibration(UpdateRate.hz4, ticks));
      this.log.log(`Calibration: 4 Hz, arming at ${armingSpeed.toFixed(1)} km/h (${ticks} ticks)`);
    } catch (e) {
      this.log.log(`Calibration: could not configure sensor: ${e.message}`, 'warning');
    }
  }

  /** Restores Kinetic's standard thresholds and the previous update rate. */
  async exitCalibrationMode() {
    const previous = this.rateBeforeCalibration;
    if (previous == null) return;
    this.rateBeforeCalibration = null;
    try {
      await this.send(Command.configure(this.settings.get('updateRate') || previous));
      this.log.log('Calibration: standard sensor settings restored');
    } catch (e) {
      this.log.log(`Calibration: could not restore update rate: ${e.message}`, 'warning');
    }
  }

  applyUpdateRateNow() {
    this.pendingUpdateRateCheck = true;
    this.applyPreferredUpdateRateIfNeeded();
  }

  // ---- Connection internals ------------------------------------------------------------------------

  op(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  attach(device, id, name) {
    this.device = device;
    this.peripheralID = id;
    this.peripheralName = name || this.settings.get('trainerName') || 'inRide';
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
    this.chars = new Map();
    this.notifying = new Set();
  }

  /** Keeps trying to connect while the rider wants a connection. */
  async connectLoop(initial) {
    if (this.connectLoopRunning) return;
    this.connectLoopRunning = true;
    let failures = 0;
    try {
      while (this.wantsConnection && this.device && !this.device.gatt.connected) {
        const device = this.device;
        const name = this.peripheralName || 'inRide';
        if (failures === 0) this.setState({ kind: initial ? 'connecting' : 'reconnecting', name });
        else if (failures === 2) this.setState({ kind: 'waiting', name });
        try {
          await withTimeout(device.gatt.connect(), 20000, 'Connection attempt timed out');
          if (device !== this.device) continue;
          await this.setup(device);
          return;
        } catch (e) {
          failures++;
          const friendly = friendlyBluetoothError(e.message);
          if (friendly) {
            this.setState({ kind: 'unavailable', message: friendly });
          }
          if (failures === 1 || failures % 20 === 0) this.log.log(`Connect attempt ${failures} failed: ${e.message}`, failures === 1 ? 'info' : 'warning');
          try {
            device.gatt.disconnect();
          } catch {
            // ignore
          }
          // After a minute of failures, also look for fresh advertisements (Windows can hold a stale handle).
          if (failures === 6 && this.peripheralID) this.bluetooth.want(this.peripheralID, (r) => this.found(r));
          await sleep(Math.min(1500 * failures, 5000));
        }
      }
    } finally {
      this.connectLoopRunning = false;
    }
  }

  async setup(device) {
    const name = this.peripheralName || 'inRide';
    this.stats.connects++;
    this.stats.connectedSince = Date.now();
    this.pendingUpdateRateCheck = true;
    this.chars = new Map();
    this.notifying = new Set();
    this.setState({ kind: 'discovering', name });
    this.log.log(`Connected to ${name}; discovering services`);
    if (this.peripheralID) this.bluetooth.unwant(this.peripheralID);

    const services = await this.op(() => device.gatt.getPrimaryServices());
    this.serviceList = [];
    for (const s of services) {
      let chars = [];
      try {
        chars = await this.op(() => s.getCharacteristics());
      } catch (e) {
        this.log.log(`Characteristic discovery failed for ${shortUUID(s.uuid)}: ${e.message}`, 'error');
      }
      this.serviceList.push({ uuid: shortUUID(s.uuid), chars });
      for (const c of chars) this.chars.set(shortUUID(c.uuid), c);
    }
    this.log.log(`Services: ${this.serviceList.map((s) => gattName(s.uuid) ?? s.uuid).join(', ')}`);
    if (!this.serviceList.some((s) => s.uuid === InRideGATT.powerService)) this.log.log('inRide Power Service not found on this device', 'error');
    this.rebuildGATTSnapshot();

    // System ID and device information first: the command key needs the System ID.
    for (const s of this.serviceList) {
      if (s.uuid !== InRideGATT.deviceInformationService) continue;
      for (const c of s.chars) {
        const id = shortUUID(c.uuid);
        if (c.properties.read && id !== InRideGATT.serialNumber) await this.read(id);
      }
    }
    if (this.chars.has(InRideGATT.batteryLevel)) {
      await this.read(InRideGATT.batteryLevel);
      if (this.chars.get(InRideGATT.batteryLevel).properties.notify) await this.subscribe(InRideGATT.batteryLevel);
    }
    if (this.chars.has(CONFIG)) {
      await this.read(CONFIG);
      if (this.chars.get(CONFIG).properties.notify) await this.subscribe(CONFIG);
    }
    if (!this.chars.has(POWER)) throw new Error('inRide Power characteristic not found');
    await this.subscribe(POWER);
    if (device !== this.device) return;
    this.setState({ kind: 'streaming', name });
  }

  async subscribe(id) {
    const c = this.chars.get(id);
    if (!c.__spindownListener) {
      c.__spindownListener = (e) => this.handleValue(id, bytesOf(e.target.value));
      c.addEventListener('characteristicvaluechanged', c.__spindownListener);
    }
    await this.setNotify(true, id);
  }

  handleDisconnect(device) {
    if (device !== this.device) return;
    this.stats.disconnects++;
    this.stats.lastDisconnect = this.wantsConnection ? 'Link lost' : 'Clean disconnect';
    this.stats.connectedSince = null;
    this.lastPacketAt = null;
    this.clearLiveData();
    this.notifying = new Set();
    this.rebuildGATTSnapshot();
    this.log.log(`Disconnected: ${this.stats.lastDisconnect}`, this.wantsConnection ? 'warning' : 'info');
    if (!this.wantsConnection) {
      this.setState({ kind: 'idle' });
      return;
    }
    this.setState({ kind: 'reconnecting', name: this.peripheralName || 'inRide' });
    this.connectLoop(false);
  }

  clearLiveData() {
    this.latest = null;
    this.latestAt = null;
    this.smoothedCadence = 0;
    this.cadenceSmoother.reset();
    this.stats.measuredHz = 0;
    changed();
  }

  handleValue(id, bytes) {
    this.values.set(id, bytes);
    if (id === POWER) {
      this.handlePowerPacket(bytes, POWER);
      return;
    }
    const packet = { date: Date.now(), direction: 'rx', characteristic: id, bytes, plain: null, summary: gattName(id) ?? 'value' };
    this.log.record(packet);
    this.onPacket?.(packet);
    const text = textOf(bytes);
    switch (id) {
      case CONFIG:
        this.handleConfiguration(bytes);
        break;
      case InRideGATT.manufacturerName: this.info.manufacturer = text; break;
      case InRideGATT.modelNumber: this.info.model = text; break;
      case InRideGATT.serialNumber: this.info.serial = text; break;
      case InRideGATT.firmwareRevision:
        this.info.firmware = text;
        if (firmwareIsOutdated(text)) this.log.log(`Firmware ${text} is older than Kinetic's last release (${InRideGATT.latestPublishedFirmware})`, 'warning');
        break;
      case InRideGATT.hardwareRevision: this.info.hardware = text; break;
      case InRideGATT.softwareRevision: this.info.software = text; break;
      case InRideGATT.systemID:
        this.info.systemID = bytes;
        this.log.log(`System ID ${hex(bytes)}`);
        this.applyPreferredUpdateRateIfNeeded();
        break;
      case InRideGATT.batteryLevel: this.info.battery = bytes[0] ?? null; break;
      default: break;
    }
    this.rebuildGATTSnapshot();
    changed();
  }

  handlePowerPacket(bytes, uuid) {
    const now = Date.now();
    try {
      const m = decodePower(bytes);
      if (this.lastPacketAt != null) {
        const dt = (now - this.lastPacketAt) / 1000;
        if (dt > 0.05 && dt < 10) {
          const hz = 1 / dt;
          this.stats.measuredHz = this.stats.measuredHz === 0 ? hz : this.stats.measuredHz * 0.8 + hz * 0.2;
        }
      }
      this.lastPacketAt = now;
      this.stats.packets++;
      this.smoothedCadence = this.cadenceSmoother.add(m.cadenceRPM, now / 1000);
      this.latest = m;
      this.latestAt = now;
      this.latestPacket = bytes;
      if (m.commandResult !== CommandResult.none) {
        const extra = m.commandResult === CommandResult.calibrationResult
          ? ` — ${calibrationResultName(m.calibrationResult)}, spindown ${m.lastSpindownResultTime.toFixed(2)} s`
          : '';
        this.log.log(`Command result: ${commandResultName(m.commandResult)}${extra}`);
      }
      const packet = {
        date: now, direction: 'rx', characteristic: uuid, bytes, plain: deobfuscate(bytes),
        summary: `${m.power} W  ${m.speedKPH.toFixed(1)} km/h  ${Math.round(this.smoothedCadence)} rpm  ${sensorStateName(m.state)}${m.coasting ? '  coasting' : ''}`,
      };
      this.log.record(packet);
      this.onPacket?.(packet);
      this.onMeasurement?.(m, now);
      for (const l of this.measurementListeners) l(m, now);
    } catch (e) {
      this.stats.decodeErrors++;
      const packet = { date: now, direction: 'rx', characteristic: uuid, bytes, plain: null, summary: `decode error: ${e.message}` };
      this.log.record(packet);
      this.onPacket?.(packet);
      this.log.log(`Power packet decode failed: ${e.message} (${hex(bytes)})`, 'error');
    }
    changed();
  }

  handleConfiguration(bytes) {
    try {
      const c = parseConfiguration(bytes);
      this.configuration = c;
      this.log.log(`Configuration: update ${c.updateHz.toFixed(0)} Hz (calibration ${c.calibrationUpdateHz.toFixed(0)} Hz), spindown ${c.currentSpindownTime.toFixed(3)} s${c.proFlywheel ? ', Pro Flywheel' : ''}`);
      this.applyPreferredUpdateRateIfNeeded();
    } catch (e) {
      this.log.log(`Configuration decode failed: ${e.message} (${hex(bytes)})`, 'error');
    }
  }

  /** Writes the configure command only if the rider asked for a rate the sensor is not using. */
  applyPreferredUpdateRateIfNeeded() {
    const preferred = this.settings.get('updateRate');
    const c = this.configuration;
    if (!this.pendingUpdateRateCheck || !preferred || !c || !this.info.systemID) return;
    this.pendingUpdateRateCheck = false;
    if (c.updateRateDefault === preferred) return;
    this.send(Command.configure(preferred))
      .then(() => {
        this.log.log(`Requested update rate ${rateLabel(preferred)}`);
        setTimeout(() => this.read(CONFIG), 2000);
      })
      .catch((e) => this.log.log(`Could not set update rate: ${e.message}`, 'error'));
  }

  rebuildGATTSnapshot() {
    this.gatt = (this.serviceList ?? []).map((s) => ({
      uuid: s.uuid,
      name: gattName(s.uuid) ?? s.uuid,
      characteristics: s.chars.map((c) => {
        const uuid = shortUUID(c.uuid);
        const p = c.properties;
        const props = [];
        if (p.read) props.push('read');
        if (p.write) props.push('write');
        if (p.writeWithoutResponse) props.push('write-no-rsp');
        if (p.notify) props.push('notify');
        if (p.indicate) props.push('indicate');
        return { uuid, name: gattName(uuid) ?? uuid, props, isNotifying: this.notifying.has(uuid), value: this.values.get(uuid) ?? null };
      }),
    }));
    changed();
  }

  startWatchdog() {
    let resubscribedAt = null;
    setInterval(() => {
      if (this.state.kind !== 'streaming' || this.lastPacketAt == null) {
        resubscribedAt = null;
        return;
      }
      const silence = (Date.now() - this.lastPacketAt) / 1000;
      if (silence > 45 && this.device) {
        this.stats.watchdogDrops++;
        this.log.log(`No data for ${Math.round(silence)} s; dropping link to force a reconnect`, 'error');
        try {
          this.device.gatt.disconnect();
        } catch {
          // ignore
        }
        resubscribedAt = null;
      } else if (silence > 15 && resubscribedAt == null) {
        this.stats.watchdogResubscribes++;
        this.log.log(`No data for ${Math.round(silence)} s; re-subscribing`, 'warning');
        this.setNotify(false, POWER).then(() => this.setNotify(true, POWER));
        resubscribedAt = Date.now();
      } else if (silence < 5) {
        resubscribedAt = null;
      }
    }, 5000);
  }
}
