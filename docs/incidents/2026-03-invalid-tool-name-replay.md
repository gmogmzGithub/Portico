# Invalid Tool Name Replay Problem

## Problem Statement

We have two customer reports where a chat becomes unrecoverable because an earlier assistant message contains a tool call name that should never be sent downstream.

The provider (Bedrock) enforces that every `toolUse.name` must match `[a-zA-Z0-9_-]+`. If any historical message violates this, the entire request is rejected. Since chat history is persisted, once a bad name is stored, every future turn replays it and fails permanently.

There are two observed versions:

1. **Report 1:** The stored tool name is literally `$TOOL_NAME` (a placeholder the model hallucinated).
2. **Report 2:** The stored tool name is `Search JIRA Issues Using JQL` (a human-readable display name with spaces).

## Why Most Users Are Unaffected

Report 2 requires a narrow chain:

1. A skill is auto-activated for the chat (e.g., user mentions "jira").
2. The skill's required MCP server has no MCPO sidecar container (because its env vars are not configured).
3. The skill prompt is injected anyway, telling the model to use specific tool names.
4. The model follows the instructions but has no real tool specs, so it uses the name from the SKILL.md verbatim.
5. That name contains spaces, violating Bedrock's regex.
6. The bad name is stored in chat history. Every future turn replays it and fails.

Report 1 is a separate, rarer path where the model itself hallucinated a shell-variable-like placeholder during tool resolution confusion.

## Detailed Root Cause Analysis

### Report 2: `Search JIRA Issues Using JQL`

**Model:** Claude Opus 4.6 via Bedrock
**Skill:** `atlassian-portico`

#### Layer 1 failure: Docker Orchestration (TRUE root cause)

The `mcp-orc-cli generate-docker-compose-override` script **did run** during startup. However, it correctly skipped the mcp-atlassian server because the required environment variables were missing from `.env`.

The script's decision logic (in `process_server()` at line 1422) requires all of these gates to pass before generating a per-server MCPO container:

1. Fragment file exists (`$server_id.fragment`)
2. Toggle is enabled (`is_server_enabled`)
3. **Required env vars are present** (`is_server_configured`) -- this is where mcp-atlassian failed
4. Not a core server
5. Not host-deployed

For this user, only `gitlab-mcp` passed all gates. The other 11 servers were toggled on in `mcp_toggles.json` but lacked their required environment variables. The script printed `"Skipping mcp-atlassian: not configured (missing environment variables)"` to stdout, but this was **never persisted to any log file**.

The OpenAPI aggregator uses dynamic discovery (calls `mcp-assistant` which returns all toggled-on servers). It then tries to connect to `mcpo-{server}:8000` for each. Since only `mcpo-gitlab-mcp` existed on the Docker network, the other 11 got DNS failures. The aggregator logged 360+ connection failures for mcp-atlassian alone.

The underlying `mcp-atlassian` MCP server (the raw stdio-based process) started fine per its own log, but the MCPO sidecar proxy that would have exposed it over HTTP was never created.

**Why restarting doesn't help:** The env vars are still missing after restart, so the script still skips those servers, the override file is regenerated identically, and the bad tool name remains in chat history.

#### Layer 2 failure: Agent Skills (prompt/spec mismatch)

The user mentioned "jira", triggering keyword auto-activation for the `atlassian-portico` skill. The activation logic in `unified_context.py`:

1. Added the skill name to Redis (`chat_skills:{chat_id}`)
2. Called `_reconcile_activated_skill_servers()` which added `server:mcp-atlassian` to `chat_tools`
3. `_fetch_available_tools()` queried the aggregator -- mcp-atlassian was unreachable, returned no specs

But Phase 6 of `inlet()` builds the skills context from `activated_skill_names` with **zero cross-reference** against `available_tools`. The gap is at `unified_context.py` lines 2005-2011 -- no guard checks whether a skill's required MCP servers have loaded specs.

The full SKILL.md body was injected into the system prompt, including a "Tool Name Reference" table:

> "Use these exact tool names (mapped from Atlassian's original names):"
> `| Search JIRA Issues Using JQL | Search with JQL query |`

#### Layer 3 failure: Agent Skills content (SKILL.md documents invalid names)

The `mcp-atlassian.yaml` config has a `tool_rename_mapping` that maps sanitized names to display names: `Searchjiraissuesusingjql` -> `"Search JIRA Issues Using JQL"`. The SKILL.md documents these **display names with spaces** as the "exact tool names" to use. Even if the tools were loaded, the skill instructs the model to use names that violate `[a-zA-Z0-9_-]+`.

