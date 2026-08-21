# frontend/src/lib/components/chat/MessageInput.svelte

## Patch Summary (v0.6.43)
- Purpose: Add reasoning-effort controls, show context usage, display active capabilities, and simplify input UI for Portico workflows.
- User-visible: Reasoning effort dropdown per model, circular context usage widget, active capabilities row, and streamlined input controls (no integrations/tools/voice menus).

## Technical Details (v0.6.43 patch)
- New props and state:
  - `reasoningEffortByModel`, `contextTokens`, `contextCost`, and `activeCapabilities` passed from `Chat.svelte`.
  - Artifacts state plus listeners (`artifacts-updated` event and `window.__updateArtifacts`).
- Reasoning effort system:
  - Uses `$lib/config/model-capabilities` helpers to determine reasoning support and options.
  - Handles custom agents by resolving `base_model_id` for capability lookup.
  - Uses model index as key to support duplicate model selections.
  - Default effort is `medium`; stored in localStorage and cleaned up when models change.
  - UI: bits-ui `DropdownMenu` with pill button (Sparkles icon) and per-option colored dots.
- Context usage widget:
  - Computes `maxContextTokens` via `getMaxTokens` and shows percent ring.
  - Custom hover tooltip shows token count and usage percent.
- Active capabilities:
  - Renders `ActiveCapabilities` component with tools, skills, and artifacts.
- File/clipboard handling changes:
  - Clipboard images and screen capture are added as base64 data URLs directly to `files` (no file upload path).
  - Image file uploads always go through `compressImageHandler`, then add to `files` as data URLs.
  - Paste handler distinguishes images, files, and text; handles files via `inputFilesHandler`.
- UI simplification:
  - Removes IntegrationsMenu (grid icon), tools count (wrench), note creation, input modal expand, voice dictate/call controls.
  - Adjusts auto-scroll button alignment and file list wrapper styling.

## Diffs by Feature (v0.6.43 -> patched)

### New imports (Dropdown + ActiveCapabilities + model capabilities)
```diff
@@
-import { onMount, tick, getContext, createEventDispatcher, onDestroy } from 'svelte';
+import { onMount, tick, getContext, createEventDispatcher, onDestroy } from 'svelte';
+import { browser } from '$app/environment';
+import { DropdownMenu } from 'bits-ui';
+import Dropdown from '../common/Dropdown.svelte';
+import { flyAndScale } from '$lib/utils/transitions';
@@
-import RichTextInput from '../common/RichTextInput.svelte';
+import RichTextInput from '../common/RichTextInput.svelte';
+import ActiveCapabilities from './ActiveCapabilities.svelte';
+import type { ChatCapabilities } from '$lib/apis/chatCapabilities';
@@
-import { KokoroWorker } from '$lib/workers/KokoroWorker';
+import { KokoroWorker } from '$lib/workers/KokoroWorker';
+import { supportsReasoning, getMaxTokens, getReasoningEffortOptions, type ReasoningEffortOption } from '$lib/config/model-capabilities';
```

### New props and artifacts state
```diff
@@
-export let webSearchEnabled = false;
-export let codeInterpreterEnabled = false;
+export let webSearchEnabled = false;
+export let codeInterpreterEnabled = false;
+export let reasoningEffortByModel: Record<string, string> = {};
+export let contextTokens = 0;
+export let contextCost = 0;
+export let activeCapabilities: ChatCapabilities = { tools: [], skills: [] };
+
+let artifacts: { artifact_id: string; name: string; current_version: number }[] = [];
```

