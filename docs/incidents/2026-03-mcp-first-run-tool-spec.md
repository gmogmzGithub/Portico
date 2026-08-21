# MCP Integration First-Run Problem: Tools Not Available Mid-Turn

## Problem Statement

When a user asks the LLM to enable an integration and immediately use it in the **same conversation turn**, the newly-enabled integration's tools are not available to the LLM. The LLM is forced to ask the user to "send another message" to use the integration, even though the tools should be available mid-agentic-loop.

**Example flow:**
1. User: "What are my meetings this week?"
2. LLM detects Google Workspace is disabled, offers to enable
3. User: "Yes please"
4. LLM calls `toggle_integration` → `authorize_integration` → `activate_integration`
5. LLM tries to call `google_workspace_get_events` → **fails** (tool not in spec)
6. LLM asks user to send another message

**Expected:** After step 4, the LLM should be able to call Google Workspace tools in the same turn.

## Architecture Layers Involved

- **MCP Orchestration** (middleware follow-up loop, tool spec loading)
- **LLM Routing** (tool_ids → tool specs → LLM API payload)
- **Docker Orchestration** (MCPO reverse proxy route registration)

## Root Cause

The agentic follow-up loop in `middleware.py` has a **sequencing problem** between the dynamic tool reload and the inlet filter. Two issues compound:

### Issue 1: MCPO 502 Bad Gateway (timing)

When `activate_integration` writes `server:google_workspace` to Redis, the dynamic tool reload immediately tries to fetch the tool specs from MCPO at `http://mcpo/google_workspace/openapi.json`. But MCPO hasn't finished registering the new server's route yet (the container was just restarted during the OAuth flow), so it returns **502 Bad Gateway**.

**Evidence from logs:**
```
[DYNAMIC_TOOLS] Found 1 NEW tools in Redis: ['server:google_workspace']
ERROR Could not fetch tool server spec from http://mcpo/google_workspace/openapi.json
    → 502 Bad Gateway (text/html response, not JSON)
[DYNAMIC_TOOLS] Loaded 0 new tool functions: []
```

### Issue 2: Sequencing — Dynamic Reload Runs Before Inlet Filter

Even if MCPO were ready, the dynamic reload runs **before** the inlet filter. The inlet filter is what calls `_ensure_tool_server_connections()` to register the new server in `TOOL_SERVER_CONNECTIONS`. Without that registration, `get_tools()` can't find the server connection config.

**Current follow-up loop order:**
```
1. DYNAMIC TOOL RELOAD (middleware.py ~L5894)
   → Reads Redis: finds server:google_workspace
   → Calls get_tools() → looks up TOOL_SERVER_CONNECTIONS → server not found
   → Also tries MCPO: 502 Bad Gateway
   → Result: 0 tool specs loaded

2. Create new_form_data (middleware.py ~L5944)
   → Inherits form_data["tools"] which has 0 google_workspace specs

3. Inlet filter re-run (middleware.py ~L5988)
   → Calls _ensure_tool_server_connections() → registers google_workspace
   → Sets body["tool_ids"] to include server:google_workspace
   → Updates system prompt to mention google_workspace is available
   → But does NOT load tool specs into form_data["tools"]

4. Strip internal fields (middleware.py ~L6003)
   → Removes tool_ids (it's an internal field, not sent to LLM API)

5. LLM API call (middleware.py ~L6050)
   → form_data["tools"] has 0 google_workspace function definitions
   → System prompt says google_workspace is available (contradiction!)
   → LLM cannot generate tool calls for tools not in its spec
```

### Issue 3: The LLM Sees Contradictory Information

The system prompt (updated by the inlet filter) tells the LLM that `server:google_workspace` is enabled. But the actual `tools` array in the API payload doesn't include any google_workspace functions. The LLM correctly identifies it can't call those tools and falls back to asking the user to send another message.

## Attempted Fix (Failed)

A retry mechanism was added to `middleware.py` that re-runs `reload_chat_tools_from_redis` **after** the inlet filter. This addresses Issue 2 (sequencing) but **does not solve the problem**.

The retry was deployed and tested (container rebuilt via `./install_v2.sh --force-local-build --node`). The retry code runs — but MCPO is **still not ready** even after the inlet filter completes. The gap between the first attempt and the retry is only ~200ms, which is not enough time for MCPO to register the new server route after a container restart.

