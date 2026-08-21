# frontend/src/lib/components/chat/Chat.svelte

## Patch Summary (v0.6.43)
- Purpose: Persist per-model reasoning effort, expose active capabilities, track context tokens/cost, and preserve `contentBlocks` for tool-call history.
- User-visible: Reasoning effort UI state persists per model, capabilities list updates live, and context usage/cost are displayed.
- System behavior: ContentBlocks survive round-trips and follow-up requests reconstruct correct tool-call history.

## Technical Details (v0.6.43 patch)
- Added APIs:
  - `getChatState`/`saveChatState` for persisted chat state.
  - `getChatCapabilities` for live tool/skill info.
- Added state:
  - `reasoningEffortByModel` + `reasoningEffortInitialized` (localStorage backed).
  - `activeCapabilities` object.
  - `contextTokens` derived from latest assistant `usage.prompt_tokens` in history chain.
  - `cumulativeCost` sums `usage.cost` across messages.
- Persistence:
  - Reactive save block writes `reasoning_effort_by_model`, `context_tokens`, and `model_name` when values change.
  - On chat load, restores persisted state and migrates old `reasoning_effort` to per-model map.
- Real-time capabilities:
  - Handles socket events `chat:capabilities:updated` and updates `activeCapabilities` immediately.
- ContentBlocks preservation:
  - When building message arrays (chat history load and message serialization), includes `contentBlocks` on messages.
  - On streaming updates, captures `contentBlocks` from the event payload and stores in message.
- Reactivity fixes:
  - Updates message files using spread (`message = { ...message, files: data.files }`) to force Svelte reactivity.
  - Forces history updates after usage changes to recalc `contextTokens`.
- Reasoning effort passthrough:
  - `sendMessageSocket` accepts `modelIdx` and passes `reasoning_effort` from `reasoningEffortByModel` keyed by model index.
- Layout tweaks:
  - Increased autoscroll threshold.
  - Adjusted padding around message list/input container.
  - Passes `reasoningEffortByModel`, `contextTokens`, `contextCost`, and `activeCapabilities` to `MessageInput`.

## Diffs by Feature (v0.6.43 -> patched)

### Imports for chat state + capabilities APIs
```diff
@@
-import { getFunctions } from '$lib/apis/functions';
+import { getFunctions } from '$lib/apis/functions';
+import { getChatState, saveChatState } from '$lib/apis/chatState';
+import { getChatCapabilities, type ChatCapabilities } from '$lib/apis/chatCapabilities';
```

### Per-model reasoning effort + active capabilities + context metrics
```diff
@@
+let reasoningEffortByModel: Record<string, string> = {};
+let reasoningEffortInitialized = false;
+let activeCapabilities: ChatCapabilities = { tools: [], skills: [] };
+
+$: contextTokens = (() => {
+    if (!history?.currentId || !history?.messages) return 0;
+    let currentId = history.currentId;
+    while (currentId) {
+        const message = history.messages[currentId];
+        if (message?.role === 'assistant' && message?.usage?.prompt_tokens) {
+            return message.usage.prompt_tokens;
+        }
+        currentId = message?.parentId;
+    }
+    return 0;
+})();
+
+$: cumulativeCost = (() => {
+    if (!history?.messages) return 0;
+    let total = 0;
+    for (const msgId in history.messages) {
+        const msg = history.messages[msgId];
+        if (msg?.usage?.cost) total += msg.usage.cost;
+    }
+    return total;
+})();
+
+$: if ($chatId && reasoningEffortInitialized && Object.keys(reasoningEffortByModel).length > 0) {
+    saveChatState($chatId, {
+        reasoning_effort_by_model: reasoningEffortByModel,
+        context_tokens: contextTokens,
+        model_name: selectedModels[0] || null
+    });
+}
```

### Capabilities socket handling + file reactivity fix
```diff
@@
-    if (event.chat_id === $chatId) {
-        await tick();
-        let message = history.messages[event.message_id];
+    if (event.chat_id === $chatId) {
+        await tick();
+        if (event?.data?.type === 'chat:capabilities:updated') {
+            const capData = event?.data?.data;
+            if (capData) {
+                activeCapabilities = { tools: capData.tools || [], skills: capData.skills || [] };
+            }
+            return;
+        }
+        let message = history.messages[event.message_id];
@@
-        } else if (type === 'chat:message:files' || type === 'files') {
-            message.files = data.files;
+        } else if (type === 'chat:message:files' || type === 'files') {
+            message = { ...message, files: data.files };
```

