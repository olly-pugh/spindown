// Trainer and heart-rate strap in one place, each with a live, verifiable status (data actually arriving, not
// just "paired"). Port of SensorsView.swift. Windows allows one Bluetooth search at a time, so each sensor
// has its own "Find" button.
import { useEffect } from 'preact/hooks';
import { html, Modal, Section, Spinner } from '../components.js';
import { linkTitle, linkColor, isConnected } from '../ble/trainer.js';

export function DeviceList({ app, kind, onPicked }) {
  const { bluetooth } = app;
  const picking = bluetooth.picker?.kind === kind;
  if (!picking) return null;
  const devices = bluetooth.pickerDevices;
  const hint = kind === 'trainer'
    ? 'Spin the pedals to wake the inRide sensor. Close other apps that use it (Kinetic Fit, Zwift, nRF Connect) and make sure the phone app is closed.'
    : 'Put the strap on (moisten the electrodes) so it wakes up. A Polar H9 shows as "Polar H9 …". Disconnect it from other apps first.';
  return html`<div class="card" style="margin-top:10px">
    ${devices.map((d) => html`<button class="device-btn" onClick=${() => { bluetooth.choose(d.id); onPicked?.(); }}>
      <span style="font-size:22px">${kind === 'trainer' ? '🚲' : '♥'}</span>
      <span style="flex:1"><div style="font-weight:600">${d.name}</div><div class="small muted">${kind === 'trainer' ? 'Kinetic inRide' : kind === 'hr' ? 'Heart-rate monitor' : d.id}</div></span>
      ${bluetooth.picker?.choice === d.id ? html`<${Spinner} /> <span class="small muted">Connecting…</span>` : html`<span class="btn primary">Connect</span>`}
    </button>`)}
    <div class="row" style="gap:12px;padding:6px 2px">
      <${Spinner} /><span class="muted">${devices.length ? 'Still searching…' : 'Searching…'} ${hint}</span>
    </div>
    <div class="row"><span class="spacer"></span><button class="btn" onClick=${() => bluetooth.stopPicker()}>Stop searching</button></div>
  </div>`;
}

export function findTrainer(app) {
  app.bluetooth.startPicker('trainer', (r) => app.trainer.connectTo(r));
}

export function findHeartRate(app) {
  app.bluetooth.startPicker('hr', (r) => app.heartRate.connectTo(r));
}

function StatusRow({ icon, color, title, detail, verified }) {
  return html`<div class="item">
    <span class=${color} style="font-size:22px;width:28px;text-align:center">${icon}</span>
    <div style="flex:1"><div style="font-weight:600">${title}</div>${detail ? html`<div class="small muted">${detail}</div>` : null}</div>
    ${verified ? html`<span class="green small" style="font-weight:700">✔ Live</span>` : null}
  </div>`;
}

export function SensorsView({ app, onClose }) {
  const { trainer, heartRate, settings, bluetooth } = app;
  const now = Date.now();
  const reading = trainer.freshReading(now);
  const hr = heartRate.freshHeartRate(now);

  // With nothing set up yet, start looking for the trainer straight away.
  useEffect(() => {
    if (!settings.get('trainerID') && !isConnected(trainer.state) && !bluetooth.picker) findTrainer(app);
    return () => bluetooth.stopPicker();
  }, []);

  const hrColor = hr != null ? 'green' : heartRate.state.kind === 'idle' ? 'gray' : heartRate.state.kind === 'unavailable' ? 'red' : 'orange';
  const hrDetail = [heartRate.battery != null ? `battery ${heartRate.battery}%` : null, heartRate.packets > 0 ? `${heartRate.packets} readings` : null].filter(Boolean).join(' · ');

  return html`<${Modal} title="Trainer & Heart-Rate Strap" onClose=${onClose} closeLabel="Done">
    ${bluetooth.unavailable ? html`<div class="card red" style="margin-bottom:16px">${bluetooth.unavailable}</div>` : null}
    <${Section} title="Trainer">
      <div class="list">
        <${StatusRow} icon="🚲" color=${linkColor(trainer.state)} title=${linkTitle(trainer.state)}
          detail=${reading ? `Receiving: ${reading.power} W · ${reading.speedKPH.toFixed(1)} km/h` : isConnected(trainer.state) ? 'Connected — spin the pedals to see data' : null}
          verified=${!!reading} />
        <div class="item row wrap">
          <button class="btn primary" onClick=${() => findTrainer(app)} disabled=${bluetooth.picker?.kind === 'trainer'}>
            ${settings.get('trainerID') ? 'Find a different trainer' : 'Find my trainer'}
          </button>
          <span class="spacer"></span>
          ${settings.get('trainerID') ? html`<button class="btn danger" onClick=${() => trainer.disconnect(true)}>Forget trainer</button>` : null}
        </div>
      </div>
      <${DeviceList} app=${app} kind="trainer" />
    </${Section}>

    <${Section} title="Heart-rate monitor" footer="A Polar H9 accepts one Bluetooth connection at a time, so disconnect it from other apps (Polar Flow, Zwift, the phone app) first.">
      <div class="list">
        <${StatusRow} icon="♥" color=${hrColor} title=${heartRate.statusLine(now)} detail=${hrDetail || null} verified=${hr != null} />
        <div class="item row wrap">
          <button class="btn primary" onClick=${() => findHeartRate(app)} disabled=${bluetooth.picker?.kind === 'hr'}>
            ${settings.get('hrmID') ? 'Find a different strap' : 'Find my heart-rate strap'}
          </button>
          <span class="spacer"></span>
          ${settings.get('hrmID') ? html`<button class="btn danger" onClick=${() => heartRate.disconnect(true)}>Forget strap</button>` : null}
        </div>
      </div>
      <${DeviceList} app=${app} kind="hr" />
    </${Section}>

    <${Section} footer="Generates genuine inRide packets so you can try the app without the trainer.">
      <div class="list">
        <div class="item">
          <button class="btn" onClick=${() => {
            const on = !settings.get('simulator');
            settings.set('simulator', on);
            if (on) trainer.startSimulator();
            else {
              trainer.stopSimulator();
              trainer.reconnectRemembered();
            }
          }}>${settings.get('simulator') ? 'Stop Simulated Trainer' : 'Use Simulated Trainer'}</button>
        </div>
      </div>
    </${Section}>
  </${Modal}>`;
}
