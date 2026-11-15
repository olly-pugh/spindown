// Entry point of the app window. Port of SpindownApp.swift and RootView.swift.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { html, Modal, Confirm } from './components.js';
import { subscribe } from './model.js';
import { createApp } from './app.js';
import { RideView } from './views/ride.js';
import { WorldView } from './views/world.js';
import { HistoryView, RideDetail } from './views/history.js';
import { DiagnosticsView } from './views/diagnostics.js';
import { SettingsView } from './views/settings.js';
import { SensorsView } from './views/sensors.js';
import { CalibrationView } from './views/calibration.js';
import { WelcomeView } from './views/welcome.js';
import { linkTitle, linkColor } from './ble/trainer.js';

const TABS = [
  ['ride', 'Ride'],
  ['world', 'World'],
  ['history', 'History'],
  ['diagnostics', 'Diagnostics'],
  ['settings', 'Settings'],
];

function useVersion() {
  const [, setV] = useState(0);
  useEffect(() => subscribe(setV), []);
}

function Root({ app }) {
  useVersion();
  const [tab, setTab] = useState('ride');
  const [modal, setModal] = useState(app.settings.get('onboarded') ? null : 'welcome');
  const [historySelection, setHistorySelection] = useState(null);
  const { trainer, heartRate, session, uploads, update } = app;
  const now = Date.now();
  const hr = heartRate.freshHeartRate(now);
  const openSensors = () => setModal('sensors');

  let screen;
  switch (tab) {
    case 'world': screen = html`<${WorldView} app=${app} openSensors=${openSensors} />`; break;
    case 'history': screen = html`<${HistoryView} app=${app} selectedID=${historySelection} onSelect=${setHistorySelection} />`; break;
    case 'diagnostics': screen = html`<${DiagnosticsView} app=${app} />`; break;
    case 'settings': screen = html`<${SettingsView} app=${app} openSensors=${openSensors} openWelcome=${() => setModal('welcome')} />`; break;
    default: screen = html`<${RideView} app=${app} openSensors=${openSensors} openCalibration=${() => setModal('calibration')} />`;
  }

  const garminWaiting = uploads.garminNeedsSignIn
    || (app.settings.get('autoUploadGarmin') && !uploads.garminSignedIn && app.rides.records.some((r) => r.uploads?.garmin?.status === 'pending'));

  return html`<div class="app">
    <header class="topbar">
      <div class="brand"><img src="icon.png" alt="" />Spindown</div>
      <nav class="tabs">${TABS.map(([k, label]) => html`<button class="tab ${tab === k ? 'active' : ''}" onClick=${() => setTab(k)}>${label}</button>`)}</nav>
      <span class="spacer"></span>
      ${session.phase !== 'idle' ? html`<span class="badge ${session.phase === 'paused' ? 'paused' : 'rec'}">${session.phase === 'paused' ? 'PAUSED' : 'REC'}</span>` : null}
      <button class="pill" onClick=${openSensors} title="Trainer"><span class="dot ${linkColor(trainer.state)}"></span><span class="label">${linkTitle(trainer.state)}</span></button>
      <button class="pill" onClick=${openSensors} title="Heart rate"><span class=${hr != null ? 'red' : 'muted'}>♥</span><span class="label num">${hr != null ? `${hr} bpm` : heartRate.isConnected ? '--' : 'No strap'}</span></button>
    </header>
    ${update.status === 'ready' && session.phase === 'idle'
      ? html`<div class="banner">⬆ A new version of Spindown (${update.version}) is ready. It installs automatically next time you close Spindown.<span class="spacer"></span><button class="btn primary" onClick=${() => app.api.app.installUpdate()}>Restart now</button></div>`
      : null}
    ${garminWaiting && tab !== 'settings'
      ? html`<div class="banner warn">⚠ ${uploads.garminNeedsSignIn ? 'Garmin Connect needs you to sign in again.' : 'Rides are waiting to go to Garmin Connect, but you are not signed in.'} They will upload as soon as you sign in.<span class="spacer"></span><button class="btn primary" onClick=${() => setTab('settings')}>Go to Settings</button></div>`
      : null}
    <main class="screen">${screen}</main>

    ${modal === 'sensors' ? html`<${SensorsView} app=${app} onClose=${() => setModal(null)} />` : null}
    ${modal === 'calibration' ? html`<${CalibrationView} app=${app} onClose=${() => setModal(null)} />` : null}
    ${modal === 'welcome' ? html`<${WelcomeView} app=${app} onDone=${() => setModal(null)} />` : null}
    ${app.finishedRideID ? html`<${Modal} title="Ride Saved ✔" size="wide" closeLabel="Done" onClose=${() => { app.finishedRideID = null; setModal(null); }}>
        <${RideDetail} app=${app} rideID=${app.finishedRideID} compact />
      </${Modal}>` : null}
    ${app.recoveryMessage ? html`<${Confirm} title="Ride recovered" message=${app.recoveryMessage}
        onCancel=${() => { app.recoveryMessage = null; setModal(modal); }}
        buttons=${[{ label: 'OK', kind: 'primary', onClick: () => { app.recoveryMessage = null; setTab('ride'); setModal(modal); } }]} />` : null}
  </div>`;
}

createApp(window.spindown)
  .then((app) => {
    window.__spindownApp = app; // for diagnostics from the developer tools
    render(html`<${Root} app=${app} />`, document.getElementById('root'));
  })
  .catch((e) => {
    document.getElementById('root').innerHTML = `<div style="padding:40px;font-size:18px">Spindown could not start: ${String(e?.message ?? e)}</div>`;
    window.spindown?.log.write(`Startup failed: ${e?.stack ?? e}`, 'error');
  });
