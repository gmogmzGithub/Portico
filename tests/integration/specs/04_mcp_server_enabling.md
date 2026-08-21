---
name: MCP Server Enabling
description: Verify MCP tool servers are correctly enabled and persisted per chat
timeout: 180
tags: [mcp, tools, critical]
---

# Test: MCP Server Enabling

## Objective

Verify that:
1. Always-on core MCP servers are enabled on every simple new chat
2. Tool server state is persisted in Redis
3. Redis TTL is set correctly (7 days)
4. Tool server IDs are stored in the expected `server:*` format

## Prerequisites

- Open WebUI container is running
- Redis is accessible
- MCP servers are configured in the system

## Steps

### Step 1: Simulate New Chat

Use `simulate_chat` with:
- prompt: "Hello, what time is it?"
- model: "Claude Opus 5"
- wait_for_completion: true

Record the `chat_id`.

### Step 2: Verify Tools Management Phase Ran

Use `check_docker_logs` with:
- container: "portico-open-webui"
- since: "5m"
- patterns:
  - `UNIFIED_CONTEXT_FILTER - Processing Request`
  - `Phase 3 complete: Tools management done`
  - `Tools: .* available, .* enabled`

Use `assert_condition` to verify the tools-management phase ran.

### Step 3: Verify Core Tools in Redis

Use `check_redis` with:
- key: `chat_tools:{chat_id}`
- expected_contains:
  - `server:mcp-assistant`
  - `server:subagents`
  - `server:skills`
  - `server:agent-vm`

Use `assert_condition` for each core tool.

### Step 4: Verify Redis TTL

Use `check_redis` with key `chat_tools:{chat_id}` and check the TTL.

Expected TTL: approximately 7 days (604800 seconds).
Acceptable range: 600000 to 610000 seconds.

Use `assert_condition` with severity "warning".

### Step 5: Verify Agent VM Container Is Not Created For A Simple Prompt

Use `verify_enabled_tools` with chat_id and expected_tools:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`

Then use `Bash` to check Redis key absence directly, for example:
- `redis-cli -h "$REDIS_HOST" EXISTS "agent_vm:{chat_id}"`
or an equivalent Python one-liner against Redis.

The expected result is `0` / false.

This confirms the Agent VM MCP server is always-on, while the VM container remains on-demand.

### Step 6: Test Persistence Across Requests

Simulate a follow-up message in the same chat by noting that
in a real scenario, the chat_tools key should persist.

Use `check_redis` again with the same chat_id to verify the key still exists.

### Step 7: Verify Tool Server IDs Format

Use `check_redis` to get the full list from `chat_tools:{chat_id}`.

Verify all tool server IDs follow the format `server:*`.

Use `assert_condition` to verify format consistency.

## Expected Results

| Check | Expected |
|-------|----------|
| Tools-management phase runs | Yes |
| server:mcp-assistant enabled | Yes |
| server:subagents enabled | Yes |
| server:skills enabled | Yes |
| server:agent-vm enabled | Yes |
| Agent VM container created | No, for a simple prompt |
| Redis TTL | ~7 days (604800s) |
| Tool ID format | server:* |

## Success Criteria

- The 4 always-on core MCP tool servers are enabled on a simple new chat
- Tool servers are stored in Redis with correct key pattern
- TTL is approximately 7 days
- Agent VM is not created for a prompt that does not require it
- Tool server IDs follow consistent naming convention
