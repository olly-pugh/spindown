// First-run guide: connect the trainer, optionally the heart-rate strap and Garmin, then explain the
// everyday routine. Written for someone who has never used the app.
import { useEffect, useState } from 'preact/hooks';
import { html, Modal, Spinner } from '../components.js';
import { DeviceList, findTrainer, findHeartRate } from './sensors.js';
import { isStreaming, linkTitle } from '../ble/trainer.js';
import { GarminSection } from './settings.js';

export function WelcomeView({ app, onDone }) {
  const { trainer, heartRate, settings, bluetooth } = app;
  const [step, setStep] = useState(0);
  const now = Date.now();

  useEffect(() => {
    if (step === 1 && !isStreaming(trainer.state) && bluetooth.picker?.kind !== 'trainer') findTrainer(app);
    if (step === 2 && !heartRate.isConnected && bluetooth.picker?.kind !== 'hr') findHeartRate(app);
    if (step !== 1 && step !== 2) bluetooth.stopPicker();
  }, [step]);

  const finish = () => {
    bluetooth.stopPicker();
    settings.set('onboarded', true);
    onDone();
  };

  const next = () => setStep(step + 1);
  const steps = html`<div class="steps">${[0, 1, 2, 3, 4].map((i) => html`<div class=${i <= step ? 'on' : ''}></div>`)}</div>`;
  let body, footer;

  switch (step) {
    case 0:
      body = html`<div class="welcome-big">
        <p style="font-size:24px;font-weight:700;margin-top:0">Welcome to Spindown 👋</p>
        <p>Spindown shows your power, speed, cadence and heart rate from the Kinetic trainer, records each ride, and sends it to Garmin Connect for you.</p>
        <p>This takes about two minutes. Have the bike on the trainer and the heart-rate strap nearby.</p>
      </div>`;
      footer = html`<button class="btn primary" style="min-width:160px;font-size:17px" onClick=${next}>Let's start</button>`;
      break;
    case 1: {
      const connected = isStreaming(trainer.state) && trainer.state.kind !== 'simulated';
      body = html`<div class="welcome-big">
        <p style="font-size:22px;font-weight:700;margin-top:0">1. Connect the trainer</p>
        ${connected
          ? html`<div class="card green" style="font-size:20px">✔ Connected to ${trainer.peripheralName}. ${trainer.latest ? `Reading ${trainer.latest.power} W.` : ''}</div>`
          : html`<p><b>Turn the pedals</b> for a few seconds to wake the trainer's sensor. When its name appears below, click <b>Connect</b>.</p>
            ${trainer.state.kind !== 'idle' && !bluetooth.picker ? html`<div class="card row"><${Spinner} /> ${linkTitle(trainer.state)}</div>` : null}
            <${DeviceList} app=${app} kind="trainer" />
            ${!bluetooth.picker && trainer.state.kind === 'idle' ? html`<button class="btn" onClick=${() => findTrainer(app)}>Search again</button>` : null}`}
        ${bluetooth.unavailable ? html`<div class="card red" style="margin-top:10px">${bluetooth.unavailable}</div>` : null}
      </div>`;
      footer = connected
        ? html`<button class="btn primary" style="min-width:160px;font-size:17px" onClick=${next}>Next</button>`
        : html`<button class="btn" onClick=${next}>Skip for now</button>`;
      break;
    }
    case 2: {
      const hr = heartRate.freshHeartRate(now);
      body = html`<div class="welcome-big">
        <p style="font-size:22px;font-weight:700;margin-top:0">2. Heart-rate strap <span class="muted" style="font-weight:400">(optional)</span></p>
        ${heartRate.isConnected
          ? html`<div class="card green" style="font-size:20px">✔ Connected to ${heartRate.deviceName}${hr != null ? ` · ${hr} bpm` : ' — wet the strap and put it on to see your heart rate'}.</div>`
          : html`<p><b>Wet the strap's electrodes and put it on</b> so it wakes up. When it appears below, click <b>Connect</b>.</p>
            <p class="small muted">The strap can only talk to one app at a time, so close the phone app and Polar Flow first.</p>
            <${DeviceList} app=${app} kind="hr" />
            ${!bluetooth.picker ? html`<button class="btn" onClick=${() => findHeartRate(app)}>Search again</button>` : null}`}
      </div>`;
      footer = heartRate.isConnected
        ? html`<button class="btn primary" style="min-width:160px;font-size:17px" onClick=${next}>Next</button>`
        : html`<button class="btn" onClick=${next}>Skip — no strap</button>`;
      break;
    }
    case 3:
      body = html`<div class="welcome-big">
        <p style="font-size:22px;font-weight:700;margin-top:0">3. Garmin Connect <span class="muted" style="font-weight:400">(optional)</span></p>
        <p>Sign in once and every ride is sent to Garmin Connect automatically. A Garmin window opens; sign in there as you would on the website.</p>
        <${GarminSection} app=${app} />
      </div>`;
      footer = html`<button class=${app.uploads.garminSignedIn ? 'btn primary' : 'btn'} style="min-width:160px;font-size:17px" onClick=${next}>${app.uploads.garminSignedIn ? 'Next' : 'Skip for now'}</button>`;
      break;
    default:
      body = html`<div class="welcome-big">
        <p style="font-size:24px;font-weight:700;margin-top:0">You're all set 🎉</p>
        <p>Every time you ride:</p>
        <ol class="checklist">
          <li>Double-click <b>Spindown</b> on the desktop.</li>
          <li>Start pedalling. The trainer connects by itself within a few seconds (the dot at the top turns green).</li>
          <li>Click the big green <b>Start Ride</b> button.</li>
          <li>When you've finished, click <b>Finish</b>, then <b>Save Ride</b>.</li>
        </ol>
        <p>The ride is saved on this computer and sent to Garmin Connect automatically. You can close Spindown whenever you like.</p>
        <p class="small muted">Try the <b>Lakes</b> tab for a cartoon ride around the Lake District, with optional workouts.</p>
      </div>`;
      footer = html`<button class="btn primary" style="min-width:200px;font-size:17px" onClick=${finish}>Start using Spindown</button>`;
  }

  return html`<${Modal} title="Getting started" onClose=${finish} closeLabel="Close guide" footer=${footer}>
    ${steps}${body}
  </${Modal}>`;
}
