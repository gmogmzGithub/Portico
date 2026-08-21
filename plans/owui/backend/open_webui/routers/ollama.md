# backend/open_webui/routers/ollama.py

## Patch Summary (v0.6.43)
- Purpose: Prevent system prompt duplication when applying model params.
- User-visible: Stops repeated or telescoping system prompts in chat history.

## Technical Details (v0.6.43 patch)
- In both `generate_chat_completion` (Ollama) and `generate_openai_chat_completion` (proxy) paths:
  - Calls `apply_system_prompt_to_body(system, payload, metadata, user, replace=True)`.
  - `replace=True` ensures the system message is replaced instead of appended repeatedly.

## Diffs by Feature (v0.6.43 -> patched)

### System prompt replacement (Ollama chat completion)
```diff
@@
-    payload = apply_model_params_to_body_ollama(params, payload)
-    payload = apply_system_prompt_to_body(system, payload, metadata, user)
+    payload = apply_model_params_to_body_ollama(params, payload)
+    # PORTICO PATCH: Use replace=True to prevent telescoping system prompt duplication
+    payload = apply_system_prompt_to_body(system, payload, metadata, user, replace=True)
```

### System prompt replacement (OpenAI-compatible path)
```diff
@@
-    payload = apply_model_params_to_body_openai(params, payload)
-    payload = apply_system_prompt_to_body(system, payload, metadata, user)
+    payload = apply_model_params_to_body_openai(params, payload)
+    # PORTICO PATCH: Use replace=True to prevent telescoping system prompt duplication
+    payload = apply_system_prompt_to_body(system, payload, metadata, user, replace=True)
```

## Repatch Plan for v0.7.2
1. Locate the v0.7.2 system prompt application sites (now include `bypass_system_prompt` and DB session dependency).
2. Reapply `replace=True` in those calls, only when the system prompt is actually applied (respect `bypass_system_prompt`).
3. Confirm no new upstream logic depends on the previous append behavior.
