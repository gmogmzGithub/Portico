# backend/open_webui/routers/openai.py

## Patch Summary (v0.6.43)
- Purpose: Improve system prompt handling, preserve metadata for callbacks, and surface SSE errors clearly.
- User-visible: More consistent system prompts, clearer error messages (e.g., rate limits).
- System behavior: Custom agent prompts get a shared base prompt; LLM debug callbacks receive chat metadata.

## Technical Details (v0.6.43 patch)
- Added `extract_error_message(error_json)` helper to normalize error shapes.
- Removed system role conversion:
  - Deleted logic that changed the first `system` message to `developer` for specific models.
  - Keeps system prompts consistent across providers and avoids debug filters missing `developer` role.
- Custom agent base prompt injection:
  - If `model_info.base_model_id` is set and a system prompt exists, reads `/app/agents/base_system_prompt.md` and prepends it.
  - Adds a separator header `## Custom Agent Instructions`.
- System prompt debugging:
  - Logs system prompt length and preview before and after `apply_system_prompt_to_body`.
  - Uses `replace=True` to avoid prompt duplication.
- Metadata preservation:
  - Preserves filtered request metadata for gateway headers.
- SSE error handling:
  - Checks `r.status` before constructing `StreamingResponse`.
  - On error (including 429), reads response body, extracts message, and returns `JSONResponse` with `{error: {message, type, code}}`.

## Diffs by Feature (v0.6.43 -> patched)

### Error message extraction helper
```diff
@@
+def extract_error_message(error_json: dict) -> str:
+    if "error" in error_json:
+        err = error_json["error"]
+        if isinstance(err, dict) and "message" in err:
+            return err["message"]
+        if isinstance(err, str):
+            return err
+    if "detail" in error_json:
+        return error_json["detail"]
+    if "message" in error_json:
+        return error_json["message"]
+    return json.dumps(error_json)
```

### Remove system->developer role conversion
```diff
@@
-    # Handle system role conversion based on model type
-    if payload["messages"][0]["role"] == "system":
-        model_lower = payload["model"].lower()
-        if model_lower.startswith("o1-mini") or model_lower.startswith("o1-preview"):
-            payload["messages"][0]["role"] = "user"
-        else:
-            payload["messages"][0]["role"] = "developer"
+    # PORTICO PATCH: Removed system->developer role conversion
```

### Base system prompt injection for custom agents
```diff
@@
-    payload = apply_model_params_to_body_openai(params, payload)
-    payload = apply_system_prompt_to_body(system, payload, metadata, user)
+    # PORTICO PATCH: Inject base system prompt for custom agents
+    if model_info.base_model_id and system:
+        try:
+            base_prompt_path = "/app/agents/base_system_prompt.md"
+            with open(base_prompt_path, "r") as f:
+                base_system_prompt = f.read().strip()
+            if base_system_prompt and not system.startswith("# Portico"):
+                system = f"{base_system_prompt}\n\n---\n\n## Custom Agent Instructions\n\n{system}"
+        except Exception:
+            pass
+    payload = apply_model_params_to_body_openai(params, payload)
+    payload = apply_system_prompt_to_body(system, payload, metadata, user, replace=True)
```

### System prompt debug logging (before/after apply)
```diff
@@
+    log.info("[SYSTEM-PROMPT-DEBUG] ========== BEFORE apply_system_prompt_to_body ==========")
+    log.info(f"[SYSTEM-PROMPT-DEBUG] Model: {model_id}")
+    log.info(f"[SYSTEM-PROMPT-DEBUG] System prompt length: {len(system) if system else 0}")
+    for i, msg in enumerate(payload.get("messages", [])):
+        if msg.get("role") == "system":
+            content = msg.get("content", "")
+            content_preview = content[:150] + "..." if len(content) > 150 else content
+            has_portico_context = "<portico_context>" in content
+            log.info(f"[SYSTEM-PROMPT-DEBUG]   System msg {i}: len={len(content)}, has_portico_context={has_portico_context}, preview={content_preview}")
@@
+    log.info("[SYSTEM-PROMPT-DEBUG] ========== AFTER apply_system_prompt_to_body ==========")
+    for i, msg in enumerate(payload.get("messages", [])):
+        if msg.get("role") == "system":
+            content = msg.get("content", "")
+            content_preview = content[:150] + "..." if len(content) > 150 else content
+            has_portico_context = "<portico_context>" in content
+            log.info(f"[SYSTEM-PROMPT-DEBUG]   System msg {i}: len={len(content)}, has_portico_context={has_portico_context}, preview={content_preview}")
```

### Preserve metadata for gateway headers
```diff
@@
-    payload = json.dumps(payload)
+    if metadata:
+        serializable_metadata = {}
+        for key in ("chat_id", "session_id", "message_id", "user_id"):
+            if key in metadata and metadata[key] is not None:
+                serializable_metadata[key] = metadata[key]
+        if serializable_metadata:
+            payload["metadata"] = serializable_metadata
+    payload = json.dumps(payload)
```

### SSE error handling before StreamingResponse
```diff
@@
-    if "text/event-stream" in r.headers.get("Content-Type", ""):
-        streaming = True
-        return StreamingResponse(stream_chunks_handler(r.content), background=BackgroundTask(cleanup_response, r, session))
+    if "text/event-stream" in r.headers.get("Content-Type", ""):
+        if r.status >= 400:
+            error_body = await r.content.read()
+            await cleanup_response(r, session)
+            try:
+                error_json = json.loads(error_body)
+                error_message = extract_error_message(error_json)
+            except Exception:
+                error_message = error_body.decode("utf-8", errors="replace")
+            return JSONResponse(
+                status_code=r.status,
+                content={"error": {"message": error_message, "type": "rate_limit_exceeded" if r.status == 429 else "api_error", "code": r.status}},
+            )
+        streaming = True
+        return StreamingResponse(stream_chunks_handler(r.content), background=BackgroundTask(cleanup_response, r, session))
```

## Repatch Plan for v0.7.2
1. Identify updated entry points (now include DB session dependency and `bypass_system_prompt`).
2. Reapply removal of system->developer conversion in payload normalization.
3. Reapply base system prompt injection for custom agents (guarded by `base_model_id`).
4. Reapply `replace=True` plus before/after debug logging around `apply_system_prompt_to_body` (only when not bypassed).
5. Reapply metadata preservation for gateway headers (filter to serializable keys only).
6. Reapply pre-stream SSE error handling using `extract_error_message`.