#### Layer 4 failure: No replay validation

The model called `Search JIRA Issues Using JQL` four times (content positions 3-6). These were stored in `contentBlocks`, `tool_calls`, and serialized `content` HTML. On the next turn, `reconstruct_anthropic_format` passed them through verbatim. Bedrock rejected:

```
ValidationException: 4 validation errors detected:
  Value at 'messages.2.member.content.3.member.toolUse.name' failed to satisfy constraint: [a-zA-Z0-9_-]+
  ...positions 4, 5, 6...
```

The chat export confirms: 11 unique tool calls (stored as 22 due to a streaming accumulation duplication bug). The 4 JIRA calls had invalid names; the 7 others (glean_search, slack_search_messages, gitlab_mcp_search_repositories) were valid.

#### Evidence from debug logs

- `mcpo-openapi-aggregator.log`: "Error fetching from mcp-atlassian: Cannot connect to host mcpo-mcp-atlassian:8000 ssl:default [Name or service not known]" (360+ occurrences)
- `portico-open-webui.log` line 3700: "Tool server data not found for mcp-atlassian"
- `llm-gateway.log` lines 366-6300: 160 tool definitions in first request, zero from mcp-atlassian
- `llm-gateway.log` line 14991: Bedrock ValidationException on the follow-up request
- `docker-compose.override.yml`: only `mcpo-gitlab-mcp` defined as non-core MCPO container
- `mcpo-configs-generated/`: only 7 files (gitlab-mcp.json + 6 core)

### Report 1: `$TOOL_NAME`

**Model:** Claude Sonnet 4.5 via Bedrock

#### What happened

1. User asked the model to install a skill by fetching a URL with curl.
2. First tool call: `skills_activate_skill` to activate `code-execution` skill -- succeeded.
3. Second tool call: should have been `agent_vm_vm_execute_bash` but was stored as literal `$TOOL_NAME`.
4. The model's reasoning (visible in logs) shows confusion about tool resolution -- it discusses `vm_execute_bash` but doesn't have the VM ID and deliberates about how to proceed.
5. Tool "executed" against invalid name, returned empty content.
6. Bad name persisted in `contentBlocks`.
7. User sent "continue" -- history replayed -- Bedrock rejected `$TOOL_NAME` (contains `$`).

#### Most likely origin

The model itself emitted `$TOOL_NAME` as a shell-variable-like placeholder during its confusion about which tool to use. This is a model behavior issue, not a code injection. The code bug is that nothing caught it before persistence or replay.

## Observability Gaps

Critical finding: **the skip decisions during override generation are invisible in all persistent logs.**

The startup path in `main.js` (line 2819) calls `mcp-orc-cli generate-docker-compose-override` via `executeWithStreaming`. The script's per-server skip reasons (e.g., `"Skipping mcp-atlassian: not configured (missing environment variables)"`) go to stdout of the bash process. This output is sent to the loading window via `sendInitLog()` but is **never written to `portico-app.log`** or any persistent log file. The `initialization_temp.log` files in both debug bundles are empty.

This means:
- When a user reports "my MCP server isn't working," there is no log evidence of why its MCPO container wasn't generated.
- The mcp-config step success/failure is only visible in the ephemeral loading window UI.
- The aggregator's dynamic discovery finds servers that have no containers, but you can't tell from the logs why those containers don't exist.

## The Mismatch Between Toggles and Containers

The aggregator uses dynamic discovery via `mcp-assistant`, which returns all toggled-on servers. The override generator uses env var checks to filter which servers get containers. These two systems have **no shared view of eligibility**:

| Component | What it checks | Result for unconfigured server |
|-----------|---------------|-------------------------------|
| `mcp_toggles.json` | User toggle state | Enabled |
| `mcp-orc-cli generate-docker-compose-override` | Toggle + env vars + fragment | Skipped (no container) |
| `mcp-assistant` (dynamic discovery) | Toggle state only | Returned to aggregator |
| Aggregator | Tries to connect | DNS failure (no container) |
| Skill auto-activation | Keyword in user message | Activated (prompt injected) |
| `unified_context.py` Phase 6 | Activation state only | Full skill prompt injected |

Every layer checks a different subset of readiness. No single layer has the complete picture.

## Defensive Hardening Plan

### 1. Prompt / Spec Alignment (highest priority)

In [`unified_context.py`](../../src/filters/unified_context.py), add request-time skill eligibility based on actual spec availability, not just `chat_skills` or enabled server IDs.

