# Generic Agentic E2E Framework

## Summary

Build one canonical agentic test harness in `tests/integration` that can execute any end-to-end scenario from a Markdown spec, through the real Electron app and any external browser handoffs, with backend observability used only for synchronization and verification. Do not add per-scenario Playwright files or handwritten scripts.

Current gaps this closes:
- Existing Markdown spec runner is backend/API-driven, not UI/world-driven.
- `electron-app/mcp-server` is a thin manual-debug tool, not a generic attachable executor.
- `electron-app/playwright.config.js` has no real suite behind it.
- `clean_dev.sh` and first-run setup are interactive.
- `shell.openExternal()` is opaque to automation.
- `llm-debug-monitor` does not expose a chat-scoped timeline rich enough for policy assertions.

## Key Changes

### 1. Canonical scenario format and runner

- Keep Markdown specs as the source of truth; extend the existing spec format instead of replacing it with hardcoded test code.
- Standardize spec frontmatter to include: `name`, `description`, `timeout`, `start_state` (`fresh`, `reuse`, `either`), `entrypoint`, `surfaces`, `requires_browser_profile`, and `artifacts`.
- Standardize reserved sections in each spec:
  - `## Goal`: natural-language end-user outcome.
  - `## Seeds`: deterministic inputs like names, example prompts, or account expectations.
  - `## Guardrails`: machine-readable YAML for UI-first only, forbidden shortcuts, timeout ceilings, and allowed surfaces.
  - `## Assertions`: machine-readable YAML for UI expectations, backend policies, tool-call rules, and response matching.
- Keep `tests/integration/framework/agent_runner.py` as the orchestrator entrypoint, but replace its Bash-helper model with a generic world-executor tool surface.

### 2. Generic world executor, not scenario scripts

- Promote `electron-app/mcp-server` into the canonical automation gateway instead of a demo tool. It must support attach-to-running-app, not just launch-its-own-app.
- Expose generic capabilities, not scenario methods: `session_attach`, `surface_list`, `surface_observe`, `surface_act`, `surface_wait`, `surface_switch`, `handoff_list`, `handoff_claim`, `browser_attach_profile`, `chat_context_get`, `artifact_capture`, and `session_close`.
- `surface_act` must cover click, fill, press, select, scroll, and submit by semantic target; the agent decides what to do at runtime from observations.
- `surface_observe` must return accessibility tree, visible text, URL/title, screenshots, and stable element metadata for the current surface.
- `surface_wait` must support generic predicates: text appears, text disappears, URL pattern, modal open/close, progress phase, network idle, and response complete.
- Keep backend verifiers hidden from the acting agent; they run after milestones or completion.

### 3. Attachable environment lifecycle

- Add non-interactive environment controls:
  - `./clean_dev.sh --yes`
  - `./clean_dev.sh --yes --docker-volumes`
- Add `install_v2.sh --e2e` support that writes a machine-readable state file with Electron PID, API port, debug port, log paths, and launch timestamps.
- The generic runner reads that state and attaches to the already-launched app; it does not own scenario logic.
- Replace `.atlas/hooks/check-guided-setup-env.sh` as source of truth with a repo-level preflight routine shared by humans and tests; the Atlas hook can become a thin wrapper only.

### 4. External browser handoff as a first-class primitive

- Instrument every `openExternal` call into a generic handoff stream instead of an unobservable side effect.
- Expose handoffs through the Electron API server with enough metadata to classify them as OAuth, docs, downloads, or generic links.
- For test runs, the executor must be able to attach Playwright to a persistent signed-in browser profile and continue from the handoff URL.
- Default browser policy for E2E: external browser attach with a reused signed-in work profile from `portico_E2E_CHROME_PROFILE_DIR`.
- This handoff system must be generic; OAuth is only one consumer.

### 5. Chat correlation and hidden verification APIs

- Add a first-class `chat_context_get` capability that returns the active `chat_id`, current conversation URL, and related request IDs for the visible chat surface.
- Extend `llm-debug-monitor` so request records persist ordered `tool_calls`, `response_content`, `thinking_content`, and completion status on the matching request.
- Add chat-scoped APIs for hidden verifiers:
  - `GET /api/chats/{chat_id}/timeline`
  - `GET /api/chats/{chat_id}/tool-calls`
  - `GET /api/chats/{chat_id}/responses`
- Support generic assertion policies in spec YAML:
  - exact ordered sequence
  - allowed alternatives
  - forbidden tool calls
  - no-extra-calls before completion
  - frontend/backend response equivalence after normalization
- The "no `Restart MCP Server`" requirement becomes one reusable forbidden-call policy, not one-off code.

### 6. Reliability and selector policy

- Add stable, generic `data-testid` or equivalent semantic anchors to first-party Electron UI and patched Open WebUI surfaces for major controls, modals, suggestion items, message boundaries, and completion states.
- Do not encode scenario text into selectors beyond what the spec explicitly names; the executor should prefer semantics first, text second.
- Capture artifacts for every run: screenshots, observation snapshots, action log, handoff log, backend timeline, and final assertion report.

## Test Plan

- Prove the framework on at least three specs:
  - Fresh-install guided-setup plus Google Workspace meetings flow, including OAuth browser handoff and exact tool policy assertions.
  - Reuse-install variant of the same user goal with no wizard and no re-auth unless required.
  - A different end-to-end UI scenario that does not involve Google OAuth, to prove the framework is generic.
- Add framework-level tests for:
  - attach to installer-launched Electron
  - external browser handoff capture and attach
  - chat ID correlation from visible UI to backend timeline
  - forbidden-call and exact-sequence policy evaluation
  - frontend/backend response mismatch reporting
- Retire the broken assumption that `electron-app/tests/*` contains the canonical E2E suite; Playwright remains the engine, but the canonical suite is the Markdown spec runner.

## Assumptions and Defaults

- Canonical scenario authoring stays Markdown-first with YAML frontmatter and machine-readable guardrail/assertion sections.
- Execution stays UI-first; backend hooks are hidden verifiers and synchronization aids, not actor shortcuts.
- External browser attach is the default handoff strategy, using a reused signed-in browser profile.
- Test affordances are gated behind explicit E2E flags or env vars and must not change normal user behavior.
- No scenario-specific JS or Python automation files are added; scenario behavior lives in specs plus the shared generic executor.
