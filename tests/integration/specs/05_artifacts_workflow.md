---
name: Artifacts End-to-End Workflow
description: Verify artifact workflow readiness from skill activation through VM and server enablement
timeout: 300
tags: [artifacts, e2e, agent-vm]
---

# Test: Artifacts End-to-End Workflow

## Objective

Verify the artifact workflow handoff:
1. A web-app prompt triggers artifacts skill activation
2. Agent VM is auto-created
3. Required tool servers are enabled
4. Redis state reflects the activated skill and attached tools
5. The assistant response hands off into artifact/tool work without critical errors

## Prerequisites

- Open WebUI container is running
- Redis is accessible
- The standard MCP infrastructure is running with agent-vm and artifacts available

## Steps

### Step 1: Simulate Artifact Creation Request

Use `simulate_chat` with:
- prompt: "Create a simple calculator web app with HTML, CSS, and JavaScript"
- model: "Claude Opus 5"
- wait_for_completion: true
- timeout_seconds: 300

The phrase "web app" should trigger the artifacts skill.

Record the `chat_id`.

### Step 2: Verify Skill Auto-Activation

Use `check_redis` with:
- key: `chat_skills:{chat_id}`
- expected_contains: ["artifacts"]

Use `assert_condition` to verify artifacts skill activated.

### Step 3: Verify Agent VM Created

Use `check_redis` with:
- key: `agent_vm:{chat_id}`
- should_exist: true

Record the VM ID value.

Use `assert_condition` to verify VM was created.

### Step 4: Verify All Required Tools Enabled

Use `verify_enabled_tools` with chat_id and expected_tools:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`
- `server:artifacts`

Use `assert_condition` for each tool.

### Step 5: Verify Artifact Workflow Logs

Use `check_docker_logs` with:
- container: "portico-open-webui"
- since: "10m"
- patterns:
  - `Auto-activated skill: artifacts`
  - `Auto-enabled MCP server 'server:artifacts'`
  - `Created VM via MCP`
  - `Phase 2 complete: VM - created/reused`

Use `assert_condition` to verify the workflow handoff occurred.

### Step 6: Check Response for Artifact Handoff

Use the `response_content` from Step 1.

Use `assert_condition` with severity "info" to verify the assistant response references creating the web app, files, or a live preview.

### Step 7: Verify No Critical Artifact/VM Errors Appeared

Use `Bash` to inspect the recent Open WebUI logs, for example with:
- `docker logs portico-open-webui --since 10m 2>&1 | rg -i 'ERROR.*agent\\.vm|Error.*VM|Exception.*artifact'`

Use `assert_condition` to verify there are no matches.

This is an absence check, so do not use `check_docker_logs` for it.

### Step 8: Summary Verification

Create a summary assertion that checks:
- Chat completed successfully
- Artifacts skill was activated
- Agent VM was created
- All required tools are enabled
- No critical errors occurred

Use `assert_condition` with message summarizing the workflow status.

## Expected Results

| Check | Expected |
|-------|----------|
| Chat completes | Yes, with response |
| artifacts skill activated | Yes |
| agent-vm created | Yes, UUID in Redis |
| Required tools enabled | All 5 |
| artifacts server enabled | Yes |
| Artifact workflow logs | Yes |
| No critical errors | True |

## Success Criteria

- The complete workflow executes without errors
- All preconditions are met (skill, VM, tools)
- The assistant hands off into the artifact/tool workflow
- The chat completes with a meaningful response
- All state is correctly persisted in Redis
