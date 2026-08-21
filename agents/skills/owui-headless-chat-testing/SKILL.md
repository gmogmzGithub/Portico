---
name: owui-headless-chat-testing
description: Run deep integration tests against a live headless Open WebUI chat using the existing consistency runners. Use when asked to simulate chats, validate first-turn tool flows, debug chat orchestration, or run repeated perfection/consistency loops.
---

# OWUI Headless Chat Testing

Use this skill for live end-to-end chat validation against local Open WebUI infrastructure.

## When To Use

Use this skill when the task is about:
- running a real headless OWUI chat
- validating tool-call order in a live chat
- proving a chat flow is "perfect" or consistent across repeated runs
- reproducing integration bugs that only appear in full chat execution
- verifying skill activation, MCP activation, or first-turn tool injection

Do not use this skill for:
- unit tests
- isolated API smoke tests when a chat simulation is not required
- ad hoc curl-driven debugging when an existing runner already matches the scenario

## Default Workflow

1. Start from an existing runner instead of inventing a new flow.
2. Run the nearest matching consistency script from the repo root with `uv run --with httpx`.
3. Let the runner enforce preconditions and perfection checks when it already knows how.
4. Inspect the JSON output for tool order, timing, failures, and chat IDs.
5. Only write a new runner if no existing runner covers the scenario.

## Canonical Commands

Google Workspace:

```bash
uv run --with httpx src/scripts/run_google_workspace_chat_consistency.py --runs 10 --max-attempts 10
```

Company Knowledge / Glean:

```bash
uv run --with httpx src/scripts/run_company_knowledge_chat_consistency.py --runs 5 --max-attempts 10
```

Useful overrides:

```bash
uv run --with httpx src/scripts/run_google_workspace_chat_consistency.py \
  --runs 1 \
  --max-attempts 1 \
  --prompt "What are my most important meetings this week?" \
  --model "Atlas Sonnet 4.5"
```

Run these commands from the repository root so the scripts can import `tests/integration/framework/utils/api_client.py`.

## What The Existing Runners Already Validate

The current consistency scripts already check for scenario-specific "perfect run" conditions such as:
- whether toggle, authorize, or activate happened when they should not have
- whether the expected skill auto-activated
- whether the expected MCP server became active for the chat
- whether the first tool call was the correct downstream tool
- whether the expected downstream tool call succeeded

Use the script output as the source of truth before manually inspecting containers or Redis.

## Failure Triage

When a run fails, inspect in this order:

1. Runner summary JSON:
   - `perfect`
   - `failures`
   - `tool_names`
   - `tool_calls`
   - `elapsed_seconds`
   - `chat_id`
2. The exact tool sequence:
   - unexpected toggle/auth/activate calls
   - missing or repeated downstream tool calls
   - wrong first tool call
3. Chat state side effects:
   - skill activation
   - chat MCP tool activation
4. Only then inspect readiness, containers, logs, or Redis directly.

If the runner emits chat IDs, preserve them in your report so the chat can be inspected later.

## Environment Assumptions

The existing runners auto-detect most local endpoints, but they may rely on:
- `OPENWEBUI_BASE_URL`
- `ELECTRON_API_BASE`
- `MCPO_SUMMARY_BASE`
- `REDIS_CONTAINER_NAME`

Prefer environment overrides only when local defaults are wrong.

## Extending To New Scenarios

If a scenario needs a new runner:

1. Start from the nearest existing script in `src/scripts/`.
2. Reuse the `OWUIClient` flow:
   - create chat
   - generate completion
   - poll for completion
   - parse tool calls from the assistant HTML payload
3. Encode the scenario's precondition in the script.
4. Encode the scenario's exact "perfect run" contract in `_validate_perfect_run`.
5. Keep the script JSON-first so repeated runs are easy to compare in CI or local debugging.

For the current runner catalog and extension notes, read `references/runners.md`.
