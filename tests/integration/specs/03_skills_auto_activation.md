---
name: Skills Auto-Activation
description: Verify skills auto-activate based on trigger keywords and reconcile required MCP servers
timeout: 180
tags: [skills, auto-activation]
---

# Test: Skills Auto-Activation

## Objective

Verify that the unified context filter skill phase:
1. Detects trigger keywords in user prompts
2. Auto-activates matching high-priority skills
3. Stores activated skills in Redis
4. Auto-enables required MCP servers for the skill
5. Notifies frontend via capabilities-changed endpoint

## Prerequisites

- Open WebUI container is running
- Redis is accessible
- Skills are configured with trigger keywords

## Steps

### Step 1: Simulate Chat with Artifact Trigger

Use `simulate_chat` with:
- prompt: "Create a simple calculator web app with HTML, CSS, and JavaScript"
- model: "Atlas Opus 5"
- wait_for_completion: true
- timeout_seconds: 180

The phrase "web app" should trigger the artifacts skill auto-activation.

**CRITICAL**: Record the `chat_id` for subsequent verifications.

### Step 2: Verify Skills Loader Execution

Use `check_docker_logs` with:
- container: "portico-open-webui"
- since: "5m"
- patterns:
  - `UNIFIED_CONTEXT_FILTER - Processing Request`
  - `\[Skills\].*Checking 'artifacts' triggers`
  - `Auto-activated skill: artifacts`
  - `Auto-enabled MCP server 'server:artifacts'`

Use `assert_condition` to verify:
- Skills phase ran
- Trigger detection occurred
- artifacts skill was auto-activated
- the required artifacts server was auto-enabled

### Step 3: Verify Frontend Notification

Use `check_docker_logs` with:
- container: "portico-open-webui"
- since: "5m"
- patterns:
  - `\[ChatCapabilities\]` OR `capabilities-changed`
  - `POST.*capabilities`

This verifies the frontend was notified about the new capabilities.

Use `assert_condition` with severity "warning" (may vary by implementation).

### Step 4: Verify Redis Skill State

Use `check_redis` with:
- key: `chat_skills:{chat_id}`
- expected_contains: ["artifacts"]

Use `assert_condition` to verify:
- Key exists
- "artifacts" is in the list

### Step 5: Verify Required MCP Server State

The artifacts skill should auto-enable `server:artifacts`.

Use `verify_enabled_tools` with chat_id and expected_tools:
- `server:artifacts`

Use `assert_condition` to verify the artifacts server is enabled.

Require `server:agent-vm` in `chat_tools` as an always-on MCP tool server. The live VM itself is still created and tracked separately with `agent_vm:{chat_id}` only when a workflow needs one.

### Step 6: Verify Agent VM Was Created

Use `check_redis` with:
- key: `agent_vm:{chat_id}`
- should_exist: true

Artifacts activation should create a VM for the chat.

### Step 7: Verify Chat Capabilities Notification

Use `check_docker_logs` with:
- container: "portico-open-webui"
- since: "5m"
- patterns:
  - `\[ChatCapabilities\] POST /capabilities-changed called for chat_id={chat_id}`
  - `Notified capabilities change for chat {chat_id}:`

Use `assert_condition` with severity "warning" for the exact notification lines.

## Expected Results

| Check | Expected |
|-------|----------|
| Skills loader runs | Yes, on every request |
| "artifact" triggers skill | artifacts skill activated |
| Redis skill state | ["artifacts"] in chat_skills |
| agent-vm enabled in chat_tools | Yes, always-on MCP tool server |
| artifacts server enabled | Yes (required by artifacts) |
| Agent VM created | Yes |
| Frontend notified | capabilities-changed called |

## Success Criteria

- Skills loader filter executes on every chat request
- Trigger keywords in user prompt activate matching skills
- Activated skills are stored in Redis with correct key pattern
- Required MCP servers are automatically enabled where the runtime exposes them in `chat_tools`
- Agent VM is created when the artifacts skill is activated
- `server:agent-vm` is present in `chat_tools` while the VM container remains demand-created
- The frontend is notified when capabilities change
