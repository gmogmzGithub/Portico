const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function loadUserQuestionRendererContext() {
  const source = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.js",
  );
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

test("user-question modal keeps the OAuth-style drag and overlay suppression path", () => {
  const html = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.html",
  );
  const source = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.js",
  );

  assert.match(
    html,
    /\.platform-darwin\s+\.user-question-modal\.visible\s*\{[^}]*-webkit-app-region:\s*drag;[^}]*\}/s,
  );
  assert.match(
    html,
    /\.platform-darwin\s+\.user-question-content,\s*\.platform-darwin\s+\.user-question-content\s+\*\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*\}/s,
  );
  assert.match(
    source,
    /setOwuiInteractionSuppressed\?\.\("user-question-modal",\s*suppressed\);\s*window\.setNativeOverlayInteractionSuppressed\?\.\("user-question-modal",\s*suppressed\);/s,
  );
  assert.match(
    source,
    /window\.runUserQuestionModal\s*=\s*runUserQuestionModal;\s*window\.closeUserQuestionModal\s*=\s*closeUserQuestionModal;/s,
  );
});

test("user-question modal presents navigable multi-question review controls", () => {
  const html = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.html",
  );
  const source = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.js",
  );

  assert.doesNotMatch(html, /id="user-question-preview"/);
  assert.doesNotMatch(html, /Need Your Input/);
  assert.doesNotMatch(html, /Pick an option for each question/);
  assert.doesNotMatch(source, /All questions answered\. Review anything you want, then submit\./);
  assert.match(html, /id="user-question-title-text"[\s\S]*We need your input\.\.\./);
  assert.match(html, /id="user-question-title-logo-badge"/);
  assert.match(html, /id="user-question-prev-btn"/);
  assert.match(html, /id="user-question-next-btn"/);
  assert.match(html, /id="user-question-submit-btn"[\s\S]*Submit Answers/);
  assert.match(html, /id="user-question-freeform-input"/);
  assert.match(html, /id="user-question-step-indicators"/);
  assert.doesNotMatch(html, /id="user-question-submit-helper"/);
  assert.match(
    source,
    /titleText\.textContent = "We need your input\.\.\.";/s,
  );
  assert.match(
    source,
    /const hasLogoImage = Boolean\(identity\.logoDataUrl\);/s,
  );
  assert.match(
    source,
    /elements\.titleLogoBadge\.classList\.toggle\("has-logo-image", hasLogoImage\);/s,
  );
  assert.match(
    source,
    /const hasPreviousQuestion =[\s\S]*userQuestionState\.questions\.length > 1 && userQuestionState\.currentIndex > 0;/s,
  );
  assert.match(
    source,
    /elements\.prevBtn\.hidden = !hasPreviousQuestion;/s,
  );
  assert.match(
    source,
    /elements\.nextBtn\.hidden = !hasNextQuestion;/s,
  );
  assert.match(
    source,
    /elements\.progressText\.hidden = userQuestionState\.questions\.length <= 1;/s,
  );
  assert.match(source, /const USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID = "none_of_the_above";/);
  assert.match(source, /function doesUserQuestionAnswerCount\(question\)/);
  assert.match(source, /hasUserQuestionFallbackOption\(question\)[\s\S]*answer\.freeformText\.trim\(\)/s);
  assert.match(source, /function freeformSelectionUpdates\(question, value\)/);
  assert.match(source, /return answer\.selectedOptionId\s*\? \{\}\s*:\s*\{ selectedOptionId: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID \}/s);
  assert.match(source, /selectedOptionId:\s*USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID/);
  assert.match(source, /function renderUserQuestionStepIndicators\(\)/);
  assert.match(source, /data-question-index="\$\{index\}"/);
  assert.match(source, /userQuestionState\.currentIndex = questionIndex;/);
  assert.match(source, /renderUserQuestionNavigation\(\);[\s\S]*\};[\s\S]*renderUserQuestionNavigation\(\);/s);
  assert.match(
    html,
    /\.user-question-btn-primary\s*\{[^}]*background:\s*var\(--accent-primary,\s*#4f94ff\);/s,
  );
  assert.match(
    html,
    /\.user-question-option\.selected\s*\{[^}]*background:\s*rgba\(var\(--accent-primary-rgb,\s*79,\s*148,\s*255\),\s*0\.16\);/s,
  );
  assert.match(
    html,
    /\.user-question-content\s*\{[^}]*padding:\s*22px;[^}]*width:\s*min\(720px,\s*94vw\);/s,
  );
  assert.match(
    html,
    /\.user-question-title-logo-badge\.has-logo-image\s*\{[^}]*background:\s*#ffffff;[^}]*box-shadow:\s*0 0 0 1px rgba\(148,\s*163,\s*184,\s*0\.18\);/s,
  );
  assert.match(
    html,
    /\.user-question-title-logo\s*\{[^}]*object-fit:\s*contain;/s,
  );
  assert.match(
    html,
    /\.user-question-title\s*\{[^}]*font-size:\s*18px;/s,
  );
  assert.match(
    html,
    /\.user-question-prompt\s*\{[^}]*font-size:\s*18px;/s,
  );
  assert.match(
    html,
    /\.user-question-freeform textarea\s*\{[^}]*min-height:\s*88px;/s,
  );
  assert.match(
    html,
    /\.user-question-step-indicator\.completed\s*\{[^}]*background:\s*rgba\(var\(--accent-primary-rgb,\s*79,\s*148,\s*255\),\s*0\.16\);/s,
  );
});

