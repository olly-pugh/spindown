// The Garmin sign-in bridge: garmin-preload.cjs must hand the page's events, including the login ticket, to the
// app. `pageSend` is Garmin's own dispatch function from its sign-in page (sso.garmin.com/mobile/assets/index-*.js,
// November 2026), de-minified but otherwise unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { garminBridgeEvent } from '../src/core/services.js';

const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'garmin-preload.cjs');

/** Runs the preload as Electron would and returns the page's window plus what reached the app over IPC. */
function loadPreload() {
  const window = { addEventListener() {} };
  const sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => (window[key] = api) },
    ipcRenderer: { send: (channel, text) => sent.push({ channel, text }) },
  };
  vm.runInNewContext(fs.readFileSync(preloadPath, 'utf8'), { require: (m) => (m === 'electron' ? electron : null), window, document: {} });
  return { window, sent };
}

function pageSend(window, e) {
  try {
    if (window.GMNEventHandler) window.GMNEventHandler.handleEvent(JSON.stringify(e));
    else if (window.webkit?.messageHandlers?.GMNEventHandler) window.webkit.messageHandlers.GMNEventHandler.postMessage(e);
    else return false;
  } catch {
    return false; // the page only logs "Error calling thick client event handler"
  }
  return true;
}

test('the login ticket sent by Garmin\'s page reaches the app', () => {
  const { window, sent } = loadPreload();
  const ok = pageSend(window, {
    eventType: 'USER_AUTHENTICATED',
    flowName: 'AUTHENTICATION',
    logMessage: '',
    data: { serviceTicket: 'ST-0123456-abcdef-cas', serviceUrl: 'https://mobile.integration.garmin.com/gcm/ios' },
  });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'garmin:bridge');
  const e = garminBridgeEvent(JSON.parse(sent[0].text));
  assert.equal(e.type, 'USER_AUTHENTICATED');
  assert.equal(e.ticket, 'ST-0123456-abcdef-cas');
});

test('page messages such as a wrong password reach the app', () => {
  const { window, sent } = loadPreload();
  pageSend(window, { eventType: 'COMMUNICATION', flowName: 'AUTHENTICATION', logMessage: '', data: { communication: { type: 'ERROR', message: 'Invalid sign in.' } } });
  assert.equal(garminBridgeEvent(JSON.parse(sent[0].text)).message, 'Invalid sign in.');
});

test('the preload does not define the Android-style global the page would try first', () => {
  const { window } = loadPreload();
  assert.equal(window.GMNEventHandler, undefined);
});
