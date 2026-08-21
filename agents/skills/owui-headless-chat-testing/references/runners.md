# Headless OWUI Runner Catalog

This reference lists the current headless chat runners that already exist in this repository.

## Google Workspace

Path:

```text
src/scripts/run_google_workspace_chat_consistency.py
```

Use it for:
- Google Workspace startup and readiness validation
- first-turn chat orchestration involving calendar access
- repeated "perfect run" streak checks
- regressions around toggle, authorize, activate, and downstream `google_workspace_get_events`

Canonical command:

```bash
uv run --with httpx src/scripts/run_google_workspace_chat_consistency.py --runs 10 --max-attempts 10
```

Key behavior:
- enforces its own precondition before each run
- runs a real OWUI chat with `OWUIClient`
- validates tool sequence, timing, skill activation, and chat tool activation
- prints per-run JSON plus a final summary

## Company Knowledge / Glean

Path:

```text
src/scripts/run_company_knowledge_chat_consistency.py
```

Use it for:
- Glean-first first-turn behavior
- company-knowledge skill activation
- repeated headless chat validation for knowledge-search flows

Canonical command:

```bash
uv run --with httpx src/scripts/run_company_knowledge_chat_consistency.py --runs 5 --max-attempts 10
```

Key behavior:
- enforces the Glean precondition
- runs a real OWUI chat
- validates the first downstream tool call is already a Glean tool
- checks that at least one successful `glean_search` happens in the same turn

## Code Execution Follow-Up

Path:

```text
src/scripts/run_code_execution_followup_chat_consistency.py
```

Use it for:
- request-by-request validation of `code-execution` auto-activation
- proving Agent VM tools are present on the initial upstream request
- validating one-followup-per-tool-batch behavior for code-execution chats

Canonical command:

```bash
uv run --with httpx src/scripts/run_code_execution_followup_chat_consistency.py --runs 5 --max-attempts 10
```

Key behavior:
- runs a real OWUI chat with a code-execution prompt
- validates initial request skill injection and request-local Agent VM tools
- validates follow-up request preservation and absence of continuation spam

## Calibration Skill + Integrations

Path:

```text
src/scripts/run_calibration_skill_activation_chat_consistency.py
```

Use it for:
- reproducing and guarding the “skill activated, follow-up split-brain” class of bugs
- validating explicit `skills_activate_skill` flows with dependent integrations
- ensuring follow-up requests reflect attached Google Workspace and Agent VM state immediately

Canonical command:

```bash
uv run --with httpx src/scripts/run_calibration_skill_activation_chat_consistency.py --runs 3 --max-attempts 10
```

Key behavior:
- creates a temporary `skills-user` skill that depends on `server:google_workspace` and `server:agent-vm`
- verifies no extra `mcp_assistant_activate_integration` call is needed after skill activation
- validates the first tool-followup request includes the activated skill body, enabled servers, request-local tool ids, and downstream tool payloads

## Browser Automation / Chrome DevTools

Path:

```text
src/scripts/run_browser_automation_chat_consistency.py
```

Use it for:
- Chrome DevTools cross-turn tool resolution
- proving already-attached `server:chrome-devtools` exposes `chrome_devtools_*` tools on the next user turn
- catching repeated `activate_integration`, `get_chat_tools`, or `restart_mcp_server` calls before browser navigation

Canonical command:

```bash
uv run --with httpx src/scripts/run_browser_automation_chat_consistency.py --runs 3 --max-attempts 10
```

Key behavior:
- requires Chrome DevTools to be healthy and `tool_ready` before running
- attaches `server:chrome-devtools` to the chat before the browser action turn
- validates the browser action request exposes `chrome_devtools_navigate_page`
- fails if lifecycle/recovery tools are called before Chrome navigation

## Atlassian Steer

Path:

```text
src/scripts/run_atlassian_steer_chat_consistency.py
```

Use it for:
- validating steer-triggered upstream request anchoring
- reproducing prompt-steer regressions that only show up on background dispatch / live-turn steer promotion
- catching “tool advertised to the model but unavailable at execution” regressions for Atlassian flows

Canonical command:

```bash
uv run --with httpx src/scripts/run_atlassian_steer_chat_consistency.py --runs 3 --max-attempts 10
```

Key behavior:
- starts from a completed chat, then injects a pending steer through the chats API
- verifies the steer-generated request sequence stays anchored to the inserted steer user turn
- validates Atlassian tools are callable once exposed and do not hit the synthetic unavailable-tool guard

## Marketplace Provenance and Ownership

Path:

```text
src/scripts/run_marketplace_provenance_chat_consistency.py
```

Use it to verify that the model:
- inspects installed/read-only provenance for the foreign PORTICO-272 agent and skill fixtures
- uses `list_published_agents` and `list_published_skills` as ownership authority
- avoids edit, publish, unpublish, install, and delete tools for those foreign installations
- recommends creating an editable copy

The runner installs missing local fixture copies for the scenario and deletes
only copies it installed itself. It verifies that both remote fixtures remain
readable after cleanup.

Canonical command:

```bash
uv run --with httpx src/scripts/run_marketplace_provenance_chat_consistency.py --runs 3 --max-attempts 3
```

## Malformed Tool-Use Diagnostics

Paths:

```text
src/scripts/run_malformed_tool_use_chat_consistency.py
src/scripts/run_malformed_tool_use_bridge_probe.py
```

Use them for:
- reproducing `tool_use` / `tool_calls` terminals with no tool block
- comparing serial and synchronized multi-chat execution
- A/B-testing preserved versus omitted signed reasoning without changing runtime behavior
- correlating sanitized bridge failure events with debug-monitor request traces

Canonical commands:

```bash
uv run --with httpx src/scripts/run_malformed_tool_use_chat_consistency.py
uv run --with httpx src/scripts/run_malformed_tool_use_bridge_probe.py
```

Key behavior:
- the full-stack runner uses real OpenWebUI chats and dependent Agent VM calls
- the direct bridge runner uses only synthetic prompts and tool results
- the direct bridge runner uses the provider model id `us.anthropic.claude-opus-4-8`
- signatures stay in process memory and JSON output contains only IDs, timing, terminal reasons, and counts
- a clean run with no reproduction is reported as inconclusive rather than fixed

## Shared Building Blocks

Existing reusable pieces:

```text
tests/integration/framework/utils/api_client.py
```

Use `OWUIClient` from that module for:
- chat creation
- completion generation
- polling for completion

The current scripts also share common patterns for:
- endpoint auto-detection from local Docker state
- parsing tool calls from assistant HTML
- reading Redis chat state
- producing machine-readable JSON summaries

## New Runner Recipe

When adding a new scenario-specific runner:

1. Copy the nearest existing runner.
2. Keep the script executable from repo root with:

```bash
uv run --with httpx src/scripts/<new-runner>.py --runs <n> --max-attempts <n>
```

3. Define scenario constants near the top:
- `PROMPT`
- `MODEL`
- `SERVER_ID`
- container name if needed
- target streak

4. Implement:
- scenario precondition setup/check
- `_validate_perfect_run`
- `run_once`
- `main`

5. Keep validation focused on observable chat behavior:
- exact tool order
- downstream tool success
- skill activation
- chat MCP server activation
- absence of unexpected lifecycle calls

6. Prefer extending the runner instead of layering manual shell steps around it.