**Evidence from logs:**
```
[DYNAMIC_TOOLS] Found 1 NEW tools in Redis: ['server:google_workspace']
ERROR Could not fetch tool server spec from http://mcpo/google_workspace/openapi.json
Tool server data not found for google_workspace after refresh
[DYNAMIC_TOOLS] Loaded 0 new tool functions: []
[DYNAMIC_TOOLS] Mid-turn: added 1 tools: ['server:google_workspace']
[DYNAMIC_TOOLS] Partial failure: 1 IDs found but only 0 specs loaded; will retry after inlet filter
[DYNAMIC_TOOLS] Retry after inlet filter also failed to load tool specs
```

The LLM then attempted to call `google_workspace_get_events` anyway (because the system prompt said it was available), but the tool wasn't in the execution registry:
```
[TOOL-CALL] Processing 1 tool calls: ['google_workspace_get_events']
[TOOL-CALL] Tool google_workspace_get_events not found in tools dict (integration likely disabled) - returning error to LLM
```

**Conclusion:** A simple immediate retry is insufficient. MCPO route registration takes significantly longer than the ~200ms between the dynamic reload and the retry. The fix needs a fundamentally different approach — either waiting for MCPO readiness with a poll/delay, or bypassing MCPO entirely for the initial tool spec load.

## Key Files

| File | Role |
|------|------|
| `src/patches/backend/open_webui/utils/middleware.py` L5894-5946 | Dynamic tool reload in follow-up loop |
| `src/patches/backend/open_webui/utils/middleware.py` L388-472 | `reload_chat_tools_from_redis()` function |
| `src/patches/backend/open_webui/utils/middleware.py` L5988-5999 | Inlet filter re-run on follow-up |
| `src/filters/unified_context.py` L1297-1404 | `_ensure_tool_server_connections()` |
| `src/filters/unified_context.py` L2018-2063 | `tool_ids` merging and `body["tool_ids"]` assignment |
| `src/core-mcp-rust/mcp-assistant/src/mcp_assistant_server/tools.py` L1505-1564 | `handle_activate_integration()` — writes to Redis |

## What `activate_integration` Actually Does

1. Reads existing tools from `chat_tools:{chat_id}` in Redis
2. Merges new server IDs, avoids duplicates
3. Writes combined list back to Redis with 7-day TTL
4. Sends UI notification via `notify_capabilities_changed()`

It does **not** register tool server connections, load tool specs, or signal the middleware to refresh. It relies entirely on the follow-up loop's dynamic reload reading from Redis.

## What Would Fix This

The core issue is that tool spec loading (`get_tools()`) needs to happen **after** both:
1. `_ensure_tool_server_connections()` has registered the server in `TOOL_SERVER_CONNECTIONS`
2. MCPO has had time to register the server's route (at least a few hundred ms after container restart)

Possible approaches (in order of likely effectiveness):
- **MCPO readiness check with polling**: Have the retry poll MCPO with a short backoff (e.g., 3 attempts, 500ms apart) until the OpenAPI spec is available. This accounts for the variable startup time.
- **Proactive MCPO readiness in `authorize_integration`**: The OAuth flow already waits for the server to be healthy. Extend it to also verify MCPO is serving the route before returning success. This front-loads the wait into the blocking tool call rather than the follow-up loop.
- **Inlet filter loads specs**: Have the inlet filter not just set `tool_ids` but also load and inject tool specs into `form_data["tools"]` for newly-added servers on follow-up requests.
- **Optimistic tool injection**: Have `activate_integration` return the tool specs directly (fetched from MCPO at that point, when the server is already healthy), and have the middleware inject them without a second MCPO fetch.

**Ruled out:**
- **Simple immediate retry:** ~200 ms is not enough for MCPO route registration.

## How to Reproduce

1. Start with Google Workspace (or any OAuth integration) disabled
2. In a new chat, ask: "What are my meetings this week?"
3. When the LLM offers to enable Google Workspace, say "yes"
4. Observe: LLM calls toggle → authorize → activate successfully
5. LLM tries to call `google_workspace_get_events` → fails
6. LLM asks user to send another message

## How to Verify a Fix

1. Check Docker logs for: `[DYNAMIC_TOOLS] Retry succeeded: loaded N tools`
2. The LLM should call `google_workspace_get_events` in the same turn without asking the user to resend
3. Normal chat requests (no new integrations) should show zero `[DYNAMIC_TOOLS]` retry overhead
