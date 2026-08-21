# frontend/src/app.css

## Patch Summary (v0.6.43)
- Purpose: Apply Portico branding/typography and adjust UI spacing/readability.
- User-visible: Portico Sans font, smaller sidebar/chat text, shimmer placeholder, cleaner message spacing, and a more defined input box.

## Technical Details (v0.6.43 patch)
- Custom font system:
  - Adds `@font-face` for Portico Sans variable font and CSS vars `--portico-font-family` / `--portico-font-weight`.
  - Forces global font via `html, body, *` and overrides `.font-primary`/`.font-secondary`.
- Sidebar/chat list sizing tweaks:
  - Reduces chat list font size via `#sidebar-chat-item`.
  - Reduces sidebar nav button text size and user name size.
- Placeholder shimmer effect:
  - Replaces placeholder text color with animated gradient for `.ProseMirror p.is-editor-empty::before`.
  - Adds `@keyframes placeholder-shimmer-slow` and dark mode variants.
- Messages layout tweaks:
  - Adds gradient mask + top padding on `#messages-container` to prevent content bleeding into header.
  - Reduces bottom padding in messages area by overriding `.pb-18` and `.pb-6`.
  - Reduces message font size in `#messages-container .prose/.markdown-prose`.
- Message input styling:
  - Adds stronger border/shadow on `#message-input-container` (light/dark variants).
  - Constrains input width and adds bottom spacing around input wrapper.

## Diffs by Feature (v0.6.43 -> patched)

### Portico Sans font + global overrides
```diff
@@
 @reference "./tailwind.css";
+
+@font-face {
+    font-family: 'Portico Sans';
+    src: url('/static/fonts/portico-sans/PorticoSansVF.woff2') format('woff2');
+    font-weight: 100 900;
+    font-style: normal;
+    font-display: swap;
+}
+
+:root {
+    --portico-font-family: 'Portico Sans', -apple-system, BlinkMacSystemFont, sans-serif;
+    --portico-font-weight: 400;
+}
+
+html, body, * {
+    font-family: var(--portico-font-family) !important;
+    font-weight: var(--portico-font-weight) !important;
+}
+
+.font-primary,
+.font-secondary {
+    font-family: var(--portico-font-family) !important;
+    font-weight: var(--portico-font-weight) !important;
+}
```

### Sidebar and chat list sizing
```diff
@@
 #sidebar-chat-item {
     min-height: calc(32px * var(--app-text-scale, 1));
     padding-inline: calc(11px * var(--app-text-scale, 1));
     padding-block: calc(6px * var(--app-text-scale, 1));
+    font-size: 0.8rem !important;
 }
@@
+#sidebar-new-chat-button .text-sm,
+#sidebar-search-button .text-sm,
+#sidebar-notes-button .text-sm,
+#sidebar-workspace-button .text-sm {
+    font-size: 0.8rem !important;
+}
+
+#sidebar div.font-primary .font-medium {
+    font-size: 0.8rem !important;
+}
```

### Placeholder shimmer (light + dark)
```diff
@@
 .ProseMirror p.is-editor-empty:first-child::before {
-    color: #676767;
     pointer-events: none;
+    background: linear-gradient(90deg, #9ca3af 25%, #6b7280 50%, #9ca3af 75%);
+    background-size: 200% 100%;
+    -webkit-background-clip: text !important;
+    -webkit-text-fill-color: transparent;
+    background-clip: text !important;
+    animation: placeholder-shimmer-slow 8s ease-in-out infinite;
@@
+@keyframes placeholder-shimmer-slow {
+    0% { background-position: 100% 0; }
+    50% { background-position: 0% 0; }
+    100% { background-position: 100% 0; }
+}
@@
 @media (prefers-color-scheme: dark) {
     .ProseMirror p.is-editor-empty:first-child::before {
-        color: #757575;
+        background: linear-gradient(90deg, #9ca3af 25%, #d1d5db 50%, #9ca3af 75%);
+        background-size: 200% 100%;
     }
 }
+
+.dark .ProseMirror p.is-editor-empty:first-child::before {
+    background: linear-gradient(90deg, #9ca3af 25%, #d1d5db 50%, #9ca3af 75%);
+    background-size: 200% 100%;
+}
```

### Messages container mask + padding tweaks
```diff
@@
+#messages-container {
+    -webkit-mask-image: linear-gradient(
+        to bottom,
+        transparent 0px,
+        transparent 50px,
+        rgba(0, 0, 0, 0.5) 70px,
+        black 100px
+    );
+    mask-image: linear-gradient(
+        to bottom,
+        transparent 0px,
+        transparent 50px,
+        rgba(0, 0, 0, 0.5) 70px,
+        black 100px
+    );
+    padding-top: 35px !important;
+}
+
+#messages-container .pb-18 { padding-bottom: 0.75rem !important; }
+#messages-container .pb-6 { padding-bottom: 0.25rem !important; }
+
+#messages-container .prose,
+#messages-container .markdown-prose {
+    font-size: 0.9rem !important;
+}
```

### Message input border + sizing
```diff
@@
+#message-input-container {
+    border: 1.5px solid rgba(100, 100, 100, 0.4) !important;
+    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.04) !important;
+    max-width: 630px !important;
+    margin-left: auto !important;
+    margin-right: auto !important;
+}
+
+.dark #message-input-container {
+    border: 1.5px solid rgba(150, 150, 150, 0.3) !important;
+    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05) !important;
+}
+
+#chat-container > div > div.pb-0\.5 { padding-bottom: 1rem !important; }
+.font-primary > .bg-transparent { padding-bottom: 1.5rem !important; }
```

## Repatch Plan for v0.7.2
1. Reapply the Portico Sans font block and global font overrides at the top of the file.
2. Reapply sidebar/chat font size overrides and confirm selectors still match v0.7.2 markup.
3. Reapply placeholder shimmer styles and dark mode overrides (verify `.ProseMirror` selectors unchanged).
4. Reapply `#messages-container` mask + spacing tweaks and verify layout after v0.7.2 CSS changes.
5. Reapply `#message-input-container` border/shadow and width/spacing overrides.
6. Preserve upstream v0.7.2 CSS changes (e.g., `text-start`) while merging our overrides.
