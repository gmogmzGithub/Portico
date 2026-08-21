# frontend/src/lib/components/chat/Messages/ResponseMessage.svelte

## Patch Summary (v0.6.43)
- Purpose: Render MCP tool images inline in the main response, and show a custom activity indicator during streaming.
- User-visible: Tool-returned images appear beneath the assistant response; activity indicator replaces empty skeleton while streaming.

## Technical Details (v0.6.43 patch)
- Added ActivityIndicator:
  - Imports `ActivityIndicator.svelte` and renders it when `!message.done && !message.error`.
- Inline image helpers:
  - `isDisplayableImage(file)` checks string data URIs or object forms (`type: image`, `type: data`, `content_type` prefix).
  - `getImageSrc(file)` normalizes image URLs across MCP formats.
- Image rendering changes:
  - Removed top-positioned image block that rendered `message.files` before content.
  - Added bottom-positioned block after message content to render only displayable images.
- Profile image styling:
  - Wraps model profile image with a black background unless the model name includes `atlas`.
- Loading behavior:
  - Removes fallback skeleton for empty content; activity indicator handles loading state instead.

## Diffs by Feature (v0.6.43 -> patched)

### ActivityIndicator import + render
```diff
@@
-import Skeleton from './Skeleton.svelte';
+import Skeleton from './Skeleton.svelte';
+import ActivityIndicator from '$lib/components/chat/ActivityIndicator.svelte';
@@
-    {#if message.content === '' && !message.error && ...}
-        <Skeleton />
-    {:else if message.content && message.error !== true}
+    {#if message.content && message.error !== true}
         <ContentRenderer ... />
     {/if}
+
+    {#if !message.done && message.error !== true}
+        <ActivityIndicator isActive={true} messageId={message.id} />
+    {/if}
```

### Inline MCP image helpers
```diff
@@
+function isDisplayableImage(file: any): boolean {
+    if (typeof file === 'string') return file.startsWith('data:image/');
+    if (typeof file === 'object' && file !== null) {
+        if (file.type === 'image' && file.url) return true;
+        if (file.type === 'data' && file.content?.startsWith('data:image/')) return true;
+        if (file?.content_type?.startsWith('image/')) return true;
+    }
+    return false;
+}
+
+function getImageSrc(file: any): string {
+    if (typeof file === 'string') return file;
+    if (file.type === 'image' && file.url) return file.url;
+    if (file.type === 'data' && file.content) return file.content;
+    if (file.url) return file.url;
+    return '';
+}
```

### Move image rendering to bottom of message
```diff
@@
-{#if message?.files && message.files?.filter((f) => f.type === 'image').length > 0}
-    <div class="my-1 w-full flex overflow-x-auto gap-2 flex-wrap"> ... </div>
-{/if}
+<!-- removed top-positioned image rendering -->
@@
+{#if message?.files && message.files.length > 0}
+    {@const imageFiles = message.files.filter(isDisplayableImage)}
+    {#if imageFiles.length > 0}
+        <div class="my-2 w-full flex overflow-x-auto gap-2 flex-wrap">
+            {#each imageFiles as file}
+                <div>
+                    <Image src={getImageSrc(file)} alt="Generated Image" />
+                </div>
+            {/each}
+        </div>
+    {/if}
+{/if}
```

### Profile image styling
```diff
@@
-<ProfileImage
-    src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${model?.id}&lang=${$i18n.language}`}
-    className={'size-8 assistant-message-profile-image'}
-/>
+<div class="rounded-full {model?.name?.toLowerCase().includes('atlas') ? '' : 'bg-black p-0.5'}">
+    <ProfileImage
+        src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${model?.id}&lang=${$i18n.language}`}
+        className={'size-8 assistant-message-profile-image'}
+    />
+</div>
```

## Repatch Plan for v0.7.2
1. Reapply ActivityIndicator import and conditional render while streaming.
2. Reapply helper functions for MCP image detection and URL extraction.
3. Reapply inline image block after content and keep top-of-message image block removed.
4. Reapply profile image wrapper styling (black background for non-Atlas models).
5. Merge with v0.7.2 upstream updates (TTS changes, iframe sandbox options, image handling changes) without regressing those behaviors.
