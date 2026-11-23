// The bridge between the app window and the main process. Everything the window can ask for is listed here.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (fn) => {
  const listener = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('spindown', {
  app: {
    info: invoke('app:info'),
    openExternal: invoke('app:openExternal'),
    openFolder: invoke('app:openFolder'),
    keepAwake: invoke('app:keepAwake'),
    setRidePhase: invoke('app:setRidePhase'),
    readyToClose: invoke('app:readyToClose'),
    saveText: invoke('app:saveText'),
    capturePicture: invoke('app:capturePicture'),
    installUpdate: invoke('app:installUpdate'),
    checkForUpdates: invoke('app:checkForUpdates'),
    onUpdate: on('app:update'),
    onFinishAndClose: on('app:finishAndClose'),
  },
  game: {
    load: invoke('game:load'),
    save: invoke('game:save'),
  },
  settings: {
    all: invoke('settings:all'),
    set: invoke('settings:set'),
  },
  log: {
    write: (message, level) => ipcRenderer.send('log:write', message, level),
    recent: invoke('log:recent'),
    onEvent: on('log:event'),
  },
  journal: {
    open: invoke('journal:open'),
    append: (line, sync) => ipcRenderer.send('journal:append', line, !!sync),
    appendPacket: (line) => ipcRenderer.send('journal:appendPacket', line),
    flush: invoke('journal:flush'),
    read: invoke('journal:read'),
    discard: invoke('journal:discard'),
    moveAside: invoke('journal:moveAside'),
    save: invoke('journal:save'),
  },
  rides: {
    list: invoke('rides:list'),
    track: invoke('rides:track'),
    rename: invoke('rides:rename'),
    delete: invoke('rides:delete'),
    export: invoke('rides:export'),
    exportRaw: invoke('rides:exportRaw'),
    picture: invoke('rides:picture'),
    copyPicture: invoke('rides:copyPicture'),
    savePicture: invoke('rides:savePicture'),
    onChange: on('rides:changed'),
  },
  uploads: {
    state: invoke('uploads:state'),
    enqueue: invoke('uploads:enqueue'),
    process: invoke('uploads:process'),
    onState: on('uploads:state'),
  },
  accounts: {
    garminSignIn: invoke('accounts:garminSignIn'),
    garminTest: invoke('accounts:garminTest'),
    garminSignOut: invoke('accounts:garminSignOut'),
    stravaCredentials: invoke('accounts:stravaCredentials'),
    stravaSetCredentials: invoke('accounts:stravaSetCredentials'),
    stravaSignIn: invoke('accounts:stravaSignIn'),
    stravaVerify: invoke('accounts:stravaVerify'),
    stravaSignOut: invoke('accounts:stravaSignOut'),
  },
  ble: {
    start: invoke('ble:start'),
    select: invoke('ble:select'),
    onDevices: on('ble:devices'),
  },
});
