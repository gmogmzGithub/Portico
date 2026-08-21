const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const {
  buildChatWorkspaceConsentCancelledResult,
  buildChatWorkspaceConsentTimeoutResult,
  normalizeChatWorkspaceConsentRequest,
} = require("./chat-workspace-consent-flows");
const {
  normalizeAbsoluteWorkspacePath,
  validateAndApplyChatWorkspaceSelection,
} = require("./chat-workspace-application");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function loadChatWorkspaceConsentRendererContext() {
  const source = read("electron-app/src/renderer/components/chat-workspace-consent-modal.js");
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

test("chat workspace consent request accepts absolute and home-relative paths", () => {
  const request = normalizeChatWorkspaceConsentRequest(
    {
      chat_id: "chat-1",
      host_path: "/Users/dsantiago/Projects/example",
      preamble: "  Explain **why** this folder is needed.  ",
      timeout_seconds: 30,
    },
    { homeDir: "/Users/dsantiago" },
  );

  assert.equal(request.chatId, "chat-1");
  assert.equal(request.hostPath, "/Users/dsantiago/Projects/example");
  assert.equal(request.displayPath, "~/Projects/example");
  assert.equal(request.preamble, "Explain **why** this folder is needed.");
  assert.equal(request.timeoutSeconds, 30);

  const homeRequest = normalizeChatWorkspaceConsentRequest(
    {
      chat_id: "chat-1",
      host_path: "~/.snowflake",
      timeout_seconds: 30,
    },
    { homeDir: "/Users/dsantiago" },
  );

  assert.equal(homeRequest.hostPath, "/Users/dsantiago/.snowflake");
  assert.equal(homeRequest.displayPath, "~/.snowflake");
  assert.equal(homeRequest.preamble, null);

  assert.equal(
    normalizeChatWorkspaceConsentRequest(
      { chat_id: "chat-1", host_path: "~/.snowflake", preamble: "   " },
      { homeDir: "/Users/dsantiago" },
    ).preamble,
    null,
  );
  assert.throws(
    () =>
      normalizeChatWorkspaceConsentRequest(
        { chat_id: "chat-1", host_path: "~/.snowflake", preamble: "x".repeat(4001) },
        { homeDir: "/Users/dsantiago" },
      ),
    /preamble must be 4000 characters or fewer/,
  );

  assert.throws(
    () =>
      normalizeChatWorkspaceConsentRequest({
        chat_id: "chat-1",
        host_path: "relative/path",
      }),
    /host_path must be an absolute path/,
  );

  assert.throws(
    () =>
      normalizeChatWorkspaceConsentRequest({
        chat_id: "chat-1",
        host_path: "~other/workspace",
      }),
    /host_path uses unsupported '~user' expansion/,
  );

  assert.throws(
    () =>
      normalizeChatWorkspaceConsentRequest({
        chat_id: "chat-1",
        host_path: "/app/mcpo-runtime-homes/core/agent-vm/.snowflake",
      }),
    /host_path points to an internal container path/,
  );

  const timeout = buildChatWorkspaceConsentTimeoutResult({
    flowId: "flow-1",
    chatId: "chat-1",
    hostPath: "/Users/dsantiago/Projects/example",
    displayPath: "~/Projects/example",
  });
  assert.equal(timeout.success, false);
  assert.equal(timeout.status, "timeout");
});

test("validateAndApplyChatWorkspaceSelection reuses the shared validation, settings, and rebind path", async () => {
  const calls = [];
  const result = await validateAndApplyChatWorkspaceSelection({
    projectRoot: "/tmp/project",
    chatId: "chat-1",
    hostPath: "~/Projects/example",
    homeDir: "/Users/dsantiago",
    env: { TEST_ENV: "1" },
    stat: async (targetPath) => {
      calls.push(["stat", targetPath]);
      return { isDirectory: () => true };
    },
    validateWorkspaceBind: async (targetPath) => {
      calls.push(["validate", targetPath]);
    },
    getSelection: () => ({
      isCustom: false,
      hostPath: "/tmp/project/open-webui-data/workspaces/chat-1",
    }),
    setSelection: async ({ chatId, hostPath }) => {
      calls.push(["set", chatId, hostPath]);
      return {
        chatId,
        hostPath,
        isCustom: Boolean(hostPath),
      };
    },
    rebind: async (chatId, workspacePath) => {
      calls.push(["rebind", chatId, workspacePath]);
      return {
        success: true,
        reboundCount: 0,
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.selection.isCustom, true);
  assert.deepEqual(calls, [
    ["stat", "/Users/dsantiago/Projects/example"],
    ["validate", "/Users/dsantiago/Projects/example"],
    ["set", "chat-1", "/Users/dsantiago/Projects/example"],
    ["rebind", "chat-1", "/Users/dsantiago/Projects/example"],
  ]);
});

test("workspace application path normalization expands supported home-relative paths", () => {
  assert.equal(
    normalizeAbsoluteWorkspacePath("~/.snowflake", {
      homeDir: "/Users/dsantiago",
    }),
    "/Users/dsantiago/.snowflake",
  );
  assert.equal(
    normalizeAbsoluteWorkspacePath("~/Projects/example", {
      homeDir: "/Users/dsantiago",
    }),
    "/Users/dsantiago/Projects/example",
  );
  assert.throws(
    () =>
      normalizeAbsoluteWorkspacePath("~other/workspace", {
        homeDir: "/Users/dsantiago",
      }),
    /Selected workspace folder uses unsupported '~user' expansion/,
  );
  assert.throws(
    () =>
      normalizeAbsoluteWorkspacePath("/app/mcpo-runtime-homes/core/agent-vm/.snowflake", {
        homeDir: "/Users/dsantiago",
      }),
    /Selected workspace folder points to an internal container path/,
  );
});

test("buildChatWorkspaceConsentCancelledResult is terminal and keeps path context", () => {
  const cancelled = buildChatWorkspaceConsentCancelledResult(
    {
      flowId: "flow-cw-1",
      chatId: "chat-1",
      hostPath: "/Users/someone/project",
      displayPath: "~/project",
    },
    "tool_timeout",
  );
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.flow_id, "flow-cw-1");
  assert.equal(cancelled.chat_id, "chat-1");
  assert.equal(cancelled.display_path, "~/project");
  assert.match(cancelled.error, /cancelled before the user responded \(tool_timeout\)/);
});

test("chat workspace consent wiring spans API, IPC, preload, listener, modal, and HTML bootstrapping", () => {
  const api = read("electron-app/src/services/api.js");
  const ipc = read("electron-app/src/services/ipc.js");
  const preload = read("electron-app/src/services/preload.js");
  const chatWebviewPreload = read("electron-app/src/services/chat-webview-preload.js");
  const backendListeners = read("electron-app/src/renderer/components/backend-modal-listeners.js");
  const modalSource = read("electron-app/src/renderer/components/chat-workspace-consent-modal.js");
  const modalHtml = read("electron-app/src/renderer/components/chat-workspace-consent-modal.html");
  const indexHtml = read("electron-app/src/renderer/views/index.html");
  const conversationHtml = read("electron-app/src/renderer/views/conversation-window.html");
  const indexSource = read("electron-app/src/renderer/views/index.js");

  assert.match(api, /apiApp\.post\('\/api\/trigger-chat-workspace-consent-flow'/);
  assert.match(api, /apiApp\.get\('\/api\/chat-workspace-consent-flow-status\/:flowId'/);
  assert.match(api, /apiApp\.post\('\/api\/cancel-chat-workspace-consent-flow'/);
  assert.match(api, /apiApp\.post\('\/api\/cancel-sensitive-info-flow'/);
  assert.match(api, /apiApp\.post\('\/api\/cancel-user-question-flow'/);
  assert.match(api, /function terminateChatWorkspaceConsentFlow\(flowId, result\)/);
  assert.match(api, /function terminateSensitiveInfoFlow\(flowId, result\)/);
  assert.match(api, /function terminateUserQuestionFlow\(flowId, result\)/);
  assert.match(api, /preamble:\s*normalizedRequest\.preamble/);
  assert.match(
    api,
    /sendBackendModalRequest\("chat-workspace-consent-requested",\s*payload,\s*\{[\s\S]*activateFallback:\s*false/s,
  );
  assert.match(ipc, /ipcMain\.on\("chat-workspace-consent-completed"/);
  assert.match(ipc, /ipcMain\.handle\("chat-workspace-consent-open-path"/);
  assert.match(ipc, /validateAndApplyChatWorkspaceSelection\(\{[\s\S]*hostPath:\s*entry\.hostPath/s);
  assert.match(ipc, /emitChatWorkspaceSelectionUpdated\(\{[\s\S]*applicationResult,[\s\S]*modalTarget:\s*payload\.modal_target/s);
  assert.match(ipc, /owuiViews\.sendToView\([\s\S]*"owui-chat-workspace-selection-updated"/s);
  assert.match(ipc, /owuiViews\.broadcastToViews\("owui-chat-workspace-selection-updated"/);
  assert.match(preload, /onChatWorkspaceConsentRequested:\s*\(callback\)\s*=>/);
  assert.match(preload, /openChatWorkspaceConsentPath:\s*\(payload\)\s*=>/);
  assert.match(
    chatWebviewPreload,
    /ipcRenderer\.on\('owui-chat-workspace-selection-updated'[\s\S]*new CustomEvent\('chat-workspace-selection-updated'/s,
  );
  // The kind's registry record supplies the IPC event and the runner; the
  // generic wiring loop turns that record into the listener. [^}]*? keeps the
  // match inside this kind's object literal.
  assert.match(
    backendListeners,
    /kind: "chat-workspace-consent",[^}]*?event: "onChatWorkspaceConsentRequested",/s,
  );
  assert.match(
    backendListeners,
    /kind: "chat-workspace-consent",[^}]*?runner: runChatWorkspaceConsentFlow,/s,
  );
  assert.match(
    backendListeners,
    /for \(const spec of BACKEND_MODAL_KINDS\)[\s\S]*?window\.electronAPI\?\.\[spec\.event\]\?\.\(\(payload\) => \{[\s\S]*?runOrDeferBackendModal\(spec\.kind, payload, options, spec\.runner\)/,
  );
  assert.match(backendListeners, /__modalTarget:\s*payload\.__modalTarget \|\| null/);
  assert.match(backendListeners, /display_path,\s*preamble,\s*timeout_seconds/);
  assert.match(modalHtml, /background:\s*rgba\(30,\s*35,\s*36,\s*0\.95\)/);
  assert.match(modalHtml, /background:\s*var\(--bg-secondary,\s*#2d3233\)/);
  assert.match(modalHtml, /border-radius:\s*16px/);
  assert.match(modalHtml, /animation:\s*chatWorkspaceConsentSlideIn 0\.3s ease-out/);
  assert.match(modalHtml, /class="chat-workspace-consent-title-row"/);
  assert.match(modalHtml, /id="chat-workspace-consent-hide-btn"/);
  assert.match(modalHtml, /aria-label="Hide workspace permission and return to chat"/);
  assert.match(modalHtml, /id="chat-workspace-consent-preamble"[^>]*hidden/);
  assert.match(modalHtml, /id="chat-workspace-consent-title-logo-badge"/);
  assert.match(modalHtml, /id="chat-workspace-consent-title-logo"/);
  assert.match(modalHtml, /id="chat-workspace-consent-title-logo-fallback">AI<\/span>/);
  assert.match(modalHtml, /\.chat-workspace-consent-title-logo-badge\.has-logo-image\s*\{[^}]*background:\s*#ffffff;/s);
  assert.match(modalHtml, /\.chat-workspace-consent-title-logo-badge\.dark-badge-light-mode\s*\{[^}]*background:\s*#000000;/s);
  assert.match(modalHtml, /\.chat-workspace-consent-title-logo\s*\{[^}]*object-fit:\s*contain;/s);
  assert.match(modalHtml, /class="chat-workspace-consent-panel"/);
  assert.match(modalHtml, /class="chat-workspace-consent-tag">Workspace<\/span>/);
  assert.match(modalHtml, /Allow the agent to work inside of this folder\?/);
  assert.match(modalHtml, /class="chat-workspace-consent-footer"/);
  assert.match(modalHtml, /chat-workspace-consent-btn-secondary/);
  assert.match(modalHtml, /chat-workspace-consent-btn-primary/);
  assert.match(modalHtml, /\[data-theme="light"\] \.chat-workspace-consent-modal/);
  assert.match(modalSource, /renderer\.renderSafeModalPreamble\(/);
  // PORTICO-348: hideChatWorkspaceConsentModal now takes an options argument so a
  // navigation park can be distinguished from an explicit Hide. Pinning its
  // signature never exercised the behaviour; Hide semantics are covered in
  // chat-workspace-consent-modal-lifecycle.unit.test.js.
  assert.match(modalSource, /kind: "chat_workspace_consent"/);
  assert.match(modalSource, /onNativeInputReopenRequested/);
  assert.match(modalSource, /onNativeInputTerminal/);
  assert.match(preload, /setNativeInputPresentation/);
  assert.match(chatWebviewPreload, /getNativeInputPresentationSnapshot/);
  assert.match(chatWebviewPreload, /reopenNativeInput/);
  assert.match(modalHtml, /@media \(max-width:\s*720px\)/);
  assert.match(modalHtml, /<svg width="18" height="18" viewBox="0 0 24 24"/);
  assert.match(modalHtml, /id="chat-workspace-consent-open-btn"[\s\S]*Open/);
  assert.match(modalHtml, /id="chat-workspace-consent-approve-btn"[\s\S]*Allow/);
  assert.doesNotMatch(modalHtml, /Set Workspace/);
  assert.match(modalSource, /function resolveChatWorkspaceConsentRequesterIdentityFromOwui\(chatId,\s*modalTarget = null\)/);
  assert.match(modalSource, /pushCandidate\(modalTarget\?\.viewKey\)/);
  assert.match(
    modalSource,
    /resolveLogoUrl\(logoModelPayload\?\.info\?\.meta\?\.profile_image_url\)\s*\|\|\s*resolveLogoUrl\(logoModelPayload\?\.meta\?\.profile_image_url\)\s*\|\|\s*resolveLogoUrl\(logoModelPayload\?\.profile_image_url\)/s,
  );
  assert.match(
    modalSource,
    /let logoDataUrl = await fetchImageDataUrl\(profileImageUrl,\s*headers\);\s*if \(!logoDataUrl\) \{\s*logoDataUrl = await fetchImageDataUrl\(fallbackImageUrl\.toString\(\),\s*headers\);/s,
  );
  assert.match(
    modalSource,
    /needsDarkBadge:\s*brandFamily === "openai" && celestialIdentity === null/,
  );
  assert.match(modalSource, /elements\.titleLogoBadge\.classList\.toggle\("has-logo-image", hasLogoImage\);/);
  assert.match(
    modalHtml,
    /\.chat-workspace-consent-title-logo-badge\.has-logo-image\.celestial-logo\s*\{[^}]*padding:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
  );
  // PORTICO-348: identity hydration takes the flow rather than a bare flow id, so a
  // request pending in a background chat resolves against its own chat and view.
  // Covered behaviourally in chat-workspace-consent-modal-lifecycle.unit.test.js.
  assert.match(modalSource, /modal_target:\s*chatWorkspaceConsentState\.modalTarget/);
  assert.match(modalSource, /elements\.path\.textContent\s*=[\s\S]*displayPath[\s\S]*hostPath/s);
  assert.match(modalSource, /elements\.path\.title\s*=\s*chatWorkspaceConsentState\.hostPath/);
  assert.match(modalSource, /openChatWorkspaceConsentPath\?\.\(\{[\s\S]*flow_id:\s*chatWorkspaceConsentState\.flowId/s);
  assert.match(modalSource, /notifyChatWorkspaceConsentCompleted\?\.\(\{[\s\S]*action:\s*"approved"/s);
  assert.match(modalSource, /notifyChatWorkspaceConsentCompleted\?\.\(\{[\s\S]*action:\s*"dismissed"/s);
  assert.match(indexHtml, /<div id="chat-workspace-consent-container"><\/div>/);
  assert.match(indexHtml, /<script src="renderer\/components\/chat-workspace-consent-modal\.js"><\/script>/);
  assert.match(conversationHtml, /<div id="chat-workspace-consent-container"><\/div>/);
  assert.match(conversationHtml, /<script src="renderer\/components\/chat-workspace-consent-modal\.js"><\/script>/);
  assert.match(indexSource, /'chat-workspace-consent-modal': '#chat-workspace-consent-modal\.visible'/);
});

test("chat workspace consent uses unpadded celestial logos without changing generic OpenAI badges", () => {
  const {
    normalizeChatWorkspaceConsentRequesterIdentity,
    resolveChatWorkspaceConsentCelestialIdentity,
  } = loadChatWorkspaceConsentRendererContext();

  assert.equal(
    resolveChatWorkspaceConsentCelestialIdentity({
      modelId: "openai/responses/gpt-5.6-sol-pro:latest",
    }),
    "sol",
  );
  assert.equal(
    resolveChatWorkspaceConsentCelestialIdentity({ modelId: "GPT-5.6 Terra" }),
    "terra",
  );
  assert.equal(
    resolveChatWorkspaceConsentCelestialIdentity({ modelId: "GPT-5.6 Luna" }),
    "luna",
  );

  const celestialIdentity = normalizeChatWorkspaceConsentRequesterIdentity({
    displayName: "GPT-5.6 Terra",
    modelId: "GPT-5.6 Terra",
    logoDataUrl: "data:image/png;base64,celestial",
    needsDarkBadge: true,
  });
  assert.equal(celestialIdentity.needsDarkBadge, false);
  assert.equal(celestialIdentity.isCelestialLogo, true);

  const genericOpenAiIdentity = normalizeChatWorkspaceConsentRequesterIdentity({
    displayName: "GPT-5.5",
    modelId: "GPT-5.5",
    logoDataUrl: "data:image/png;base64,gpt",
  });
  assert.equal(genericOpenAiIdentity.needsDarkBadge, true);
  assert.equal(genericOpenAiIdentity.isCelestialLogo, false);

  const derivedIdentity = normalizeChatWorkspaceConsentRequesterIdentity({
    displayName: "GPT-5.6 Luna",
    modelId: "portico_agent_custom",
    logoDataUrl: "data:image/png;base64,custom",
    isDerivedModel: true,
  });
  assert.equal(derivedIdentity.celestialIdentity, null);
  assert.equal(derivedIdentity.needsDarkBadge, true);
  assert.equal(derivedIdentity.isCelestialLogo, false);
});
