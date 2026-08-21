const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function cssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} CSS block should exist`);
  return match[1];
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(name) {
    this.values.add(name);
  }

  remove(name) {
    this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    if (force === true || (force === undefined && !this.values.has(name))) {
      this.values.add(name);
      return true;
    }
    this.values.delete(name);
    return false;
  }
}

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.innerHTML = "";
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
  }

  addEventListener(eventName, listener) {
    const listeners = this.listeners.get(eventName) || [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll() {
    return [];
  }

  async trigger(eventName, event = {}) {
    for (const listener of this.listeners.get(eventName) || []) {
      await listener({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
}

async function runModalConfigureOutcome(configureResult, options = {}) {
  const elementIds = [
    "host-mcp-bridge-config-modal",
    "host-mcp-bridge-config-close-btn",
    "host-mcp-config-cancel-btn",
    "host-mcp-client-grid",
    "host-mcp-config-select-all-btn",
    "host-mcp-configure-btn",
    "host-mcp-remove-config-btn",
    "host-mcp-config-status",
  ];
  const elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
  const documentListeners = new Map();
  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener(eventName, listener) {
      const listeners = documentListeners.get(eventName) || [];
      listeners.push(listener);
      documentListeners.set(eventName, listeners);
    },
  };
  const client = {
    id: "claude-code",
    displayName: "Claude Code",
    detected: true,
    selectable: true,
    configured: false,
    status: "detected",
    statusText: "Detected",
    ...(options.client || {}),
  };
  const window = {
    detectCalls: 0,
    electronAPI: {
      async hostMcpBridgeConfigDetect() {
        window.detectCalls += 1;
        return { success: true, clients: [client] };
      },
      async hostMcpBridgeConfigureClients() {
        return configureResult;
      },
    },
  };
  const source = read("electron-app/src/renderer/components/host-mcp-bridge-config-modal.js");
  vm.runInNewContext(source, { document, window, console, Error, Map, Promise, Set });
  for (const listener of documentListeners.get("DOMContentLoaded") || []) {
    listener();
  }
  await window.openHostMcpBridgeConfigModal();
  const configuring = options.skipConfigure === true
    ? Promise.resolve()
    : elements.get("host-mcp-configure-btn").trigger("click");
  await Promise.resolve();
  await options.whileConfiguring?.({ elements, window });
  await configuring;
  return {
    detectCalls: window.detectCalls,
    gridHtml: elements.get("host-mcp-client-grid").innerHTML,
    status: elements.get("host-mcp-config-status").textContent,
    statusClasses: elements.get("host-mcp-config-status").classList,
    configureDisabled: elements.get("host-mcp-configure-btn").disabled,
  };
}

function readRgbaPng(filePath) {
  const input = fs.readFileSync(filePath);
  assert.deepEqual([...input.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    offset += 4;
    const type = input.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    const data = input.subarray(offset, offset + length);
    offset += length + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * bytesPerPixel);
  let sourceOffset = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? rgba[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? rgba[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? rgba[prevStart + x - bytesPerPixel] : 0;
      const value = filter === 0 ? raw
        : filter === 1 ? raw + left
          : filter === 2 ? raw + up
            : filter === 3 ? raw + Math.floor((left + up) / 2)
              : filter === 4 ? raw + paeth(left, up, upLeft)
                : assert.fail(`Unsupported PNG filter ${filter}`);
      rgba[rowStart + x] = value & 0xff;
    }
    sourceOffset += stride;
  }
  return {
    width,
    height,
    alphaAt: (x, y) => rgba[(y * width + x) * bytesPerPixel + 3],
    alphaBounds: (threshold = 10) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const alpha = rgba[(y * width + x) * bytesPerPixel + 3];
          if (alpha > threshold) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      assert.ok(maxX >= minX && maxY >= minY, "PNG should contain visible pixels");
      return {
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      };
    },
  };
}

function assertNormalizedAlphaBounds(name, png) {
  const bounds = png.alphaBounds();
  const normalizedWidth = Math.round((bounds.width / png.width) * 512);
  const normalizedHeight = Math.round((bounds.height / png.height) * 512);
  assert.ok(
    normalizedWidth >= 400 && normalizedWidth <= 430,
    `${name} visible alpha width should normalize to 400-430px, got ${normalizedWidth}px`,
  );
  assert.ok(
    normalizedHeight >= 400 && normalizedHeight <= 430,
    `${name} visible alpha height should normalize to 400-430px, got ${normalizedHeight}px`,
  );
}

test("Host MCP Bridge service row exposes the config control beside logs", () => {
  const html = read("electron-app/src/renderer/views/index.html");
  const footerMatch = html.match(/<div class="host-mcp-config-footer">[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(footerMatch, "Host MCP footer should exist");
  const footerHtml = footerMatch[0];

  assert.match(
    html,
    /id="host-mcp-bridge-config-btn"[\s\S]*class="service-logs-btn-compact"\s+data-service="host-mcp-bridge"[\s\S]*Host MCP Bridge/,
  );
  assert.doesNotMatch(html, /host-mcp-bridge-power-btn/);
  assert.match(html, /id="host-mcp-bridge-config-modal"/);
  assert.match(html, /id="host-mcp-client-grid"/);
  assert.match(html, /class="host-mcp-client-grid"\s+id="host-mcp-client-grid"/);
  assert.doesNotMatch(html, /class="server-grid host-mcp-client-grid"/);
  assert.match(html, /id="host-mcp-config-select-all-btn"[\s\S]*Select all/);
  assert.match(footerHtml, /class="setup-wizard-modal-buttons host-mcp-config-buttons"/);
  assert.match(footerHtml, /class="btn btn-secondary"\s+id="host-mcp-config-cancel-btn"/);
  assert.match(footerHtml, /class="btn btn-danger"\s+id="host-mcp-remove-config-btn"\s+type="button"\s+disabled\s+hidden[\s\S]*Remove configuration/);
  assert.match(footerHtml, /class="btn btn-primary"\s+id="host-mcp-configure-btn"/);
  assert.doesNotMatch(footerHtml, /oauth-buttons|oauth-btn/);
  assert.match(html, /renderer\/components\/host-mcp-bridge-config-modal\.js/);
});

test("Host MCP Bridge modal renderer wires card selection and configure calls", () => {
  const modalSource = read("electron-app/src/renderer/components/host-mcp-bridge-config-modal.js");
  const indexSource = read("electron-app/src/renderer/views/index.js");

  assert.doesNotMatch(indexSource, /host-mcp-bridge-power-btn/);
  assert.doesNotMatch(indexSource, /handleHostMcpBridgePowerClick/);
  assert.doesNotMatch(indexSource, /stopHostMcpBridge/);
  assert.match(indexSource, /openHostMcpBridgeConfigFromServiceDrawer/);
  assert.doesNotMatch(indexSource, /window\.electronAPI\?\.hostMcpBridgeStart/);
  assert.match(indexSource, /host-mcp-bridge-config-btn/);
  assert.match(indexSource, /openHostMcpBridgeConfigModal/);
  assert.match(indexSource, /hostMcpBridgeConfigBtn\.addEventListener\('click', openHostMcpBridgeConfigFromServiceDrawer\)/);
  assert.match(indexSource, /window\.ensureControlPlaneTabActive\?\.\(\);\s*await waitForNextAnimationFrame\(\);/);
  assert.match(modalSource, /hostMcpBridgeConfigDetect/);
  assert.match(modalSource, /hostMcpBridgeConfigureClients/);
  assert.match(modalSource, /Starting bridge and configuring selected clients/);
  assert.match(modalSource, /Bridge is running\. Configuration complete\./);
  assert.match(modalSource, /hostMcpBridgeRemoveClientConfigs/);
  assert.match(modalSource, /hostMcpBridgeRevealClientConfig/);
  assert.match(modalSource, /Select all/);
  assert.match(modalSource, /Deselect all/);
  assert.match(modalSource, /host-mcp-client-card/);
  assert.match(modalSource, /host-mcp-client-pill-action/);
  assert.match(modalSource, /Open configuration file location/);
  assert.match(modalSource, /selectedConfiguredClients/);
  assert.match(modalSource, /const shouldShow = selectedCount > 0 \|\| state\.busyAction === "remove";/);
  assert.match(modalSource, /removeBtn\.hidden = !shouldShow;/);
  assert.match(modalSource, /removeBtn\.textContent = "Remove configuration";/);
  assert.match(modalSource, /Remove 1 configuration/);
  assert.doesNotMatch(modalSource, /Remove 0 configurations/);
  assert.match(modalSource, /Removing selected configurations/);
  assert.match(modalSource, /function handleDocumentKeydown\(event\)/);
  assert.match(modalSource, /event\.key !== "Escape" \|\| !modal\?\.classList\.contains\("visible"\)/);
  assert.match(modalSource, /event\.preventDefault\(\);\s*closeModal\(\);/);
  assert.match(modalSource, /document\.addEventListener\("keydown", handleDocumentKeydown\);/);
  assert.match(modalSource, /host-mcp-client-logo-fallback/);
  assert.match(modalSource, /alt=""/);
  assert.match(modalSource, /onerror="this\.hidden=true;this\.parentElement\.classList\.add\('logo-failed'\)"/);
  assert.doesNotMatch(modalSource, /alt="\$\{escapeHtml\(client\.displayName\)\}"/);
  assert.doesNotMatch(modalSource, /mcp-card-description/);
  assert.doesNotMatch(modalSource, /mcp-card-badges/);
  assert.doesNotMatch(modalSource, /MCPB/);
  assert.doesNotMatch(modalSource, /is-mcpb/);
  assert.doesNotMatch(modalSource, /installConfirmationRequired/);
  assert.doesNotMatch(modalSource, /Install confirmation opened/);
  assert.doesNotMatch(modalSource, /host-mcp-config-result/);
  assert.doesNotMatch(modalSource, /renderResults/);
  assert.doesNotMatch(modalSource, /Restart Claude Desktop to load changes/);
  assert.doesNotMatch(modalSource, /clientId\s*===\s*"claude-desktop"/);
  assert.match(modalSource, /You may need to restart configured clients for changes to take effect/);
  assert.match(modalSource, /Configured/);
  assert.match(modalSource, /client\.configured === true/);
  assert.match(modalSource, /client\.selectable === true/);
});

test("Host MCP Bridge modal renders bounded client errors and only valid restart guidance", async () => {
  const failed = await runModalConfigureOutcome({
    success: false,
    error: "Host MCP Bridge did not become healthy",
    results: [{
      clientId: "claude-code",
      success: false,
      error: `spawn claude ENOENT <script>alert(1)</script> ${"x".repeat(500)}`,
    }],
  });
  assert.equal(failed.status, "Bridge setup did not complete. Host MCP Bridge did not become healthy");
  assert.equal(failed.statusClasses.contains("error"), true);
  assert.doesNotMatch(failed.status, /restart/i);
  assert.match(failed.gridHtml, /host-mcp-client-error/);
  assert.match(failed.gridHtml, /spawn claude ENOENT &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(failed.gridHtml, /<script>/);
  const renderedError = failed.gridHtml.match(/class="host-mcp-client-error"[^>]*>([^<]+)<\/span>/)?.[1] || "";
  const renderedText = renderedError
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  assert.equal(renderedText.length <= 320, true);

  const noRestart = await runModalConfigureOutcome({
    success: true,
    results: [{ clientId: "claude-code", success: true, restartRequired: false }],
  });
  assert.equal(noRestart.status, "Bridge is running. Configuration complete.");
  assert.doesNotMatch(noRestart.status, /restart/i);

  const restart = await runModalConfigureOutcome({
    success: true,
    results: [{ clientId: "claude-code", success: true, restartRequired: true }],
  });
  assert.match(restart.status, /restart configured clients/i);
  assert.equal(restart.statusClasses.contains("success"), true);
});

test("Host MCP Bridge modal keeps Configure available for repairable clients", async () => {
  const repairable = await runModalConfigureOutcome(null, {
    skipConfigure: true,
    client: {
      repairNeeded: true,
      status: "needs_repair",
      statusText: "Needs repair",
    },
  });

  assert.match(repairable.gridHtml, /Needs repair/);
  assert.match(repairable.gridHtml, /host-mcp-client-card selected needs-repair/);
  assert.match(repairable.gridHtml, /host-mcp-client-pill is-repair-needed/);
  assert.match(repairable.gridHtml, /host-mcp-client-pill-alert/);
  assert.match(repairable.gridHtml, /aria-pressed="true"/);
  assert.equal(repairable.configureDisabled, false);
});

test("Host MCP Bridge modal does not start overlapping detection when reopened during configuration", async () => {
  let finishConfiguration;
  const configureResult = new Promise((resolve) => {
    finishConfiguration = resolve;
  });
  const outcome = await runModalConfigureOutcome(configureResult, {
    async whileConfiguring({ elements, window }) {
      await elements.get("host-mcp-config-cancel-btn").trigger("click");
      await window.openHostMcpBridgeConfigModal();
      assert.equal(window.detectCalls, 1);
      finishConfiguration({
        success: false,
        error: "Host MCP Bridge did not become healthy",
        results: [],
      });
    },
  });

  assert.equal(outcome.detectCalls, 2);
  assert.equal(outcome.status, "Bridge setup did not complete. Host MCP Bridge did not become healthy");
});

test("Host MCP Bridge modal has compact scoped grid and control styling", () => {
  const css = read("electron-app/src/styles.css");
  const contentBlock = cssBlock(css, ".host-mcp-config-content");
  const specificContentBlock = cssBlock(css, ".host-mcp-config-modal .host-mcp-config-content");
  const gridBlock = cssBlock(css, ".host-mcp-client-grid");
  const cardBlock = cssBlock(css, ".host-mcp-client-card");
  const footerBlock = cssBlock(css, ".host-mcp-config-footer");
  const buttonsBlock = cssBlock(css, ".host-mcp-config-buttons");
  const hiddenButtonBlock = cssBlock(css, ".host-mcp-config-buttons .btn[hidden]");
  const dangerButtonBlock = cssBlock(css, ".host-mcp-config-buttons .btn-danger");
  const setupWizardDarkPrimaryBlock = cssBlock(css, '[data-theme="dark"] .setup-wizard-modal-buttons .btn-primary');
  const logoBlock = cssBlock(css, ".host-mcp-client-logo");
  const imageBlock = cssBlock(css, ".host-mcp-client-logo-img");
  const configBtnFocusBlock = cssBlock(css, ".service-card-compact #host-mcp-bridge-config-btn:focus-visible");
  const html = read("electron-app/src/renderer/views/index.html");

  assert.match(contentBlock, /max-width:\s*700px;/);
  assert.doesNotMatch(contentBlock, /max-height:/);
  assert.doesNotMatch(contentBlock, /overflow:\s*hidden/);
  assert.match(specificContentBlock, /width:\s*min\(92vw,\s*700px\);/);
  assert.match(specificContentBlock, /max-width:\s*700px;/);
  assert.match(html, /class="oauth-modal host-mcp-config-modal"[\s\S]*class="oauth-modal-content host-mcp-config-content"/);
  assert.match(html, /\.oauth-modal-content\s*\{[\s\S]*max-width:\s*550px;[\s\S]*width:\s*95%;/);
  assert.match(css, /\.host-mcp-config-modal\s+\.host-mcp-config-content\s*\{[\s\S]*width:\s*min\(92vw,\s*700px\);[\s\S]*max-width:\s*700px;/);
  assert.match(css, /\.host-mcp-client-grid\s*\{[\s\S]*display:\s*grid;/);
  assert.match(gridBlock, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(gridBlock, /gap:\s*1rem;/);
  assert.match(gridBlock, /overflow:\s*visible;/);
  assert.doesNotMatch(gridBlock, /overflow-y:\s*auto/);
  assert.doesNotMatch(gridBlock, /overflow-x:\s*hidden/);
  assert.doesNotMatch(gridBlock, /scrollbar-gutter/);
  assert.match(css, /\.host-mcp-config-content\s+\.server-selection-link\s*\{[\s\S]*appearance:\s*none;[\s\S]*background:\s*transparent;/);
  assert.match(css, /\.host-mcp-client-card\s*\{[\s\S]*grid-template-columns:\s*48px\s+minmax\(0,\s*1fr\)\s+24px;/);
  assert.match(cardBlock, /gap:\s*0\.85rem;/);
  assert.match(cardBlock, /padding:\s*0\.78rem\s+0\.9rem;/);
  assert.match(footerBlock, /display:\s*flex;/);
  assert.match(footerBlock, /justify-content:\s*center;/);
  assert.match(buttonsBlock, /gap:\s*0\.75rem;/);
  assert.match(buttonsBlock, /margin:\s*0\s+auto;/);
  assert.match(buttonsBlock, /width:\s*min\(560px,\s*100%\);/);
  assert.match(hiddenButtonBlock, /display:\s*none;/);
  assert.match(dangerButtonBlock, /background:\s*#ef4444;/);
  assert.match(dangerButtonBlock, /border-radius:\s*0\.375rem;/);
  assert.match(dangerButtonBlock, /cursor:\s*pointer;/);
  assert.match(dangerButtonBlock, /transition:\s*background 0\.15s ease;/);
  assert.match(css, /\.host-mcp-config-buttons\s+\.btn-danger:hover:not\(:disabled\)\s*\{[\s\S]*background:\s*#dc2626;/);
  assert.match(css, /\.host-mcp-client-pill-action\s*\{[\s\S]*cursor:\s*pointer;/);
  assert.match(setupWizardDarkPrimaryBlock, /color:\s*#ffffff;/);
  assert.match(logoBlock, /background:\s*transparent;/);
  assert.match(logoBlock, /border:\s*none;/);
  assert.match(logoBlock, /border-radius:\s*0;/);
  assert.match(logoBlock, /height:\s*48px;/);
  assert.match(logoBlock, /width:\s*48px;/);
  assert.match(imageBlock, /display:\s*block;/);
  assert.match(imageBlock, /height:\s*48px;/);
  assert.match(imageBlock, /object-fit:\s*contain;/);
  assert.match(imageBlock, /padding:\s*0;/);
  assert.match(imageBlock, /width:\s*48px;/);
  assert.match(configBtnFocusBlock, /outline:\s*2px solid var\(--accent-primary\);/);
  assert.match(configBtnFocusBlock, /outline-offset:\s*2px;/);
  assert.doesNotMatch(css, /service-power-btn-compact/);
  assert.match(css, /\[data-theme="light"\] \.service-card-compact #host-mcp-bridge-config-btn\s*\{[^}]*color:\s*#9a3412;/);
  assert.doesNotMatch(imageBlock, /background:/);
  assert.doesNotMatch(imageBlock, /border-radius:/);
  assert.doesNotMatch(css, /is-mcpb/);
  assert.match(css, /\.host-mcp-client-pill\.is-configured\s*\{/);
  assert.match(css, /\.host-mcp-client-pill\.is-error\s*\{/);
  assert.doesNotMatch(css, /host-mcp-config-results/);
  assert.doesNotMatch(css, /host-mcp-config-result/);
  assert.doesNotMatch(html, /host-mcp-config-results/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*\.host-mcp-config-modal\s+\.host-mcp-config-content\s*\{[\s\S]*width:\s*min\(95vw,\s*560px\);[\s\S]*max-width:\s*min\(95vw,\s*560px\);/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*\.host-mcp-client-grid\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
});

test("Host MCP Bridge config IPC and preload expose narrow redacted methods", () => {
  const preloadSource = read("electron-app/src/services/preload.js");
  const ipcSource = read("electron-app/src/services/ipc.js");

  assert.match(preloadSource, /hostMcpBridgeConfigDetect:\s*\(\) => ipcRenderer\.invoke\('host-mcp-bridge-config-detect'\)/);
  assert.match(preloadSource, /hostMcpBridgeStart:\s*\(\) => ipcRenderer\.invoke\('start-host-mcp-bridge'\)/);
  assert.match(preloadSource, /hostMcpBridgeConfigureClients:\s*\(payload\) => ipcRenderer\.invoke\('host-mcp-bridge-configure-clients', payload\)/);
  assert.match(preloadSource, /hostMcpBridgeRemoveClientConfigs:\s*\(payload\) => ipcRenderer\.invoke\('host-mcp-bridge-remove-client-configs', payload\)/);
  assert.match(preloadSource, /hostMcpBridgeRevealClientConfig:\s*\(payload\) => ipcRenderer\.invoke\('host-mcp-bridge-reveal-client-config', payload\)/);
  assert.match(ipcSource, /ipcMain\.handle\("host-mcp-bridge-config-detect"/);
  assert.match(ipcSource, /ipcMain\.handle\("start-host-mcp-bridge"/);
  assert.match(ipcSource, /ipcMain\.handle\("host-mcp-bridge-configure-clients"/);
  assert.match(ipcSource, /ipcMain\.handle\("host-mcp-bridge-remove-client-configs"/);
  assert.match(ipcSource, /ipcMain\.handle\("host-mcp-bridge-reveal-client-config"/);
  assert.match(ipcSource, /ipcMain\.handle\("host-mcp-bridge-status"[\s\S]*await checkDockerStatus\(\);/);
  assert.match(ipcSource, /bridgeStatus === "running"/);
  assert.match(ipcSource, /readHostMcpBridgePreferences/);
  assert.match(ipcSource, /setHostMcpBridgeDesiredEnabled\(true,[\s\S]*source: "ipc_start"/);
  assert.match(ipcSource, /setHostMcpBridgeDesiredEnabled\(false,[\s\S]*source: "ipc_stop"/);
  assert.match(ipcSource, /const result = await stopHostMcpBridge\(\{ reason: "manual_stop" \}\);[\s\S]*if \(!result\?\.success\) \{/);
  assert.match(ipcSource, /getBridgeAuthRedactedStatus/);
  assert.match(ipcSource, /require\("\.\/host-mcp-bridge-telemetry"\)/);
  assert.match(ipcSource, /emitBridgeLogRepoEvent\("bridge_clients_detected"/);
  assert.match(ipcSource, /emitBridgeLogRepoEvent\("client_configure_requested"/);
  assert.match(ipcSource, /Select at least one MCP client to configure\./);
  assert.match(ipcSource, /setHostMcpBridgeDesiredEnabled\(true,[\s\S]*source: "ipc_configure_clients"/);
  assert.match(ipcSource, /const bridgeReady = await ensureHostMcpBridgeReady\(\);/);
  assert.match(ipcSource, /Host MCP Bridge did not become healthy/);
  assert.match(ipcSource, /emitBridgeLogRepoEvent\("client_configure_completed"/);
  assert.match(ipcSource, /bridge_ready: true/);
  assert.match(ipcSource, /await checkDockerStatus\(\);/);
  assert.match(ipcSource, /emitBridgeClientResultEvents\("client_configure"/);
  assert.match(ipcSource, /emitBridgeLogRepoEvent\("client_remove_requested"/);
  assert.match(ipcSource, /emitBridgeLogRepoEvent\("client_remove_completed"/);
  assert.match(ipcSource, /emitBridgeClientResultEvents\("client_remove"/);
  assert.doesNotMatch(preloadSource, /hostMcpBridgeToken/);
});

test("MCP client logo assets are bundled for supported clients only", () => {
  const assetsDir = path.join(REPO_ROOT, "electron-app/assets/mcp-clients");
  for (const name of ["claude.png", "codex.png", "cursor.png", "amp.png"]) {
    const assetPath = path.join(assetsDir, name);
    assert.equal(fs.existsSync(assetPath), true, `${name} should exist`);
    assert.ok(fs.statSync(assetPath).size > 0, `${name} should not be empty`);
  }
  assert.equal(fs.existsSync(path.join(assetsDir, "openai.png")), false);
  const claudePath = path.join(assetsDir, "claude.png");
  const ampPath = path.join(assetsDir, "amp.png");
  const codexPath = path.join(assetsDir, "codex.png");
  const cursorPath = path.join(assetsDir, "cursor.png");
  const claudePng = readRgbaPng(claudePath);
  assert.equal(claudePng.width, 512);
  assert.equal(claudePng.height, 512);
  assert.equal(claudePng.alphaAt(0, 0), 0);
  assert.equal(claudePng.alphaAt(511, 0), 0);
  assert.equal(claudePng.alphaAt(0, 511), 0);
  assert.equal(claudePng.alphaAt(256, 256), 255);
  assertNormalizedAlphaBounds("Claude", claudePng);
  const ampPng = readRgbaPng(ampPath);
  assert.equal(ampPng.width, 512);
  assert.equal(ampPng.height, 512);
  assert.equal(ampPng.alphaAt(0, 0), 0);
  assert.equal(ampPng.alphaAt(511, 0), 0);
  assert.equal(ampPng.alphaAt(0, 511), 0);
  assertNormalizedAlphaBounds("Amp", ampPng);
  const cursorPng = readRgbaPng(cursorPath);
  assert.equal(cursorPng.width, 512);
  assert.equal(cursorPng.height, 512);
  assertNormalizedAlphaBounds("Cursor", cursorPng);
  const codexPng = readRgbaPng(codexPath);
  assert.equal(codexPng.width, 1024);
  assert.equal(codexPng.height, 1024);
  assertNormalizedAlphaBounds("Codex", codexPng);
  const autoConfigSource = read("electron-app/src/services/host-mcp-bridge-auto-config.js");
  assert.match(autoConfigSource, /\.\.\/assets\/mcp-clients\/claude\.png/);
  assert.match(autoConfigSource, /\.\.\/assets\/mcp-clients\/codex\.png/);
  assert.match(autoConfigSource, /\.\.\/assets\/mcp-clients\/cursor\.png/);
  assert.match(autoConfigSource, /\.\.\/assets\/mcp-clients\/amp\.png/);
  assert.doesNotMatch(autoConfigSource, /\.\.\/assets\/mcp-clients\/openai\.png/);
  assert.doesNotMatch(autoConfigSource, /logo:\s*"assets\/mcp-clients\//);
  assert.doesNotMatch(autoConfigSource, /windsurf/i);
});
