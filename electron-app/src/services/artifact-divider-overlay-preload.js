const { ipcRenderer } = require('electron');

let dragging = false;
let hovering = false;

function send(channel, payload = {}) {
  ipcRenderer.send(channel, payload);
}

function setHovering(nextHovering) {
  const normalized = Boolean(nextHovering);
  if (hovering === normalized) {
    return;
  }

  hovering = normalized;
  send(normalized ? 'artifact-divider-overlay-hover-start' : 'artifact-divider-overlay-hover-end');
}

window.addEventListener('mouseenter', () => {
  setHovering(true);
});

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0) {
    return;
  }

  dragging = true;
  send('artifact-divider-overlay-drag-start', {
    screenX: Number.isFinite(Number(event.screenX)) ? Number(event.screenX) : null,
  });
  event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
  if (!dragging) {
    return;
  }

  send('artifact-divider-overlay-drag-move', {
    screenX: Number.isFinite(Number(event.screenX)) ? Number(event.screenX) : null,
  });
});

window.addEventListener('mouseup', (event) => {
  if (!dragging) {
    return;
  }

  dragging = false;
  send('artifact-divider-overlay-drag-end', {
    screenX: Number.isFinite(Number(event.screenX)) ? Number(event.screenX) : null,
  });
});

window.addEventListener('mouseleave', () => {
  setHovering(false);
  document.body.style.cursor = 'col-resize';
});

ipcRenderer.on('artifact-divider-overlay-state', (_event, payload = {}) => {
  dragging = Boolean(payload.dragging);
  document.body.style.cursor = 'col-resize';
});
