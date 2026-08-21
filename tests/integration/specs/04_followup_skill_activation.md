---
name: Follow-up Request Skill Activation
description: Verify code-execution activation propagates into runtime state and request/response monitoring for the same chat
timeout: 300
tags: [skills, follow-up, tool-calling]
---

# Test: Follow-up Request Skill Activation

## Objective

Verify the stable, observable parts of the code-execution follow-up workflow:
1. A code-execution prompt auto-activates the `code-execution` skill
2. Runtime state for that chat reflects the activated skill and Agent VM/tool path
3. The LLM debug monitor receives request and response events for the same `chat_id`
4. The turn completes instead of getting stuck

This spec intentionally does **not** assert hidden system-message contents or internal follow-up middleware log markers, because the current integration harness does not expose those reliably.

## Prerequisites

- Open WebUI container is running
- Redis is accessible
- `code-execution` skill is configured with trigger keywords
- Agent VM infrastructure is available
- LLM debug monitor container is running

## Steps

### Step 1: Send Prompt that Triggers Code Execution

Use `simulate_chat` with:
- prompt: "Write a Python script to compute the first 50 prime numbers. Tell me the numbers."
- model: "Atlas Opus 5"
- wait_for_completion: true
- timeout_seconds: 300

This prompt should trigger `code-execution` and drive the Agent VM/tool path for the chat.

**CRITICAL**: Record the `chat_id` for subsequent verifications.

### Step 2: Verify Skill Auto-Activated and VM Path Started

Use `check_docker_logs` with:
- container: "portico-open-webui"
- since: "10m"
- patterns:
  - `Auto-activated skill: code-execution`
  - `Created VM via MCP`
  - `Phase 2 complete: VM - created/reused`

Use `assert_condition` to verify the code-execution path started for this request.

### Step 3: Verify Chat Skill State in Redis

Use `check_redis` with:
- key: `chat_skills:{chat_id}`
- expected_contains: ["code-execution"]

Use `assert_condition` to verify the skill persisted for the chat.

### Step 4: Verify Agent VM Tooling Was Attached

Use `verify_enabled_tools` with chat_id and expected_tools:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`

Then use `check_redis` with:
- key: `agent_vm:{chat_id}`

Use `assert_condition` to verify the Agent VM tool path was attached to the chat by confirming:
- the 4 core MCP servers remained enabled
- an `agent_vm:{chat_id}` record exists for the chat

`server:agent-vm` should be present in `chat_tools` as an always-on MCP tool server; the `agent_vm:{chat_id}` record confirms the live VM container was created for this workflow.

### Step 5: Verify LLM Debug Monitor Request/Response Events

Use `Bash` to inspect recent `llm-debug-monitor` logs for the recorded `chat_id`, for example:
- `docker logs llm-debug-monitor --since 10m 2>&1 | grep -i '{chat_id}'`

Use `assert_condition` to verify the monitor observed:
- `llm_request_start` for the same `chat_id`
- `llm_response_complete` for the same `chat_id`

This confirms the chat ID propagated through request and response monitoring for the skill-driven turn.

### Step 6: Verify Response Completed

Use the `simulate_chat` result from Step 1 and/or the debug monitor evidence from Step 5.

Use `assert_condition` to verify the response completed successfully and did not remain stuck in a pending tool-call state.

## Expected Results

| Check | Expected |
|-------|----------|
| `code-execution` skill activated | Yes, via trigger keyword |
| Agent VM path started | Yes, VM created and Phase 2 completed |
| Redis has skill | Yes, `["code-execution"]` |
| Agent VM tools attached | Yes, `server:agent-vm` is in `chat_tools` and `agent_vm:{chat_id}` exists |
| LLM debug monitor has correct `chat_id` | Yes, request + response events for that chat |
| Response completes | Yes, not stuck |

## Success Criteria

- Trigger keywords activate `code-execution`
- Runtime state for the chat reflects the skill-driven VM/tool path
- The LLM debug monitor sees the correct `chat_id` on both request and response events
- The response completes successfully
- Skill state persists in Redis for the chat
