const { contextBridge, ipcRenderer } = require('electron');

const OWNER_EVENT_CHANNEL = 'local-find-overlay-window-event';

function sendEvent(type, detail = {}) {
  if (!type) {
    return;
  }

  ipcRenderer.send(OWNER_EVENT_CHANNEL, {
    type,
    ...detail,
  });
}

contextBridge.exposeInMainWorld('localFindOverlayWindowAPI', {
  onState: (callback) => {
    ipcRenderer.on('local-find-overlay-state', (_event, payload) => callback(payload));
  },
  sendEvent,
});

window.addEventListener('blur', () => {
  sendEvent('release-focus', { reason: 'blur' });
});
