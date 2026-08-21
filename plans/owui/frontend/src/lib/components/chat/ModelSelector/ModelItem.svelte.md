# frontend/src/lib/components/chat/ModelSelector/ModelItem.svelte

## Patch Summary (v0.6.43)
- Purpose: Apply consistent branding to model avatars (black circular background for non-Claude models).

## Technical Details (v0.6.43 patch)
- Wraps the model profile `<img>` in a `div` with `bg-black` and `p-0.5` unless the model label includes `claude`.
- Keeps the original image URL and tooltip behavior intact.

## Diffs by Feature (v0.6.43 -> patched)

### Avatar wrapper styling
```diff
@@
-<img
-    src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${item.model.id}&lang=${$i18n.language}`}
-    alt="Model"
-    class="rounded-full size-5 flex items-center"
-/>
+<div class="rounded-full {item.label?.toLowerCase().includes('claude') ? '' : 'bg-black p-0.5'} dark:bg-transparent dark:p-1">
+    <img
+        src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${item.model.id}&lang=${$i18n.language}`}
+        alt="Model"
+        class="rounded-full size-5 flex items-center"
+    />
+</div>
```

## Repatch Plan for v0.7.2
1. Reapply the wrapper `div` around the model profile image and the Claude conditional styling.
2. Preserve v0.7.2 additions such as `loading="lazy"` on the image.
