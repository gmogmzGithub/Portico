# backend/open_webui/utils/middleware.py

## Patch Summary (v0.6.43)
- Purpose: Preserve tool-call history fidelity, enable dynamic tools, improve RAG/stream handling, and surface usage + files + tool timing for UI/observability.
- User-visible: Inline MCP tool images, accurate tool-call history on follow-up, clearer context-window error messaging, token/cost metrics, and per-tool call durations.
- System behavior: Dynamic MCP tool loading, tool rename mapping, duplicate tool-result suppression, safer payloads for LLM calls, and persistence of in-progress tool-call blocks.

## Technical Details (v0.6.43 patch)
- Added YAML-based MCP tool rename mapping:
  - New helpers `_normalize_server_id`, `_find_mcp_yaml_path`, `_sanitize_tool_name`, `_load_tool_rename_mapping`, `_get_renamed_tool_name`.
  - Caches rename mapping by mtime and applies it during MCP tool discovery (both normal and dynamic fetch paths).
- Added context-window error handling:
  - `_CONTEXT_WINDOW_ERROR_FRAGMENTS`, `CONTEXT_WINDOW_ERROR_MESSAGE`, `_is_context_window_error`, `_format_error_message`.
  - `_extract_error_message` parses JSONResponse and error dicts to find user-facing message.
- Added dynamic tool loading:
  - Redis integration (`reload_chat_tools_from_redis`) reads `chat_tools:{chat_id}`, loads new tools with `get_tools`, and produces new tool specs.
  - `fetch_mcp_tools_for_servers` connects to MCP servers, fetches tool specs, applies filters/renames, and builds callable tool dicts.
- Added contentBlocks preservation and reconstruction:
  - `reconstruct_anthropic_format` converts assistant `contentBlocks` into proper assistant + tool messages.
  - Called early in `process_chat_payload` to rebuild request history before filters.
  - Saves `contentBlocks` alongside serialized `content` for streaming, completion save, and cancellation save paths.
  - Sends `contentBlocks` back in websocket updates for frontend storage.
- Added RAG bypass:
  - `chat_completion_files_handler` early-returns when `BYPASS_EMBEDDING_AND_RETRIEVAL` is true to avoid context injection.
- Added usage/cost extraction:
  - For SSE, normalizes `usage` fields (prompt/completion/total) across providers and attaches response cost from Bifrost bridge metadata.
  - Emits usage events and writes usage to DB for headless/subagent flows.
  - Adds `stream_options.include_usage=true` when streaming.
- Added tool-result de-duplication:
  - In `serialize_content_blocks` and `convert_content_blocks_to_messages`, drops assistant text that duplicates tool results using a fingerprint match.
- Fixed tool-call name accumulation:
  - Uses assignment (not append) for streaming tool name deltas to avoid repeated names.
- Emits `files` events for tool results:
  - Sends `tool_result_files` to websocket so frontend can render inline images.
- Persists in-progress tool_calls state:
  - After tool_calls block creation and after each tool result, serializes contentBlocks and upserts chat message content (non-local chats) so mid-stream tool progress survives reloads.
- Captures per-tool-call timing:
  - Records started_at/ended_at/duration on each tool result and prefers per-result duration when rendering tool_calls detail blocks.
- Re-runs inlet filters on follow-up requests and strips OWUI-only fields (`tool_ids`, `files`, `tool_servers`, `features`, `variables`) before calling LLM.
- Adds targeted debug logging for system prompts, reconstruction, and tool handling.

## Diffs by Feature (v0.6.43 -> patched)

