# frontend/src/lib/components/common/Collapsible.svelte

## Patch Summary (v0.6.43)
- Purpose: Provide richer tool-call/reasoning UI with better timing, formatting, copy-to-clipboard actions, and consistent dark-mode styling.
- User-visible: Tool calls show server icons, readable names, elapsed time, extracted scripts/commands, and copy buttons; reasoning blocks have distinct styling with copy actions; in-progress blocks shimmer.

## Technical Details (v0.6.43 patch)
- Dark-mode awareness:
  - Uses `MutationObserver` on `document.documentElement` to track `dark` class and set `isDark` for inline styles.
- Interaction and rendering:
  - Adds `dir` prop for direction.
  - Adds `toggleOpen` and keyboard handlers (`Enter`/`Space`).
  - Defers heavy content render (`shouldRenderContent`) until after animation start via `requestAnimationFrame` + `tick`.
- Timing support:
  - Client-side timer for elapsed time using `attributes.started_at` and `attributes.elapsed` with resync.
  - Displays `displayElapsed` and `displayDuration` for in-progress and completed states.
- Tool name formatting:
  - `extractServerIdFromToolName` strips server prefix and HTTP suffixes.
  - `formatToolDisplayName` title-cases and uppercases acronyms; special-cases `tool_run_subagent_post`.
- MCP server icons:
  - Fetches server IDs from `http://localhost:9876/api/mcp/servers`.
  - Computes `serverIconUrl` and hides icon on load error.
- New collapsible types:
  - Adds `tool_preparation` and `tool_analysis` blocks with spinner and elapsed time display.
- Tool call display overhaul:
  - Custom layout with server icon, formatted tool name chip, and duration.
  - Input and Output sections render with `CodeBlock` and formatted JSON.
- Code extraction for VM tools:
  - Detects Python/Bash execution tools.
  - Extracts `script` or `command` from JSON args and shows as separate code block; replaces inline args with placeholder.
- Copy-to-clipboard controls:
  - Adds `copyText` prop for reasoning blocks and builds a structured tool summary (input/output/script/command).
  - Adds copy buttons with tooltips, clipboard writes, and toast feedback for tool and thought blocks.
- In-progress shimmer styling + header tweaks:
  - Applies `tool-shimmer` class when tool/thought blocks are running, plus header-row layout sizing.
- Image handling:
  - Disables inline tool image rendering in Collapsible (delegated to `ResponseMessage`).

## Diffs by Feature (v0.6.43 -> patched)

### Dark-mode tracking + dir prop
```diff
@@
-import { getContext } from 'svelte';
+import { getContext, onDestroy, tick } from 'svelte';
+import { onMount } from 'svelte';
@@
+let isDark = false;
+
+onMount(() => {
+    isDark = document.documentElement.classList.contains('dark');
+    const observer = new MutationObserver(() => {
+        isDark = document.documentElement.classList.contains('dark');
+    });
+    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
+    return () => observer.disconnect();
+});
@@
-export let attributes = null;
+export let attributes = null;
+export let dir: string | undefined = undefined;
@@
-<div {id} class={className}>
+<div {id} class={className} {dir}>
```

### Deferred rendering + keyboard toggle
```diff
@@
+let shouldRenderContent = false;
+$: if (open) {
+    requestAnimationFrame(() => {
+        tick().then(() => {
+            shouldRenderContent = true;
+        });
+    });
+} else {
+    shouldRenderContent = false;
+}
+
+function toggleOpen(event?: MouseEvent) {
+    if (disabled) return;
+    open = !open;
+}
+
+function handleKeydown(event: KeyboardEvent) {
+    if (disabled) return;
+    if (event.key === 'Enter' || event.key === ' ') {
+        event.preventDefault();
+        open = !open;
+    }
+}
```

