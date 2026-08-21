# backend/open_webui/routers/chats.py

## Patch Summary (v0.6.43)
- Purpose: Surface active MCP capabilities to the UI, serve MCP server icons, and protect `contentBlocks` from being lost on chat updates.
- User-visible: Real-time capabilities display (tools/skills) and proper server icons in UI.
- System behavior: New chat-level endpoints using Redis and socket.io to push capability changes.

## Technical Details (v0.6.43 patch)
- Redis integration for capabilities:
  - Optional `redis` import with `REDIS_AVAILABLE` guard.
  - `_get_redis_client()` connects to Redis (host `redis`, db 0), pings, and returns client or None.
  - `GET /{id}/active-capabilities` reads `chat_tools:{id}` and `chat_skills:{id}` keys, parses JSON, and returns tool/skill metadata.
  - `_format_server_display_name` removes `server:` prefix, splits on hyphens, and uppercases known acronyms.
- MCP icon serving:
  - Adds `FileResponse` and `Path` usage.
  - `GET /mcp/servers/{server_id}/icon` searches `/app/mcp-configs/{server_id}/{server_id}.png` and `/app/mcp-configs-user/...`, falls back to OWUI logo (`/app/source/...` or `/app/backend/...`).
- Capabilities change push:
  - `POST /{id}/capabilities-changed` emits a `chat:capabilities:updated` socket event via `sio` to `user:{user_id}` room.
  - Includes tools and skills payload so frontend can update state immediately.
- ContentBlocks preservation in chat updates:
  - In chat update handler, merges existing `history.messages[*].contentBlocks` into the incoming update when the new message lacks `contentBlocks`.

## Diffs by Feature (v0.6.43 -> patched)

### Redis-backed capabilities (imports + helpers)
```diff
@@
-import logging
-from typing import Optional
+import logging
+from typing import Optional
+
+# PORTICO PATCH: Redis import for active capabilities
+try:
+    import redis
+    REDIS_AVAILABLE = True
+except ImportError:
+    REDIS_AVAILABLE = False
@@
-from open_webui.socket.main import get_event_emitter
+from open_webui.socket.main import get_event_emitter, sio
@@
-from fastapi import APIRouter, Depends, HTTPException, Request, status
+from fastapi import APIRouter, Depends, HTTPException, Request, status
+from fastapi.responses import FileResponse
+from pathlib import Path
```

### MCP server icon endpoint
```diff
@@
+MCP_CONFIGS_DIR = Path("/app/mcp-configs")
+MCP_CONFIGS_USER_DIR = Path("/app/mcp-configs-user")
+DEFAULT_ICON_PATH = Path("/app/source/backend/open_webui/static/logo.png")
+DEFAULT_ICON_PATH_PROD = Path("/app/backend/open_webui/static/logo.png")
+
+@router.get("/mcp/servers/{server_id}/icon")
+async def get_mcp_server_icon(server_id: str):
+    icon_path = MCP_CONFIGS_DIR / server_id / f"{server_id}.png"
+    if icon_path.exists():
+        return FileResponse(icon_path, media_type="image/png")
+    icon_path = MCP_CONFIGS_USER_DIR / server_id / f"{server_id}.png"
+    if icon_path.exists():
+        return FileResponse(icon_path, media_type="image/png")
+    for default_path in [DEFAULT_ICON_PATH, DEFAULT_ICON_PATH_PROD]:
+        if default_path.exists():
+            return FileResponse(default_path, media_type="image/png")
+    raise HTTPException(status_code=404, detail="Icon not found")
```

### Active capabilities read + push endpoints
```diff
@@
+def _get_redis_client():
+    if not REDIS_AVAILABLE:
+        return None
+    try:
+        client = redis.Redis(host="redis", port=6379, db=0, decode_responses=True, socket_connect_timeout=2)
+        client.ping()
+        return client
+    except Exception:
+        return None
+
+def _format_server_display_name(server_id: str) -> str:
+    name = server_id.replace("server:", "")
+    words = name.split("-")
+    acronyms = {"mcp", "vm", "api", "pdf", "oauth", "ai"}
+    return " ".join([w.upper() if w.lower() in acronyms else w.capitalize() for w in words])
+
+@router.get("/{id}/active-capabilities")
+async def get_chat_active_capabilities(id: str, user=Depends(get_verified_user)):
+    redis_client = _get_redis_client()
+    if not redis_client:
+        return {"tools": [], "skills": []}
+    tools_json = redis_client.get(f"chat_tools:{id}")
+    skills_json = redis_client.get(f"chat_skills:{id}")
+    tools = json.loads(tools_json) if tools_json else []
+    skills = json.loads(skills_json) if skills_json else []
+    ...
+    return {"tools": tools_response, "skills": skills_response}
+
+class CapabilitiesChangedForm(BaseModel):
+    tools: Optional[list[dict]] = None
+    skills: Optional[list[dict]] = None
+
+@router.post("/{id}/capabilities-changed")
+async def notify_capabilities_changed(id: str, form_data: CapabilitiesChangedForm):
+    chat = Chats.get_chat_by_id(id)
+    if not chat:
+        return {"success": False, "error": "Chat not found"}
+    user_id = chat.user_id
+    await sio.emit(
+        "events",
+        {"chat_id": id, "message_id": None, "data": {"type": "chat:capabilities:updated", "data": {"chat_id": id, "tools": form_data.tools or [], "skills": form_data.skills or []}}},
+        room=f"user:{user_id}",
+    )
+    return {"success": True}
```

### Preserve contentBlocks on chat update
```diff
@@
-    if chat:
-        updated_chat = {**chat.chat, **form_data.chat}
-        chat = Chats.update_chat_by_id(id, updated_chat)
-        return ChatResponse(**chat.model_dump())
+    if chat:
+        updated_chat = {**chat.chat, **form_data.chat}
+        existing_history = chat.chat.get("history", {})
+        existing_messages = existing_history.get("messages", {})
+        new_history = updated_chat.get("history", {})
+        new_messages = new_history.get("messages", {})
+        for msg_id, existing_msg in existing_messages.items():
+            if msg_id in new_messages:
+                if "contentBlocks" in existing_msg and "contentBlocks" not in new_messages[msg_id]:
+                    new_messages[msg_id]["contentBlocks"] = existing_msg["contentBlocks"]
+        if new_messages:
+            new_history["messages"] = new_messages
+            updated_chat["history"] = new_history
+        chat = Chats.update_chat_by_id(id, updated_chat)
+        return ChatResponse(**chat.model_dump())
```

## Repatch Plan for v0.7.2
1. Review v0.7.2 changes (DB session injection, new chat stats export) and identify updated function signatures.
2. Reapply Redis-based capabilities endpoints:
   - Restore `REDIS_AVAILABLE`, `_get_redis_client`, `_format_server_display_name`, and `/active-capabilities` route.
   - Keep tool response shape: `server_id`, `display_name`, `icon_url`, `is_core`.
3. Reapply MCP icon endpoint and ensure file paths still match runtime layout.
4. Reapply `/capabilities-changed` route using `sio.emit` to user room.
5. Reapply `contentBlocks` preservation in chat update logic, adjusting for any v0.7.2 model/DB changes.
6. Ensure new v0.7.2 DB session usage is threaded through these new handlers (if required by updated signatures).