### MCP tool rename mapping (YAML + sanitization)
```diff
@@
-import textwrap
+import textwrap
+from pathlib import Path
@@
-from typing import Any, Optional
+from typing import Any, Optional, Callable
@@
+try:
+    import yaml
+except ImportError:
+    yaml = None
@@
+MCP_CONFIGS_DIR = Path("/app/mcp-configs")
+MCP_CONFIGS_USER_DIR = Path("/app/mcp-configs-user")
+_TOOL_RENAME_CACHE: dict[str, dict[str, Any]] = {}
+_TOOL_NAME_SANITIZE_RE = re.compile(r"[^A-Za-z0-9_]+")
+
+def _find_mcp_yaml_path(server_id: str) -> Optional[Path]:
+    server_id = _normalize_server_id(server_id)
+    user_yaml = MCP_CONFIGS_USER_DIR / server_id / f"{server_id}.yaml"
+    if user_yaml.exists():
+        return user_yaml
+    system_yaml = MCP_CONFIGS_DIR / server_id / f"{server_id}.yaml"
+    if system_yaml.exists():
+        return system_yaml
+    return None
+
+def _load_tool_rename_mapping(server_id: str) -> dict[str, str]:
+    normalized_id = _normalize_server_id(server_id)
+    yaml_path = _find_mcp_yaml_path(normalized_id)
+    if not yaml_path:
+        return {}
+    ...
+    mapping = data.get("tool_rename_mapping", {})
+    ...
+    _TOOL_RENAME_CACHE[normalized_id] = {"mtime": mtime, "mapping": cleaned}
+    return cleaned
+
+def _get_renamed_tool_name(rename_mapping: dict[str, str], original_name: str) -> str:
+    if not rename_mapping:
+        return original_name
+    desired = rename_mapping.get(original_name) or rename_mapping.get(
+        original_name.lower()
+    )
+    if not desired:
+        return original_name
+    sanitized = _sanitize_tool_name(desired)
+    return sanitized or original_name
```

### Context-window error normalization
```diff
@@
+CONTEXT_WINDOW_ERROR_MESSAGE = (
+    "Oops, looks like we exceeded our context window budget. Please start a new chat "
+    "or switch to a model with a larger context window."
+)
+_CONTEXT_WINDOW_ERROR_FRAGMENTS = (
+    "context window",
+    "context length",
+    "maximum context",
+    "max context",
+    "input is too long",
+    "prompt is too long",
+    "too long for requested model",
+    "too many tokens",
+    "exceeds the context",
+    "exceeded the context",
+    "input too long",
+    "maximum input length",
+    "context_size",
+    "context size",
+)
+
+def _is_context_window_error(message: str) -> bool:
+    if not message:
+        return False
+    lowered = message.lower()
+    return any(fragment in lowered for fragment in _CONTEXT_WINDOW_ERROR_FRAGMENTS)
+
+def _format_error_message(message: str) -> str:
+    if _is_context_window_error(message):
+        return CONTEXT_WINDOW_ERROR_MESSAGE
+    return message
+
+def _extract_error_message(error_data: Any) -> str:
+    if isinstance(error_data, JSONResponse):
+        ...
+    if isinstance(error_data, dict):
+        ...
+    if isinstance(error_data, str):
+        return error_data
+    return str(error_data)
```

### Dynamic tool loading from Redis
```diff
@@
+# Dynamic tool loading support for mid-turn tool enabling
+try:
+    from redis import Redis as RedisClient
+
+    DYNAMIC_TOOLS_REDIS_AVAILABLE = True
+except ImportError:
+    DYNAMIC_TOOLS_REDIS_AVAILABLE = False
+
+# PORTICO PATCH: Dynamic tool loading from Redis for mid-turn tool enabling
+async def reload_chat_tools_from_redis(
+    request,
+    chat_id: str,
+    existing_tool_ids: list,
+    user,
+    extra_params: dict,
+    model: dict,
+    form_data: dict,
+    metadata: dict,
+) -> tuple[dict, list, list]:
+    if not DYNAMIC_TOOLS_REDIS_AVAILABLE or not chat_id:
+        return {}, [], []
+    ...
+    chat_tools = json.loads(chat_tools_json)
+    new_tool_ids = [t for t in chat_tools if t not in existing_tool_ids]
+    ...
+    new_tools_dict = await get_tools(
+        request,
+        new_tool_ids,
+        user,
+        {"__model__": model, "__messages__": form_data.get("messages", []), "__files__": metadata.get("files", [])},
+    )
+    new_tool_specs = [
+        {"type": "function", "function": tool.get("spec", {})}
+        for tool in new_tools_dict.values()
+    ]
+    return new_tools_dict, new_tool_ids, new_tool_specs
```

