const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('artifactVersionMenuAPI', {
  onState: (callback) => {
    ipcRenderer.on('artifact-version-menu-state', (_event, payload) => callback(payload));
  },
  chooseVersion: (version) => {
    ipcRenderer.send('artifact-version-menu-select', { version });
  },
  close: (reason = 'dismiss') => {
    ipcRenderer.send('artifact-version-menu-close', { reason });
  },
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }

  event.preventDefault();
  ipcRenderer.send('artifact-version-menu-close', { reason: 'escape' });
});

window.addEventListener('blur', () => {
  ipcRenderer.send('artifact-version-menu-close', { reason: 'blur' });
});
