# Deferred Tool Loading for Claude (`find_tools`) — Plan D

**Status: PROPOSED (v1, 2026-08-06).** Authored as the second phase of the tool-spec
tokenomics work. Executes only after Plan A (bridge-side tool-spec slimming,
`slim_tool_definitions` in `src/bifrost-bridge-rust/src/prompt_cache.rs`) has shipped and
been measured, and after its own review. All `file:line` anchors were verified on
2026-08-06 and will drift; symbol names are the stable reference.

This plan spans the **Chat UI** (OWUI middleware / unified_context), **MCP
Orchestration** (mcp-assistant), and **LLM Routing** (payload effects) layers.

---

## 1. Problem and target

Every Claude request carries the full tool specs of every attached MCP server. Measured
2026-08-06 (llm-debug-monitor): 318 tools ≈ 400KB of tools JSON = 41.6% of a ~240k-token
payload; p50 across recent requests = 317 tools. The same 247-tool history billed
210,175 prompt tokens on Opus 5 vs 56,202 on GPT-5.6
(`docs/architecture/llm/tool-compaction-parity-backlog.md`), because GPT already has
BOTH mitigations: spec slimming AND deferred loading (`namespace`/`defer_loading` +
`tool_search` built by `chat_tools_to_responses_tools`, bifrost-bridge `main.rs`).

**Target state per Claude request:**
- Eager set = the `is_core` servers' tools (user-confirmed parity with GPT's eager
  policy: mcp-assistant, skills, subagents, agent-vm, artifacts, web-tools ≈ 101 tools
  ≈ ~15k tokens post-slimming) + the chat's working set + `find_tools` itself.
- Every other attached server's tools are **searchable, not injected**. Discovery loads
  only matched tools, mid-turn, as native tools.
- Expected effect on the reference chat: ~140k billed (post-Plan-A) → **~90-100k**.
  Tool-selection accuracy is expected to improve, not degrade (selection quality
  degrades past 30-50 visible tools; we ship 317 today).