### Dynamic tool reload hook after tool execution
```diff
@@
                     content_blocks.append(
                         {
                             "type": "tool_calls",
                             "content": response_tool_calls,
+                            "started_at": time.time(),
                         }
                     )
+                    tool_calls_block_index = len(content_blocks) - 1
@@
+                    try:
+                        dyn_chat_id = metadata.get("chat_id")
+                        if dyn_chat_id:
+                            dyn_existing_ids = metadata.get("tool_ids", []) or []
+                            (dyn_new_tools, dyn_new_ids, dyn_new_specs) = await reload_chat_tools_from_redis(
+                                request=request,
+                                chat_id=dyn_chat_id,
+                                existing_tool_ids=dyn_existing_ids,
+                                user=user,
+                                extra_params=extra_params,
+                                model=model,
+                                form_data=form_data,
+                                metadata=metadata,
+                            )
+                            if dyn_new_ids:
+                                tools = metadata.get("tools", {})
+                                tools.update(dyn_new_tools)
+                                metadata["tools"] = tools
+                                metadata["tool_ids"] = dyn_existing_ids + dyn_new_ids
+                                if "tools" in form_data:
+                                    form_data["tools"].extend(dyn_new_specs)
+                                else:
+                                    form_data["tools"] = dyn_new_specs
+                    except Exception:
+                        pass
```

### MCP tool fetch for dynamically added servers
```diff
@@
+# PORTICO PATCH: Helper function to fetch MCP tools for dynamically added servers
+async def fetch_mcp_tools_for_servers(
+    request,
+    tool_ids: list,
+    user,
+    extra_params: dict = None,
+) -> tuple[dict, list]:
+    from open_webui.utils.tools import is_string_allowed
+    from open_webui.utils.mcp.client import MCPClient
+    ...
+    for tool_id in tool_ids:
+        if not tool_id.startswith("server:"):
+            continue
+        ...
+        tool_specs = await mcp_clients[server_id].list_tool_specs()
+        rename_mapping = _load_tool_rename_mapping(server_id)
+        for tool_spec in tool_specs:
+            ...
+            renamed_name = _get_renamed_tool_name(rename_mapping, original_name)
+            full_name = f"{server_id}_{renamed_name}"
+            ...
+            mcp_tools_dict[full_name] = {
+                "spec": {**tool_spec, "name": full_name},
+                "callable": tool_function,
+                "type": "mcp",
+                "client": mcp_clients[server_id],
+                "direct": False,
+            }
```

### RAG bypass for full-context file uploads
```diff
@@
 async def chat_completion_files_handler(
@@
-    if files := body.get("metadata", {}).get("files", None):
+    if request.app.state.config.BYPASS_EMBEDDING_AND_RETRIEVAL:
+        log.info("[RAG] BYPASS_EMBEDDING_AND_RETRIEVAL=True - skipping RAG processing")
+        return body, {"sources": []}
+
+    if files := body.get("metadata", {}).get("files", None):
```

