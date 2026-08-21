const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const {
  buildSensitiveInfoPreambleTree,
  normalizeSensitiveInfoPreambleUrl,
  renderSensitiveInfoPreamble,
} = require("../renderer/components/sensitive-info-markdown-renderer");

function loadSensitiveInfoRendererContext() {
  const source = read("electron-app/src/renderer/components/sensitive-info-modal.js");
  const context = {
    window: {},
    document: {},
    navigator: {},
    console,
    URL,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context);
  return context;
}

test("sensitive info modal uses masked input and does not log submitted values", () => {
  const html = read("electron-app/src/renderer/components/sensitive-info-modal.html");
  const source = read("electron-app/src/renderer/components/sensitive-info-modal.js");

  assert.match(html, /class="sensitive-info-title-logo-badge" id="sensitive-info-title-logo-badge"/);
  assert.match(html, /class="sensitive-info-title-logo" id="sensitive-info-title-logo"/);
  assert.match(html, /id="sensitive-info-title-logo-fallback">AI<\/span>/);
  assert.match(html, /class="sensitive-info-panel"/);
  assert.match(html, /id="sensitive-info-header-tag">Sensitive info<\/span>/);
  assert.match(html, /aria-describedby="sensitive-info-preamble sensitive-info-prompt sensitive-info-disclosure"/);
  assert.match(html, /id="sensitive-info-preamble" class="sensitive-info-preamble" hidden/);
  assert.match(html, /id="sensitive-info-disclosure" class="sensitive-info-disclosure"/);
  assert.match(html, /id="sensitive-info-close-btn"[\s\S]*<svg[\s\S]*<line x1="18" y1="6"/);
  assert.match(html, /id="sensitive-info-hide-btn"/);
  assert.match(html, /aria-label="Hide secure request and return to chat"/);
  assert.match(html, /class="sensitive-info-footer"/);
  assert.match(html, /class="sensitive-info-actions-left"[\s\S]*sensitive-info-btn-secondary/);
  assert.match(html, /class="sensitive-info-actions-right"[\s\S]*sensitive-info-btn-primary/);
  assert.match(html, /id="sensitive-info-input"[\s\S]*type="password"/);
  assert.match(html, /id="sensitive-info-submit-btn"[\s\S]*Submit/);
  assert.match(html, /\.sensitive-info-content\s*\{[\s\S]*border-radius:\s*16px;[\s\S]*width:\s*min\(720px,\s*94vw\);/s);
  assert.match(source, /const SENSITIVE_INFO_FIXED_DISCLOSURE_TEXT =\s*"It will be stored securely, automatically deleted after 15 minutes, and will not be shown in the chat or shown to the model\."/);
  assert.match(source, /const SENSITIVE_INFO_INPUT_PLACEHOLDER =\s*"Type or paste the requested information here"/);
  assert.match(source, /elements\.disclosure\.textContent = SENSITIVE_INFO_FIXED_DISCLOSURE_TEXT;/);
  assert.match(source, /elements\.input\.placeholder = SENSITIVE_INFO_INPUT_PLACEHOLDER;/);
  assert.match(source, /renderer\.renderSafeModalPreamble\([\s\S]*elements\.preamble,[\s\S]*sensitiveInfoState\.preamble/s);
  assert.doesNotMatch(source, /elements\.input\.placeholder\s*=\s*sensitiveInfoState\.placeholder/);
  assert.match(source, /notifySensitiveInfoCompleted\?\.\(\{[\s\S]*sensitive_value:\s*sensitiveValue/s);
  assert.match(source, /function buildFallbackSensitiveInfoRequesterIdentity\(overrides = \{\}\)\s*\{[\s\S]*fallbackText:\s*"AI"/s);
  assert.match(source, /function buildSensitiveInfoRequesterResolutionScript\(\{ chatId,\s*language \}\)/);
  assert.match(source, /\/api\/v1\/chats\/\\\$\{encodeURIComponent\(CHAT_ID\)\}/);
  assert.match(source, /\/models\/model\/profile\/image/);
  assert.match(source, /elements\.titleLogoBadge\.classList\.toggle\("has-logo-image",\s*hasLogoImage\);/);
  assert.match(source, /elements\.titleLogoBadge\.classList\.toggle\(\s*"dark-badge-light-mode"/s);
  assert.match(
    html,
    /\.sensitive-info-title-logo-badge\.has-logo-image\.celestial-logo\s*\{[^}]*padding:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
  );
  // PORTICO-348: identity hydration is now per flow (it takes the flow, not a bare
  // flow id) so a prompt pending in a background chat resolves against its own
  // chat. Behaviour is covered in sensitive-info-modal-lifecycle.unit.test.js.
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^)]*sensitiveValue/s);
  assert.match(source, /window\.runSensitiveInfoModal\s*=\s*runSensitiveInfoModal;/);
  assert.match(source, /window\.closeSensitiveInfoModal\s*=\s*closeSensitiveInfoModal;/);
});

// PORTICO-348: this was a source-text pin on hideSensitiveInfoModal's body. It
// broke the moment the function took an options argument, and it never actually
// exercised the behaviour. The rules it protected -- Hide must not settle the
// flow or clear the masked draft, and must release interaction suppression --
// are now executable in sensitive-info-modal-lifecycle.unit.test.js
// ("Hide keeps the flow pending and preserves the masked draft"), alongside the
// per-chat scoping tests.

test("sensitive info preamble keeps allowlisted Markdown and removes active content", () => {
  const tree = buildSensitiveInfoPreambleTree(
    [
      "Follow **these steps** and use `Generate token`.",
      "",
      "1. [Open settings](https://example.test/settings)",
      "2. [Unsafe](javascript:alert(1)) ![tracking](https://example.test/pixel.png) <b>raw text</b>",
      "",
      "<script>alert('nope')</script>",
    ].join("\n"),
  );
  const rendered = JSON.stringify(tree);

  assert.match(rendered, /"tag":"strong"/);
  assert.match(rendered, /"tag":"code"/);
  assert.match(rendered, /"tag":"ol"/);
  assert.match(rendered, /https:\/\/example\.test\/settings/);
  assert.match(rendered, /Unsafe/);
  assert.match(rendered, /tracking/);
  assert.doesNotMatch(rendered, /javascript:/);
  assert.doesNotMatch(rendered, /pixel\.png/);
  assert.doesNotMatch(rendered, /"tag":"script"/);
  assert.doesNotMatch(rendered, /alert\('nope'\)/);
  assert.equal(normalizeSensitiveInfoPreambleUrl("data:text/html,nope"), null);
  assert.equal(normalizeSensitiveInfoPreambleUrl("https://example.test"), "https://example.test/");
});

test("sensitive info preamble links open externally without clearing the modal content", () => {
  class FakeNode {
    constructor(tag, text = "") {
      this.tag = tag;
      this.text = text;
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.hidden = false;
    }

    appendChild(child) {
      this.children.push(child);
    }

    replaceChildren() {
      this.children = [];
    }

    setAttribute(name, value) {
      this.attributes[name] = value;
    }

    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }
  }

  const documentRef = {
    createTextNode: (text) => new FakeNode("#text", text),
    createElement: (tag) => new FakeNode(tag),
  };
  const container = new FakeNode("div");
  const opened = [];
  renderSensitiveInfoPreamble(
    container,
    "[Open Snowflake](https://app.snowflake.com/settings)",
    {
      documentRef,
      openExternal: (url) => opened.push(url),
    },
  );

  const anchor = container.children[0].children[0];
  let prevented = false;
  anchor.listeners.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened, ["https://app.snowflake.com/settings"]);
  assert.equal(container.hidden, false);
  assert.equal(container.children.length, 1);
});

test("sensitive info modal uses unpadded celestial logos without changing generic OpenAI badges", () => {
  const {
    normalizeResolvedSensitiveInfoRequesterIdentity,
    resolveSensitiveInfoCelestialIdentity,
  } = loadSensitiveInfoRendererContext();

  assert.equal(
    resolveSensitiveInfoCelestialIdentity({
      modelId: "openai/responses/gpt-5.6-sol:latest",
    }),
    "sol",
  );
  assert.equal(
    resolveSensitiveInfoCelestialIdentity({ modelId: "GPT-5.6 Terra" }),
    "terra",
  );
  assert.equal(
    resolveSensitiveInfoCelestialIdentity({ modelId: "portico-openai/gpt-5.6-luna" }),
    "luna",
  );

  const celestialIdentity = normalizeResolvedSensitiveInfoRequesterIdentity({
    displayName: "GPT-5.6 Luna",
    modelId: "GPT-5.6 Luna",
    logoDataUrl: "data:image/png;base64,celestial",
    needsDarkBadge: true,
  });
  assert.equal(celestialIdentity.needsDarkBadge, false);
  assert.equal(celestialIdentity.isCelestialLogo, true);

  const genericOpenAiIdentity = normalizeResolvedSensitiveInfoRequesterIdentity({
    displayName: "GPT-5.5",
    modelId: "GPT-5.5",
    logoDataUrl: "data:image/png;base64,gpt",
  });
  assert.equal(genericOpenAiIdentity.needsDarkBadge, true);
  assert.equal(genericOpenAiIdentity.isCelestialLogo, false);

  const derivedIdentity = normalizeResolvedSensitiveInfoRequesterIdentity({
    displayName: "GPT-5.6 Sol",
    modelId: "portico_agent_custom",
    logoDataUrl: "data:image/png;base64,custom",
    isDerivedModel: true,
  });
  assert.equal(derivedIdentity.celestialIdentity, null);
  assert.equal(derivedIdentity.needsDarkBadge, true);
  assert.equal(derivedIdentity.isCelestialLogo, false);
});

test("sensitive info modal strips caller-supplied disclosure wording from displayed prompt", () => {
  const { buildSensitiveInfoDisplayPrompt } = loadSensitiveInfoRendererContext();

  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Please enter your API key. It will be stored securely in a temporary workspace file and used by code execution without ever being displayed in chat.",
      "API key",
    ),
    "Please enter your API key.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Paste your Snowflake programmatic access token. It will be stored in a temporary file and will not be shown to the model.",
      "Snowflake PAT",
    ),
    "Paste your Snowflake programmatic access token.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Please enter your API key. It will be stored securely, automatically deleted after 15 minutes, and will not be shown in the chat or shown to the model.",
      "API key",
    ),
    "Please enter your API key.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "It will be stored in a temporary file and will not be shown to the model.",
      "API key",
    ),
    "Please enter API key.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Enter the API key you'd like to provide for use in code execution.",
      "API key",
    ),
    "Enter the API key you'd like to provide.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Enter the API key you'd like to provide to be used by code execution.",
      "API key",
    ),
    "Enter the API key you'd like to provide.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Paste the token for the Agent VM.",
      "Token",
    ),
    "Paste the token.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Paste the password inside the sandbox.",
      "Password",
    ),
    "Paste the password.",
  );
  assert.equal(
    buildSensitiveInfoDisplayPrompt(
      "Provide the credential for /work.",
      "Credential",
    ),
    "Provide the credential.",
  );
});

