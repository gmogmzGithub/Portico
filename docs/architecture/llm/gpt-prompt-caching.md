# GPT Prompt Caching

**Audience:** developers maintaining the LLM routing layer (Bifrost bridge + OWUI middleware) and the cost-reporting pipeline.

OpenAI's prompt cache rewards stable prefixes: when a request prefix matches a recent prefix on the same account, the cached portion is billed at a discounted rate and reported back as `usage.cache_read_input_tokens` (Responses API) or `usage.prompt_tokens_details.cached_tokens` (Chat Completions). For tool-heavy multi-turn chats this discount is the difference between cheap and expensive sessions. This document describes how Portico shapes GPT-5.x requests to maximize that hit rate.

## Layers involved

- **LLM Routing — Bifrost bridge** (`src/bifrost-bridge-rust/`): final payload shaping for the upstream provider; instructions hoisting, namespace grouping, per-call cost reporting.
- **MCP Orchestration → middleware** (`src/patches/backend/open_webui/utils/middleware.py`): builds the tool payload sent into the bridge, attaches `_tool_namespaces` metadata so the bridge can group tools by MCP server.
- **State & Persistence — cost dashboard**: consumes the per-call cost events emitted by the bridge.

## Architectural decisions

### 1. Per-call cost reporting

The bridge emits one cost-reporting event per upstream provider call rather than collapsing the usage from every call inside a single visible assistant turn. Without this the dashboard cannot distinguish a cache miss from a multi-call assistant turn that internally reused most of its prefix.

### 2. Instructions hoisting (Responses API)

GPT-5.x caches the Responses API `instructions` field as a stable prefix, separate from `input` messages. The bridge splits incoming traffic so that:

- Static system content (base system prompt, skills, tool instructions) → `instructions`.
- Dynamic content (timestamps, session context, recent conversation) → `input`.

Entry point: `split_responses_instructions_and_messages()` in `src/bifrost-bridge-rust/src/main.rs`.

This is the single largest contributor to GPT-5.x cache hit rate today.

### 3. Namespace-based tool packaging

OpenAI's Responses API supports [`tool_search`](https://developers.openai.com/api/docs/guides/tools-tool-search/) with [namespaces](https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces). Grouping MCP-server tools into a single `type: "namespace"` entry keeps the *prefix* identical across calls even when the underlying function set is large, and dramatically reduces the prompt-token count.

How it is wired:

- The middleware emits `_tool_namespaces` metadata for GPT-5.5 and GPT-5.6 requests, mapping MCP server → list of tool names (e.g. all `glean_*` tools → `glean` namespace).
- The bridge groups those tools into namespaces in the outgoing payload and marks every namespaced function with `defer_loading: true` (`chat_tools_to_responses_tools`, `src/bifrost-bridge-rust/src/main.rs` ~7567). A `{"type": "tool_search"}` entry is appended whenever namespaces exist (~7600), so the model discovers deferred functions on demand. Only the namespace name + description occupy the cacheable prefix; deferred schemas travel on the wire but are excluded from the billed prompt until fetched via `tool_search`.
- Core servers (`mcp-assistant`, `skills`, `subagents`, `agent-vm`, `artifacts`, `web-tools`) are deliberately excluded from namespacing so the model still sees their function names directly.

Multi-turn tool-call → tool-result → follow-up flows work in this mode because the Responses API accepts the full prefixed name (`glean_search`) in tool-call history regardless of whether it was originally surfaced inside a namespace.

### 4. Pitfalls intentionally avoided

- **Client-side schema minification.** OpenAI re-serializes tool JSON to TypeScript internally before computing the cache key, so JSON-level changes (whitespace, key ordering, description shortening) do not affect the cache key.
- **`defer_loading: true` without `tool_search`.** Treated as a different payload by the provider, breaks caching.
- **Per-tool `defer_loading` with `tool_search` but no namespaces.** Function names and descriptions still appear in the prefix, producing unstable token counts and intermittent caching.

## Observed behavior

| Path | Prompt tokens | Cache hit rate |
|---|---|---|
| GPT-5.x + Responses API + namespace grouping (default) | ~3.6k for a Glean-tool chat | ~95% on repeated turns |
| GPT-5.x + Responses API + flat tool list (per-tool defer) | ~8k | 0–intermittent |
| Historical GPT-4.1 + Chat Completions + flat tool list | ~8k | ~87% on repeated turns |

The retired GPT-4.1 benchmark is retained only as historical comparison. Active GPT-5.5 and GPT-5.6 models use namespace-based packaging to stabilize the Responses API cache prefix.

## Known limitations

- The model does not always initiate `tool_search` to discover tools inside deferred namespaces on the first turn. The current configuration accepts this trade-off: namespaced (non-core) functions are deferred (`defer_loading: true`) for the token/caching win, while core servers (`mcp-assistant`, `skills`, `subagents`, `agent-vm`, `artifacts`, `web-tools`) stay flat and eager so first-turn tool selection still sees their function names directly. In a representative live request this yields ~101 eager function tools + ~146 deferred behind 3 namespaces.
- Some GPT-5.x community reports describe intermittent cache misses with very complex tool schemas. The mitigations in this document do not eliminate provider-side variance, only minimize the contribution from this app.