### contentBlocks reconstruction (function + call site)
```diff
@@
+def reconstruct_anthropic_format(messages):
+    """
+    Reconstruct proper Anthropic/OpenAI message format from stored contentBlocks.
+    """
+    if not messages:
+        return messages
+    reconstructed = []
+    for msg in messages:
+        if msg.get("role") != "assistant":
+            reconstructed.append(msg)
+            continue
+        if "contentBlocks" in msg and msg["contentBlocks"]:
+            converted_messages = []
+            temp_text_parts = []
+            for block in msg["contentBlocks"]:
+                if block.get("type") == "tool_calls":
+                    converted_messages.append({
+                        "role": "assistant",
+                        "content": text_content,
+                        "tool_calls": block.get("content", []),
+                    })
+                    for result in block.get("results", []):
+                        converted_messages.append({
+                            "role": "tool",
+                            "tool_call_id": result.get("tool_call_id", ""),
+                            "content": result.get("content", "") or "",
+                        })
+                    temp_text_parts = []
+                else:
+                    temp_text_parts.append(block)
+            ...
+            reconstructed.extend(converted_messages)
+        else:
+            reconstructed.append(msg)
+    return reconstructed
@@
-    form_data = apply_params_to_form_data(form_data, model)
+    if "messages" in form_data and form_data["messages"]:
+        try:
+            form_data["messages"] = reconstruct_anthropic_format(form_data["messages"])
+        except Exception:
+            pass
+    form_data = apply_params_to_form_data(form_data, model)
```

### contentBlocks storage + websocket payloads
```diff
@@
-    data = {
-        "done": True,
-        "content": serialize_content_blocks(content_blocks),
-        "title": title,
-    }
+    data = {
+        "done": True,
+        "content": serialize_content_blocks(content_blocks),
+        "contentBlocks": content_blocks,
+        "title": title,
+    }
@@
-    Chats.upsert_message_to_chat_by_id_and_message_id(
-        metadata["chat_id"],
-        metadata["message_id"],
-        {"content": serialize_content_blocks(content_blocks)},
-    )
+    Chats.upsert_message_to_chat_by_id_and_message_id(
+        metadata["chat_id"],
+        metadata["message_id"],
+        {
+            "content": serialize_content_blocks(content_blocks),
+            "contentBlocks": content_blocks,
+        },
+    )
```

### stream_options.include_usage for SSE
```diff
@@
-    form_data = apply_params_to_form_data(form_data, model)
+    form_data = apply_params_to_form_data(form_data, model)
+    if form_data.get("stream", False):
+        if "stream_options" not in form_data:
+            form_data["stream_options"] = {}
+        form_data["stream_options"]["include_usage"] = True
```

### Tool-result de-duplication
```diff
@@
-                for block in content_blocks:
-                    if block["type"] == "text":
-                        block_content = block["content"].strip()
-                        if block_content:
-                            content = f"{content}{block_content}\n"
+                all_tool_results = []
+                for block in content_blocks:
+                    if block["type"] == "tool_calls":
+                        for result in block.get("results", []):
+                            result_content = result.get("content", "") or ""
+                            if result_content:
+                                all_tool_results.append(result_content)
+
+                for block in content_blocks:
+                    if block["type"] == "text":
+                        block_content = block["content"].strip()
+                        if block_content:
+                            is_duplicate = False
+                            for tool_result in all_tool_results:
+                                result_fingerprint = (tool_result or "")[:150].strip()
+                                if result_fingerprint and result_fingerprint in block_content:
+                                    is_duplicate = True
+                                    break
+                            if not is_duplicate:
+                                content = f"{content}{block_content}\n"
@@
-                messages.append(
-                    {
-                        "role": "assistant",
-                        "content": serialize_content_blocks(temp_blocks, raw),
-                        "tool_calls": block.get("content"),
-                    }
-                )
+                assistant_content = serialize_content_blocks(temp_blocks, raw)
+                is_duplicate = False
+                ...
+                messages.append(
+                    {
+                        "role": "assistant",
+                        "content": "" if is_duplicate else assistant_content,
+                        "tool_calls": block.get("content"),
+                    }
+                )
```

