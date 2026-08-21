# backend/open_webui/retrieval/loaders/main.py

## Patch Summary (v0.6.43)
- Purpose: Avoid noisy encoding warnings when users upload binary files.
- User-visible: Uploading binaries (zip, images, audio, etc.) no longer triggers chardet warnings in logs.

## Technical Details (v0.6.43 patch)
- Introduced `known_binary_ext` list for archives, executables, images, audio, video, fonts, and generic binaries.
- Added `BinaryFileLoader` class that returns a single empty `Document` with `metadata.source` set to the file path.
- Inserted binary extension check in `_get_loader` fallback chain:
  - If `file_ext` is in `known_binary_ext`, use `BinaryFileLoader` instead of `TextLoader`.

## Diffs by Feature (v0.6.43 -> patched)

### Known binary extension list
```diff
@@
+known_binary_ext = [
+    "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
+    "exe", "dll", "so", "dylib",
+    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff",
+    "mp3", "wav", "ogg", "flac", "aac",
+    "mp4", "avi", "mkv", "mov", "wmv",
+    "woff", "woff2", "ttf", "otf", "eot",
+    "bin", "dat",
+]
```

### BinaryFileLoader implementation
```diff
@@
+class BinaryFileLoader:
+    def __init__(self, file_path):
+        self.file_path = file_path
+
+    def load(self) -> list[Document]:
+        return [Document(page_content="", metadata={"source": self.file_path})]
```

### Loader selection hook
```diff
@@
-            elif self._is_text_file(file_ext, file_content_type):
-                loader = TextLoader(file_path, autodetect_encoding=True)
-            else:
-                loader = TextLoader(file_path, autodetect_encoding=True)
+            elif self._is_text_file(file_ext, file_content_type):
+                loader = TextLoader(file_path, autodetect_encoding=True)
+            elif file_ext in known_binary_ext:
+                loader = BinaryFileLoader(file_path)
+            else:
+                loader = TextLoader(file_path, autodetect_encoding=True)
```

## Repatch Plan for v0.7.2
1. Locate `_get_loader` fallback chain in v0.7.2 (note upstream added `REQUESTS_VERIFY` changes for Tika).
2. Reapply `known_binary_ext` list and `BinaryFileLoader` class.
3. Reinsert binary extension check before the final `TextLoader` fallback.
4. Confirm `Document` import remains unchanged and return shape is compatible.