### Load reasoning effort + capabilities on mount/load
```diff
@@
 onMount(async () => {
+    const storedReasoningEffortByModel = localStorage.getItem('reasoningEffortByModel');
+    if (storedReasoningEffortByModel) {
+        try {
+            const parsed = JSON.parse(storedReasoningEffortByModel);
+            if (typeof parsed === 'object' && parsed !== null) {
+                reasoningEffortByModel = parsed;
+            }
+        } catch (e) {
+            // Invalid JSON, ignore
+        }
+    }
+    reasoningEffortInitialized = true;
@@
-    if (history) {
+    if (history) {
         ...
+        const persistedState = await getChatState($chatId);
+        if (persistedState) {
+            if (persistedState.reasoning_effort_by_model) {
+                reasoningEffortByModel = persistedState.reasoning_effort_by_model;
+            } else if (persistedState.reasoning_effort) {
+                for (const modelId of selectedModels) {
+                    reasoningEffortByModel[modelId] = persistedState.reasoning_effort;
+                }
+            }
+        }
+        activeCapabilities = await getChatCapabilities(localStorage.token, chatIdProp);
```

### Preserve contentBlocks in message serialization
```diff
@@
-    messages = messages.map((message) => ({
-        role: message.role,
-        ...
-    }))
+    messages = messages.map((message) => ({
+        role: message.role,
+        ...(message.contentBlocks && { contentBlocks: message.contentBlocks }),
+        ...
+    }))
```

```diff
@@
-    messages = messages.map((message) => ({
-        role: message.role,
-        content: message.content,
-        info: message.info ? message.info : undefined,
-        timestamp: message.timestamp,
-        ...
-    }))
+    messages = messages.map((message) => ({
+        role: message.role,
+        content: message.content,
+        ...(message.contentBlocks && { contentBlocks: message.contentBlocks }),
+        info: message.info ? message.info : undefined,
+        timestamp: message.timestamp,
+        ...
+    }))
```

### Capture contentBlocks + usage reactivity during streaming
```diff
@@
-    const { id, done, choices, content, sources, selected_model_id, error, usage } = data;
+    const { id, done, choices, content, contentBlocks, sources, selected_model_id, error, usage } = data;
@@
-    if (usage) {
-        message.usage = usage;
-    }
+    if (usage) {
+        message.usage = usage;
+        history.messages[message.id] = message;
+        history = history;
+    }
+    if (contentBlocks && contentBlocks.length > 0) {
+        message.contentBlocks = contentBlocks;
+    }
```

### Pass per-model reasoning effort to backend
```diff
@@
-const sendMessageSocket = async (model, _messages, _history, responseMessageId, _chatId) => {
+const sendMessageSocket = async (model, _messages, _history, responseMessageId, _chatId, modelIdx = 0) => {
@@
-    params: {
+    params: {
         ...,
-    }
+        reasoning_effort: reasoningEffortByModel[String(modelIdx)] || 'medium'
+    }
```

### MessageInput props + layout tweaks
```diff
@@
-    autoScroll = messagesContainerElement.scrollHeight - messagesContainerElement.scrollTop <=
-        messagesContainerElement.clientHeight + 5;
+    autoScroll = messagesContainerElement.scrollHeight - messagesContainerElement.scrollTop <=
+        messagesContainerElement.clientHeight + 50;
@@
-    <div class=" pb-2 z-10">
+    <div class=" pb-0.5 z-10">
         <MessageInput
             ...
+            bind:reasoningEffortByModel
+            {contextTokens}
+            contextCost={cumulativeCost}
+            {activeCapabilities}
         />
```

## Repatch Plan for v0.7.2
1. Reapply imports for chat state + capabilities APIs and ensure modules still exist.
2. Reapply reasoning effort state (localStorage init, persistence on change, per-model map).
3. Reapply active capabilities handling:
   - Socket event handler for `chat:capabilities:updated`.
   - Initial fetch via `getChatCapabilities` after chat load.
4. Reapply `contentBlocks` preservation in message serialization and history load.
5. Reapply `contentBlocks` capture in `chatCompletionEventHandler` and usage reactivity fix.
6. Reapply `sendMessageSocket` signature change and `reasoning_effort` passthrough.
7. Reapply context token/cost computation and persistence.
8. Merge with v0.7.2 upstream logic changes (favorites event, model selection updates) without regressing new behavior.
