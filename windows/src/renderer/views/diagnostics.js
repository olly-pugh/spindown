// Diagnostics tab and its tools. Port of DiagnosticsView.swift.
import { useEffect, useState } from 'preact/hooks';
import { html, LV, Section, Toggle, Modal, Spinner } from '../components.js';
import { linkTitle, linkColor, firmwareIsOutdated } from '../ble/trainer.js';
import { InRideGATT, gattName } from '../../core/gatt.js';
import { hex, parseHex } from '../../core/bytes.js';
import { deobfuscate } from '../../core/obfuscation.js';
import { commandKey, Command, UPDATE_RATES, rateLabel, describeCommand } from '../../core/commands.js';
import { sensorStateName, commandResultName, calibrationResultName } from '../../core/decoder.js';
import * as Format from '../../core/format.js';
import { DiagnosticsLog } from '../model.js';

const TOOLS = [
  ['packets', 'Packet Log'],
  ['events', 'Event Log'],
  ['gatt', 'GATT Explorer'],
  ['commands', 'Sensor Commands'],
  ['scan', 'Scan All BLE Devices'],
];

export function DiagnosticsView({ app }) {
  const [tool, setTool] = useState(null);
  if (tool) {
    const title = TOOLS.find(([k]) => k === tool)[1];
    const Tool = { packets: PacketLog, events: EventLog, gatt: GATTExplorer, commands: SensorCommands, scan: RawScan }[tool];
    return html`<div class="page" style="max-width:980px">
      <div class="row" style="margin-bottom:14px"><button class="btn" onClick=${() => setTool(null)}>‹ Diagnostics</button><h2 style="margin:0">${title}</h2></div>
      <${Tool} app=${app} />
    </div>`;
  }
  return html`<${Overview} app=${app} openTool=${setTool} />`;
}

