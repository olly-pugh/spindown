// Runs in Garmin's sign-in page before its own scripts. Provides the native bridge the page expects inside
// Garmin Connect Mobile: window.webkit.messageHandlers.GMNEventHandler.postMessage(event) on iOS, and
// window.GMNEventHandler.postMessage(event) as on Android. Messages are forwarded to the app.
const { contextBridge, ipcRenderer } = require('electron');

function post(body) {
  let text;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    text = String(body);
  }
  ipcRenderer.send('garmin:bridge', text);
}

const handler = { postMessage: post };
contextBridge.exposeInMainWorld('webkit', { messageHandlers: { GMNEventHandler: handler } });
contextBridge.exposeInMainWorld('GMNEventHandler', handler);

// The page is styled for a dark host, as in the iPhone app.
window.addEventListener('DOMContentLoaded', () => {
  try {
    document.documentElement.style.background = '#000';
  } catch {
    // ignore
  }
});
