// Runs in Garmin's sign-in page before its own scripts. Provides the native bridge the page expects inside
// Garmin Connect Mobile on iOS, window.webkit.messageHandlers.GMNEventHandler.postMessage(event), exactly as the
// iPhone app's WKWebView does. Messages are forwarded to the app.
//
// Do not also define window.GMNEventHandler: the page checks for it first and, if present, calls the Android
// method window.GMNEventHandler.handleEvent(JSON string) instead. Defining only half of that silently drops
// every event, including the login ticket, and the page then spins on /portal/sso/embed.
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

contextBridge.exposeInMainWorld('webkit', { messageHandlers: { GMNEventHandler: { postMessage: post } } });

// The page is styled for a dark host, as in the iPhone app.
window.addEventListener('DOMContentLoaded', () => {
  try {
    document.documentElement.style.background = '#000';
  } catch {
    // ignore
  }
});