### Reasoning effort capability logic
```diff
@@
+$: selectedModelName = selectedModelIds.length === 1
+    ? $models.find(m => m.id === selectedModelIds[0])?.name
+    : null;
+$: maxContextTokens = (() => {
+    if (selectedModelIds.length !== 1) return 128000;
+    const model = $models.find(m => m.id === selectedModelIds[0]);
+    if (!model?.name) return 128000;
+    let lookupName = model.name;
+    const baseModelId = model.info?.base_model_id;
+    if (baseModelId) {
+        const baseModel = $models.find(m => m.id === baseModelId);
+        if (baseModel?.name) lookupName = baseModel.name;
+    }
+    return getMaxTokens(lookupName) || 128000;
+})();
+
+$: reasoningCapableModels = selectedModelIds
+    .map((id, index) => {
+        const model = $models.find(m => m.id === id);
+        if (!model?.name) return null;
+        let lookupName = model.name;
+        const baseModelId = model.info?.base_model_id;
+        if (baseModelId) {
+            const baseModel = $models.find(m => m.id === baseModelId);
+            if (baseModel?.name) lookupName = baseModel.name;
+        }
+        const options = getReasoningEffortOptions(lookupName);
+        if (!options || options.length === 0) return null;
+        return { index, id, name: model.name, baseModelName: baseModelId ? lookupName : null, options };
+    })
+    .filter(Boolean) as { index: number; id: string; name: string; baseModelName: string | null; options: ReasoningEffortOption[] }[];
+
+$: {
+    const currentIndices = new Set(reasoningCapableModels.map(m => String(m.index)));
+    for (const model of reasoningCapableModels) {
+        const key = String(model.index);
+        if (!(key in reasoningEffortByModel)) {
+            reasoningEffortByModel[key] = 'medium';
+            reasoningEffortByModel = reasoningEffortByModel;
+        }
+    }
+    for (const key of Object.keys(reasoningEffortByModel)) {
+        if (!currentIndices.has(key)) {
+            delete reasoningEffortByModel[key];
+            reasoningEffortByModel = reasoningEffortByModel;
+        }
+    }
+}
```

### Context usage helpers
```diff
@@
+const formatTokens = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : n.toString();
+const formatCost = (cost: number) => {
+    if (cost === 0) return '$0.00';
+    return '$' + cost.toFixed(2);
+};
```

### Include reasoningEffortByModel in onChange payload
```diff
@@
 onChange({
     prompt,
     history,
     files,
     selectedModels,
     selectedToolIds,
     selectedFilterIds,
     imageGenerationEnabled,
     webSearchEnabled,
-    codeInterpreterEnabled
+    codeInterpreterEnabled,
+    reasoningEffortByModel
 });
```

### Clipboard + image handling changes (data URLs)
```diff
@@
-const file = new File([blob], `clipboard-image.${type.split('/')[1]}`, { type: type });
-inputFilesHandler([file]);
+const reader = new FileReader();
+reader.onload = (event) => {
+    files = [...files, { type: 'image', url: event.target.result as string }];
+};
+reader.readAsDataURL(blob);
@@
-const blob = await (await fetch(imageUrl)).blob();
-const file = new File([blob], `screen-capture-${Date.now()}.png`, { type: 'image/png' });
-inputFilesHandler([file]);
+files = [...files, { type: 'image', url: imageUrl }];
@@
-// Compress only for certain settings, then upload
-... uploadFileHandler(compressedFile, false)
+imageUrl = await compressImageHandler(imageUrl, $settings, $config);
+files = [...files, { type: 'image', url: `${imageUrl}` }];
```

### Artifacts event listeners
```diff
@@
+function handleArtifactsUpdated(event: CustomEvent) {
+    const detail = event.detail;
+    if (detail && Array.isArray(detail.artifacts)) {
+        artifacts = detail.artifacts;
+    }
+}
@@
 onMount(async () => {
+    if (browser) {
+        const storedReasoningEffortByModel = localStorage.getItem('reasoningEffortByModel');
+        if (storedReasoningEffortByModel) {
+            try {
+                const parsed = JSON.parse(storedReasoningEffortByModel);
+                if (typeof parsed === 'object' && parsed !== null) {
+                    reasoningEffortByModel = parsed;
+                }
+            } catch (e) {
+                // Invalid JSON, ignore
+            }
+        }
+    }
+    window.addEventListener('artifacts-updated', handleArtifactsUpdated as EventListener);
+    (window as any).__updateArtifacts = (detail: any) => {
+        if (detail && Array.isArray(detail.artifacts)) artifacts = detail.artifacts;
+    };
@@
 onDestroy(() => {
+    window.removeEventListener('artifacts-updated', handleArtifactsUpdated as EventListener);
+    delete (window as any).__updateArtifacts;
```

