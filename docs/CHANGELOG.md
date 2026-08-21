# Changelog

All notable user-visible changes to Portico ship here.

This file is a curated rolling summary, grouped by month. Detailed
per-release notes live in [`releases/`](releases/). Detailed root-cause
analyses for individual incidents live in [`incidents/`](incidents/).

## How to maintain this file

1. When you ship a release, add a new per-release file under `releases/`
   (named `<YYYY-MM-DD>-<short-sha>.md`) with the full detail.
2. Add a short bullet under the matching month heading here, linking to
   the per-release file or to the relevant incident write-up.
3. Categories follow a relaxed *Keep-a-Changelog* style: `Added`,
   `Changed`, `Fixed`, `Security`, `Removed`. Skip categories that
   are empty in a given month.
4. Keep entries one or two lines. If something needs more context,
   write the full story in `architecture/`, `incidents/`, or
   `releases/` and link to it from here.

---

## [Unreleased]

Tracks work landed on the main branch since the last named release.

### Added
- Host MCP Bridge app-managed MCP client setup for Atlas Code, Atlas
  Desktop, Workbench, Cursor, and Amp. See
  [`MCPBridge.md`](MCPBridge.md) and
  [`architecture/mcp/host-mcp-bridge.md`](architecture/mcp/host-mcp-bridge.md).
- Atlas Opus 4.8 model support, artifact version preview snapshots,
  and VM-isolated sensitive-info file handling. See the combined release
  notes for [`b8a971d3` / `69c5278a`](releases/2026-06-07-69c5278a.md).
- Per-action user confirmation chip ("chip system") for every
  destructive MCP tool call. See
  [`architecture/chat-ui/chip-system.md`](architecture/chat-ui/chip-system.md)
  and the security model at
  [`security/tool-confirmation.md`](security/tool-confirmation.md).
- Scheduled task runtime: saved (prompt + schedule + scope) records
  dispatched by a Rust scheduling daemon as fresh sub-agent chats. See
  [`architecture/mcp/scheduled-task-runtime.md`](architecture/mcp/scheduled-task-runtime.md).
- Per-user tool allowlists, managed from Settings. End-user how-to:
  [`howto/users/manage-tool-allowlists.md`](howto/users/manage-tool-allowlists.md).
- Task "needs attention" indicator (amber dot) surfaced from
  scheduled-task terminal failures.

### Fixed
- First-time OAuth setup (e.g. Slack) no longer dead-ends on a
  `connection refused` / `authorization required` loop: the single-server
  wizard now runs in bootstrap mode (no access-token broker) so it can
  generate the first authorization URL, then exports the captured record
  into host secure storage. See the bootstrap-mode section of
  [`architecture/auth/mcp-secret-broker.md`](architecture/auth/mcp-secret-broker.md).
- Wizard/setup failure logs now show the single-server (`mcpo-single-<id>`)
  container that actually ran the attempt instead of a stale managed
  container.

### Security
- Centralized runtime-secret registry with explicit key scope and
  write policy.
- Container secret ingress moved to Docker Compose `secrets:` (read-only
  tmpfs at `/run/secrets/*`) for Bifrost and both MCPO services.
- Durable OAuth records now stay host-side in Electron secure storage;
  MCP runtimes receive only scoped broker-vended runtime material. See
  [`architecture/auth/mcp-secret-broker.md`](architecture/auth/mcp-secret-broker.md)
  and the combined release notes for
  [`b8a971d3` / `69c5278a`](releases/2026-06-07-69c5278a.md).
- `CLOUDSMITH_API_KEY` (privileged upload) gated on `!app.isPackaged`
  so packaged DMG/beta builds never expose it.
- See [`security/hardening-overview.md`](security/hardening-overview.md)
  and [`security/vault-prerequisites.md`](security/vault-prerequisites.md)
  for the forward-looking Vault plan.

---

## 2026-04 — Slack OAuth & search hardening

