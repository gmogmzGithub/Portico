const { BrowserWindow } = require('electron');

const FRAME_SEND_FAILURE_RE =
  /render frame was disposed|webframemain|frame[^\n]*disposed|cannot send messages to a destroyed renderer|object has been destroyed/i;
const RECOVERY_SIGNAL_CHANNEL = 'force-webview-recovery';
const RECOVERY_SIGNAL_COOLDOWN_MS = 15000;

const recoverySignalTimestamps = new Map();

function resolveWebContents(target) {
  if (!target) {
    return null;
  }

  if (typeof target.send === 'function' && typeof target.getType === 'function') {
    return target;
  }

  if (target.webContents && typeof target.webContents.send === 'function') {
    return target.webContents;
  }

  return null;
}

function getErrorDetails(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
  };
}

function getWebContentsDescriptor(target, webContents) {
  const descriptor = {
    webContentsId: webContents?.id,
    windowId: null,
    type: null,
    url: null,
  };

  const ownerWindow = BrowserWindow.fromWebContents(webContents);
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    descriptor.windowId = ownerWindow.id;
  } else if (target && typeof target.id === 'number') {
    descriptor.windowId = target.id;
  }

  try {
    descriptor.type = webContents?.getType?.() || null;
  } catch (error) {
    descriptor.type = 'unknown';
  }

  try {
    descriptor.url = webContents?.getURL?.() || null;
  } catch (error) {
    descriptor.url = null;
  }

  return descriptor;
}

function isFrameSendFailure(error) {
  const message = String(error?.message || '');
  return FRAME_SEND_FAILURE_RE.test(message);
}

function shouldEmitRecoverySignal(webContents, channel) {
  if (!webContents || typeof webContents.id !== 'number') {
    return false;
  }

  if (channel === RECOVERY_SIGNAL_CHANNEL) {
    return false;
  }

  const now = Date.now();
  const lastSignalAt = recoverySignalTimestamps.get(webContents.id) || 0;
  if (now - lastSignalAt < RECOVERY_SIGNAL_COOLDOWN_MS) {
    return false;
  }

  recoverySignalTimestamps.set(webContents.id, now);
  return true;
}

function emitRecoverySignal(webContents, payload) {
  const trySend = (attemptsRemaining) => {
    if (!webContents || webContents.isDestroyed()) {
      return;
    }

    try {
      webContents.send(RECOVERY_SIGNAL_CHANNEL, payload);
    } catch (error) {
      if (attemptsRemaining > 1) {
        setTimeout(() => trySend(attemptsRemaining - 1), 150);
      } else {
        console.warn('[SafeSend] Failed to emit renderer recovery signal:', {
          payload,
          error: getErrorDetails(error),
        });
      }
    }
  };

  setTimeout(() => trySend(2), 0);
}

function safeWebContentsSend(target, channel, data, options = {}) {
  const {
    tag = 'ipc-send',
    meta = null,
    emitRendererRecoverySignal = true,
  } = options;

  const webContents = resolveWebContents(target);
  if (!webContents) {
    console.warn(`[SafeSend:${tag}] Could not resolve webContents for channel '${channel}'`, {
      meta,
    });
    return false;
  }

  if (webContents.isDestroyed()) {
    console.warn(`[SafeSend:${tag}] Target webContents already destroyed for '${channel}'`, {
      ...getWebContentsDescriptor(target, webContents),
      meta,
    });
    return false;
  }

  try {
    webContents.send(channel, data);
    return true;
  } catch (error) {
    const descriptor = getWebContentsDescriptor(target, webContents);
    const errorDetails = getErrorDetails(error);

    console.error(`[SafeSend:${tag}] Failed to send '${channel}'`, {
      ...descriptor,
      meta,
      error: errorDetails,
    });

    if (
      emitRendererRecoverySignal &&
      isFrameSendFailure(error) &&
      shouldEmitRecoverySignal(webContents, channel)
    ) {
      emitRecoverySignal(webContents, {
        reason: 'frame-send-failure',
        failedChannel: channel,
        tag,
        webContentsId: descriptor.webContentsId,
        windowId: descriptor.windowId,
        error: errorDetails,
        meta,
      });
    }

    return false;
  }
}

async function safeExecuteJavaScript(target, script, options = {}) {
  const { tag = 'execute-javascript', meta = null, rethrow = false } = options;

  const webContents = resolveWebContents(target);
  if (!webContents) {
    const error = new Error('Could not resolve webContents for executeJavaScript');
    console.warn(`[SafeExec:${tag}] ${error.message}`, { meta });
    if (rethrow) {
      throw error;
    }
    return null;
  }

  if (webContents.isDestroyed()) {
    const error = new Error('Target webContents destroyed before executeJavaScript');
    console.warn(`[SafeExec:${tag}] ${error.message}`, {
      ...getWebContentsDescriptor(target, webContents),
      meta,
    });
    if (rethrow) {
      throw error;
    }
    return null;
  }

  try {
    return await webContents.executeJavaScript(script);
  } catch (error) {
    console.error(`[SafeExec:${tag}] executeJavaScript failed`, {
      ...getWebContentsDescriptor(target, webContents),
      meta,
      error: getErrorDetails(error),
    });

    if (rethrow) {
      throw error;
    }
    return null;
  }
}

module.exports = {
  isFrameSendFailure,
  safeWebContentsSend,
  safeExecuteJavaScript,
};
