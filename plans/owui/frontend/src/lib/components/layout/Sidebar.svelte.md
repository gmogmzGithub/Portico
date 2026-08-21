# frontend/src/lib/components/layout/Sidebar.svelte

## Patch Summary (v0.6.43)
- Purpose: Apply Portico branding to the user avatar in the sidebar.
- User-visible: User profile image replaced with Portico logo inside a black circular badge.

## Technical Details (v0.6.43 patch)
- Adds `handleProfileImageError` helper to replace broken profile images with `/static/portico-logo.png`.
- Replaces the user profile `<img>` in both desktop and mobile sidebar layouts with a wrapper `div`:
  - Uses `bg-black` and `p-0.5` and always points to `portico-logo.png`.
  - Keeps existing menu button and status indicator markup intact.

## Diffs by Feature (v0.6.43 -> patched)

### Profile image fallback handler
```diff
@@
+const handleProfileImageError = (event: Event) => {
+    const img = event.target as HTMLImageElement;
+    img.src = `${WEBUI_BASE_URL}/static/portico-logo.png`;
+};
```

### Avatar replacement (desktop + mobile)
```diff
@@
-<img
-    src={`${WEBUI_API_BASE_URL}/users/${$user?.id}/profile/image`}
-    class=" size-7 object-cover rounded-full"
-    alt={$i18n.t('Open User Profile Menu')}
-    aria-label={$i18n.t('Open User Profile Menu')}
-/>
+<div class="rounded-full bg-black dark:bg-transparent p-0.5">
+    <img
+        src={`${WEBUI_BASE_URL}/static/portico-logo.png`}
+        class=" size-7 object-cover rounded-full"
+        alt={$i18n.t('Open User Profile Menu')}
+        aria-label={$i18n.t('Open User Profile Menu')}
+    />
+</div>
```

## Repatch Plan for v0.7.2
1. Reapply the avatar replacement markup (black wrapper + `portico-logo.png`) in both desktop and mobile user menu blocks.
2. Keep any v0.7.2 conditional user-status indicator logic intact when merging.
3. If `handleProfileImageError` is still desired, reattach it to the `<img>` `on:error` handler or remove the unused helper.
