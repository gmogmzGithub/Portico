# Incidents

Historical root-cause analyses and bug-fix write-ups. These documents
are a record of how something broke and how it was fixed; they are not
maintained going forward.

If you are looking for the current behavior of a system, start at
[`../architecture/`](../architecture/) or [`../howto/`](../howto/).
If you are tracking when fixes shipped, see
[`../CHANGELOG.md`](../CHANGELOG.md).

File naming: `<YYYY-MM>-<short-slug>.md`.

## 2026-04

| Document | Topic |
|---|---|
| [`2026-04-bedrock-converse-stall.md`](2026-04-bedrock-converse-stall.md) | Bedrock Converse stream stalls during tool follow-up turns; opus-4-7 specific. |
| [`2026-04-opus47-live-stack-sweep.md`](2026-04-opus47-live-stack-sweep.md) | EJS/EJG sweep against Opus 4.7 across reasoning-effort levels. Effort-correlated instability findings. |

## 2026-03

| Document | Topic |
|---|---|
| [`2026-03-app-header-titlebar.md`](2026-03-app-header-titlebar.md) | macOS-specific header hit-testing dead zones in the Electron shell. |
| [`2026-03-streaming-thinking-flash.md`](2026-03-streaming-thinking-flash.md) | Rare flash of raw `<thinking>` markup before reasoning blocks render. |
| [`2026-03-mcp-first-run-tool-spec.md`](2026-03-mcp-first-run-tool-spec.md) | Newly enabled integrations not available in the same agentic loop. |
| [`2026-03-invalid-tool-name-replay.md`](2026-03-invalid-tool-name-replay.md) | Tool names with spaces stored in chat history poisoning every future Bedrock turn. |
| [`2026-03-owui-lag.md`](2026-03-owui-lag.md) | Stream-time UI jank on long messages: incremental Markdown rendering and scroll cleanup. |
| [`2026-03-tool-call-history-flatten.md`](2026-03-tool-call-history-flatten.md) | Anthropic content blocks flattened across turns; Phoenix observability blind on follow-up requests. |

## 2026-02

| Document | Topic |
|---|---|
| [`2026-02-glean-mcp-large-payloads.md`](2026-02-glean-mcp-large-payloads.md) | Glean MCP tool calls returning raw search/index records as enormous payloads. |
| [`2026-02-glean-mcp-regression-timeline.md`](2026-02-glean-mcp-regression-timeline.md) | Historical timeline of when Glean MCP response formats regressed. |
| [`2026-02-redis-persistence.md`](2026-02-redis-persistence.md) | Tool/skill enablement lost from Redis after restart; persistence and eviction policy fix. |

## Rolling

| Document | Topic |
|---|---|
| [`install-issues-tracker.md`](install-issues-tracker.md) | Live tracker of recurring installation issues (network, file locking, Nexus, MCP startup races). |
