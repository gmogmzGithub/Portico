const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");

function readPatch(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function cssRuleBody(source, selector) {
  const selectorIndex = source.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `${selector} should be present`);

  const bodyStart = source.indexOf("{", selectorIndex);
  assert.notEqual(bodyStart, -1, `${selector} should have a rule body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${selector} should have a closing brace`);
}

test("activity indicator dark shimmer animates readable text colors only", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/ActivityIndicator.svelte");

  assert.match(source, /:global\(\.dark\)\s+\.activity-text\s*\{/);
  assert.match(source, /#f8fbff/);
  assert.match(source, /#d3e3ff/);
  assert.match(source, /var\(--portico-accent-text,\s*#4f94ff\)/);
  assert.match(source, /color:\s*var\(--activity-shimmer-rest\);/);
  assert.match(source, /@keyframes activity-text-shimmer/);
  assert.match(source, /animation:\s*activity-text-shimmer 4s ease-in-out infinite;/);
  assert.match(source, /text-shadow:\s*0 0 14px rgba\(79,\s*148,\s*255,\s*0\.34\);/);
  assert.doesNotMatch(source, /background:\s*linear-gradient/);
  assert.doesNotMatch(source, /background-clip:\s*text|-webkit-background-clip:\s*text/);
  assert.doesNotMatch(source, /-webkit-text-fill-color:\s*transparent|color:\s*transparent/);
  assert.doesNotMatch(source, /#4b5563|#000|black/i);
});

test("reasoning thinking block uses thought-specific spotlight styling", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/common/Collapsible.svelte");
  const reasoningStart = source.indexOf("{:else if attributes?.type === 'reasoning'}");
  const nextBranchStart = source.indexOf("{#if title !== null}", reasoningStart);

  assert.notEqual(reasoningStart, -1, "reasoning branch should be present");
  assert.notEqual(nextBranchStart, -1, "generic collapsible branch should follow reasoning branch");

  const reasoningBranch = source.slice(reasoningStart, nextBranchStart);

  assert.match(reasoningBranch, /message-thought-block--running/);
  assert.match(reasoningBranch, /thought-status-text--running/);
  assert.match(reasoningBranch, /thought-status-label/);
  assert.match(reasoningBranch, /thought-status-time/);
  assert.doesNotMatch(reasoningBranch, /tool-shimmer/);
  assert.doesNotMatch(reasoningBranch, /\?\s*'shimmer'/);

  assert.match(source, /\.message-thought-block--running::after\s*\{/);
  assert.match(source, /animation:\s*thoughtBlockSpotlight 2\.8s ease-in-out infinite;/);
  assert.match(source, /@keyframes thoughtBlockSpotlight/);
  assert.match(source, /@keyframes thoughtTextSpotlight/);
  assert.match(source, /--thought-text-rest:\s*#f8fbff;/);
  assert.match(source, /--thought-text-mid:\s*#d3e3ff;/);
  assert.match(source, /--thought-text-peak:\s*var\(--portico-accent-text,\s*#4f94ff\);/);
  assert.match(source, /\.message-thought-block--running > \*\s*\{[\s\S]*z-index:\s*1;/);
  assert.match(source, /text-shadow:\s*0 0 14px rgba\(79,\s*148,\s*255,\s*0\.36\);/);
  assert.doesNotMatch(source, /--thought-text-(?:rest|mid|peak):\s*(?:#4b5563|#000|black)/i);
});

test("active capability chip combines MCPs and skills into a read-only active count", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/ActiveCapabilities.svelte");

  assert.match(source, /\$: activeCount = sortedTools\.length \+ sortedSkills\.length;/);
  assert.match(source, /\{activeCount\} Active/);
  assert.match(source, /capability-pill capability-pill--readonly/);
  assert.match(source, /class="size-3\.5 text-purple-500"/);
  assert.match(source, /M9\.813 15\.904L9 18\.75/);
  assert.match(source, /ACTIVE MCPs/);
  assert.doesNotMatch(source, /uppercase tracking-wide">Active MCPs/);
  assert.match(source, /Active Skills/);
  assert.doesNotMatch(source, /activeBadgeWrapper/);
  assert.doesNotMatch(source, /activeTooltipAnchorX/);
  assert.doesNotMatch(source, /activeTooltipLeft/);
  assert.doesNotMatch(source, /updateActiveTooltipAnchor|resetActiveTooltipAnchor/);
  assert.doesNotMatch(source, /on:mouseenter|on:mousemove|on:mouseleave/);
  assert.doesNotMatch(source, /style:left/);
  assert.match(source, /class="absolute bottom-full left-1\/2 mb-2 -translate-x-1\/2/);
  assert.match(source, /w-max max-w-\[calc\(100vw-2rem\)\]/);
  assert.match(source, /rounded-lg bg-gray-900 p-4 shadow-xl dark:bg-black/);
  assert.match(source, /sortedTools\.length > 0 && sortedSkills\.length > 0\s*\? 'grid grid-cols-\[minmax\(0,max-content\)_1px_minmax\(0,max-content\)\] gap-x-4'\s*: 'flex flex-col gap-4'/);
  assert.match(source, /text-gray-500 mb-2\.5 font-medium tracking-wide/);
  assert.match(source, /text-gray-500 mb-2\.5 font-medium uppercase tracking-wide/);
  assert.match(source, /flex flex-col gap-2\.5/);
  assert.match(source, /flex flex-col gap-2/);
  assert.match(source, /flex w-full items-center gap-2\.5 min-w-0/);
  assert.match(source, /w-px self-stretch bg-gray-500\/20 dark:bg-gray-600\/30/);
  assert.match(source, /left-1\/2 -translate-x-1\/2 border-4 border-transparent border-t-gray-900 dark:border-t-black/);
  assert.doesNotMatch(source, /rounded-lg bg-gray-900 p-3 shadow-xl/);
  assert.doesNotMatch(source, /gap-x-3/);
  assert.doesNotMatch(source, /flex flex-col gap-3/);
  assert.doesNotMatch(source, /w-\[min\(calc\(100vw-2rem\),500px\)\]/);
  assert.doesNotMatch(source, /w-\[min\(calc\(100vw-2rem\),560px\)\]/);
  assert.doesNotMatch(source, /absolute bottom-full mb-2\s+\{sortedTools\.length > 0 && sortedSkills\.length > 0 \? 'right-0'/);
  assert.ok(
    source.indexOf("ACTIVE MCPs") < source.indexOf("Active Skills"),
    "MCPs should render before skills in the active capabilities tooltip",
  );
  assert.doesNotMatch(source, /\{sortedTools\.length\} \{sortedTools\.length === 1 \? 'MCP' : 'MCPs'\}/);
  assert.doesNotMatch(source, /\{sortedSkills\.length\} \{sortedSkills\.length === 1 \? 'skill' : 'skills'\}/);
  assert.doesNotMatch(source, /Active mcp|\} mcp/);
  assert.doesNotMatch(source, /integration' : 'integrations|integrations\}/);
});

test("composer metrics are one right-aligned read-only control before submit", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/MessageInput.svelte");
  const metricsSource = readPatch("src/patches/frontend/src/lib/components/chat/MessageInput/ComposerMetrics.svelte");
  const cssSource = readPatch("src/patches/frontend/src/app.css");
  const artifactIndex = source.indexOf("{artifacts}");
  const metricsIndex = source.indexOf("composer-metrics-row", artifactIndex);
  const combinedIndex = source.indexOf("<ComposerMetrics", metricsIndex);
  const sendIndex = source.indexOf('id="send-message-button"', combinedIndex);

  assert.notEqual(artifactIndex, -1);
  assert.notEqual(metricsIndex, -1);
  assert.notEqual(combinedIndex, -1);
  assert.notEqual(sendIndex, -1);
  assert.ok(artifactIndex < metricsIndex);
  assert.ok(metricsIndex < combinedIndex);
  assert.ok(combinedIndex < sendIndex);
  assert.match(
    source,
    /: 'ml-0 self-center flex flex-wrap items-center flex-1 min-w-0 max-w-full'/,
  );
  assert.match(
    source,
    /composer-metrics-row \{readOnlyMode \? 'self-center' : 'ml-auto self-center'\}/,
  );
  assert.match(
    source,
    /<div class="composer-active-capabilities flex shrink-0 items-center">\s*<ActiveCapabilities\s+tools=\{\[\]\}\s+skills=\{\[\]\}\s+\{artifacts\}\s*\/>\s*<\/div>/s,
  );
  assert.match(source, /<ComposerMetrics\s+capabilities=\{activeCapabilities\}/s);
  assert.match(
    metricsSource,
    /composer-metrics-trigger composer-rail-control-surface capability-pill capability-pill--readonly/,
  );
  assert.match(
    metricsSource,
    /<button\s+type="button"[\s\S]*?aria-describedby="composer-metrics-tooltip"/s,
  );
  assert.match(
    metricsSource,
    /bind:this=\{popoverElement\}[\s\S]*?id="composer-metrics-tooltip"[\s\S]*?class="composer-metrics-popover"[\s\S]*?role="tooltip"/,
  );
  assert.match(metricsSource, /Chat details/);
  // "Connected capabilities" heading pin removed: the popover now stacks
  // separate "Active MCPs" / "Active skills" panels (behavioral home:
  // tests/active-skill-badges.unit.test.js + live visual QA).
  assert.match(metricsSource, /Spend and cache/);
  assert.match(metricsSource, /Context usage/);
  assert.doesNotMatch(source, /capability-pill--readonly capability-pill--cost/);
  assert.doesNotMatch(source, /capability-pill--readonly capability-pill--context/);
  assert.doesNotMatch(source, /composer-metrics-row[^\n]*relative -top-px/);
  assert.doesNotMatch(source, /relative -top-px flex h-8 shrink-0 items-center/);
  assert.match(cssSource, /--owui-readonly-pill-bg-light/);
  assert.match(cssSource, /--owui-readonly-pill-bg-dark/);
  assert.match(cssSource, /\.capability-pill--readonly\s*\{/);
  assert.match(cssSource, /\.dark \.capability-pill--readonly\s*\{/);
  assert.match(
    cssSource,
    /\.capability-row \.capability-pill > span,\s*\.composer-metrics-row \.capability-pill > span\s*\{[^}]*font-weight:\s*700 !important;/s,
  );
  assert.doesNotMatch(cssSource, /\.capability-pill--cost\s*\{[^}]*top:\s*1px/s);
  assert.doesNotMatch(cssSource, /\.capability-pill--context\s*\{[^}]*top:\s*1px/s);
  assert.match(
    cssSource,
    /\.composer-metrics-row,\s*\.composer-active-capabilities\s*\{[^}]*height:\s*var\(--owui-capability-pill-height\);[^}]*min-height:\s*var\(--owui-capability-pill-height\);[^}]*max-height:\s*var\(--owui-capability-pill-height\);/s,
  );
});

test("message input places folder picker immediately after the plus input menu", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/MessageInput.svelte");
  const plusIndex = source.indexOf("<InputMenu");
  const folderIndex = source.indexOf("selectChatWorkspaceFolder", plusIndex);
  const reasoningIndex = source.indexOf("Per-model Reasoning Effort", plusIndex);

  assert.notEqual(plusIndex, -1);
  assert.notEqual(folderIndex, -1);
  assert.notEqual(reasoningIndex, -1);
  assert.ok(folderIndex > plusIndex, "folder picker should come after plus input menu");
  assert.ok(folderIndex < reasoningIndex, "folder picker should come before capability pills");
  assert.match(source, /selectedWorkspaceDisplayPath/);
  assert.match(source, /workspaceSelection\?\.isUserSelectedCustom/);
  assert.match(source, /workspaceOperation: WorkspaceOperation/);
  assert.match(source, /workspaceOperation === 'picking'/);
  assert.match(source, /workspaceSelectionApplying/);
  assert.match(source, /hostApi\.chooseChatWorkspaceFolder/);
  assert.match(source, /clearChatWorkspaceFolder/);
  assert.match(source, /openChatWorkspaceFolder/);
  assert.match(source, /hostApi\.openChatWorkspace/);
  assert.match(source, /function handleChatWorkspaceSelectionUpdated\(event: CustomEvent\)/);
  assert.match(source, /String\(detail\.chatId \|\| ''\)\.trim\(\) !== currentChatId/);
  assert.match(source, /workspaceSelection = detail\.selection;/);
  assert.match(source, /workspaceSelectionChatId = currentChatId;/);
  assert.match(source, /window\.addEventListener\(\s*'chat-workspace-selection-updated'/s);
  assert.match(source, /window\.removeEventListener\(\s*'chat-workspace-selection-updated'/s);
  assert.match(source, /workspace-folder-badge capability-pill capability-pill--interactive -ml-0\.5/);
  assert.doesNotMatch(source, /workspace-folder-badge capability-pill capability-pill--interactive -ml-1\.5/);
  assert.match(source, /class="workspace-folder-badge -ml-1\.5 flex size-8/);
  assert.match(source, /class="capability-pill capability-pill--interactive relative -top-px shrink-0/);
  assert.match(
    source,
    /id="reasoning-effort-button-\{model\.index\}"\s+class="capability-pill shrink-0 whitespace-nowrap select-none"/,
  );
  assert.match(source, /Select folder to work in\.\.\./);
  assert.match(source, /ensureChatId/);
  assert.doesNotMatch(source, /Workspace Folder/);
});

test("read-only subagent view shows only user-selected workspaces as a passive badge", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/MessageInput.svelte");
  const readOnlyBadgeIndex = source.indexOf("{#if readOnlyMode && readOnlyWorkspaceBadgeLabel}");
  const reasoningIndex = source.indexOf("Per-model Reasoning Effort", readOnlyBadgeIndex);
  const readOnlyBadgeSource = source.slice(readOnlyBadgeIndex, reasoningIndex);

  assert.notEqual(readOnlyBadgeIndex, -1);
  assert.notEqual(reasoningIndex, -1);
  assert.ok(readOnlyBadgeIndex < reasoningIndex);
  assert.match(source, /readOnlyWorkspaceBadgeLabel/);
  assert.match(source, /readOnlyMode && workspaceSelection\?\.isUserSelectedCustom/);
  assert.doesNotMatch(source, /Generated workspace/);
  assert.doesNotMatch(source, /isGeneratedWorkspaceSelection/);
  assert.match(
    readOnlyBadgeSource,
    /workspace-folder-badge capability-pill capability-pill--readonly/,
  );
  assert.match(readOnlyBadgeSource, /<FolderOpen className="size-4" \/>/);
  assert.doesNotMatch(readOnlyBadgeSource, /on:click|selectChatWorkspaceFolder|clearChatWorkspaceFolder/);
});

test("workspace folder select and clear show optimistic spinner feedback", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/MessageInput.svelte");
  const chooseIndex = source.indexOf("await hostApi.chooseChatWorkspaceFolder(currentChatId)");
  const optimisticSetIndex = source.indexOf("workspaceSelection = chooseResult.selection", chooseIndex);
  const applyingIndex = source.indexOf("workspaceOperation = 'applying-selection'", optimisticSetIndex);
  const applyIndex = source.indexOf("await hostApi.selectChatWorkspaceFolder", applyingIndex);

  assert.notEqual(chooseIndex, -1);
  assert.notEqual(optimisticSetIndex, -1);
  assert.notEqual(applyingIndex, -1);
  assert.notEqual(applyIndex, -1);
  assert.ok(chooseIndex < optimisticSetIndex);
  assert.ok(optimisticSetIndex < applyingIndex);
  assert.ok(applyingIndex < applyIndex);
  assert.match(source, /workspaceOperation = 'clearing';/);
  assert.match(source, /workspaceSelection = previousSelection;/);
  assert.match(source, /\{#if workspaceSelectionApplying\}/);
  assert.match(source, /workspace-folder-spinner/);
  assert.match(source, /animate-spin rounded-full border-\[1\.5px\] border-current border-r-transparent/);
  assert.match(source, /workspaceOperation === 'picking'/);
  assert.match(source, /disabled=\{workspaceBusy \|\| \(!chatId && typeof ensureChatId !== 'function'\)\}/);
});

test("composer clears workspace badges across chat changes and ignores stale responses", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/MessageInput.svelte");
  const loadStart = source.indexOf("async function loadChatWorkspaceSelection()");
  const loadEnd = source.indexOf("async function reconcileChatWorkspaceVms", loadStart);
  const loadSource = source.slice(loadStart, loadEnd);
  const clearIndex = loadSource.indexOf("workspaceSelection = null;");
  const requestIndex = loadSource.indexOf("await hostApi.getChatWorkspaceSelection(currentChatId)");

  assert.notEqual(loadStart, -1);
  assert.notEqual(loadEnd, -1);
  assert.notEqual(clearIndex, -1);
  assert.notEqual(requestIndex, -1);
  assert.ok(clearIndex < requestIndex, "the previous badge must clear before loading the next chat");
  assert.match(loadSource, /const requestGeneration = \+\+workspaceSelectionRequestGeneration;/);
  assert.match(loadSource, /requestGeneration !== workspaceSelectionRequestGeneration/);
  assert.match(loadSource, /String\(chatId \|\| ''\)\.trim\(\) !== currentChatId/);
  assert.match(
    source,
    /\$: if \(browser && String\(chatId \|\| ''\)\.trim\(\) !== workspaceSelectionChatId\)/,
  );
  assert.doesNotMatch(source, /browser && chatId && chatId !== workspaceSelectionChatId/);
  assert.match(
    source,
    /function handleChatWorkspaceSelectionUpdated[\s\S]*workspaceSelectionRequestGeneration \+= 1;[\s\S]*workspaceSelection = detail\.selection;/,
  );
});

test("composer placeholder and plus icon use the requested visual weight", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/MessageInput.svelte");
  const cssSource = readPatch("src/patches/frontend/src/app.css");

  assert.match(
    cssSource,
    /#chat-input-container \.ProseMirror p\.is-editor-empty:first-child::before\s*\{[^}]*font-weight:\s*500 !important;/s,
  );
  assert.doesNotMatch(source, /PlusAlt/);
  assert.match(
    source,
    /id="input-menu-button"[\s\S]*<svg[\s\S]*viewBox="0 0 24 24"[\s\S]*stroke="currentColor"[\s\S]*stroke-width="2\.5"[\s\S]*stroke-linecap="round"[\s\S]*class="size-5"[\s\S]*<path d="M12 5v14M5 12h14" \/>/,
  );
  assert.doesNotMatch(source, /class="size-5\.5"[\s\S]*aria-hidden="true"/);
});

test("composer placeholder uses a text-width traveling spotlight shimmer", () => {
  const cssSource = readPatch("src/patches/frontend/src/app.css");
  const selector = "#chat-input-container .ProseMirror p.is-editor-empty:first-child::before";
  const composerRule = cssRuleBody(cssSource, selector);
  const darkRule = cssRuleBody(cssSource, `.dark ${selector}`);

  assert.match(composerRule, /--composer-placeholder-shimmer-rest:\s*#334155;/);
  assert.match(composerRule, /--composer-placeholder-shimmer-mid:\s*#6b7c94;/);
  assert.match(composerRule, /--composer-placeholder-shimmer-peak:\s*#7aa7f8;/);
  assert.match(composerRule, /--composer-placeholder-shimmer-core:\s*#f8fbff;/);
  assert.match(composerRule, /background:\s*linear-gradient\(/);
  assert.match(composerRule, /background-size:\s*240% 100% !important;/);
  assert.match(composerRule, /-webkit-background-clip:\s*text !important;/);
  assert.match(composerRule, /background-clip:\s*text !important;/);
  assert.match(composerRule, /-webkit-text-fill-color:\s*transparent !important;/);
  assert.match(composerRule, /display:\s*block !important;/);
  assert.match(composerRule, /width:\s*max-content;/);
  assert.match(composerRule, /animation:\s*composer-placeholder-text-spotlight 3\.8s cubic-bezier\(0\.4, 0, 0\.2, 1\) infinite;/);
  assert.match(composerRule, /font-weight:\s*500 !important;/);

  assert.match(darkRule, /--composer-placeholder-shimmer-rest:\s*#b8c3d2;/);
  assert.match(darkRule, /--composer-placeholder-shimmer-mid:\s*#e2e8f0;/);
  assert.match(darkRule, /--composer-placeholder-shimmer-peak:\s*var\(--portico-accent-text,\s*#60a5fa\);/);
  assert.match(darkRule, /--composer-placeholder-shimmer-core:\s*#ffffff;/);

  assert.match(cssSource, /@keyframes composer-placeholder-text-spotlight/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*composer-placeholder-shimmer-rest/);
  assert.doesNotMatch(cssSource, /text-shadow:\s*0 0 14px/);
  assert.doesNotMatch(cssSource, /--composer-placeholder-shimmer-(?:rest|mid|peak):\s*(?:#4b5563|#000|black)/i);
});

// Behavioral extract-and-exec of Chat.svelte's composer chat-id functions
// (converted from source-pin assertions per the no-source-pin rule): the real
// function bodies execute against stubs and are asserted on behavior.
function extractChatFunction(name) {
  const chatSource = readPatch("src/patches/frontend/src/lib/components/chat/Chat.svelte");
  const start = chatSource.indexOf(`const ${name} = async (`);
  assert.notEqual(start, -1, `${name} should exist in Chat.svelte`);
  const end = chatSource.indexOf("\n\t};", start);
  assert.notEqual(end, -1, `${name} should have a closing brace`);
  const segment = chatSource.slice(start, end + "\n\t};".length);
  // eslint-disable-next-line no-new-func
  return (deps) =>
    new Function("deps", `with (deps) { ${segment}\n return ${name}; }`)(deps);
}

test("chat composer can allocate a pending chat id before folder selection", async () => {
  const build = extractChatFunction("ensureComposerChatId");

  const makeDeps = (overrides = {}) => {
    const setCalls = [];
    return {
      deps: {
        isTile: false,
        activeChatId: "",
        chatIdProp: "",
        chatId: { current: "" },
        get: (store) => store.current,
        $temporaryChatEnabled: false,
        $socket: { id: "sock-1" },
        uuidv4: () => "uuid-fresh",
        setActiveChat: (id) => setCalls.push(id),
        ...overrides,
      },
      setCalls,
    };
  };

  // An existing id is returned as-is without minting a new one.
  const existing = makeDeps({ chatId: { current: "chat-existing" } });
  assert.equal(await build(existing.deps)(), "chat-existing");
  assert.deepEqual(existing.setCalls, []);

  // No id yet: a fresh uuid is minted AND published as the active chat, so
  // folder selection has a real id before the chat record exists.
  const fresh = makeDeps();
  assert.equal(await build(fresh.deps)(), "uuid-fresh");
  assert.deepEqual(fresh.setCalls, ["uuid-fresh"]);

  // Temporary chats mint local: ids from the socket.
  const temporary = makeDeps({ $temporaryChatEnabled: true });
  assert.equal(await build(temporary.deps)(), "local:sock-1");
  assert.deepEqual(temporary.setCalls, ["local:sock-1"]);

  // Tile panes render no composer and must never mint ids.
  const tile = makeDeps({ isTile: true, activeChatId: "pane-1" });
  assert.equal(await build(tile.deps)(), "pane-1");
  assert.deepEqual(tile.setCalls, []);
});

test("chat creation transfers pending workspace selection before final chat id is set", async () => {
  const build = extractChatFunction("initChatHandler");

  const calls = [];
  const deps = {
    activeChatId: "pending-1",
    $temporaryChatEnabled: false,
    chat: null,
    createNewChat: async (_token, _payload, _folderId) => {
      calls.push(["createNewChat"]);
      return { id: "final-9" };
    },
    localStorage: { token: "tok" },
    $i18n: { t: (value) => value },
    selectedModels: ["m1"],
    $settings: {},
    params: {},
    createMessagesList: () => [],
    $selectedFolder: null,
    movePendingWorkspaceSelection: async (fromId, toId) => {
      calls.push(["moveWorkspace", fromId, toId]);
    },
    toast: { error: (message) => calls.push(["toast", message]) },
    setActiveChat: (id) => calls.push(["setActiveChat", id]),
    window: { history: { replaceState: () => calls.push(["replaceState"]) } },
    tick: async () => {},
    refreshChatListPageOne: async () => calls.push(["refreshChatList"]),
    selectedFolder: { set: (value) => calls.push(["selectedFolder.set", value]) },
    $socket: { id: "sock-1" },
    uuidv4: () => "uuid-x",
    Date: Date,
    history: { state: null },
  };

  const result = await build(deps)({ currentId: null, state: null });
  assert.equal(result, "final-9");

  // The workspace selection moves from the pending id to the real chat id
  // BEFORE the active chat flips — order is the whole point of this flow.
  const names = calls.map((entry) => entry[0]);
  const moveIndex = names.indexOf("moveWorkspace");
  const setIndex = names.indexOf("setActiveChat");
  assert.ok(names.indexOf("createNewChat") < moveIndex);
  assert.ok(moveIndex < setIndex);
  assert.deepEqual(calls[moveIndex], ["moveWorkspace", "pending-1", "final-9"]);
  assert.deepEqual(calls[setIndex], ["setActiveChat", "final-9"]);

  // A failed transfer surfaces an error and aborts (selection is never
  // silently dropped).
  const failing = {
    ...deps,
    movePendingWorkspaceSelection: async () => {
      throw new Error("move failed");
    },
    toast: { error: (message) => calls.push(["toastError", message]) },
  };
  await assert.rejects(() => build(failing)({ currentId: null, state: null }), /move failed/);
  assert.ok(calls.some((entry) => entry[0] === "toastError"));
});

test("chat submission reconciles workspace VM binds before saving or executing", () => {
  const chatSource = readPatch("src/patches/frontend/src/lib/components/chat/Chat.svelte");
  const initIndex = chatSource.indexOf("_chatId = await initChatHandler(historySnapshot)");
  const reconcileIndex = chatSource.indexOf(
    "await reconcileWorkspaceVmsBeforeExecution(_chatId)",
    initIndex,
  );
  const saveIndex = chatSource.indexOf("await saveChatHandler(_chatId, historySnapshot", reconcileIndex);

  assert.notEqual(initIndex, -1);
  assert.notEqual(reconcileIndex, -1);
  assert.notEqual(saveIndex, -1);
  assert.ok(initIndex < reconcileIndex);
  assert.ok(reconcileIndex < saveIndex);
  assert.match(chatSource, /hostApi\.reconcileChatWorkspaceVms/);
});

test("workspace selection transfer is exposed through IPC and preload", () => {
  const ipcSource = readPatch("electron-app/src/services/ipc.js");
  const preloadSource = readPatch("electron-app/src/services/chat-webview-preload.js");

  assert.match(ipcSource, /ipcMain\.handle\("choose-chat-workspace-folder"/);
  assert.match(ipcSource, /buildCustomWorkspaceSelectionCandidate/);
  assert.match(ipcSource, /isUserSelectedCustom:\s*true/);
  assert.match(ipcSource, /displayPath:\s*collapseHomePath\(selectedPath\)/);
  assert.match(ipcSource, /ipcMain\.handle\("select-chat-workspace-folder", async \(_event, \{ chatId, hostPath \} = \{\}\)/);
  assert.match(preloadSource, /function chooseChatWorkspaceFolder\(chatId\)/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('choose-chat-workspace-folder'/);
  assert.match(preloadSource, /function selectChatWorkspaceFolder\(chatId, hostPath = null\)/);
  assert.match(preloadSource, /payload\.hostPath = hostPath\.trim\(\);/);
  assert.match(preloadSource, /chooseChatWorkspaceFolder,/);
  assert.match(ipcSource, /moveChatWorkspaceSelection/);
  assert.match(ipcSource, /ipcMain\.handle\("move-chat-workspace-selection"/);
  assert.match(preloadSource, /function moveChatWorkspaceSelection\(fromChatId, toChatId\)/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('move-chat-workspace-selection'/);
  assert.match(preloadSource, /moveChatWorkspaceSelection,/);
  assert.match(ipcSource, /ipcMain\.handle\("reconcile-chat-workspace-vms"/);
  assert.match(preloadSource, /function reconcileChatWorkspaceVms\(chatId\)/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('reconcile-chat-workspace-vms'/);
  assert.match(preloadSource, /reconcileChatWorkspaceVms,/);
});

test("folder picker icon is a compact filled folder glyph", () => {
  const iconSource = readPatch("src/patches/frontend/src/lib/components/icons/FolderOpen.svelte");
  const pathCount = (iconSource.match(/<path\b/g) || []).length;

  assert.equal(pathCount, 2);
  assert.match(iconSource, /fill="currentColor"/);
  assert.doesNotMatch(iconSource, /stroke="currentColor"|stroke-linecap|stroke-linejoin|fill-opacity|opacity=|M8 14\.05|M7\.25 16\.1/);
});

test("response message no longer renders tool result images at the message bottom", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte");

  assert.match(source, /getWorkspaceMarkdownImagePaths/);
  assert.match(source, /imageDedupeIdentityFromSrc/);
  assert.match(source, /imageDedupeIdentity\(file\)/);
  assert.match(source, /shouldSuppressInlineImageFile/);
  assert.match(source, /getVisibleInlineImageFiles\(_message[^)]*\)/);
  assert.match(source, /getToolResultImageFilesFromContentBlocks/);
  assert.match(source, /mergeDistinctDisplayableImageFiles/);
  assert.match(source, /return \[];/);
  assert.doesNotMatch(source, /\.\.\.getToolResultImageFilesFromContentBlocks\(message\?\.contentBlocks\)/);
  assert.match(source, /\/workspace\//);
  assert.match(source, /raw\.startsWith\('data:image\/'\)/);
  assert.match(source, /markdownImagePaths\.has\(identity\)/);
  assert.match(source, /let imageFiles: any\[] = \[];/);
  assert.match(source, /\$: imageFiles = getVisibleInlineImageFiles\(message\);/);
  assert.match(source, /\{#each imageFiles as file, imageIndex \(getImageRenderKey\(file, imageIndex\)\)\}/);
  assert.doesNotMatch(source, /\{@const imageFiles = getVisibleInlineImageFiles\(message\)\}/);
  assert.doesNotMatch(source, /message\.files\.filter\(isDisplayableImage\)/);
  assert.doesNotMatch(source, /src\.startsWith\('data:image\/'\)\)\s*\{\s*return true;/);
});

test("display files render in the message stream outside the tool accordion", () => {
  const collapsibleSource = readPatch("src/patches/frontend/src/lib/components/common/Collapsible.svelte");
  const responseSource = readPatch("src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte");
  const markdownTokensSource = readPatch("src/patches/frontend/src/lib/components/chat/Messages/Markdown/MarkdownTokens.svelte");
  const displayFilesSource = readPatch("src/patches/frontend/src/lib/components/chat/Messages/Markdown/DisplayFilesInline.svelte");
  const workActivitySource = readPatch("src/patches/frontend/src/lib/utils/work-activity-summary.mjs");

  assert.doesNotMatch(collapsibleSource, /isDisplayFilesToolName|agent_vm_display_files|data-display-files-inline/);
  assert.match(workActivitySource, /export const isDisplayFilesToolCall = /);
  assert.match(workActivitySource, /name === 'display_files' \|\| name === 'agent_vm_display_files'/);
  assert.match(workActivitySource, /type: 'display_files'/);
  assert.match(responseSource, /segment\.type === 'display_files'[\s\S]*<DisplayFilesInline/);
  assert.match(responseSource, /renderDisplayFilesInline=\{segment\.type !== 'activity'\}/);
  assert.match(markdownTokensSource, /import DisplayFilesInline from '\.\/DisplayFilesInline\.svelte';/);
  assert.match(markdownTokensSource, /import \{ isDisplayFilesToolCall \} from '\$lib\/utils\/work-activity-summary\.mjs';/);
  assert.match(markdownTokensSource, /<\/Collapsible>\s*\{#if renderDisplayFilesInline && isDisplayFilesToolCall\(token\?\.attributes\)\}\s*<DisplayFilesInline/);
  assert.match(markdownTokensSource, /<\/Collapsible>\s*\{#if renderDisplayFilesInline && isDisplayFilesToolCall\(segment\.attributes\)\}\s*<DisplayFilesInline/);
  assert.match(displayFilesSource, /extractFilesAttribute\(attributes\?\.files\)/);
  assert.match(displayFilesSource, /extractDisplayPayloadFiles\(attributes\?\.result\)/);
  assert.match(displayFilesSource, /\$: resultDisplayFiles = extractDisplayPayloadFiles\(attributes\?\.result\);/);
  assert.match(
    displayFilesSource,
    /resultDisplayFiles\.length > 0 \? resultDisplayFiles : extractFilesAttribute\(attributes\?\.files\)/,
  );
  assert.match(displayFilesSource, /record\.display_files === true && Array\.isArray\(record\.files\)/);
  assert.match(displayFilesSource, /<Image[\s\S]*src=\{file\.url\}[\s\S]*alt=\{file\.name\}/);
});

test("chat file events merge distinct images instead of replacing prior files", () => {
  const source = readPatch("src/patches/frontend/src/lib/components/chat/Chat.svelte");

  assert.match(source, /const normalizeInlineFileIdentity = \(file: any\): string =>/);
  assert.match(source, /const mergeDistinctInlineFiles = \(existingFiles: any\[] = \[], nextFiles: any\[] = \[]\): any\[] =>/);
  assert.match(source, /Array\.isArray\(existingFiles\) \? existingFiles : \[]/);
  assert.match(source, /Array\.isArray\(nextFiles\) \? nextFiles : \[]/);
  assert.match(source, /files: mergeDistinctInlineFiles\(message\.files, data\.files\)/);
  assert.match(source, /message\.files = mergeDistinctInlineFiles\(message\.files, files\)/);
  assert.doesNotMatch(source, /message = \{ \.\.\.message, files: data\.files \}/);
});