- After Phase 3 tool enablement, probe each activated skill's `required_mcp_servers` through the proxied OpenAPI route.
- Mark a skill `spec_ready` only if every required server exposes a usable spec for the request.
- Build the `<skills>` context from two buckets:
  - eligible activated skills: keep full `<activated_skill>` bodies
  - activated-but-spec-unavailable skills: replace the body with a short note naming the missing server(s) and explicitly telling the model to ignore that skill's tool examples and use only attached tool specs
- Do not change `chat_skills` persistence or skill activation state. This is request-scoped prompt filtering only.
- Add structured logs with `chat_id`, `skill_name`, and missing server IDs whenever a skill is suppressed.

### 2. Rust Bridge Safety Net (critical for current architecture)

In [`main.rs`](../../src/bifrost-bridge-rust/src/main.rs), add validation in `chat_tool_call_to_responses_input_item`.

- Derive the allowed tool-name set from the original chat `tools` payload before namespacing.
- Validate `raw_name` against `^[A-Za-z0-9_-]+$` regex.
- Skip assistant tool-call items whose raw name fails the regex or is not in the allowed set.
- Track retained `call_id`s and skip `function_call_output` items for dropped calls.
- Keep valid namespaced and core-tool behavior unchanged.

The Rust bridge agent confirmed zero validation exists today. Names like `$TOOL_NAME` and `Search JIRA Issues Using JQL` pass through completely unimpeded via the fallback path at line 3322-3329.

### 3. Python Middleware Replay Sanitization (defense-in-depth)

In [`middleware.py`](../../src/patches/backend/open_webui/utils/middleware.py), add request-time sanitization after `tools_dict` is resolved.

- Walk reconstructed assistant/tool history before the outbound model call.
- Drop any historical assistant tool call if its name fails `^[A-Za-z0-9_-]+$`.
- Drop any later `role=tool` messages whose `tool_call_id` belongs to a removed call.
- Preserve assistant text content when tool calls are stripped.
- Log each drop with reason (`invalid_name` or `not_in_registry`).

Note: Since the app now routes through the Rust backend, this layer matters only if history reconstruction still flows through the Python `reconstruct_anthropic_format` path before hitting Rust.

### 4. SKILL.md Content Fix

Update all SKILL.md tool name reference tables to use sanitized names matching `[A-Za-z0-9_-]+` instead of human-readable display names with spaces.

### 5. Observability Fix

In `main.js` startup path (line 2819) and `mcp-orc-cli generate-docker-compose-override`:

- Persist the script's per-server decisions (skip reasons, enabled servers) to `portico-app.log` via `console.log`, not just `sendInitLog`.
- Log a summary line: "Override generated: N MCPO containers for M toggled servers (K skipped: missing env vars)".
- Emit a structured log when the aggregator discovers a server that has no corresponding container.

### 6. Aggregator/Toggle Alignment (root cause fix)

Either:
- The aggregator should filter discovered servers against the set that actually has containers (compare against compose-defined services), or
- The aggregator should use the static `MCPO_SERVERS` env var (which correctly reflects only generated containers) instead of dynamic discovery, or
- The toggle UI should surface that a server is "enabled but not configured" so users know why their tools aren't available.

## Test Plan

### Skills / Context

- activated `atlassian-portico` plus missing Atlassian spec route suppresses full skill body and emits the unavailable note
- the same skill plus a ready spec route keeps the full activated skill body

### Rust Bridge

- invalid or unregistered historical tool calls do not produce downstream `function_call` items
- dropped calls do not leave orphaned `function_call_output` items
- existing valid namespaced round-trip behavior still passes

### Middleware Replay Sanitization

- `$TOOL_NAME` with a matching tool result is removed safely
- `Search JIRA Issues Using JQL` is removed safely
- regex-valid but currently unattached tool names are removed with their paired tool outputs
- assistant text-only parts remain intact

## Acceptance Criteria

The fix is correct when all of the following are true:

1. A request with an activated skill but without loaded required tool specs does **not** send that skill's detailed callable guidance to the model.
2. A replayed malformed tool name never reaches the downstream provider.
3. Historical tool/result pairs with invalid names are removed safely without destroying surrounding assistant text.
4. Valid tool-call history still round-trips normally.
5. Override generation skip reasons are visible in persistent logs.

## Assumptions

- This is a mainline-only fix.
- We are not blocking this work on root-causing the exact origin of `$TOOL_NAME`.
- Activated skills remain persisted for the chat and become fully visible again automatically once their required tool specs are available on a later request.
