// screen-vpn-check.js
// VPN preflight screen for guided setup

let vpnCheckState = {
  checking: false,
  result: null
};

let _callbacks = null;

function normalizeResult(result) {
  const harbor = result?.harbor || {};
  const cloudsmith = result?.cloudsmith || {};
  return {
    success: result?.success === true,
    harbor: {
      ok: harbor.ok === true,
      error: harbor.error || null
    },
    cloudsmith: {
      ok: cloudsmith.ok === true,
      error: cloudsmith.error || null
    }
  };
}

function getStatusLabel(ok, checking, hasResult) {
  if (checking) return 'Checking...';
  if (!hasResult) return 'Not checked';
  if (ok) return 'Connected';
  return 'Needs VPN';
}

function updateStatusPill(element, ok, checking, hasResult) {
  if (!element) return;
  element.textContent = getStatusLabel(ok, checking, hasResult);
  element.classList.remove('success', 'error', 'pending');
  if (checking || !hasResult) {
    element.classList.add('pending');
  } else if (ok) {
    element.classList.add('success');
  } else {
    element.classList.add('error');
  }
}

function renderVpnCheck() {
  const harborStatus = document.getElementById('vpn-check-harbor-status');
  const cloudsmithStatus = document.getElementById('vpn-check-cloudsmith-status');
  const errorBox = document.getElementById('vpn-check-error');
  const button = document.getElementById('vpn-check-button');

  const result = normalizeResult(vpnCheckState.result);
  const hasResult = !!vpnCheckState.result;
  updateStatusPill(harborStatus, result.harbor.ok, vpnCheckState.checking, hasResult);
  updateStatusPill(cloudsmithStatus, result.cloudsmith.ok, vpnCheckState.checking, hasResult);

  if (button) {
    button.disabled = vpnCheckState.checking;
    button.textContent = vpnCheckState.checking ? 'Checking...' : 'Check VPN & Continue';
  }

  if (!errorBox) return;
  if (!vpnCheckState.result || result.success || vpnCheckState.checking) {
    errorBox.style.display = 'none';
    errorBox.textContent = '';
    return;
  }

  const failures = [];
  if (!result.harbor.ok) failures.push('Harbor registry');
  if (!result.cloudsmith.ok) failures.push('Cloudsmith repository');
  const failureText = failures.length > 0 ? failures.join(' and ') : 'internal services';

  errorBox.style.display = 'block';
  errorBox.textContent = `We could not reach ${failureText}. Please confirm you are connected to the Portico VPN, then try again.`;
}

async function runVpnCheck() {
  if (vpnCheckState.checking) return;
  if (!window.electronAPI?.checkVpnConnectivity) {
    if (_callbacks?.showStage) _callbacks.showStage('prerequisites');
    return;
  }

  vpnCheckState.checking = true;
  renderVpnCheck();

  try {
    const result = await window.electronAPI.checkVpnConnectivity();
    vpnCheckState.result = result;
  } catch (error) {
    vpnCheckState.result = {
      success: false,
      harbor: { ok: false, error: error.message },
      cloudsmith: { ok: false, error: error.message }
    };
  }

  vpnCheckState.checking = false;
  renderVpnCheck();

  if (vpnCheckState.result?.success) {
    if (_callbacks?.showStage) _callbacks.showStage('prerequisites');
  }
}

function loadVpnCheckScreen(setupState, callbacks = {}, options = {}) {
  _callbacks = callbacks;
  vpnCheckState = {
    checking: false,
    result: options.initialResult || null
  };

  renderVpnCheck();
}

module.exports = {
  loadVpnCheckScreen,
  runVpnCheck,
  _test: {
    normalizeResult,
    getStatusLabel,
    renderVpnCheck,
    getState() {
      return vpnCheckState;
    }
  }
};
