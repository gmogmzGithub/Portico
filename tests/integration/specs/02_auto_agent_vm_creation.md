---
name: Auto Agent VM Creation
description: Verify a VM is auto-created only when a VM-requiring skill is activated
timeout: 180
tags: [agent-vm, critical]
---

# Test: Auto Agent VM Creation

## Objective

Verify that the unified context filter:
1. Auto-activates `code-execution` for a code-execution prompt
2. Creates a VM when that skill is activated
3. Stores the VM ID in Redis with the expected TTL
4. Keeps the always-on core tools enabled while tracking the VM for the chat

## Prerequisites

- Open WebUI container is running
- Redis is accessible
- mcpo-core container is running with agent-vm MCP server

## Steps

### Step 1: Simulate New Chat

Use `simulate_chat` with:
- prompt: "Write a Python script to compute the first 50 prime numbers. Tell me the numbers."
- model: "Atlas Opus 5"
- wait_for_completion: false
- timeout_seconds: 180

**CRITICAL**: Record the `chat_id` for subsequent verifications.

Use `assert_condition` to verify chat created successfully.

This spec validates inlet-time effects (skill activation, VM creation, Redis state, tool enablement). It does not need to wait for the full tool-driven assistant turn to finish.

### Step 2: Verify VM Created in Docker Logs

Use `check_docker_logs` with:
- container: "portico-open-webui"
- since: "5m"
- patterns:
  - `Auto-activated skill: code-execution`
  - `Created VM via MCP`
  - `VM ready:`
  - `Phase 2 complete: VM - created/reused`

Use `assert_condition` for each pattern.

Note: From the "Created VM via MCP" log line, extract the VM ID (UUID format).

### Step 3: Verify Redis State - VM ID

Use `check_redis` with:
- key: `agent_vm:{chat_id}` (substitute actual chat_id)
- should_exist: true

The value should be a valid UUID (36 characters with hyphens).

Use `assert_condition` to verify:
- Key exists
- Value is a valid UUID format

### Step 4: Verify Redis TTL

The agent_vm key should have a TTL of approximately 5 hours (18000 seconds).

Use `check_redis` to get the TTL and verify it's between 17000 and 19000 seconds.

Use `assert_condition` with severity "warning" (TTL can vary slightly).

### Step 5: Verify Core Tool Servers Remain Enabled

Use `verify_enabled_tools` with chat_id and expected_tools:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`

For the current implementation, `server:agent-vm` is always attached in `chat_tools`; `code-execution` creates and tracks the actual VM container on demand.

Use `assert_condition` to verify the 4 core tools are enabled.

### Step 6: Verify Full Chat Capabilities

Use `check_redis` with:
- key: `chat_tools:{chat_id}`
- expected_contains:
  - `server:mcp-assistant`
  - `server:subagents`
  - `server:skills`
  - `server:agent-vm`

Use `assert_condition` to verify:
- the 4 always-on core tools are present
- `server:agent-vm` is present in `chat_tools` while `agent_vm:{chat_id}` tracks the created VM

### Step 7: Verify Skill State in Redis

Use `check_redis` with:
- key: `chat_skills:{chat_id}`
- expected_contains:
  - `code-execution`

This verifies the skill activation was persisted for the chat.

### Step 8: Verify Agent VM Container Exists

Use `Bash` to list running Docker containers and verify there is an `agent-vm-*` container whose name contains the VM ID from Step 3.

This verifies the VM was actually provisioned without hardcoding a specific MCP runtime container name.

## Expected Results

| Check | Expected |
|-------|----------|
| VM created | Yes, new UUID generated |
| Redis key exists | `agent_vm:{chat_id}` |
| Redis TTL | ~5 hours (18000s) |
| Core tools enabled | Yes (`mcp-assistant`, `subagents`, `skills`, `agent-vm`) |
| agent-vm tool attached in chat_tools | Yes, always-on MCP tool server |
| code-execution skill stored | Yes |
| agent-vm container exists | Yes |

## Success Criteria

- New VM is created for the chat
- VM ID is stored in Redis with correct key pattern
- TTL is approximately 5 hours
- `code-execution` is activated and stored in Redis
- The 4 always-on core tools remain enabled for the chat
- `server:agent-vm` is present in `chat_tools` while the VM container remains demand-created
- A running `agent-vm-*` container exists for the created VM ID