test("additional context preserves a listed selection and only auto-selects the fallback when empty", () => {
  const context = loadUserQuestionRendererContext();
  const question = {
    id: "scope",
    options: [
      { id: "all", label: "All meetings" },
      { id: "none_of_the_above", label: "Something else" },
    ],
  };

  vm.runInContext(
    `userQuestionState.answersByQuestionId = { scope: { selectedOptionId: "all", freeformText: "" } };`,
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.freeformSelectionUpdates(question, "Extra context"))),
    {},
  );

  vm.runInContext(
    `userQuestionState.answersByQuestionId = { scope: { selectedOptionId: null, freeformText: "" } };`,
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.freeformSelectionUpdates(question, "Extra context"))),
    { selectedOptionId: "none_of_the_above" },
  );

  vm.runInContext(
    `userQuestionState.answersByQuestionId = { scope: { selectedOptionId: "none_of_the_above", freeformText: "Extra context" } };`,
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.freeformSelectionUpdates(question, ""))),
    { selectedOptionId: null },
  );
});

test("user-question modal can hide without settling and reopen through the owning shell", () => {
  const html = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.html",
  );
  const source = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.js",
  );
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");
  const webviewPreloadSource = readRepoFile(
    "electron-app/src/services/chat-webview-preload.js",
  );
  const messageInputSource = readRepoFile(
    "src/patches/frontend/src/lib/components/chat/MessageInput.svelte",
  );

  assert.match(html, /id="user-question-hide-btn"/);
  assert.match(html, /aria-label="Hide questions and return to chat"/);
  assert.match(source, /async function hideUserQuestionModal\(\)/);
  assert.match(source, /presentation: "hidden"/);
  assert.match(source, /function showUserQuestionModal\(\)/);
  assert.match(source, /onUserQuestionReopenRequested/);
  assert.match(source, /onUserQuestionTerminal/);
  assert.doesNotMatch(
    source.match(/async function hideUserQuestionModal\(\)[\s\S]*?\n\}/)?.[0] || "",
    /settleUserQuestionFlow|createInitialUserQuestionState/,
  );
  assert.match(preloadSource, /setUserQuestionPresentation:[\s\S]*user-question-set-presentation/);
  assert.match(preloadSource, /onUserQuestionTerminal:[\s\S]*user-question-terminal/);
  assert.match(preloadSource, /setNativeInputPresentation:[\s\S]*native-input-set-presentation/);
  assert.match(preloadSource, /onNativeInputReopenRequested:[\s\S]*native-input-reopen-requested/);
  assert.match(preloadSource, /onNativeInputTerminal:[\s\S]*native-input-terminal/);
  assert.match(webviewPreloadSource, /getNativeInputPresentationSnapshot/);
  assert.match(webviewPreloadSource, /reopenNativeInput/);
  assert.match(messageInputSource, /class="question-attention-bar/);
  assert.match(messageInputSource, /Sensitive information is waiting/);
  assert.match(messageInputSource, /Workspace permission is waiting/);
  const composerOpeningTag = messageInputSource.match(
    /<div\s+id="message-input-container"[\s\S]*?>/,
  )?.[0];
  const capabilityRowOpeningTag = messageInputSource.match(
    /<div\s+inert=\{nativeInputInteractionLocked\}\s+class="capability-row[\s\S]*?>/,
  )?.[0];
  const metricsRowOpeningTag = messageInputSource.match(
    /<div class="composer-metrics-row[^>]*>/,
  )?.[0];
  assert.ok(composerOpeningTag);
  assert.ok(capabilityRowOpeningTag);
  assert.ok(metricsRowOpeningTag);
  assert.doesNotMatch(composerOpeningTag, /\binert=/);
  assert.match(capabilityRowOpeningTag, /inert=\{nativeInputInteractionLocked\}/);
  assert.doesNotMatch(metricsRowOpeningTag, /\binert=/);
  assert.match(
    messageInputSource,
    /<div inert=\{nativeInputInteractionLocked\} class="px-2\.5">/,
  );
  assert.match(
    messageInputSource,
    /<div inert=\{nativeInputInteractionLocked\} class="self-center flex space-x-1 mr-1 shrink-0">/,
  );
  assert.match(messageInputSource, /prefers-reduced-motion: reduce/);
});

