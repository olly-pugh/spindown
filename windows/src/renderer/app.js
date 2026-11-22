// Composition root: builds the long-lived services once and wires them together. Port of AppModel.swift.
import { DiagnosticsLog, SettingsModel, changed } from './model.js';
import { Bluetooth } from './ble/bluetooth.js';
import { TrainerManager } from './ble/trainer.js';
import { HeartRateMonitor } from './ble/heartrate.js';
import { RideSession } from './session.js';

export async function createApp(api) {
  const settings = new SettingsModel(api, await api.settings.all());
  const log = new DiagnosticsLog(api);
  const bluetooth = new Bluetooth(api, log);
  const trainer = new TrainerManager({ settings, log, bluetooth });
  const heartRate = new HeartRateMonitor({ settings, log, bluetooth });
  const session = new RideSession({ api, trainer, heartRate, settings, log });
  const info = await api.app.info();

  const app = {
    api, settings, log, bluetooth, trainer, heartRate, session, info,
    rides: { records: [], loadErrors: [] },
    uploads: await api.uploads.state(),
    update: info.update ?? { status: 'idle' },
    /** Shown once after launch if a ride was recovered. */
    recoveryMessage: null,
    /** The ride just finished, for the summary screen. */
    finishedRideID: null,

    async finishRide() {
      const record = await session.finish();
      if (record) {
        app.finishedRideID = record.id;
        changed();
      }
      return record;
    },
  };

  trainer.onMeasurement = (m, date) => session.handle(m, date);
  trainer.onPacket = (p) => session.handlePacket(p);
  // Heart-rate packets also keep sampling going if the trainer is asleep or disconnected.
  heartRate.onHeartRate = (_bpm, date) => session.tick(date);

  const applyRides = (r) => {
    app.rides = r;
    changed();
  };
  applyRides(await api.rides.list());
  api.rides.onChange(applyRides);
  api.uploads.onState((s) => {
    app.uploads = s;
    changed();
  });
  api.app.onUpdate((u) => {
    app.update = u;
    changed();
  });
  // The window was closed mid-ride and the rider chose to save.
  api.app.onFinishAndClose(async () => {
    await app.finishRide();
    await api.app.readyToClose();
  });

  app.recoveryMessage = await session.recoverIfNeeded();
  session.updateKeepAwake();

  if (settings.get('simulator')) trainer.startSimulator();
  else trainer.reconnectRemembered();
  heartRate.reconnectRemembered();

  setInterval(changed, 1000); // clocks on screen
  return app;
}