test("sensitive info visual aids preload at decoration and size-adapt the tooltip", () => {
  const html = read("electron-app/src/renderer/components/sensitive-info-modal.html");
  const source = read("electron-app/src/renderer/components/sensitive-info-modal.js");

  // Decoration kicks off the fire-and-forget preload for each appended button
  // and skips aids whose image already failed (no dead magnifiers, no
  // per-keystroke re-fetch churn).
  const decorate =
    source.match(
      /function decorateSensitiveInfoPreambleVisualAids\(\)[\s\S]*?\n\}/,
    )?.[0] || "";
  assert.match(decorate, /preloadSensitiveInfoVisualAid\(aid,\s*button\);/);
  assert.match(decorate, /aid\.loadFailed/);

  // Preload caches on the aid, warns once, and removes the (still-connected)
  // magnifier when the screenshot cannot load. No timers involved.
  const preload =
    source.match(/function preloadSensitiveInfoVisualAid\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(preload, /aid\.dataUrlPromise\s*=\s*fetchSensitiveInfoVisualAidDataUrl\(aid\.imageUrl\);/);
  assert.match(preload, /aid\.dataUrl\s*=\s*dataUrl;/);
  assert.match(preload, /measureSensitiveInfoVisualAidNaturalSize/);
  assert.match(preload, /\.catch\(\(error\)\s*=>\s*\{[\s\S]*console\.warn[\s\S]*button\.isConnected[\s\S]*button\.remove\(\);/s);
  assert.doesNotMatch(preload, /setTimeout|setInterval/);

  // Natural dimensions are captured via an offscreen Image after the data URL
  // resolves and drive the --large tooltip variant.
  assert.match(source, /function measureSensitiveInfoVisualAidNaturalSize\(dataUrl\)/);
  assert.match(source, /naturalWidth/);
  assert.match(source, /const SENSITIVE_INFO_VISUAL_AID_LARGE_MIN_NATURAL_WIDTH = 600;/);

  // The shared tooltip always drops the --large class first, re-adds it for
  // large captures, and only then sets the image + positions.
  const show =
    source.match(
      /async function showSensitiveInfoVisualAidTooltip\([\s\S]*?\n\}/,
    )?.[0] || "";
  assert.match(show, /classList\.remove\("sensitive-info-visual-aid-tooltip--large"\)/);
  assert.match(show, /classList\.add\("sensitive-info-visual-aid-tooltip--large"\)/);
  const classToggleIndex = show.indexOf('classList.remove("sensitive-info-visual-aid-tooltip--large")');
  const imageSrcIndex = show.indexOf("image.src = aid.dataUrl");
  const positionIndex = show.indexOf("positionSensitiveInfoVisualAidTooltip(button)");
  assert.ok(classToggleIndex !== -1 && imageSrcIndex !== -1 && positionIndex !== -1);
  assert.ok(classToggleIndex < imageSrcIndex, "class toggle must precede image set");
  assert.ok(imageSrcIndex < positionIndex, "positioning must follow image set");
  assert.match(show, /image\.complete[\s\S]*requestAnimationFrame[\s\S]*image\.onload/s);
  // Round 9: the shared <img> drops the previous hover's onload BEFORE the new
  // src is assigned, and deferred repositions are token-guarded so a stale
  // callback can never re-anchor the tooltip to an earlier magnifier.
  const onloadClearIndex = show.indexOf("image.onload = null;");
  assert.ok(
    onloadClearIndex !== -1 && onloadClearIndex < imageSrcIndex,
    "stale onload must be cleared before the new src is assigned",
  );
  assert.match(
    show,
    /const repositionIfCurrent = \(\) => \{\s*if \(sensitiveInfoVisualAidShowToken === showToken\) \{\s*positionSensitiveInfoVisualAidTooltip\(button\);/s,
  );
  assert.match(show, /requestAnimationFrame\(repositionIfCurrent\);/);
  assert.match(show, /image\.onload = repositionIfCurrent;/);

  // Round 9: the tooltip ALWAYS opens to the right of the magnifier — the
  // positioner sets the available-space custom property and never flips left.
  const position =
    source.match(
      /function positionSensitiveInfoVisualAidTooltip\([\s\S]*?\n\}/,
    )?.[0] || "";
  assert.match(
    position,
    /Math\.min\(rect\.right \+ 10, window\.innerWidth - tipRect\.width - margin\)/,
  );
  assert.match(
    position,
    /setProperty\(\s*"--sensitive-info-aid-fit",\s*`\$\{Math\.max\(160, available\)\}px`,?\s*\)/,
  );
  assert.doesNotMatch(position, /rect\.left - tipRect\.width/);

  // CSS: base tooltip rules unchanged; --large variant only widens dimensions.
  // Round-8 sizing: previews render ~30% smaller than the original caps.
  // Round 9: the caps gain the --sensitive-info-aid-fit term so the tooltip
  // shrinks into the space right of the magnifier instead of flipping left.
  assert.match(
    html,
    /\.sensitive-info-visual-aid-tooltip\s*\{[^}]*max-width:\s*min\(266px,\s*calc\(100vw - 32px\),\s*var\(--sensitive-info-aid-fit,\s*9999px\)\);/s,
  );
  assert.match(
    html,
    /\.sensitive-info-visual-aid-tooltip img\s*\{[^}]*max-height:\s*224px;/s,
  );
  assert.match(
    html,
    /\.sensitive-info-visual-aid-tooltip--large\s*\{\s*max-width:\s*min\(49vw,\s*630px,\s*var\(--sensitive-info-aid-fit,\s*9999px\)\);\s*\}/s,
  );
  assert.match(
    html,
    /\.sensitive-info-visual-aid-tooltip--large img\s*\{\s*max-height:\s*min\(49vh,\s*504px\);\s*\}/s,
  );
});

test("visual aid tooltip stays right-anchored and ignores stale image callbacks", async () => {
  const source = read("electron-app/src/renderer/components/sensitive-info-modal.js");

  // Fake singleton tooltip + <img>. The module's internal singleton variable
  // is lexical (unreachable from the vm global), so the fakes are adopted the
  // same way the browser wires them: through document.createElement inside
  // ensureSensitiveInfoVisualAidTooltip.
  const styleProps = {};
  const image = { complete: false, onload: null, src: "", alt: "" };
  const tooltip = {
    hidden: true,
    className: "",
    classList: { remove() {}, add() {} },
    style: {
      setProperty(name, value) {
        styleProps[name] = value;
      },
    },
    setAttribute() {},
    appendChild() {},
    querySelector: () => image,
    getBoundingClientRect: () => ({ width: 266, height: 200 }),
  };
  let mountedTooltip = null;
  const modal = {
    contains: (node) => node === mountedTooltip,
    appendChild: (node) => {
      mountedTooltip = node;
    },
  };

  const context = {
    window: { innerWidth: 1400, innerHeight: 900 },
    document: {
      createElement: (tag) => (tag === "img" ? image : tooltip),
    },
    navigator: {},
    console,
    URL,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => cb(),
  };
  vm.runInNewContext(source, context);
  context.getSensitiveInfoElements = () => ({ modal });

  // Record which button anchors each placement by wrapping the global
  // positioner (unqualified internal calls resolve through the vm global).
  const positionedAgainst = [];
  const realPosition = context.positionSensitiveInfoVisualAidTooltip;
  context.positionSensitiveInfoVisualAidTooltip = (button) => {
    positionedAgainst.push(button.label);
    return realPosition(button);
  };

  const makeButton = (label, rightEdge) => ({
    label,
    isConnected: true,
    getBoundingClientRect: () => ({
      right: rightEdge,
      left: rightEdge - 24,
      top: 300,
    }),
  });
  const buttonA = makeButton("A", 500);
  const buttonB = makeButton("B", 700);
  const aidA = { step: 1, dataUrl: "data:image/png;base64,AA==", naturalWidth: 400, alt: "a" };
  const aidB = { step: 2, dataUrl: "data:image/png;base64,BB==", naturalWidth: 400, alt: "b" };

  // Hover A: image not complete, so A parks an onload callback.
  await context.showSensitiveInfoVisualAidTooltip(buttonA, aidA);
  const staleOnload = image.onload;
  assert.equal(typeof staleOnload, "function");

  // Hover B before A's image ever loads. In a real browser, assigning the new
  // src on the shared <img> fires a load event — simulate the worst case where
  // A's callback is still reachable and fires while B is current.
  await context.showSensitiveInfoVisualAidTooltip(buttonB, aidB);
  positionedAgainst.length = 0;
  staleOnload();
  assert.deepEqual(
    positionedAgainst,
    [],
    "a stale onload from a previous hover must never reposition the tooltip",
  );
  assert.equal(typeof image.onload, "function");
  image.onload();
  assert.deepEqual(positionedAgainst, ["B"]);

  // Always-right invariant: the placement uses the CURRENT button's right
  // edge and publishes the available-space fit constraint (window 1400 wide,
  // icon right edge 700 → left 710, fit 1400-700-10-12 = 678px).
  assert.equal(tooltip.style.left, `${700 + 10}px`);
  assert.equal(styleProps["--sensitive-info-aid-fit"], "678px");
});

test("visual aid preload removes the magnifier and warns once when the image cannot load", async () => {
  const source = read("electron-app/src/renderer/components/sensitive-info-modal.js");
  const warnings = [];
  const context = {
    window: {},
    document: {},
    navigator: {},
    console: { ...console, warn: (...args) => warnings.push(args) },
    URL,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context);

  const makeButton = () => ({
    isConnected: true,
    removed: false,
    remove() {
      this.removed = true;
      this.isConnected = false;
    },
  });
  const aid = {
    step: 1,
    imageUrl: "http://localhost:9876/workspace/chat-1/skill-assets/setup/step-1.png",
    dataUrl: null,
    dataUrlPromise: null,
    naturalSizePromise: null,
    naturalWidth: 0,
    naturalHeight: 0,
    loadFailed: false,
  };

  // fetch is undefined in the VM context, so the preload fetch rejects.
  const connectedButton = makeButton();
  context.preloadSensitiveInfoVisualAid(aid, connectedButton);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(connectedButton.removed, true);
  assert.equal(aid.loadFailed, true);
  assert.equal(warnings.length, 1);

  // Re-render mid-flight: a button that is no longer connected is a no-op,
  // and the failure is only warned once per aid.
  const detachedButton = makeButton();
  detachedButton.isConnected = false;
  context.preloadSensitiveInfoVisualAid(aid, detachedButton);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detachedButton.removed, false);
  assert.equal(warnings.length, 1);
});

test("sensitive info wiring spans preload API, backend listener, and HTML bootstrapping", () => {
  const preload = read("electron-app/src/services/preload.js");
  const api = read("electron-app/src/services/api.js");
  const ipc = read("electron-app/src/services/ipc.js");
  const backendListeners = read("electron-app/src/renderer/components/backend-modal-listeners.js");
  const indexHtml = read("electron-app/src/renderer/views/index.html");
  const conversationHtml = read("electron-app/src/renderer/views/conversation-window.html");
  const indexSource = read("electron-app/src/renderer/views/index.js");

  assert.match(preload, /onSensitiveInfoRequested:\s*\(callback\)\s*=>\s*\{[\s\S]*ipcRenderer\.on\('sensitive-info-requested'/s);
  assert.match(preload, /notifySensitiveInfoCompleted:\s*\(payload\)\s*=>\s*ipcRenderer\.send\('sensitive-info-completed',\s*payload\)/);
  assert.match(api, /apiApp\.post\('\/api\/trigger-sensitive-info-flow'/);
  assert.match(api, /preamble:\s*normalizedRequest\.preamble/);
  assert.match(api, /apiApp\.get\('\/api\/sensitive-info-flow-status\/:flowId'/);
  assert.match(api, /state\.sensitiveInfoFlowResults\.delete\(flowId\)/);
  assert.match(ipc, /ipcMain\.on\("sensitive-info-completed",/);
  // The kind's registry record supplies the IPC event and the runner; the
  // generic wiring loop turns that record into the listener. [^}]*? keeps the
  // match inside this kind's object literal.
  assert.match(
    backendListeners,
    /kind: "sensitive-info",[^}]*?event: "onSensitiveInfoRequested",/s,
  );
  assert.match(
    backendListeners,
    /kind: "sensitive-info",[^}]*?runner: runSensitiveInfoFlow,/s,
  );
  assert.match(
    backendListeners,
    /for \(const spec of BACKEND_MODAL_KINDS\)[\s\S]*?window\.electronAPI\?\.\[spec\.event\]\?\.\(\(payload\) => \{[\s\S]*?runOrDeferBackendModal\(spec\.kind, payload, options, spec\.runner\)/,
  );
  assert.match(indexSource, /'sensitive-info-modal': '#sensitive-info-modal\.visible'/);
  assert.match(indexHtml, /<div id="sensitive-info-container"><\/div>/);
  assert.match(indexHtml, /<script src="renderer\/dist\/sensitive-info-markdown-renderer\.bundle\.js"><\/script>[\s\S]*<script src="renderer\/components\/sensitive-info-modal\.js"><\/script>/s);
  assert.match(conversationHtml, /<div id="sensitive-info-container"><\/div>/);
  assert.match(conversationHtml, /<script src="renderer\/dist\/sensitive-info-markdown-renderer\.bundle\.js"><\/script>[\s\S]*<script src="renderer\/components\/sensitive-info-modal\.js"><\/script>/s);
});