test("user-question requester identity resolution prefers shared model branding and metadata logos", () => {
  const html = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.html",
  );
  const source = readRepoFile(
    "electron-app/src/renderer/components/user-question-modal.js",
  );

  assert.match(
    source,
    /if \(haystack\.includes\("claude"\) \|\| haystack\.includes\("anthropic"\)\) \{\s*return "claude";/s,
  );
  assert.match(
    source,
    /resolveLogoUrl\(modelPayload\?\.info\?\.meta\?\.profile_image_url\)\s*\|\|\s*resolveLogoUrl\(modelPayload\?\.meta\?\.profile_image_url\)\s*\|\|\s*resolveLogoUrl\(modelPayload\?\.profile_image_url\)/s,
  );
  assert.match(
    source,
    /let logoDataUrl = await fetchImageDataUrl\(profileImageUrl,\s*headers\);\s*if \(!logoDataUrl\) \{\s*logoDataUrl = await fetchImageDataUrl\(fallbackImageUrl\.toString\(\),\s*headers\);/s,
  );
  assert.match(
    source,
    /needsDarkBadge:\s*brandFamily === "openai" && celestialIdentity === null/s,
  );
  assert.match(
    source,
    /elements\.titleLogoBadge\.classList\.remove\("has-logo-image"\);/s,
  );
  assert.match(
    html,
    /\[data-theme="light"\]\s+\.user-question-title-logo-badge\.has-logo-image\s*\{[^}]*background:\s*#ffffff;/s,
  );
  assert.match(
    html,
    /\.user-question-title-logo-badge\.has-logo-image\.celestial-logo\s*\{[^}]*padding:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
  );
});

test("user-question modal leaves celestial logos unpadded and keeps generic OpenAI badges", () => {
  const {
    normalizeResolvedRequesterIdentity,
    resolveUserQuestionCelestialIdentity,
  } = loadUserQuestionRendererContext();

  assert.equal(
    resolveUserQuestionCelestialIdentity({
      modelId: "openai/responses/gpt-5.6-sol:latest",
    }),
    "sol",
  );
  assert.equal(
    resolveUserQuestionCelestialIdentity({ modelId: "GPT-5.6 Sol Pro" }),
    "sol",
  );
  assert.equal(
    resolveUserQuestionCelestialIdentity({ modelId: "portico-openai/gpt-5.6-terra" }),
    "terra",
  );
  assert.equal(
    resolveUserQuestionCelestialIdentity({ modelId: "GPT-5.6 Luna:latest" }),
    "luna",
  );

  const celestialIdentity = normalizeResolvedRequesterIdentity({
    displayName: "GPT-5.6 Sol",
    modelId: "GPT-5.6 Sol",
    logoDataUrl: "data:image/png;base64,celestial",
    needsDarkBadge: true,
  });
  assert.equal(celestialIdentity.needsDarkBadge, false);
  assert.equal(celestialIdentity.isCelestialLogo, true);

  const genericOpenAiIdentity = normalizeResolvedRequesterIdentity({
    displayName: "GPT-5.5",
    modelId: "GPT-5.5",
    logoDataUrl: "data:image/png;base64,gpt",
  });
  assert.equal(genericOpenAiIdentity.needsDarkBadge, true);
  assert.equal(genericOpenAiIdentity.isCelestialLogo, false);

  const derivedIdentity = normalizeResolvedRequesterIdentity({
    displayName: "GPT-5.6 Sol",
    modelId: "portico_agent_custom",
    logoDataUrl: "data:image/png;base64,custom",
    isDerivedModel: true,
  });
  assert.equal(derivedIdentity.celestialIdentity, null);
  assert.equal(derivedIdentity.needsDarkBadge, true);
  assert.equal(derivedIdentity.isCelestialLogo, false);
});

test("user-question wiring spans Electron API, renderer safety net, and HTML bootstrapping", () => {
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");
  const apiSource = readRepoFile("electron-app/src/services/api.js");
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");
  const indexHtml = readRepoFile("electron-app/src/renderer/views/index.html");
  const backendListenersSource = readRepoFile(
    "electron-app/src/renderer/components/backend-modal-listeners.js",
  );
  const conversationHtml = readRepoFile(
    "electron-app/src/renderer/views/conversation-window.html",
  );

  assert.match(
    preloadSource,
    /onUserQuestionRequested:\s*\(callback\)\s*=>\s*\{[\s\S]*ipcRenderer\.on\('user-question-requested'/s,
  );
  assert.match(
    preloadSource,
    /notifyUserQuestionCompleted:\s*\(payload\)\s*=>\s*ipcRenderer\.send\('user-question-completed',\s*payload\)/s,
  );
  assert.match(apiSource, /apiApp\.post\('\/api\/trigger-user-question-flow'/);
  assert.match(apiSource, /apiApp\.get\('\/api\/user-question-flow-status\/:flowId'/);
  assert.match(apiSource, /sendBackendModalRequest\("user-question-requested",\s*payload\)/s);
  assert.doesNotMatch(apiSource, /getActiveUserQuestionFlow\(\)/);
  assert.match(ipcSource, /ipcMain\.on\("user-question-completed",/);
  assert.match(ipcSource, /ipcMain\.handle\("user-question-set-presentation",/);
  assert.match(ipcSource, /ipcMain\.handle\("owui-reopen-user-question",/);
  assert.match(ipcSource, /ipcMain\.handle\("native-input-set-presentation",/);
  assert.match(ipcSource, /ipcMain\.handle\("owui-reopen-native-input",/);
  assert.match(indexSource, /'user-question-modal': '#user-question-modal\.visible'/);
  assert.match(indexSource, /window\.setupBackendModalListeners\(\{ label: 'Control Panel' \}\);/);
  assert.match(
    backendListenersSource,
    /window\.electronAPI\?\.onUserQuestionRequested\?\.\(\(payload\) => \{[\s\S]*runOrDeferBackendModal\("user-question",\s*payload,\s*options,\s*runUserQuestionFlow\);/s,
  );
  assert.match(
    backendListenersSource,
    /window\.backendModalAttention = \{[\s\S]*drainForTab:\s*drainPendingBackendModalsForTab,/s,
  );
  assert.match(
    backendListenersSource,
    /await window\.runUserQuestionModal\(\{[\s\S]*flow_id,[\s\S]*chat_id,[\s\S]*questions,[\s\S]*timeout_seconds,[\s\S]*launchSource: "backend-requested"/s,
  );
  assert.match(indexHtml, /<div id="user-question-container"><\/div>/);
  assert.match(indexHtml, /<script src="renderer\/components\/user-question-modal\.js"><\/script>/);
  assert.match(indexHtml, /<script src="renderer\/components\/backend-modal-listeners\.js"><\/script>/);
  assert.match(conversationHtml, /<div id="user-question-container"><\/div>/);
  assert.match(conversationHtml, /<script src="renderer\/components\/user-question-modal\.js"><\/script>/);
  assert.match(conversationHtml, /<script src="renderer\/components\/backend-modal-listeners\.js"><\/script>/);
});

test("native-input reopen remains successful when a secondary snapshot broadcast fails", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");

  assert.match(
    ipcSource,
    /const owuiViews = require\("\.\/owui-views"\);[\s\S]*?function broadcastNativeInputPresentationSnapshot\(ownerWindowId\)[\s\S]*?function registerOAuthHandlers\(\)/,
  );
  assert.match(
    ipcSource,
    /ownerWindow\.webContents\.send\("native-input-reopen-requested",[\s\S]*?const snapshot = state\.buildNativeInputPresentationSnapshot\(ownerWindowId\);[\s\S]*?try \{[\s\S]*?broadcastNativeInputPresentationSnapshot\(ownerWindowId\);[\s\S]*?catch \(error\)[\s\S]*?return \{ success: true, data: snapshot \};/,
  );
});