### Reasoning dropdown UI + ActiveCapabilities + context widget
```diff
@@
-<IntegrationsMenu ...> ... </IntegrationsMenu>
+{#each reasoningCapableModels as model (model.index)}
+    <Tooltip content={...} placement="top">
+        <Dropdown ...>
+            <button id="reasoning-effort-button-{model.index}" ...>
+                <svg ... class="size-3.5 ...">...</svg>
+                <span class="text-gray-700 dark:text-gray-300 capitalize">{currentEffort}</span>
+            </button>
+            <div slot="content">
+                <DropdownMenu.Content ...>
+                    {#each availableOptions as option}
+                        <DropdownMenu.Item ... on:click={() => {
+                            reasoningEffortByModel[modelKey] = option.value;
+                            reasoningEffortByModel = reasoningEffortByModel;
+                            localStorage.setItem('reasoningEffortByModel', JSON.stringify(reasoningEffortByModel));
+                        }}>
+                            <div class="size-2 rounded-full {option.color}"></div>
+                            <div class="flex-1">{option.label}</div>
+                        </DropdownMenu.Item>
+                    {/each}
+                </DropdownMenu.Content>
+            </div>
+        </Dropdown>
+    </Tooltip>
+{/each}
+
+<ActiveCapabilities tools={activeCapabilities.tools} skills={activeCapabilities.skills} {artifacts} />
+
+<div class="group relative flex items-center gap-1 ml-3">
+    <span class="text-xs text-gray-600 dark:text-gray-500">{Math.round(contextPercent)}%</span>
+    <svg class="size-5 -rotate-90" viewBox="0 0 36 36">...</svg>
+    <div class="absolute bottom-full ...">
+        <div class="flex justify-between">
+            <span class="text-gray-400">Tokens</span>
+            <span class="text-white font-medium">{formatTokens(contextTokens)}</span>
+        </div>
+        <div class="flex justify-between">
+            <span class="text-gray-400">Usage</span>
+            <span class="text-white font-medium">{Math.round(contextPercent)}%</span>
+        </div>
+    </div>
+</div>
```

### UI removals (tools, notes, voice)
```diff
@@
-<InputModal ... />
@@
-    {#if (selectedToolIds ?? []).length > 0}
-        <Tooltip content={...}>
-            <button ...>
-                <Wrench ... />
-                <span class="text-sm">{selectedToolIds.length}</span>
-            </button>
-        </Tooltip>
-    {/if}
@@
-    {#if prompt !== '' && !history?.currentId && ...}
-        <Tooltip content={$i18n.t('Create note')}>...</Tooltip>
-    {/if}
-    {#if ... voice input ...}
-        <Tooltip content={$i18n.t('Dictate')}>...</Tooltip>
-    {/if}
-    {#if ... voice mode ...}
-        <Tooltip content={$i18n.t('Voice mode')}>...</Tooltip>
-    {:else}
-        <Tooltip content={$i18n.t('Send message')}>...</Tooltip>
-    {/if}
+    <Tooltip content={$i18n.t('Send message')}>
+        <button id="send-message-button" type="submit" ...>...</button>
+    </Tooltip>
```

## Repatch Plan for v0.7.2
1. Reapply new props and imports (model-capabilities helpers, ActiveCapabilities, bits-ui Dropdown).
2. Reapply reasoning-effort logic (per-model index map, localStorage persistence, dropdown UI).
3. Reapply context usage widget using `contextTokens` and `getMaxTokens`.
4. Reapply artifacts event listeners and `ActiveCapabilities` component rendering.
5. Reapply image/file handling changes (data URL flow and compression), ensuring upstream clipboard newline fixes remain intact.
6. Reapply UI removals (integrations/tools/voice/notes/input modal) while merging v0.7.2 fixes.
7. Validate interactions with updated v0.7.2 input logic (e.g., clipboard handling and permission gating).