### Elapsed timer tracking
```diff
@@
+let clientElapsed = 0;
+let timerInterval: ReturnType<typeof setInterval> | null = null;
+let lastStartedAt: number | null = null;
+let lastBackendElapsed: number | null = null;
+let timerStartMs: number | null = null;
+
+$: {
+    const backendElapsed = attributes?.elapsed && attributes.elapsed !== 'None' ? parseInt(attributes.elapsed) : null;
+    if (backendElapsed !== null && backendElapsed !== lastBackendElapsed) {
+        lastBackendElapsed = backendElapsed;
+        clientElapsed = backendElapsed;
+        timerStartMs = Date.now() - backendElapsed * 1000;
+    }
+}
+
+$: {
+    const isDone = attributes?.done === 'true' || attributes?.done === true;
+    const startedAt = attributes?.started_at ? parseFloat(attributes.started_at) : null;
+    if (!isDone && startedAt && startedAt !== lastStartedAt) {
+        lastStartedAt = startedAt;
+        if (timerInterval) clearInterval(timerInterval);
+        timerStartMs = startedAt * 1000;
+        timerInterval = setInterval(() => {
+            const elapsed = Math.floor((Date.now() - (timerStartMs ?? Date.now())) / 1000);
+            clientElapsed = elapsed;
+        }, 100);
+        clientElapsed = Math.floor((Date.now() - (timerStartMs ?? Date.now())) / 1000);
+    } else if (isDone || !startedAt) {
+        if (timerInterval) {
+            clearInterval(timerInterval);
+            timerInterval = null;
+            lastStartedAt = null;
+            lastBackendElapsed = null;
+            timerStartMs = null;
+        }
+        clientElapsed = 0;
+    }
+}
+
+$: displayElapsed = clientElapsed;
+$: displayDuration = attributes?.duration && attributes?.duration !== 'None' ? attributes.duration : displayElapsed;
+
+onDestroy(() => {
+    if (timerInterval) clearInterval(timerInterval);
+});
```

### Tool name formatting + acronyms
```diff
@@
+const FULL_CAPS_WORDS = ['vm', 'mcp', 'pdf', 'pptx', 'xlsx', 'api', 'url', 'id', 'json', 'xml', 'html', 'css', 'sql', 'http', 'https', 'oauth', 'jwt', 'ui', 'ux', 'ai', 'suid', 'jira', 'jql', 'cql'];
+
+function applyAcronymCapitalization(text: string): string {
+    let result = text;
+    for (const word of FULL_CAPS_WORDS) {
+        const regex = new RegExp(`\\b${word.charAt(0).toUpperCase() + word.slice(1)}\\b`, 'g');
+        result = result.replace(regex, word.toUpperCase());
+    }
+    return result;
+}
+
+function extractServerIdFromToolName(toolName: string, knownServerIds: string[]): string | null {
+    if (!toolName || knownServerIds.length === 0) return null;
+    let name = toolName.startsWith('tool_') ? toolName.substring(5) : toolName;
+    name = name.replace(/_(post|get|put|delete|patch)$/i, '');
+    const normalizedServerIds = knownServerIds.map(id => ({ original: id, normalized: id.replace(/-/g, '_') }));
+    let bestMatch = null;
+    for (const { original, normalized } of normalizedServerIds) {
+        if (name.startsWith(normalized + '_') || name === normalized) {
+            if (!bestMatch || normalized.length > bestMatch.normalized.length) bestMatch = { original, normalized };
+        }
+    }
+    return bestMatch?.original || null;
+}
+
+function formatToolDisplayName(toolName: string, serverId: string | null): string {
+    if (!toolName) return toolName;
+    if (toolName === 'tool_run_subagent_post') return 'Run Subagent';
+    let name = toolName.startsWith('tool_') ? toolName.substring(5) : toolName;
+    name = name.replace(/_(post|get|put|delete|patch)$/i, '');
+    if (serverId) {
+        const normalizedServerId = serverId.replace(/-/g, '_');
+        if (name.startsWith(normalizedServerId + '_')) name = name.substring(normalizedServerId.length + 1);
+    }
+    const titleCased = name.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
+    return applyAcronymCapitalization(titleCased);
+}
```