### Usage normalization + cost extraction + DB persistence
```diff
@@
-    usage = data.get("usage", {}) or {}
-    usage.update(data.get("timings", {}))  # llama.cpp
+    usage = data.get("usage", {}) or {}
+    if not usage:
+        usage = data.get("metadata", {}).get("usage", {}) or {}
+    if usage:
+        normalized_usage = {}
+        normalized_usage["prompt_tokens"] = (
+            usage.get("prompt_tokens")
+            or usage.get("input_tokens")
+            or usage.get("inputTokens")
+            or 0
+        )
+        normalized_usage["completion_tokens"] = (
+            usage.get("completion_tokens")
+            or usage.get("output_tokens")
+            or usage.get("outputTokens")
+            or 0
+        )
+        normalized_usage["total_tokens"] = (
+            usage.get("total_tokens")
+            or usage.get("totalTokens")
+            or (normalized_usage["prompt_tokens"] + normalized_usage["completion_tokens"])
+        )
+        usage = normalized_usage
+    response_cost = (
+        data.get("hidden_params", {}).get("response_cost")
+        or data.get("llm-gateway_response_cost")
+        or data.get("metadata", {}).get("llm-gateway_response_cost")
+        or 0
+    )
+    if response_cost:
+        usage["cost"] = response_cost
+    usage.update(data.get("timings", {}))  # llama.cpp
+    if usage and usage.get("prompt_tokens"):
+        await event_emitter({"type": "chat:completion", "data": {"usage": usage}})
+        if metadata.get("chat_id") and metadata.get("message_id"):
+            if not metadata["chat_id"].startswith("local:"):
+                Chats.upsert_message_to_chat_by_id_and_message_id(
+                    metadata["chat_id"],
+                    metadata["message_id"],
+                    {"usage": usage},
+                )
```

### Streaming error formatting (context-window aware)
```diff
@@
-    if not choices:
-        error = data.get("error", {})
-        if error:
-            await event_emitter(
-                {"type": "chat:completion", "data": {"error": error}}
-            )
+    if not choices:
+        error = data.get("error", {})
+        if error:
+            error_message = _format_error_message(_extract_error_message(error))
+            await event_emitter(
+                {
+                    "type": "chat:completion",
+                    "data": {"error": {"message": error_message}},
+                }
+            )
```

### Tool name assignment fix in streaming
```diff
@@
-    if delta_name:
-        current_response_tool_call["function"]["name"] += delta_name
+    if delta_name:
+        current_response_tool_call["function"]["name"] = delta_name
```

### Emit files event for tool results
```diff
@@
-    results.append({
-        "tool_call_id": tool_call_id,
-        "content": tool_result or "",
-    })
+    if tool_result_files:
+        await event_emitter({"type": "files", "data": {"files": tool_result_files}})
+    results.append({
+        "tool_call_id": tool_call_id,
+        "content": tool_result or "",
+        **({"files": tool_result_files} if tool_result_files else {}),
+    })
```

### Per-tool-call duration tracking
```diff
@@
-                                    # Get duration from block or calculate from started_at
-                                    block_duration = block.get("duration", None)
-                                    block_started_at = block.get("started_at", None)
-                                    display_duration = (
-                                        block_duration
-                                        if block_duration is not None
-                                        else (
-                                            int(time.time() - block_started_at)
-                                            if block_started_at
-                                            else 0
-                                        )
-                                    )
-                                    tool_calls_display_content = f'... duration="{display_duration}" ...'
+                                    # Prefer per-tool-call duration when available, fallback to block duration.
+                                    tool_result_duration = result.get("duration", None)
+                                    if tool_result_duration is None:
+                                        result_started_at = result.get("started_at")
+                                        result_ended_at = result.get("ended_at")
+                                        if result_started_at and result_ended_at:
+                                            tool_result_duration = int(
+                                                result_ended_at - result_started_at
+                                            )
+                                    if tool_result_duration is None:
+                                        block_duration = block.get("duration", None)
+                                        block_started_at = block.get("started_at", None)
+                                        tool_result_duration = ...
+                                    tool_calls_display_content = f'... duration="{tool_result_duration}" ...'
```