function Overview({ app, openTool }) {
  const { trainer, heartRate, log, api, info } = app;
  const [exportMsg, setExportMsg] = useState(null);
  const now = Date.now();
  const s = trainer.stats;
  const i = trainer.info;
  const c = trainer.configuration;
  const m = trainer.latest;

  const prepareExport = async () => {
    const device = {
      name: trainer.peripheralName, identifier: trainer.peripheralID, manufacturer: i.manufacturer, model: i.model,
      firmware: i.firmware, hardware: i.hardware, software: i.software, systemID: i.systemID ? hex(i.systemID, '') : null,
      battery: i.battery, state: linkTitle(trainer.state), heartRateMonitor: heartRate.deviceName, heartRateStatus: heartRate.statusLine(),
      windows: info.systemVersion,
    };
    const bundle = {
      generated: new Date().toISOString(),
      app: `Spindown for Windows ${info.version}`,
      device,
      configuration: c,
      latest: m,
      events: log.events.map((e) => ({ ...e, date: new Date(e.date).toISOString() })),
      packets: log.packets.map((p) => ({ ...p, date: new Date(p.date).toISOString(), bytes: hex(p.bytes, ''), plain: p.plain ? hex(p.plain, '') : null })),
    };
    const path = await api.app.saveText(`spindown-diagnostics-${Math.floor(Date.now() / 1000)}.json`, JSON.stringify(bundle, null, 2));
    if (path) setExportMsg(`Saved ${path}`);
  };

  let key = null;
  try {
    key = i.systemID ? hex(commandKey(i.systemID)) : null;
  } catch {
    key = null;
  }

  return html`<div class="page" style="max-width:980px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div>
        <${Section} title="Link">
          <div class="list">
            <div class="item"><span class="dot ${linkColor(trainer.state)}"></span>${linkTitle(trainer.state)}</div>
            <${LV} k="Peripheral" v=${trainer.peripheralName} />
            <${LV} k="Identifier" v=${trainer.peripheralID} mono />
            <${LV} k="Packets" v=${String(s.packets)} />
            <${LV} k="Measured rate" v=${s.measuredHz > 0 ? `${s.measuredHz.toFixed(2)} Hz` : null} />
            <${LV} k="Last packet" v=${trainer.latestAt ? `${((now - trainer.latestAt) / 1000).toFixed(1)} s ago` : null} />
            <${LV} k="Decode errors" v=${String(s.decodeErrors)} />
            <${LV} k="Connected for" v=${s.connectedSince ? Format.duration((now - s.connectedSince) / 1000) : null} />
            <${LV} k="Connects / drops" v=${`${s.connects} / ${s.disconnects}`} />
            <${LV} k="Watchdog" v=${`${s.watchdogResubscribes} resubscribes, ${s.watchdogDrops} drops`} />
            <${LV} k="Last disconnect" v=${s.lastDisconnect} />
          </div>
        </${Section}>
        <${Section} title="Device" footer="The System ID (Device Information 0x2A23) is needed to build control point commands. Windows does not allow reading the serial number.">
          <div class="list">
            <${LV} k="Manufacturer" v=${i.manufacturer} />
            <${LV} k="Model" v=${i.model} />
            <${LV} k="Firmware" v=${i.firmware ? (firmwareIsOutdated(i.firmware) ? `${i.firmware} (Kinetic's last: ${InRideGATT.latestPublishedFirmware})` : i.firmware) : null} />
            <${LV} k="Hardware" v=${i.hardware} />
            <${LV} k="Software" v=${i.software} />
            <${LV} k="System ID" v=${i.systemID ? hex(i.systemID) : null} mono />
            <${LV} k="Command key" v=${key} mono />
            <${LV} k="Battery" v=${i.battery != null ? `${i.battery}%` : null} />
          </div>
        </${Section}>
        <${Section} title="Sensor Configuration (E9410104)">
          <div class="list">
            ${c ? html`
              <${LV} k="Update rate" v=${`${c.updateHz.toFixed(0)} Hz (0x${c.updateRateDefault.toString(16).toUpperCase().padStart(2, '0')})`} />
              <${LV} k="Calibration rate" v=${`${c.calibrationUpdateHz.toFixed(0)} Hz (0x${c.updateRateCalibration.toString(16).toUpperCase().padStart(2, '0')})`} />
              <${LV} k="Stored spindown" v=${`${c.currentSpindownTime.toFixed(3)} s (${c.currentSpindownTicks} ticks)`} />
              <${LV} k="Pro Flywheel" v=${c.proFlywheel ? 'Yes' : 'No'} />
              <${LV} k="Cal. ready / start / end" v=${`${c.calibrationReady} / ${c.calibrationStart} / ${c.calibrationEnd}`} />
              <${LV} k="Cal. debounce" v=${String(c.calibrationDebounce)} />
              <div class="item"><button class="btn" onClick=${() => trainer.read(InRideGATT.configCharacteristic)}>Re-read</button></div>
            ` : html`<div class="item muted">Not read yet</div>`}
          </div>
        </${Section}>
      </div>
      <div>
        <${Section} title="Decoded (Kinetic algorithm)">
          <div class="list">
            ${m ? html`
              <${LV} k="State" v=${sensorStateName(m.state)} />
              <${LV} k="Command result" v=${`${commandResultName(m.commandResult)} (0x${m.raw.commandResultBits.toString(16).toUpperCase()})`} />
              <${LV} k="Power" v=${`${m.power} W`} />
              <${LV} k="Speed (roller)" v=${`${m.speedKPH.toFixed(2)} km/h`} />
              <${LV} k="Roller" v=${`${m.rollerRPM.toFixed(1)} rpm`} />
              <${LV} k="Cadence raw / smoothed" v=${`${m.cadenceRPM.toFixed(1)} / ${trainer.smoothedCadence.toFixed(1)} rpm`} />
              <${LV} k="Coasting" v=${m.coasting ? 'Yes' : 'No'} />
              <${LV} k="Alpha" v=${m.alpha.toFixed(2)} />
              <${LV} k="Applied spindown" v=${`${m.spindownTime.toFixed(3)} s`} />
              <${LV} k="Last spindown result" v=${`${m.lastSpindownResultTime.toFixed(3)} s (${calibrationResultName(m.calibrationResult)})`} />
              <${LV} k="Roller resistance" v=${m.rollerResistance.toFixed(3)} />
              <${LV} k="Pro Flywheel" v=${m.proFlywheel ? 'Yes' : 'No'} />
            ` : html`<div class="item muted">No power packets yet</div>`}
          </div>
        </${Section}>
        ${m && trainer.latestPacket ? html`<${Section} title="Raw Fields">
          <div class="list">
            <${LV} k="Rotation" v=${String(m.raw.rotation)} />
            <${LV} k="Interval" v=${`${m.raw.interval} ticks`} />
            <${LV} k="Ticks / revs" v=${`${m.raw.ticks} / ${m.raw.revs}`} />
            <${LV} k="Previous ticks / revs" v=${`${m.raw.ticksPrevious} / ${m.raw.revsPrevious}`} />
            <${LV} k="Cadence raw" v=${String(m.raw.cadenceRaw)} />
            <${LV} k="Spindown ticks" v=${String(m.raw.spindownTicks)} />
            <div class="item" style="display:block">
              <div class="small muted">Received</div><div class="mono">${hex(trainer.latestPacket)}</div>
              <div class="small muted" style="margin-top:6px">De-obfuscated</div><div class="mono">${hex(deobfuscate(trainer.latestPacket))}</div>
            </div>
          </div>
        </${Section}>` : null}
        <${Section} title="Heart-Rate Monitor">
          <div class="list">
            <${LV} k="Status" v=${heartRate.statusLine(now)} />
            <${LV} k="Device" v=${heartRate.deviceName} />
            <${LV} k="Manufacturer / firmware" v=${[heartRate.manufacturer, heartRate.firmware].filter(Boolean).join(' / ') || null} />
            <${LV} k="Heart rate" v=${heartRate.bpm != null ? `${heartRate.bpm} bpm` : null} />
            <${LV} k="Skin contact" v=${heartRate.sensorContact == null ? 'Not reported' : heartRate.sensorContact ? 'Yes' : 'No'} />
            <${LV} k="RR intervals" v=${heartRate.lastRRIntervals.length ? heartRate.lastRRIntervals.map((x) => `${Math.round(x * 1000)} ms`).join(', ') : null} />
            <${LV} k="Last reading" v=${heartRate.lastAt ? `${((now - heartRate.lastAt) / 1000).toFixed(1)} s ago` : null} />
            <${LV} k="Readings" v=${String(heartRate.packets)} />
            <${LV} k="Connects / drops" v=${`${heartRate.connects} / ${heartRate.disconnects}`} />
            <${LV} k="Battery" v=${heartRate.battery != null ? `${heartRate.battery}%` : null} />
            <${LV} k="Last packet" v=${heartRate.lastPacket ? hex(heartRate.lastPacket) : null} mono />
          </div>
        </${Section}>
      </div>
    </div>
    <${Section} title="Tools">
      <div class="list">
        ${TOOLS.map(([k, label]) => html`<button class="item" onClick=${() => openTool(k)}><span style="flex:1">${label}${k === 'packets' ? ` (${log.packets.length})` : k === 'events' ? ` (${log.events.length})` : ''}</span><span class="muted">›</span></button>`)}
      </div>
    </${Section}>
    <${Section} footer=${`A JSON file with device details, configuration, the event log and the last ${DiagnosticsLog.packetCapacity} packets (raw and de-obfuscated). Send it to whoever is helping you.`}>
      <div class="list">
        <button class="item" onClick=${prepareExport}>📄 <span style="flex:1">Save Diagnostics Bundle…</span></button>
        <button class="item" onClick=${() => api.app.openFolder('logs')}>📁 <span style="flex:1">Open the log folder</span></button>
        ${exportMsg ? html`<div class="item small muted selectable">${exportMsg}</div>` : null}
      </div>
    </${Section}>
  </div>`;
}

function PacketLog({ app }) {
  const { log } = app;
  const [showPlain, setShowPlain] = useState(true);
  const [powerOnly, setPowerOnly] = useState(false);
  const packets = log.packets.slice().reverse().filter((p) => !powerOnly || p.characteristic === InRideGATT.powerCharacteristic).slice(0, 500);
  return html`
    <div class="list" style="margin-bottom:14px">
      <${Toggle} label="Pause logging" checked=${log.packetLoggingPaused} onChange=${(v) => { log.packetLoggingPaused = v; }} />
      <${Toggle} label="Show de-obfuscated bytes" checked=${showPlain} onChange=${setShowPlain} />
      <${Toggle} label="Power packets only" checked=${powerOnly} onChange=${setPowerOnly} />
      <div class="item"><button class="btn" onClick=${() => log.clear()}>Clear logs</button></div>
    </div>
    <div class="list">
      ${packets.map((p) => html`<div class="item" style="display:block">
        <div class="row">
          <span class=${p.direction === 'rx' ? 'green' : 'orange'} style="font-weight:800;font-size:12px">${p.direction.toUpperCase()}</span>
          <span class="small" style="font-weight:600">${gattName(p.characteristic) ?? p.characteristic}</span>
          <span class="spacer"></span><span class="small muted num">${Format.time(p.date)}</span>
        </div>
        <div class="mono">${hex(p.bytes)}</div>
        ${showPlain && p.plain ? html`<div class="mono cyan">${hex(p.plain)}</div>` : null}
        <div class="small muted">${p.summary}</div>
      </div>`)}
    </div>`;
}

function EventLog({ app }) {
  return html`<div class="list">
    ${app.log.events.slice().reverse().map((e) => html`<div class="item" style="display:block">
      <div class="small muted num">${Format.time(e.date)}</div>
      <div class="selectable ${e.level === 'error' ? 'red' : e.level === 'warning' ? 'orange' : ''}">${e.message}</div>
    </div>`)}
  </div>`;
}

function GATTExplorer({ app }) {
  const { trainer } = app;
  const [writeTarget, setWriteTarget] = useState(null);
  return html`
    ${trainer.gatt.length === 0 ? html`<div class="card muted">Connect to a trainer to browse its services.</div>` : null}
    ${trainer.gatt.map((service) => html`<div class="section">
      <h3>${service.name} <span class="mono" style="text-transform:none">${service.uuid}</span></h3>
      <div class="list">
        ${service.characteristics.map((c) => html`<div class="item" style="display:block">
          <div style="font-weight:600">${c.name}</div>
          <div class="mono muted">${c.uuid}</div>
          <div class="small">${c.props.join(' · ')}</div>
          ${c.value ? html`<div class="mono">${hex(c.value)}</div>` : null}
          <div class="row" style="margin-top:6px">
            ${c.props.includes('read') ? html`<button class="btn" onClick=${() => trainer.read(c.uuid)}>Read</button>` : null}
            ${c.props.includes('notify') || c.props.includes('indicate') ? html`<button class="btn" onClick=${() => trainer.setNotify(!c.isNotifying, c.uuid)}>${c.isNotifying ? 'Unsubscribe' : 'Subscribe'}</button>` : null}
            ${c.props.includes('write') || c.props.includes('write-no-rsp') ? html`<button class="btn" style="color:var(--orange)" onClick=${() => setWriteTarget(c)}>Write…</button>` : null}
          </div>
        </div>`)}
      </div>
    </div>`)}
    ${writeTarget ? html`<${RawWrite} app=${app} c=${writeTarget} onClose=${() => setWriteTarget(null)} />` : null}`;
}

function RawWrite({ app, c, onClose }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const write = async () => {
    const bytes = parseHex(text);
    if (!bytes || !bytes.length) {
      setError('Not valid hex');
      return;
    }
    try {
      await app.trainer.write(bytes, c.uuid, c.props.includes('write'), 'manual');
      onClose();
    } catch (e) {
      setError(e.message);
    }
  };
  return html`<${Modal} title=${c.name} onClose=${onClose} closeLabel="Cancel" size="narrow" footer=${html`<button class="btn primary" onClick=${write}>Write</button>`}>
    <input type="text" class="mono" style="width:100%" placeholder="Hex bytes, e.g. 21 65 03" value=${text} onInput=${(e) => setText(e.target.value)} />
    <p class="small muted">Writes go straight to the sensor. Wrong values on the control point can change its configuration; a power cycle (remove the battery) restores normal operation.</p>
    ${error ? html`<div class="red">${error}</div>` : null}
  </${Modal}>`;
}

function SensorCommands({ app }) {
  const { trainer } = app;
  const [message, setMessage] = useState(null);
  const run = async (command) => {
    try {
      await trainer.send(command);
      setMessage(`Sent ${describeCommand(command)}. Watch the event log for the command result.`);
    } catch (e) {
      setMessage(`Failed: ${e.message}`);
    }
  };
  return html`
    <div class="section"><h3>Update rate</h3>
      <div class="list">${UPDATE_RATES.map((r) => html`<button class="item" onClick=${() => run(Command.configure(r))}>Set update rate to ${rateLabel(r)}</button>`)}</div>
      <div class="footer">Kinetic's configure command, which also rewrites the spindown thresholds with Kinetic's standard values. The result appears in the next power packet.</div>
    </div>
    <div class="section"><h3>Calibration</h3>
      <div class="list">
        <button class="item" onClick=${() => run(Command.startCalibration())}>Start spindown</button>
        <button class="item" onClick=${() => run(Command.stopCalibration())}>Stop spindown</button>
      </div>
    </div>
    <div class="section"><h3>Read</h3>
      <div class="list">
        <button class="item" onClick=${() => trainer.read(InRideGATT.configCharacteristic)}>Read configuration</button>
        <button class="item" onClick=${() => trainer.read(InRideGATT.systemID)}>Read System ID</button>
      </div>
    </div>
    ${message ? html`<div class="card small">${message}</div>` : null}`;
}

function RawScan({ app }) {
  const { bluetooth } = app;
  useEffect(() => {
    bluetooth.startPicker('all', null);
    return () => bluetooth.stopPicker();
  }, []);
  const devices = bluetooth.picker?.kind === 'all' ? bluetooth.pickerDevices : [];
  return html`
    <div class="card row" style="margin-bottom:12px"><${Spinner} /><span class="muted">Listing every Bluetooth LE device Windows can see. Windows does not report signal strength or advertised services here.</span></div>
    <div class="list">
      ${devices.map((d) => html`<div class="item" style="display:block">
        <div style="font-weight:600">${d.name}</div>
        <div class="mono muted">${d.id}</div>
      </div>`)}
    </div>`;
}