### MCP server icon resolution
```diff
@@
+let serverIds: string[] = [];
+
+onMount(async () => {
+    try {
+        const res = await fetch('http://localhost:9876/api/mcp/servers');
+        if (res.ok) serverIds = await res.json();
+    } catch (e) {
+        // ignore
+    }
+});
+
+$: toolServerId = attributes?.name ? extractServerIdFromToolName(attributes.name, serverIds) : null;
+$: serverIconUrl = toolServerId ? `http://localhost:9876/api/mcp/servers/${toolServerId}/icon` : null;
+let iconLoadError = false;
+$: if (toolServerId) iconLoadError = false;
```

### tool_preparation + tool_analysis blocks
```diff
@@
-{#if attributes?.type === 'tool_calls'}
+{#if attributes?.type === 'tool_preparation'}
+    <div class="py-0.5 w-full cursor-pointer" on:click={() => {}}>
+        <div class="w-full font-medium flex items-center gap-2">
+            {#if attributes?.done === 'true'}
+                <Markdown id={`${collapsibleId}-tool-preparation-complete`} content={`All tool calls generated (${displayDuration}s)`} />
+            {:else}
+                <Spinner className="size-4" />
+                <Markdown id={`${collapsibleId}-tool-preparation-progress`} content={`Generating tool call inputs... (${displayElapsed}s)`} />
+            {/if}
+        </div>
+    </div>
+{:else if attributes?.type === 'tool_analysis'}
+    <div class="py-0.5 w-full cursor-pointer" on:click={() => {}}>
+        <div class="w-full font-medium flex items-center gap-2">
+            {#if attributes?.done === 'true'}
+                <Markdown id={`${collapsibleId}-tool-analysis-complete`} content={`Tool results analyzed (${displayDuration}s)`} />
+            {:else}
+                <Spinner className="size-4" />
+                <Markdown id={`${collapsibleId}-tool-analysis-progress`} content={`Analyzing tool results... (${displayElapsed}s)`} />
+            {/if}
+        </div>
+    </div>
+{:else if attributes?.type === 'tool_calls'}
```

### Tool input/output rendering + code extraction
```diff
@@
+function isPythonExecuteTool(toolName: string | null): boolean {
+    if (!toolName) return false;
+    const lowerName = toolName.toLowerCase();
+    const patterns = ['vm_execute_python', 'execute_python', 'vm-execute-python'];
+    return patterns.filter(p => lowerName.includes(p)).length > 0;
+}
+
+function isBashExecuteTool(toolName: string | null): boolean {
+    if (!toolName) return false;
+    const lowerName = toolName.toLowerCase();
+    const patterns = ['vm_execute_bash', 'execute_bash', 'vm-execute-bash'];
+    return patterns.filter(p => lowerName.includes(p)).length > 0;
+}
+
+function extractPythonScript(args: string): { modifiedArgs: string; script: string | null } {
+    try {
+        const parsed = JSON.parse(args);
+        if (parsed && typeof parsed.script === 'string') {
+            const script = parsed.script;
+            const modified = { ...parsed, script: '(see below)' };
+            return { modifiedArgs: JSON.stringify(modified, null, 2), script };
+        }
+    } catch (e) {
+        // ignore
+    }
+    return { modifiedArgs: args, script: null };
+}
+
+function extractBashCommand(args: string): { modifiedArgs: string; command: string | null } {
+    try {
+        const parsed = JSON.parse(args);
+        if (parsed && typeof parsed.command === 'string') {
+            const command = parsed.command;
+            const modified = { ...parsed, command: '(see below)' };
+            return { modifiedArgs: JSON.stringify(modified, null, 2), command };
+        }
+    } catch (e) {
+        // ignore
+    }
+    return { modifiedArgs: args, command: null };
+}
@@
-    {#if args === '{}' || args === '' || !args}
-        <div class="text-xs text-gray-400 dark:text-gray-500">None</div>
-    {:else}
-        <CodeBlock id={`${collapsibleId}-tool-calls-${attributes?.id}-input`} lang="json" code={formatJSONString(args)} />
-    {/if}
+    {#if args === '{}' || args === '' || !args}
+        <div class="text-xs text-gray-400 dark:text-gray-500">None</div>
+    {:else if shouldRenderContent}
+        {@const isPython = isPythonExecuteTool(attributes.name)}
+        {@const isBash = isBashExecuteTool(attributes.name)}
+        {@const pythonExtract = isPython ? extractPythonScript(args) : null}
+        {@const bashExtract = isBash ? extractBashCommand(args) : null}
+        {@const displayArgs = pythonExtract?.script ? pythonExtract.modifiedArgs : bashExtract?.command ? bashExtract.modifiedArgs : formattedArgs}
+        <CodeBlock id={`${collapsibleId}-tool-calls-${attributes?.id}-input`} lang="json" code={displayArgs} />
+        {#if pythonExtract?.script}
+            <CodeBlock id={`${collapsibleId}-tool-calls-${attributes?.id}-input-script`} lang="python" code={pythonExtract.script} />
+        {/if}
+        {#if bashExtract?.command}
+            <CodeBlock id={`${collapsibleId}-tool-calls-${attributes?.id}-input-command`} lang="bash" code={bashExtract.command} />
+        {/if}
+    {:else}
+        <div class="h-20 bg-gray-800/50 rounded animate-pulse"></div>
+    {/if}
```

### Copy-to-clipboard controls + copyText prop
```diff
@@
-import FullHeightIframe from './FullHeightIframe.svelte';
+import FullHeightIframe from './FullHeightIframe.svelte';
+import Tooltip from '$lib/components/common/Tooltip.svelte';
+import { copyToClipboard } from '$lib/utils';
+import { toast } from 'svelte-sonner';
@@
-export let attributes = null;
+export let attributes = null;
+export let copyText: string | null = null;
@@
+function buildToolCopyText(...) { ... }
+async function copyToolDetails(...) { ... }
+async function copyThoughtDetails(...) { ... }
@@
+<Tooltip content={$i18n.t('Copy')} ...>
+    <button on:click|stopPropagation={() => copyToolDetails(...)}>...</button>
+</Tooltip>
@@
+<Tooltip content={$i18n.t('Copy')} ...>
+    <button on:click|stopPropagation={() => copyThoughtDetails(copyText)}>...</button>
+</Tooltip>
```

### In-progress shimmer + header layout tweaks
```diff
@@
-<div class="rounded-lg p-4 my-4 border cursor-pointer"
+<div class="rounded-lg px-4 py-2 my-4 border cursor-pointer {isToolDone ? '' : 'tool-shimmer'}"
@@
-<div class="rounded-lg p-4 my-4 border cursor-pointer"
+<div class="rounded-lg px-4 py-2 my-4 border cursor-pointer {isThoughtDone ? '' : 'tool-shimmer'}"
@@
+.tool-shimmer { ... }
+.tool-shimmer::after { ... }
+.collapsible-header-row { min-height: 42px; }
```

### Disable inline image rendering in Collapsible
```diff
@@
-    {#if typeof files === 'object'}
-        {#each files ?? [] as file, idx}
-            ...
-        {/each}
-    {/if}
+    <!-- Images now render inline in ResponseMessage.svelte -->
+    {#if false && attributes?.done === 'true'}
+        ...
+    {/if}
```

## Repatch Plan for v0.7.2
1. Reapply dark-mode tracking, `dir` prop, and deferred rendering logic.
2. Reapply tool timing logic (elapsed/duration) and keyboard accessibility handlers.
3. Reapply tool name formatting utilities and acronym handling.
4. Reapply MCP server icon lookup (server list fetch + icon URL + error handling).
5. Reapply `tool_preparation` and `tool_analysis` collapsible blocks.
6. Reapply tool call UI layout and code extraction for Python/Bash args.
7. Reapply copy-to-clipboard buttons and `copyText` prop for tool/thought blocks (with Tooltip + toast feedback).
8. Reapply shimmer styling + header layout tweaks for in-progress tool/thought blocks.
9. Keep tool image rendering disabled here (ensure ResponseMessage handles images).
10. Merge with v0.7.2 changes (e.g., `content_type` image checks) without losing new upstream behavior.
