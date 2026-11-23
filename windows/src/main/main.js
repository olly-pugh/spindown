// Spindown for Windows: the main process. Owns files, uploads, sign-in windows, the Bluetooth device chooser
// bridge and self-updating. The app window (src/renderer) owns Bluetooth, the ride and the screens.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, net, powerMonitor, powerSaveBlocker, safeStorage, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import updaterPackage from 'electron-updater';
import { Settings, SecretStore, EventLog, RideStore, GameStore } from './storage.js';
import { UploadCoordinator } from './uploads.js';
import { garminSignIn, stravaSignIn } from './signin.js';
import { exportRide, exportFileName, ExportFormats } from '../core/fit.js';

const { autoUpdater } = updaterPackage;
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..', '..');

// Automated tests run against a throwaway data folder.
if (process.env.SPINDOWN_USER_DATA) app.setPath('userData', process.env.SPINDOWN_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  // Another Spindown is already running (it owns the Bluetooth connection); bring that one forward instead.
  app.quit();
} else {
  start();
}

function start() {
  app.setAppUserModelId('com.spindown.windows');
  Menu.setApplicationMenu(null);

  let win = null;
  let log, settings, secrets, store, uploads;
  let ridePhase = 'idle';
  let allowClose = false;
  let awakeBlocker = null;
  let wantAwake = false;
  let bleCallback = null;
  let updateState = { status: 'idle' };

  const send = (channel, ...args) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    log = new EventLog(dataDir);
    settings = new Settings(dataDir, { imperial: app.getLocaleCountryCode() === 'US' });
    secrets = new SecretStore(dataDir, safeStorage);
    store = new RideStore(dataDir, log);
    uploads = new UploadCoordinator({ store, log, transport: httpTransport, secrets, isOnline: () => net.isOnline() });

    log.onEvent((e) => send('log:event', e));
    store.onChange((records) => send('rides:changed', { records, loadErrors: store.loadErrors }));
    uploads.onState((s) => send('uploads:state', s));

    store.load();
    log.log(`Spindown ${app.getVersion()} started on ${process.platform} ${process.getSystemVersion()}; ${store.records.length} rides on file`);

    registerIPC();
    // Automated tests can load an extra preload (fake Bluetooth hardware). Never set in normal use.
    if (process.env.SPINDOWN_TEST_PRELOAD) {
      const ses = session.defaultSession;
      if (ses.registerPreloadScript) ses.registerPreloadScript({ type: 'frame', filePath: process.env.SPINDOWN_TEST_PRELOAD });
      else ses.setPreloads([process.env.SPINDOWN_TEST_PRELOAD]);
    }
    createWindow();
    setupUpdater();
    watchNetwork();

    uploads.refreshAccounts().finally(() => uploads.process());
  });

  app.on('window-all-closed', () => app.quit());

  // ---- Window --------------------------------------------------------------------------------------

  function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 640,
      title: 'Spindown',
      backgroundColor: '#000000',
      show: false,
      autoHideMenuBar: true,
      icon: path.join(appRoot, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false, // keep sampling every second even when the window is behind another
      },
    });
    win.once('ready-to-show', () => {
      win.maximize();
      win.show();
      applyKeepAwake();
    });
    for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, applyKeepAwake);
    win.loadFile(path.join(appRoot, 'dist', 'index.html'));

    // Links never navigate the app window; external ones open in the browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // F12 opens developer tools, for remote debugging only.
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });

    // Bluetooth device chooser: Chromium asks which device to use; the window shows its own list and answers.
    win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault();
      bleCallback = callback;
      send('ble:devices', devices.map((d) => ({ id: d.deviceId, name: d.deviceName || '' })));
    });
    // Windows sometimes asks to confirm pairing; the trainer and straps need no PIN.
    session.defaultSession.setBluetoothPairingHandler?.((details, callback) => {
      log.log(`Bluetooth pairing request (${details.pairingKind}) from ${details.deviceId}`);
      callback({ confirmed: details.pairingKind === 'confirm' || details.pairingKind === 'confirmPin' });
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      log.log(`App window stopped (${details.reason}); reloading. The ride in progress is kept by the crash journal.`, 'error');
      store.journalClose();
      if (!win.isDestroyed()) win.reload();
    });

    win.on('close', async (e) => {
      if (allowClose) return;
      if (ridePhase !== 'idle') {
        e.preventDefault();
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Save Ride and Close', 'Keep Riding'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: 'Ride in progress',
          message: 'You are in the middle of a ride.',
          detail: 'Save it to your history (and upload it to Garmin Connect) and close Spindown?',
        });
        if (response === 0) send('app:finishAndClose');
        return;
      }
      if (uploads.state.isProcessing) {
        e.preventDefault();
        await closeAfterUploads();
      }
    });
  }

  /** Lets an upload in progress finish (up to 45 s) before quitting, out of sight. */
  async function closeAfterUploads() {
    win.hide();
    const until = Date.now() + 45000;
    while (uploads.state.isProcessing && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    allowClose = true;
    store.journalClose();
    win.close();
  }

  /** Keeps the screen (and so the laptop) awake while Spindown is on screen, or at any time during a ride. */
  function applyKeepAwake() {
    const onScreen = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    const on = wantAwake && (onScreen || ridePhase !== 'idle');
    if (on && awakeBlocker == null) {
      awakeBlocker = powerSaveBlocker.start('prevent-display-sleep');
      log.log('Keeping the screen on');
    }
    if (!on && awakeBlocker != null) {
      powerSaveBlocker.stop(awakeBlocker);
      awakeBlocker = null;
      log.log('Screen may sleep again');
    }
  }

  // ---- HTTP (Chromium's network stack: system proxy and certificate store, as a browser would) -----

  const httpTransport = {
    async send({ url, method = 'GET', headers = {}, body, timeoutMs = 30000 }) {
      const res = await net.fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      return { status: res.status, text: await res.text() };
    },
  };

  function watchNetwork() {
    // Wi-Fi coming back: retry at once rather than waiting out the back-off.
    let online = net.isOnline();
    setInterval(() => {
      const now = net.isOnline();
      if (now && !online) uploads.networkRegained();
      online = now;
    }, 5000);
    // Waking from sleep: Wi-Fi often drops and reconnects while the laptop sleeps, so the check above never
    // sees it go offline. Give Wi-Fi a few seconds to reconnect, then retry.
    const afterWake = (why) => {
      log.log(`Laptop ${why}`);
      setTimeout(() => {
        online = net.isOnline();
        if (online && uploads.hasOutstandingWork) uploads.networkRegained();
      }, 10000);
    };
    powerMonitor.on('resume', () => afterWake('woke from sleep'));
    powerMonitor.on('unlock-screen', () => afterWake('unlocked'));
    // Retries due after a back-off.
    setInterval(() => {
      if (uploads.hasOutstandingWork) uploads.process();
    }, 60000);
  }

  // ---- Updates -------------------------------------------------------------------------------------

  function setupUpdater() {
    const setUpdate = (s) => {
      updateState = s;
      send('app:update', s);
    };
    if (!app.isPackaged) return;
    autoUpdater.logger = {
      info: (m) => log.log(`Updater: ${m}`),
      warn: (m) => log.log(`Updater: ${m}`, 'warning'),
      error: (m) => log.log(`Updater: ${m}`, 'warning'),
      debug: () => {},
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', version: info.version }));
    autoUpdater.on('update-downloaded', (info) => setUpdate({ status: 'ready', version: info.version }));
    autoUpdater.on('update-not-available', () => setUpdate({ status: 'current' }));
    autoUpdater.on('error', () => setUpdate({ status: 'idle' }));
    const check = () => autoUpdater.checkForUpdates().catch((e) => log.log(`Update check failed: ${e.message}`, 'warning'));
    setTimeout(check, 5000);
    setInterval(check, 6 * 3600 * 1000);
  }

  // ---- IPC -----------------------------------------------------------------------------------------

  function registerIPC() {
    const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

    handle('app:info', () => ({
      version: app.getVersion(),
      platform: process.platform,
      systemVersion: process.getSystemVersion(),
      isPackaged: app.isPackaged,
      dataDir: app.getPath('userData'),
      secureStorage: secrets.encryptionAvailable(),
      update: updateState,
    }));
    handle('app:openExternal', (url) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    });
    handle('app:openFolder', (which) => {
      const dir = which === 'logs' ? log.dir : which === 'rides' ? store.ridesDir : app.getPath('userData');
      return shell.openPath(dir);
    });
    handle('app:keepAwake', (on) => {
      wantAwake = !!on;
      applyKeepAwake();
    });
    handle('app:setRidePhase', (phase) => {
      ridePhase = phase;
      applyKeepAwake();
    });
    handle('app:readyToClose', async () => {
      ridePhase = 'idle';
      await closeAfterUploads();
    });
    handle('app:saveText', async (fileName, text) => {
      const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), fileName) });
      if (canceled || !filePath) return null;
      fs.writeFileSync(filePath, text);
      shell.showItemInFolder(filePath);
      return filePath;
    });
    handle('app:installUpdate', () => {
      if (ridePhase !== 'idle') return false;
      allowClose = true;
      autoUpdater.quitAndInstall(true, true);
      return true;
    });
    handle('app:checkForUpdates', async () => {
      if (!app.isPackaged) return { status: 'dev' };
      try {
        await autoUpdater.checkForUpdates();
      } catch (e) {
        return { status: 'error', message: e.message };
      }
      return updateState;
    });

    const game = new GameStore(app.getPath('userData'));
    handle('game:load', () => game.load());
    handle('game:save', (text) => game.save(text));

    handle('settings:all', () => settings.all());
    handle('settings:set', (key, value) => settings.set(key, value));

    ipcMain.on('log:write', (_e, message, level) => log.log(message, level || 'info'));
    handle('log:recent', () => log.events);

    handle('journal:open', (resume) => store.journalOpen(!!resume));
    ipcMain.on('journal:append', (_e, line, sync) => {
      try {
        store.journalAppend(line, sync);
      } catch (e) {
        log.log(`Journal write failed: ${e.message}`, 'error');
      }
    });
    ipcMain.on('journal:appendPacket', (_e, line) => store.journalAppendPacket(line));
    handle('journal:flush', () => store.journalFlush());
    handle('journal:read', () => store.journalRead());
    handle('journal:discard', () => store.journalDiscard());
    handle('journal:moveAside', () => store.journalMoveAside());
    handle('journal:save', (record, track, includePackets, picture) => {
      store.saveFromJournal(record, track, includePackets, picture ? Buffer.from(picture) : null);
      uploads.process();
      return true;
    });

    handle('rides:list', () => ({ records: store.records, loadErrors: store.loadErrors }));
    handle('rides:track', (id) => store.track(id));
    handle('rides:rename', (id, name) => store.rename(id, name));
    handle('rides:delete', (id) => store.delete(id));
    handle('rides:export', async (id, format) => {
      const ride = store.exportable(id);
      const f = ExportFormats.find((x) => x.id === format);
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('documents'), exportFileName(ride, format)),
        filters: [{ name: f.name, extensions: [f.ext] }],
      });
      if (canceled || !filePath) return null;
      fs.writeFileSync(filePath, exportRide(ride, format));
      shell.showItemInFolder(filePath);
      return filePath;
    });
    handle('rides:exportRaw', async (id) => {
      const src = store.packetCapturePath(id);
      if (!src) return null;
      const ride = store.exportable(id);
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('documents'), exportFileName(ride, 'fit').replace(/\.fit$/, '-bluetooth.jsonl')),
      });
      if (canceled || !filePath) return null;
      fs.copyFileSync(src, filePath);
      shell.showItemInFolder(filePath);
      return filePath;
    });

    // Ride pictures: a screenshot of the 3D world taken as a World ride finishes (the window hides other riders'
    // names first). rect is the 3D view's area in CSS pixels.
    handle('app:capturePicture', async (rect) => {
      const area = rect && rect.width > 50 && rect.height > 50
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        : undefined;
      let image = await win.webContents.capturePage(area);
      if (image.isEmpty()) return null;
      const { width } = image.getSize();
      if (width > 1920) image = image.resize({ width: 1920, quality: 'best' });
      return new Uint8Array(image.toJPEG(88));
    });
    handle('rides:picture', (id) => {
      const p = store.picturePath(id);
      return p ? `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}` : null;
    });
    handle('rides:copyPicture', (id) => {
      const p = store.picturePath(id);
      if (!p) return false;
      clipboard.writeImage(nativeImage.createFromPath(p));
      return true;
    });
    handle('rides:savePicture', async (id) => {
      const src = store.picturePath(id);
      if (!src) return null;
      const ride = store.exportable(id);
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('pictures'), exportFileName(ride, 'jpg')),
        filters: [{ name: 'JPEG picture', extensions: ['jpg'] }],
      });
      if (canceled || !filePath) return null;
      fs.copyFileSync(src, filePath);
      shell.showItemInFolder(filePath);
      return filePath;
    });

    handle('uploads:state', () => ({ ...uploads.state }));
    handle('uploads:enqueue', (id, destinations) => uploads.enqueue(id, destinations));
    handle('uploads:process', () => uploads.process());

    handle('accounts:garminSignIn', async () => {
      const ticket = await garminSignIn(win, (m) => log.log(`Garmin sign-in: ${m}`));
      if (!ticket) return { ok: false, cancelled: true };
      try {
        await uploads.completeGarminSignIn(ticket);
        return { ok: true };
      } catch (e) {
        log.log(`Garmin sign-in failed: ${e.message}`, 'error');
        return { ok: false, message: e.message };
      }
    });
    handle('accounts:garminTest', () => uploads.testGarmin());
    handle('accounts:garminSignOut', () => uploads.signOutGarmin());
    handle('accounts:stravaCredentials', () => uploads.stravaConfig());
    handle('accounts:stravaSetCredentials', (id, secret) => uploads.updateStravaCredentials(id, secret));
    handle('accounts:stravaSignIn', async () => {
      const state = globalThis.crypto.randomUUID();
      let url;
      try {
        url = uploads.strava.authorizeURL(state);
      } catch (e) {
        return { ok: false, message: e.message };
      }
      const callback = await stravaSignIn(win, url);
      if (!callback) return { ok: false, cancelled: true };
      try {
        await uploads.completeStravaSignIn(callback, state);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    });
    handle('accounts:stravaVerify', () => uploads.verifyStrava());
    handle('accounts:stravaSignOut', () => uploads.signOutStrava());

    // Bluetooth: requestDevice needs a user gesture, so the main process starts it on the window's behalf.
    handle('ble:start', async (token) => {
      bleCallback = null; // a new chooser replaces any earlier one
      await win.webContents.executeJavaScript(`window.__spindownBleStart(${JSON.stringify(token)})`, true);
    });
    handle('ble:select', (deviceId) => {
      const cb = bleCallback;
      bleCallback = null;
      if (cb) cb(deviceId || '');
      return !!cb;
    });
  }
}