### Persist in-progress tool_calls content
```diff
@@
+                    tool_calls_content = serialize_content_blocks(content_blocks)
+                    await event_emitter({"type": "chat:completion", "data": {"content": tool_calls_content}})
+                    if metadata.get("chat_id") and metadata.get("message_id"):
+                        if not metadata["chat_id"].startswith("local:"):
+                            Chats.upsert_message_to_chat_by_id_and_message_id(
+                                metadata["chat_id"],
+                                metadata["message_id"],
+                                {"content": tool_calls_content, "contentBlocks": content_blocks},
+                            )
@@
+                        result_entry = {
+                            "tool_call_id": tool_call_id,
+                            "content": tool_result or "",
+                            "started_at": tool_call_started_at,
+                            "ended_at": tool_call_ended_at,
+                            "duration": tool_call_duration,
+                            ...
+                        }
+                        results.append(result_entry)
+                        content_blocks[tool_calls_block_index]["results"] = results
+                        tool_calls_content = serialize_content_blocks(content_blocks)
+                        await event_emitter({"type": "chat:completion", "data": {"content": tool_calls_content}})
+                        if metadata.get("chat_id") and metadata.get("message_id"):
+                            if not metadata["chat_id"].startswith("local:"):
+                                Chats.upsert_message_to_chat_by_id_and_message_id(
+                                    metadata["chat_id"],
+                                    metadata["message_id"],
+                                    {"content": tool_calls_content, "contentBlocks": content_blocks},
+                                )
```

### Follow-up inlet re-run + internal field stripping
```diff
@@
-    new_form_data = {
-        **form_data,
-        "model": model_id,
-        "stream": True,
-        "messages": [
-            *form_data["messages"],
-            *convert_content_blocks_to_messages(content_blocks, True),
-        ],
-    }
+    new_form_data = {
+        **form_data,
+        "model": model_id,
+        "stream": True,
+        "messages": [
+            *form_data["messages"],
+            *convert_content_blocks_to_messages(content_blocks, True),
+        ],
+    }
+    try:
+        followup_extra_params = {**extra_params, "__is_followup_request__": True}
+        new_form_data, _ = await process_filter_functions(
+            request=request,
+            filter_functions=filter_functions,
+            filter_type="inlet",
+            form_data=new_form_data,
+            extra_params=followup_extra_params,
+        )
+    except Exception:
+        pass
+    owui_internal_fields = ["tool_ids", "files", "tool_servers", "features", "variables"]
+    for field in owui_internal_fields:
+        new_form_data.pop(field, None)
```

## Repatch Plan for v0.7.2
1. Review upstream v0.7.2 middleware changes (tool citation sources, tool server access gating, RAG system context) and map insert points.
2. Reapply MCP rename + dynamic tool loading:
   - Keep YAML rename mapping and collision handling in MCP tool load path.
   - Reinsert Redis-based `reload_chat_tools_from_redis` hook during tool-call streaming and follow-up cycles.
3. Reapply contentBlocks pipeline:
   - Ensure `reconstruct_anthropic_format` is called before filters.
   - Preserve `contentBlocks` in all save paths and websocket payloads.
4. Reapply RAG bypass in `chat_completion_files_handler`.
5. Reapply streaming usage and cost normalization:
   - Preserve `stream_options.include_usage` and usage extraction/DB persistence.
6. Reapply tool-result de-duplication checks during content serialization and follow-up message construction.
7. Reapply error message formatting for context-window cases in streaming error handling.
8. Reapply per-tool-call timing capture and ensure detail rendering prefers per-result duration.
9. Reapply in-progress tool_calls persistence (emit serialized content and upsert chat message after tool_calls start and each tool result).
10. Reapply tool-call name assignment fix and `files` websocket emission for tool results.
11. Reapply follow-up inlet filter re-run and internal field stripping.
12. Validate against v0.7.2 changes to ensure no new upstream fields or function signatures break these hooks.
