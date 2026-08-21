# backend/open_webui/main.py

## Patch Summary (v0.6.43)
- Purpose: Preserve custom static assets across startup and guard against null parent_message metadata.
- User-visible: Ensures Portico branding assets remain available from `/static` after startup.

## Technical Details (v0.6.43 patch)
- Null-safe parent_message handling:
  - Replaced `metadata.get("parent_message", {})` with `metadata.get("parent_message") or {}` so explicit `None` does not propagate.
  - Prevents attribute access errors when resolving parent message files.
- Static asset persistence:
  - After config clears `STATIC_DIR`, copies files from `/app/patches/backend/open_webui/static` into `STATIC_DIR`.
  - Uses `shutil.copy2` with logging and error handling.
  - Must run before `app.mount("/static", ...)` to ensure assets are served.

## Diffs by Feature (v0.6.43 -> patched)

### Null-safe parent_message retrieval
```diff
@@
-    parent_message = metadata.get("parent_message", {})
+    # PORTICO PATCH: Use `or {}` to handle explicit None values
+    parent_message = metadata.get("parent_message") or {}
```

### Copy custom static assets on startup
```diff
@@
+_portico_static_dir = "/app/patches/backend/open_webui/static"
+if os.path.exists(_portico_static_dir):
+    for _filename in os.listdir(_portico_static_dir):
+        _src = os.path.join(_portico_static_dir, _filename)
+        _dst = os.path.join(STATIC_DIR, _filename)
+        if os.path.isfile(_src):
+            try:
+                shutil.copy2(_src, _dst)
+                log.info(f"Portico: Copied {_filename} to static directory")
+            except Exception as e:
+                log.error(f"Portico: Failed to copy {_filename}: {e}")
+
 app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
```

## Repatch Plan for v0.7.2
1. Reapply the null-safe `parent_message` retrieval in the chat completion handler (where parent files are injected).
2. Reinsert the static asset copy block just before `app.mount("/static", ...)`.
3. Validate that v0.7.2 startup flow still clears `STATIC_DIR` and that the patch directory path remains `/app/patches/backend/open_webui/static`.