### Added
- Slack integration switched from manual `xoxp-` token paste to a full
  OAuth flow. Users click *Save & Test* and authorize in the browser.
- HTTPS callback server on port 3838 (self-signed cert + nginx) for
  both single-server and main stacks, since Slack requires `https://`
  redirect URIs.
- Search: explicit *Include Agent Traces* toggle so hidden reasoning /
  tool output is opt-in rather than mixed into default results.

### Changed
- Search results now present as one coherent list — title hits and
  message hits unified into the same conversation cards.
- Plain-text searches with punctuation no longer get misread as FTS5
  syntax.
- Slack tool outputs no longer leak token-type jargon
  (`xoxp`/`xoxb`/`xoxc`/`xoxd`) to the user.

### Fixed
- Search/tab focus and reveal behavior across overlays, tab switches,
  and fresh-chat title resets.

### Architecture pointers
- Slack OAuth flow:
  [`architecture/auth/slack-oauth.md`](architecture/auth/slack-oauth.md)
- Search architecture:
  [`architecture/chat-ui/search.md`](architecture/chat-ui/search.md)

---

## 2026-03 (late) — Hot-reload, OAuth unification, pending chat work

Release tag: see [`releases/2026-03-20-dc617cf.md`](releases/2026-03-20-dc617cf.md).

### Added
- **Pending chat work / user steering**: Redis-backed queue for
  follow-up prompts and mid-stream "steers" injected while the
  assistant is generating. New pill UI above the composer, Alt+Enter to
  queue, Alt+Up/Down to navigate.
- **Mac architecture guard**: detects packaged-build hardware/package
  arch mismatch on macOS and fails fast with a dialog.
- **Chat export download dialog**: PDF / TXT / JSON exports now route
  through a native save dialog with appropriate filters.
- Skills hot-reload across containers via Redis pub/sub and filesystem
  watchers. See
  [`architecture/skills/skills-hot-reload.md`](architecture/skills/skills-hot-reload.md).

### Changed
- All Agent VM tool names shortened (e.g. `agent_vm_create_agent_vm` →
  `agent_vm_create`). A canonicalization layer maps legacy
  disabled-tool names to their new equivalents so existing chats keep
  working.
- Bifrost bridge now strips `metadata` from outgoing OpenAI requests
  (OpenAI rejects unknown top-level fields).
- OAuth flows unified across guided-setup, MCP-Assistant chat install,
  and per-server reauth — same modal, same state machine.
- Faster post-OAuth restart: removed double-waiting between JavaScript
  and Rust polling layers.

### Fixed
- Tool-call history flatten on follow-up turns. Anthropic content
  blocks (`reasoningContent`, `toolUse`, `toolResult`) are now
  preserved across turns. See
  [`incidents/2026-03-tool-call-history-flatten.md`](incidents/2026-03-tool-call-history-flatten.md).
- Stream-time UI jank in OWUI on long messages. See
  [`incidents/2026-03-owui-lag.md`](incidents/2026-03-owui-lag.md).
- Rare raw `<thinking>` flash before the Thought block renders during
  streaming. See
  [`incidents/2026-03-streaming-thinking-flash.md`](incidents/2026-03-streaming-thinking-flash.md).
- Invalid tool-name replay: tool names with spaces (e.g. from a skill
  prompt with no live MCPO sidecar) no longer poison chat history. See
  [`incidents/2026-03-invalid-tool-name-replay.md`](incidents/2026-03-invalid-tool-name-replay.md).
- MCP first-run mid-turn tool availability: integrations enabled
  during a turn now become usable in the same turn. See
  [`incidents/2026-03-mcp-first-run-tool-spec.md`](incidents/2026-03-mcp-first-run-tool-spec.md).
- macOS header hit-testing improvements (work in progress; see
  [`incidents/2026-03-app-header-titlebar.md`](incidents/2026-03-app-header-titlebar.md)).
