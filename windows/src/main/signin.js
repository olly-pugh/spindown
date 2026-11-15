// Garmin and Strava sign-in windows. Port of AccountSignIn.swift.
//
// Garmin: its own mobile sign-in page in a window with a fresh in-memory session. Credentials go straight to
// Garmin; the app only receives the one-time service ticket, which the page hands to its native host through
// the GMNEventHandler bridge (provided by garmin-preload.cjs), or, in some flows, in a redirect. In this
// "thick client" mode the page sends its own errors over the bridge for the app to show, so we do.
import { BrowserWindow, dialog, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GARMIN_CONFIG, garminSignInURL, garminTicketFromRedirect, garminBridgeEvent, STRAVA_REDIRECT } from '../core/services.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Electron's default user agent without the Electron and app tokens, so pages see a normal Chrome. */
function chromeUserAgent(contents) {
  return contents.getUserAgent().replace(/\s(Electron|spindown|Spindown)\/\S+/g, '');
}

function signInWindow(parent, title, partition, preload) {
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 520,
    height: 820,
    title,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition,
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: !!preload,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setUserAgent(chromeUserAgent(win.webContents));
  win.once('ready-to-show', () => win.show());
  // Links that open new windows (help, privacy) go to the same window rather than escaping the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    win.loadURL(url);
    return { action: 'deny' };
  });
  return win;
}

/**
 * Shows Garmin's sign-in page. Resolves with the service ticket, or null if the window was closed.
 * `log` receives diagnostic lines; page messages are shown in a dialog.
 */
export function garminSignIn(parent, log) {
  return new Promise((resolve) => {
    const partition = `garmin-signin-${Date.now()}`; // no "persist:" prefix: in-memory, fresh every time
    const win = signInWindow(parent, 'Sign in to Garmin Connect', partition, path.join(here, 'garmin-preload.cjs'));
    const ses = session.fromPartition(partition);
    let delivered = false;

    const deliver = (ticket, route) => {
      if (delivered) return;
      delivered = true;
      log(`received service ticket via ${route}`);
      resolve(ticket);
      setImmediate(() => !win.isDestroyed() && win.close());
    };

    const load = () => {
      delivered = false;
      const url = garminSignInURL();
      log(`loading ${new URL(url).host}${new URL(url).pathname}`);
      win.loadURL(url).catch((e) => {
        log(`load failed: ${e.message}`);
        if (!win.isDestroyed()) {
          dialog.showMessageBox(win, { type: 'error', message: 'Could not reach Garmin', detail: `${e.message}\n\nCheck the internet connection and try again.` });
        }
      });
    };

    // Fallback: some flows redirect to the service URL with ?ticket=ST-...
    const serviceHost = new URL(GARMIN_CONFIG.serviceURL).host;
    ses.webRequest.onBeforeRequest({ urls: [`*://${serviceHost}/*`] }, (details, callback) => {
      const ticket = garminTicketFromRedirect(details.url);
      if (ticket) deliver(ticket, 'redirect');
      callback({ cancel: true });
    });

    // webContents.ipc only receives messages from this window (any of its frames).
    const onBridge = (_event, raw) => {
      let body = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep as string
      }
      const e = garminBridgeEvent(body);
      if (!e) {
        log('unrecognised bridge message');
        return;
      }
      log(`event ${e.type}${e.flow ? ` (${e.flow})` : ''}${e.title ? ` "${e.title}"` : ''}${e.messageType ? ` [${e.messageType}]` : ''}`);
      if (e.ticket) {
        if (e.serviceURL && e.serviceURL !== GARMIN_CONFIG.serviceURL) log(`page reported service URL ${e.serviceURL}`);
        deliver(e.ticket, 'bridge');
      } else if (e.message) {
        // e.g. "Invalid sign in. (Passwords are case sensitive.)"
        log(`page message: ${e.message}`);
        dialog.showMessageBox(win, { type: e.messageType?.toUpperCase() === 'ERROR' ? 'error' : 'info', title: 'Garmin', message: e.message });
      } else if (e.type === 'SESSION_EXPIRED') {
        dialog.showMessageBox(win, { type: 'info', title: 'Garmin', message: 'The Garmin sign-in page timed out. It has been reloaded; please try again.' });
        load();
      } else if (e.type === 'USER_EXIT') {
        win.close();
      }
    };
    win.webContents.ipc.on('garmin:bridge', onBridge);

    win.webContents.on('did-finish-load', () => log(`page loaded: ${safePath(win.webContents.getURL())}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !delivered) log(`navigation failed: ${desc} (${code}) ${safePath(url)}`);
    });
    win.on('closed', () => {
      if (!delivered) resolve(null);
    });
    load();
  });
}

function safePath(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}

/** Strava OAuth in a window. Resolves with the callback URL (http://localhost/strava?...), or null if closed. */
export function stravaSignIn(parent, authorizeURL) {
  return new Promise((resolve) => {
    const partition = `strava-signin-${Date.now()}`;
    const win = signInWindow(parent, 'Connect Strava', partition, null);
    const ses = session.fromPartition(partition);
    let done = false;
    const redirect = new URL(STRAVA_REDIRECT);
    ses.webRequest.onBeforeRequest({ urls: [`${redirect.protocol}//${redirect.host}/*`] }, (details, callback) => {
      callback({ cancel: true });
      if (!done && details.url.startsWith(STRAVA_REDIRECT)) {
        done = true;
        resolve(details.url);
        setImmediate(() => !win.isDestroyed() && win.close());
      }
    });
    win.on('closed', () => {
      if (!done) resolve(null);
    });
    win.loadURL(authorizeURL);
  });
}
