---
name: Filter Chain Execution
description: Verify the unified context filter executes in the expected phase order on every simple chat request
timeout: 180
tags: [filters, smoke, critical]
---

# Test: Filter Chain Execution

## Objective

Verify that the unified context filter executes on every chat request in the correct phase order for a simple prompt that does not require skills or a VM.

## Prerequisites

- Open WebUI container is running
- Redis is accessible

## Steps

### Step 1: Simulate Chat

Use `simulate_chat` with:
- prompt: "Hello, what time is it?"
- model: "Claude Opus 5"
- wait_for_completion: true

Record the `chat_id` from the result for use in subsequent steps.

**NOTE**: The function automatically records pass/fail assertions.

### Step 2: Verify Unified Filter Logs

Use `Bash` to inspect the recent Open WebUI logs for the unified filter phases, for example with:
- `docker logs portico-open-webui --since 30m 2>&1 | rg 'UNIFIED_CONTEXT_FILTER - Processing Request|Phase 1 complete: Skills - 0 activated, 0 required server\\(s\\) reconciled|Phase 1b complete: Model inventory done|Phase 2 complete: VM - not needed|Phase 3 complete: Tools management done|Phase 4 complete: Session mapping done|Phase 5 complete: Workspace files processed|UNIFIED_CONTEXT_FILTER - Completed Successfully'`

Because the shared log window may contain multiple requests, do not use `check_docker_logs` for the phase-order assertion.

Instead, inspect the most recent matching sequence for the request generated in Step 1 and then use `assert_condition` to verify the phases appear in the expected order for that request.

### Step 3: Verify Core Tools Enabled

Use `verify_enabled_tools` with the chat_id from Step 1 and expected_tools:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`

**NOTE**: For a simple prompt, the Agent VM MCP server should be stored in Redis as an always-on tool server, but no VM container should be created until a workflow needs one.

**NOTE**: The function automatically records pass/fail assertions.

### Step 4: Verify Agent VM Was Not Created

Use `check_redis` with:
- key: `agent_vm:{chat_id}` (substitute actual chat_id)
- should_exist: false

**NOTE**: The function automatically records pass/fail assertions.

## Expected Results

- Unified context filter phases execute in order
- The always-on core tools, including `server:agent-vm`, are stored in Redis
- Agent VM is not created for this simple prompt
- Chat completes successfully