- Rust toolchain auto-install in `install_v2.sh`; install no longer
  silently ignores Rust build failure.
- Docker pull no longer killed by inactivity timeout during slow
  registry start.

### Security
- Per-action runtime tool-confirmation gate landed (Phase 1).

---

## 2026-03 (mid) — Installation resilience and macOS setup

### Added
- Network connectivity pre-check at install start with explicit VPN
  troubleshooting messaging.
- `retry_with_backoff` helper across `install_v2.sh`, Docker pulls, and
  in-Dockerfile `git clone` steps.
- Bootstrap creates `~/Library/Application Support/portico/logs/`
  early so a failed install can still share logs.

### Changed
- `clean_full.sh` now delegates to `clean_dev.sh --yes` for shared
  cleanup steps and runs on default macOS Bash.
- Detached conversations move between tab and window without losing
  live state.

### Fixed
- Concurrent server restarts no longer corrupt nginx HTTP responses.
- Promise-chain serialization for `refreshMcpControlPlane` and a
  serial queue for `restartMcpoServer(s)`.

---

## 2026-03 (early) — Two-phase execution and event-driven MCP flows

### Added
- Two-phase model for the LLM: Phase 1 set up all needed integrations,
  Phase 2 use them. Slow tool queries no longer block setup of other
  integrations.
- Reactive Open WebUI readiness check via `docker logs --follow` on
  startup signals — replaces blind HTTP polling.
- Backend circuit breaker for integration flows (`MAX_RETRIES_EXCEEDED`)
  surfaced explicitly to the LLM so it stops retrying.

### Changed
- ~44% reduction in integration-instructions context (3022 → 1702
  chars). LLM gets compact per-status recipes instead of a 50-step
  enumerated plan.
- OAuth integrations are set up before token-based ones (faster, no
  manual config blocking).
- Rust handlers automatically restart MCP infrastructure after
  user-server create/update/delete — one fewer LLM tool call.

### Fixed
- Status data drift: servers reported as "available to activate" when
  the Electron readiness API said they were disabled.
- LLM enabling integrations speculatively — added a `PLAN FIRST`
  instruction so it only enables what the user's request needs.

---

## 2026-02 — Foundation, self-service flows, and Glean MCP timeline

### Added
- Self-service integration setup through AI conversation (guided setup
  + MCP Assistant install).
- User-installed MCP servers — full CRUD via the MCP Assistant. See
  [`architecture/mcp/mcp-user-installed.md`](architecture/mcp/mcp-user-installed.md).
- Redis persistence: AOF + RDB snapshots and a volume mount, with
  `volatile-lru` eviction so chat capabilities and tool toggles survive
  container restarts.
- Install-issues tracker:
  [`incidents/install-issues-tracker.md`](incidents/install-issues-tracker.md).

### Fixed
- AI calling tools for disabled integrations.
- AI not recognizing re-enabled integrations.
- GitLab 401 due to wrong auth header.
- Bedrock thinking-signature error on long tool calls.
- OAuth modal not closing after API completion; OAuth race condition
  causing redundant modals.

### Investigations (no immediate fix at the time)
- Glean MCP large response payloads:
  [`incidents/2026-02-glean-mcp-large-payloads.md`](incidents/2026-02-glean-mcp-large-payloads.md)
- Glean MCP regression timeline:
  [`incidents/2026-02-glean-mcp-regression-timeline.md`](incidents/2026-02-glean-mcp-regression-timeline.md)

---

## See also

- [`releases/`](releases/) — full per-release notes.
- [`incidents/`](incidents/) — root-cause analyses for individual bugs.
- [`TO_REMOVE.md`](TO_REMOVE.md) — legacy code paths slated for cleanup.
- [`_archive/MCP-integrations-instability.md`](_archive/MCP-integrations-instability.md)
  — the original chronological investigation log this changelog was
  distilled from. Kept as historical evidence; not maintained going
  forward.