Tool-count degradation and the two-step search→call flow are the industry-converged
pattern: Codex defers ALL MCP tools behind `tool_search` by default (openai/codex
PR #29486), and Anthropic's server-side Tool Search has identical semantics.

## 2. Bedrock / LLM-proxy compatibility (asked and answered 2026-08-06)

**This design is pure client-side and requires NOTHING from Bedrock or the LLM proxy.**
Every request remains an ordinary Bedrock Converse call with a normal (smaller)
`toolConfig`; `find_tools` is an ordinary MCP tool; "expansion" is our middleware
including matched defs in the next request's tools array. The existing mid-turn
activation flow already grows the tools array between requests on this exact wire path
in production (`_extract_followup_tool_refresh_ids` → inject).

Contrast: Anthropic's *server-side* Tool Search (`defer_loading` + `tool_reference`) is
**InvokeModel-only on Bedrock**; our Claude path is `converse.rs` → LLM proxy
`/bedrock/converse`, so the server-side variant is unavailable without LLM-proxy work
outside this repo. That is why this plan is client-side.

Two Bedrock-specific rules the design MUST keep (details in §5):
1. **Sticky called tools** — Converse can reject a request whose history contains a
   `toolUse` block without a covering `toolConfig` entry.
2. **Discovery-event-only tools churn** — tools are the top of Anthropic's prompt-cache
   hierarchy; every tools-array change invalidates the whole cached prefix.

## 3. Mechanism

### 3.1 `find_tools` on mcp-assistant (Rust; ships dark first)

Files: `src/core-mcp-rust/crates/mcp-assistant-server/tool_spec.json`, dispatcher in
`src/native/mod.rs` (~:33-57), new `handle_find_tools` in `src/native/mcp_assistant.rs`.

- **Spec**: `find_tools(chat_id: string, query: string, limit: int = 10, max 25)`.
  The description must be prescriptive about WHEN to call it ("call this when the task
  needs an action you don't have a loaded tool for; matching tools are attached
  automatically for your next response").
- **Corpus**: OWUI's Redis `tool_servers` cache — the byte-identical spec source the
  hydration funnel reads (`_get_cached_tool_servers_for_prompt_path`,
  middleware.py ~:3806). NOT a fresh mcpo OpenAPI crawl (the 8891 bridge re-crawls per
  call; that is fine for external clients, wrong for the chat hot path). Reading the
  same cache guarantees searched-name == hydratable-name (mcp-orc prefixing, renames,
  and `disabled_tools` already applied). Fail-soft to an aggregator/OpenAPI fetch only
  when the key is absent. Filter servers by the same enablement gate activation uses
  (`assistant_tool_server_enabled`) and apply each connection's
  `function_name_filter_list` — never surface a name hydration would drop.
- **Scorer**: port of the host-bridge `score_tool`
  (`src/mcp-orc-rust/crates/mcp-orc/src/bridge.rs` ~:2318-2338): lowercase substring,
  per whitespace-split query term +10 tool-name / +6 server-id / +3 body, summed;
  tie-break by name. Lexical is sufficient at ~600-tool scale; an embeddings backend is
  a later, separate upgrade (see §9).
- **Result shape (compact — no schemas)**: per hit
  `{name, server_id, description (≤120 chars), status}` with
  `status ∈ loaded | active | requires_activation`:
  - `loaded` — core server, tool already in context;
  - `active` — server in `chat_tools:{chat_id}`; the tool will attach for the next
    response;
  - `requires_activation` — server toggled on but not attached; the model should chain
    `activate_integration` (existing flow; OAuth gating preserved).
  Schemas are deliberately omitted: matched tools hydrate as REAL native tools next
  request, so schemas in the result would be redundant context.
- **Side effect (the hydration trigger)**: under `with_chat_capabilities_lock`, merge
  hits into Redis **`chat_tool_working_set:{chat_id}`** as
  `{server_id: [function_name, ...]}` (sorted, deduped), `SETEX` with
  `SKILL_TTL_SECONDS` (7 days — matches `chat_tools`). Record hits for ALL non-core
  servers including `requires_activation` ones (hydration is naturally gated by chat
  attachment; pre-recording avoids a second search after activation). Empty result ⇒
  no writes.
- Keep the existing `activate_integration` Rust success text unchanged — mcp-assistant
  is model-agnostic and that text remains correct for GPT.

### 3.2 OWUI middleware: working set + funnel-edge subsetting

File: `src/patches/backend/open_webui/utils/middleware.py`.

1. `_load_claude_tool_working_set(chat_id) -> dict[str, list[str]]` — on-demand Redis
   read (same client pattern as `_load_openai_prompt_cache_server_allowlist` ~:3015).
   No polling, no timers.
2. `_apply_claude_tool_deferral(tool_ids, chat_id, model) -> (mapped_ids, deferred_server_ids)`
   — for each bare `server:x`:
   - `is_core` server (via `_load_server_metadata`) → pass through unchanged;
   - non-core with working-set entries → **replace** with the dormant subset syntax
     `server:x|fn1,fn2` (already parsed by `load_cached_tool_specs_for_ids` ~:3917-3924;
     names sorted for deterministic serialization);
   - non-core without entries → drop, record in `deferred_server_ids`.
3. Foreground call site: map the openapi tool ids (~:9844-9850) immediately before the
   funnel call (~:9857). The registry (`metadata["tools"]`) is then built only from
   hydrated tools, so registry == payload (consistency warnings ~:10051 stay silent),
   the executor's `tools_dict` has exactly the callables it needs, and every policy
   layer keeps seeing real tool names.
4. Follow-up/activation path: map `pending_tool_ids` at the entry of
   `_load_pending_tool_specs_after_inlet` (~:4288). For servers dropped as deferred,
   append ONE system notice (pattern: `_build_dynamic_tool_starting_system_message`
   ~:3507-3519): "integration attached; its tools load on demand — call find_tools".
   **This intercept is mandatory**: without it, mid-turn activation hydrates the full
   server (google_workspace = ~36.7k tokens) and defeats the design.
5. Mid-turn discovery: extend the DYNAMIC TOOL DISCOVERY block (~:15164-15216) — read
   the working set alongside `discover_pending_chat_tool_ids_from_redis`, compute
   per-server names not yet in `metadata["tools"]`, and emit them as subset refresh ids
   into the existing `_load_pending_tool_specs_after_inlet` →
   `_inject_loaded_tool_specs_into_followup_request` rail. The injector's name-dedup
   (~:4530) makes re-detection idempotent. Mid-turn tool ADDITIONS must always ride this
   rail (the follow-up rebuild intersects with the previous payload's names ~:3229-3251,
   so additions cannot enter anywhere else).
6. **Sticky called tools**: after resolving each external tool call, write-through the
   called function name into the working set (in-memory set check first; one Redis
   write per new name). This guarantees replay/branch rebuilds always produce a
   covering `toolConfig` for any `toolUse` in history.
   `_ensure_replay_safe_tool_payload` (~:3344) remains the backstop for TTL-expired
   chats.
7. `chat_tools:{chat_id}`, `metadata["tool_ids"]`, `body["tool_ids"]` stay **bare**
   (see hard rule §5.1). Capability persistence, toggle filtering, readiness gating,
   and the GPT namespace attach (~:10071) are untouched.

### 3.3 Prompt text (same PR as 3.2 — prompt/spec alignment invariant)

File: `src/filters/unified_context.py`. The org invariant (NativeChatMigration.md A6/A12)
is that prompt claims and the tools array never disagree.

- `_build_tools_context` (~:1524-1643): for deferral-on models, annotate non-core
  `<server>` entries (`tools_deferred="true"`) and add one instruction line inside
  `<tool_servers>`: enabled ≠ loaded; use `find_tools` to load what you need.
- `_build_integrations_status_context` (~:1134-1473): activation guidance for
  deferral-on models becomes "after activate_integration, call find_tools to load the
  tools you need".
- `agents/base_system_prompt.md`: NOT modified. It is model-agnostic; deferral wording
  lives only in the unified_context conditional blocks so GPT prompts are untouched.

### 3.4 Knobs

- `CLAUDE_TOOL_DEFERRAL_MODELS` — comma-separated model-name substrings; empty default
  = off. Shared predicate `_is_claude_deferred_tools_model(model_name)` in
  middleware.py + unified_context.py (parse mirrors `_get_gpt_openai_route_mode`).
- `CLAUDE_TOOL_DEFERRAL_SUBAGENT_MODE=full|inherit` (default `full`): delegated
  subagents are already scope-locked to a parent-chosen server set
  (`delegated_subagent_allowed_tool_server_ids`, mcp_assistant.rs ~:1851; registry
  filter middleware.py ~:512). `full` hydrates their scoped servers completely — no
  find_tools round-trip inside subagents, and the parallel-subagents harness stays
  green. `inherit` applies deferral (measured later, not gated).

## 4. Working-set state machine

- **Create** on first `find_tools` hit or first external tool call (SETEX 7d).
- **Grow** on every find_tools hit and every called tool (write-through).
- **STRICTLY ADDITIVE within a chat** — never shrinks while live. Any tools-array
  change (add/remove/reorder/reserialize) invalidates Anthropic's entire cached prefix,
  so additions are confined to rare discovery events (once per new capability per chat,
  at a follow-up boundary where activation already causes the same class of
  invalidation, on a prefix ~5× smaller than today's) and removals are structurally
  prevented.
- **Expiry**: the only removal paths are the ones that exist today — the 7-day TTL on
  an idle chat (its 1h-TTL cache entries died a week earlier, so the invalidation is
  free) and global server toggle-off (already covered by
  `_sanitize_disabled_tool_history` / readiness filtering). A TTL-expired chat reverts
  to eager-core with the replay-safe backstop handling stale histories, same class of
  behavior as `chat_tools` expiry today.
- Scheduled runs use their own chat_id → own working set; a >7-day cadence re-searches
  on the first turn (accepted).

## 5. Hard design rules (each prevents a verified bug class)

1. **Subset ids are EPHEMERAL.** `server:<id>|fn1,fn2` is produced only at the funnel
   boundary and always *substituted for* the bare id — never persisted to
   `chat_tools:*`, `metadata["tool_ids"]`, or `body["tool_ids"]`, and never emitted
   alongside its bare id. Violations hit two verified bug classes:
   `_canonicalize_tool_ids_for_loading` (~:1897) dedups on the full string, so
   bare+subset double-loads and the duplicate-name loop (~:3975) mints ghost tools
   (`glean_glean_search`-style); and `_missing_tool_ids_from_registry` (~:4580)
   compares against bare registry ids, so a persisted subset id is permanently
   "missing" and triggers refresh loops.
2. **Intercept activation-driven hydration** (§3.2.4) — otherwise the existing rail
   full-hydrates newly activated servers and the design silently degrades to today.
3. **Apply `function_name_filter_list` inside search** — never promise a tool that
   hydration will drop.
4. **Sticky called tools** (§3.2.6) — Bedrock Converse 400-safety on replay/branch.
5. **Additive-only working set** (§4) — cache-invalidation discipline.
6. **Prompt/spec alignment**: §3.2 and §3.3 land in the same PR, gated by the same
   knob.
7. **No generic dispatcher.** Discovered tools are injected as native tools with their
   real names. The confirmation gate (`tool_confirmation_gate.py`,
   `mcp-policy/destructive-tools.json`), subagent locked-tool filtering, Ultra
   read-only classification, and `tool_allowlist.py` all key on real tool names; a
   `call_bridge_tool`-style wrapper would bypass the entire policy layer.
8. **Keep the 8891 host bridge out of the chat path.** Its *pattern* (score → load) is
   what this plan ports; the daemon itself re-crawls per call, forwards no
   chat/session attribution headers, and has no per-chat state.

## 6. Sensitive-data logging rules (inherited from Plan A; hard constraint)

Motivated by the raw-message filesystem leak incident: no artifact of this plan may
durably contain message text, prompts, tool-call arguments, or tool results. Tool
SPECS (names/descriptions/schemas) are non-sensitive.

- `find_tools` adds NO new logging of queries or results. Queries flow only through
  the existing tool-call channels (they are ordinary tool arguments there).
- `chat_tool_working_set:{chat_id}` values contain server ids + function NAMES only —
  never queries, arguments, or results.
- Any new log lines are numeric/name metadata only (counts, byte sizes, tool names).

## 7. Test plan

### Unit (CI)

- **Rust `find_tools`**: scorer parity vectors against the bridge `score_tool`
  weights; corpus from a Redis `tool_servers` fixture; toggled-off servers excluded;
  `function_name_filter_list` names never returned; status matrix
  (loaded/active/requires_activation, all three in one result); limit clamped [1,25];
  empty/whitespace query → structured error (not dump-all); results contain NO
  `input_schema`; working-set writes (create/merge/dedupe/sort under the capabilities
  lock, SETEX TTL == `SKILL_TTL_SECONDS`, zero hits → zero writes, malformed existing
  value overwritten safely); dispatcher registration + tool_spec.json schema.
- **Middleware (pytest)**: `_apply_claude_tool_deferral` matrix (core pass / subset
  replace / drop+record; bare+subset never co-occur — explicit ghost-duplicate
  regression test; unknown server metadata → fail-open bare; deterministic ordering);
  predicate parsing (empty/single/multi/substring; GPT and Gemini names never match);
  working-set read fail-open (missing key / malformed JSON / Redis exception → full
  hydration + one log line); foreground mapping yields registry == payload;
  ephemerality invariant (`chat_tools:*`, `metadata["tool_ids"]`, `body["tool_ids"]`
  bare after a full cycle); activation interception emits exactly one find_tools
  notice; mid-turn working-set delta rides the follow-up rail idempotently; sticky
  write-through (one Redis write per new name, failure tolerated); replay paths
  (covered history → def present; TTL-expired → clean strip); subagent `full` vs
  `inherit` modes.
- **unified_context (pytest, rendered-output assertions only — no source pins)**:
  `<tool_servers>` deferral annotations and instruction line present iff the predicate
  matches; integrations guidance switches wording; rendered GPT prompt byte-unchanged.

### Integration (the Phase 0 tokenomics suite, tags flip when this plan ships)

Gates specified and baseline-captured by Plan A's suite
(`src/scripts/run_tokenomics_chat_consistency.py`, `tests/tokenomics/`):
- **T2-P2**: activating google_workspace adds ≤ 8KB to the next request (notice only,
  no spec flood).
- **T4**: per-request tool_count ≤ 130 in the 3-server scenario (eager ~101 + working
  set ≤ 25; baseline 300+).
- **T5**: capability preserved via discovery — chat without google_workspace active,
  asked to find recent emails, shows find_tools → activate_integration → hydration →
  correct native `google_workspace_*` call within 3 assistant rounds (read-only op).
- **T6**: sticky/replay — call a discovered tool, continue, regenerate/branch from an
  earlier message → no Bedrock 400, def still in payload.
- **T7**: policy intactness — a *discovered* destructive tool still triggers the
  confirmation gate (fixture with the gate flag enabled).
- **T10**: subset hydration correctness — the follow-up request after find_tools
  contains exactly the matched defs; registry == payload; no bare+subset double-load.
- Plus billed-token thresholds tightening from Plan A's T3 (~140k → ≤110k on the
  reference scenario) and the T9 cache-health steady-state check (no unexplained
  cache_creation between discovery events).

## 8. Rollout, risks, rollback

**Rollout**: (1) `find_tools` ships dark — note it adds one core tool to every model's
toolset, which is itself a one-time fleet-wide tools-membership cache invalidation, so
land it bundled with another already-invalidating change (e.g. a Plan A knob flip).
(2) Middleware + prompt text in ONE PR behind the empty-default knob. (3) Enable one
Claude alias in staging → run the integration gates → measure → fleet. GPT keeps its
namespaces path; Gemini can adopt later behind the same predicate mechanism.

| Risk | Mitigation | Rollback |
|---|---|---|
| Model doesn't search before acting | Prescriptive find_tools description; §3.3 prompt guidance; should-search eval metric; eager core covers most historical calls | Remove model from `CLAUDE_TOOL_DEFERRAL_MODELS` → full hydration returns next turn (one invalidation per active chat) |
| Extra round-trip on first non-core use | Mid-turn hydration (no user-visible stall); subagents full-hydrate by default | Same knob |
| Ghost duplicates / refresh loops on subset ids | Hard rule §5.1 + regression tests | Prevented |
| Bedrock 400 on branch/replay | Sticky called tools + replay-safe backstop | Knob off |
| Cache churn per discovery | Additive-only set; discovery-event-only changes on a ~5× smaller prefix | Accepted by design |
| Search misses | Structured zero-result with next_steps (broaden query / `list_mcp_servers` / catalog block); model falls back to asking the user | n/a |
| Redis flap | Fail-open to bare ids (today's behavior) + one log line | Self-heals |
| Prompt/spec drift | §3.2+§3.3 same PR, same knob; rendered-output alignment test | Knob gates both sides |

## 9. Native-migration mapping and out-of-scope

- `find_tools` lives server-side on mcp-assistant and **survives the Native Chat
  migration as-is**. The middleware mapping (§3.2) is the design input for the
  equivalent host-layer logic around `BedrockConverseModel` (which ports
  `prompt_cache.rs`/`converse.rs` 1:1, so Plan A's slimming rides along as code); the
  OpenAI Agents SDK's dynamic `tool_filter` is the natural expression of the working
  set there.
- **Out of scope**: embeddings-backed search (gateway `text-embedding-3-large` is
  reachable today — probe recipe in `src/scripts/test-bifrost-prompt-caching.sh` — but
  it is a quality upgrade, not a token win, and the native plan drops vector infra);
  Anthropic server-side Tool Search (blocked on Bedrock Converse); tightening the
  eager set below `is_core` (a later dial once search behavior is proven);
  system-prompt/skills-context dieting (separate follow-up — it is the other ~72k of
  the prompt).
