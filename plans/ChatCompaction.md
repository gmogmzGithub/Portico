# Codex-Style Chat Compaction for Portico

Status: draft for review — 2026-08-07

## Context

Long chats currently grow until they hit the model's context window, at which point the app throws a **terminal** error ("start a new chat or switch models" — `CONTEXT_WINDOW_ERROR_MESSAGE`, `middleware.py:1676`). There is no compaction, trimming, or summarization of chat history anywhere in the stack (verified by full-repo sweep). This plan implements the compaction strategy used by OpenAI's Codex harness — verified below against `codex-rs` source on `main` — in our stack.

**User-confirmed decisions:** summarizer = the chat's own model (Codex parity); auto-compaction runs **synchronously at send time with a Claude Code-style estimated progress bar**; v1 scope = turn boundaries only (no mid-tool-loop compaction); everything flag-gated.

**Layers involved:** LLM Routing (engine + payload seam), State & Persistence (compaction records in chat JSON), Chat UI (trigger, progress bar, marker, gauge), Observability (llm-debug-monitor events + web-app UI).

## Non-negotiable invariants (user-mandated)

1. **The entire chat history is ALWAYS visible to the user.** Compaction never rewrites the chat DB tree, the flat messages list, or the rendered transcript — it only shrinks the outbound model payload at dispatch time. Enforced by the Tier-2 assertion that `api.getChat` returns the full tree after compaction, and by the engine having no write path to `history.messages`.
2. **Visible compaction markers in the chat UI.** Every compaction renders a persistent marker row in the transcript at the cut point (`CompactionMarker.svelte`, driven by the persisted record — not ephemeral events), showing tokens before → after, trigger, and the expandable summary.
3. **First-class llm-debug-monitor integration.** Compaction markers appear in the monitor web app's per-chat request timeline with before/after evidence, so a human can verify surgery correctness end-to-end (§2.7).
4. **PORTICO-265 privacy guardrail — no raw unencrypted chat content on the filesystem.** The debug monitor once served raw payloads from the on-disk reporting directory; PORTICO-265 (`37a9ad2c`) purged that and added `tests/reporting-payload-privacy.unit.test.js`. Compaction observability follows the post-fix architecture only: compact identity envelope over Redis pub/sub + oversized fields in TTL'd Redis keys (`llm_debug:event_*`, TTL 300s). `summary_text` and any message digests never touch `PORTICO_COST_REPORTING_DIR` or any other disk path; bridge cost events stay numbers-only. The privacy unit test is extended to cover `chat_compaction` events.

---

## Part 1 — How Codex compaction works under the hood (source-verified 2026-08-06)

Codex has three implementations behind one lifecycle (`core/src/tasks/compact.rs`): **local "Memento"** (portable — what we port), **remote V1/V2** (OpenAI Responses API compacts server-side; not portable to Bedrock), and **token-budget** (feature-flagged, no-LLM fresh-window strategy). Local mechanics:

1. **Trigger** (`core/src/session/context_window.rs`): real token usage from every response is tracked as `active_context_tokens`; compaction fires when it crosses the per-model `auto_compact_token_limit` (+ optional buffer) or the hard window. Manual `/compact` any time.
2. **Summarization call** (`core/src/compact.rs::run_compact_task_inner_impl`): clone history, append ONE user message = the summarization prompt ("You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task: progress & key decisions; context/constraints/user preferences; clear next steps; critical data/references."), run against the **same model, no tools**. If this call itself overflows → `history.remove_first_item()` and retry.
3. **Deterministic history surgery** (`build_compacted_history`): new model-facing history =
   - retained **real user messages**: newest→oldest into a `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` budget (approx chars/4), last partially-fitting one truncated, restored to chronological order, **each kept as its own user message**;
   - + ONE user message = `SUMMARY_PREFIX + "\n" + summary`. The prefix ("Another language model started to solve this problem and produced a summary of its thinking process… use the information in this summary to assist with your own analysis:") is a handoff framing AND a machine-detectable marker: on the next compaction, prior summaries are excluded from retention (`is_summary_message`) because their content folded into the new summary. Exactly one summary survives each round.
   - Assistant turns, tool calls/results, reasoning: **dropped**. Initial context (instructions/environment) is re-injected fresh on the next turn.
4. **Bookkeeping**: three representations stay distinct — append-only rollout on disk (replayable `CompactedItem`), mutable model-facing history, full UI transcript (never touched). Token usage recomputed; `ContextCompaction` marker + warning event ("multiple compactions can reduce accuracy — start a new thread when possible"); analytics with tokens before/after, duration, trigger, status.

**Properties to preserve:** real token counts drive the trigger (not estimates); the model summarizes with full context in place, then the harness does deterministic surgery; user messages are sacred (kept verbatim up to budget); handoff framing prevents the model treating the summary as its own memory; UI transcript never lies; the compact call itself is overflow-hardened.

---

## Part 2 — Implementation in our stack

Everything providers see funnels through the patched OWUI backend, so ONE implementation covers Claude, GPT, Gemini, local. The UI transcript and DB history tree are never modified — only the outbound model payload shrinks, exactly like Codex.

### 2.1 Pure engine — NEW `src/patches/backend/open_webui/utils/chat_compaction.py` (LLM Routing)

Stdlib-only module (patch entrypoint copies new files under `src/patches/backend/` into the container) holding all deterministic logic:
- `SUMMARY_PREFIX` + `COMPACTION_SUMMARIZATION_PROMPT` (ported Codex text, above); `RETAINED_USER_TOKEN_BUDGET = 20_000`, `CHARS_PER_TOKEN = 4`.
- `extract_user_message_text(content)` — string passes through; list content concatenates `text` parts (images dropped from retained text).
- `compaction_anchor_hash(content)` — sha256 of normalized text (strip `<details>` wrappers, `.strip()`). Messages carry **no ids** in request payloads, so the cut point anchors by content hash — same trick as the existing follow-up history guard (`collect_followup_user_message_anchors`, `middleware.py:7051`).
- `collect_compaction_user_anchors(messages)` — ordered user-message hashes, excluding `SUMMARY_PREFIX`-prefixed ones.
- `select_retained_user_messages(messages, budget)` — Codex retention walk (newest-first into budget, truncate last-fitting, chronological order, summary-marker exclusion).
- `find_compaction_cut(messages, covered_user_hashes)` — strict in-order prefix match of payload user hashes vs the record's covered set → cut index; `None` on any mismatch (branch/edit invalidation). If the record covers ALL payload user messages (regenerate-at-leaf), shrink coverage by one so the final user turn replays verbatim — the pending user message is never summarized away.
- `apply_compaction_record_to_messages(messages, record)` — the splice: `[leading system messages in place] + [retained user messages] + [SUMMARY_PREFIX + summary as one user message] + [post-cut messages verbatim, contentBlocks and all]`. Never raises; returns originals with `applied=False` on any anomaly.
- `latest_applicable_record(records, messages)` — newest→oldest, first record whose cut matches wins (older records can still apply on sibling branches).
- `should_trigger_compaction(...)`, `minimum_history_eligible(...)` (≥2 real user msgs), `estimate_messages_tokens(...)` (chars/4, for tokens_after estimate).

### 2.2 Fresh-turn payload seam — `middleware.py` (LLM Routing)

- New `apply_chat_compaction_to_fresh_turn(form_data, metadata)` inserted in `process_chat_payload` **immediately after the `reconstruct_anthropic_format` block closes (`:9598`)**, before `apply_params_to_form_data` (`:9600`) and before inlet filters — so `<static_context>`/`<dynamic_context>` system injection happens after the splice and prompt-cache breakpoints are untouched.
- Guards: flag on; `metadata["task"]` empty (auxiliary side-calls never compact); real chat_id (not `local:`, not subagent/delegated); records exist in chat JSON. Whole body try/except → original messages on any error (a send must never fail because of compaction).
- **Guard-safety (verified):** follow-up history-guard anchors are captured AFTER this seam from the processed payload, so the compacted payload becomes the fidelity baseline; mid-turn tool rounds (`build_followup_replay_messages` at `:15459`/`:16304`) replay it untouched. v1 does not modify the follow-up paths.
- **Log-only measurement hook**: in `background_tasks_handler` (post-response, where title/tags already fire — no new timers), when mode=`log_only` emit a `would_compact` observability event with occupancy vs threshold. No LLM call, no records.

### 2.3 Summarizer orchestrator + endpoint — `routers/tasks.py` (LLM Routing)

`run_chat_compaction(request, user, chat_id, trigger, max_context_tokens?)`, modeled on `generate_title` (`:290`):
1. Redis NX lock `chat_compaction_lock:{chat_id}` (TTL 180s); also refuse if `chat_active_turn:{chat_id}` shows a live turn.
2. Load chat, build active branch (`get_messages_map_by_chat_id` + walk to `history.currentId`), map to `{role, content, contentBlocks}` → `reconstruct_anthropic_format` → apply `latest_applicable_record` (prior summaries fold in).
3. Eligibility check (`too_short` → skipped response).
4. Summarization call: cloned view + ONE user message = `COMPACTION_SUMMARIZATION_PROMPT`; **model = the chat's own model** (env override `OWUI_CHAT_COMPACTION_MODEL`); `stream: False`; `max_completion_tokens` = `OWUI_CHAT_COMPACTION_SUMMARY_MAX_TOKENS` (default 2048); NO tools; task metadata via `build_task_metadata(..., "chat_compaction")` so filters and the seam skip it; `asyncio.wait_for(…, 120s)`.
5. **Codex overflow retry**: on `_is_context_window_error` → drop oldest non-system message, retry (max 6).
6. Empty summary → failed, no record. Success → build record (schema §2.5: `covered_user_hashes` from the raw branch's user nodes, `boundary_message_id` = tree id of last covered user message for the UI marker, retained texts, tokens before/after).
7. Persist: re-fetch chat, append to `chat["compaction"]["records"]` (cap 10), `Chats.update_chat_by_id`. Backend-written top-level key survives frontend whole-chat saves via the key-level merge (`routers/chats.py:282` — the `reviewer_workflow` precedent).
8. Emit socket `chat:compaction {record}` + observability events; release lock.

Manual/auto endpoint: `POST /api/v1/tasks/compaction/completions {chat_id, max_context_tokens?}` — ownership-checked, synchronous, returns `{status, record?}` (`locked` / `skipped:too_short` / `failed:*` / `ok`).

### 2.4 Trigger + progress UX — frontend (Chat UI)

**Auto-trigger is client-orchestrated at send time** (mirrors Claude Code; one code path for auto and manual):
- Pre-send check at the single send funnel in `Chat.svelte` (`sendPrompt`/`submitPrompt` region `:8794`, before `sendPromptSocket`): `contextTokens ≥ threshold% × resolveModelMaxContextTokens(...)` — exactly the gauge's numbers, so gauge and trigger can never disagree. Threshold default 80% (config-exposed knob).
- When triggered (or "Compact now" clicked): append the user's message to the transcript as usual, then show a **compaction progress bar** where the response would start, `await compactChat(...)` (new `src/lib/apis/chatCompaction.ts` → the endpoint), then dispatch the completion. **Compaction failure never blocks the send** — log, toast, dispatch uncompacted.
- **Progress bar (Claude Code-style, estimate is fine per user):** ETA derived from `contextTokens` (calibratable, e.g. ~8s + tokens/25k s); bar animates toward ~90% via **CSS transition with duration = ETA** (zero JS timers — honors the performance rule), jumps to 100% on response. Label: "Compacting conversation… (est.)". Component alongside the pending-response area; `ComposerMetrics` popover hosts the manual "Compact now" button (disabled while generating or below a context floor) with the same progress treatment.
- `max_context_tokens` also rides the completion request body (popped into metadata in `main.py`) so server-side `log_only` measurement and future server triggers have it.

**Marker + gauge:**
- NEW svelte-free `src/lib/utils/chatCompaction.ts` (cjs-testable): `deriveCompactionMarkersAfterMessageId(records, history)`, gauge override (`tokens_after_estimate` until fresher usage arrives), warning level (≥2 records → "multiple compactions can reduce accuracy — consider a new chat"), record de-dup.
- `Messages.svelte`: render a persistent **CompactionMarker.svelte** row after `boundary_message_id` (reuses the `debugMarkersAfterMessageId` interleave mechanism `:704-721`, but fed from the persisted record): "Conversation compacted — N → M tokens", expandable summary, warning when repeated.
- `Chat.svelte`: load `chatContent?.compaction` on chat load (reviewer_workflow read precedent `:6104`); handle `chat:compaction` socket event (marker + gauge update, other tabs converge).

### 2.5 Compaction record (State & Persistence)

Chat JSON top-level key, backend-written, append-only, cap 10:
```json
"compaction": { "version": 1, "records": [{
  "id": "cmp_<uuid>", "created_at": 0, "trigger": "auto|manual",
  "model": "<summarizer>", "chat_model": "<chat model>",
  "boundary_message_id": "<tree id of last covered user msg>",
  "covered_user_hashes": ["<sha256>", "..."],
  "retained_user_messages": ["<text>", "..."], "retained_token_budget": 20000,
  "summary_text": "<summary>",
  "tokens_before": 0, "tokens_after_estimate": 0,
  "duration_ms": 0, "summarizer_retries": 0
}]}
```
DB history tree, flat messages, and UI transcript are never rewritten. Kill switch → records simply go inert.

### 2.6 Flags & rollout

- Master: `chat_history_compaction: false` in `optimization_flags.json` (+ `OWUI_OPT_CHAT_HISTORY_COMPACTION` override); frontend visibility via the app config payload.
- Knobs: `chat_compaction_trigger_percent` (80), `OWUI_CHAT_COMPACTION_MODE=active|log_only`, `OWUI_CHAT_COMPACTION_MODEL` (empty = chat's model), `OWUI_CHAT_COMPACTION_SUMMARY_MAX_TOKENS` (2048), optional absolute cap `chat_compaction_trigger_max_tokens` for 1M-window models.
- Stages: dark → `log_only` (measure `would_compact` volume + tokens_before from llm-debug events) → manual-only dogfood (summary quality) → auto at 80%. Before/after token measurement per the expectations in `docs/architecture/llm/tool-compaction-parity-backlog.md`.

### 2.7 Observability — llm-debug-monitor as the human verification surface

**Event plumbing (Redis-only, per PORTICO-265):**
- `src/event_publisher.py`: new `publish_compaction_event` → `event_type: "chat_compaction"`, data `{phase: start|success|failure|skipped|would_compact|applied, trigger, tokens_before, tokens_after_estimate, duration_ms, dropped_message_count, retained_count, summarizer_retries, model, reason?}`. Numbers/enums ride the compact pubsub envelope; `summary_text` (chat-derived content) goes ONLY into the TTL'd Redis detail key (same pattern as `llm_debug:event_request_payload:*`, TTL 300s). **No file writes anywhere** — `event_publisher.py` has no filesystem path today and this feature adds none; nothing new lands in `PORTICO_COST_REPORTING_DIR` (the summarizer's own usage flows through the existing sanitized numbers-only cost events like any LLM call).
- Emission sites: orchestrator (start/success/failure/skipped), fresh-turn seam (`applied` with dropped/retained counts on every compacted dispatch), log_only trigger check (`would_compact`).
- `llm-debug-monitor/backend/models.py`: `ChatCompactionData` model; `BaseEvent.event_type` is already a plain string so the store/REST/WS paths accept it; include compaction events in `/api/chats/{chat_id}/requests` timeline responses.

**Monitor web-app UI (`llm-debug-monitor/src/`):**
- **Timeline marker**: a distinct compaction chip/row in the per-chat request timeline at the point where compaction ran — "⚡ Compacted (auto) — 412k → ~38k tokens, dropped 87 msgs, kept 6" — visually distinct from request rows (mirrors the in-chat marker so the two surfaces corroborate).
- **Detail panel**: full record fields (trigger, phases with timestamps, duration, retries, dropped/retained counts, models) + `summary_text` fetched from the TTL'd detail key while it lives (with an "expired — see chat record" note afterward, since the durable copy is the chat DB record).
- **Verification affordance**: the marker links its neighbors — the last pre-compaction request and the first post-compaction request — so a human opens the post request's captured payload (existing `LLMRequestPayloadData` viewer) and confirms: message count dropped, `SUMMARY_PREFIX` present, old tool_use ids gone, post-cut turns intact. Subsequent request rows show an "applied" badge from the seam's per-dispatch event, proving the record keeps applying.
- `llm-debug-monitor/src/types/events.ts`: add `'chat_compaction'` to the `EventType` union + interface; timeline/list rendering entries.

### 2.8 Edge cases (decided)

- **Branch/edit above the cut** → hash prefix mismatch → record inapplicable → older records tried → else full history (+ `anchor_mismatch` event). Auto-trigger re-evaluates at the next send by construction.
- **Regenerate at leaf** → shrink-coverage-by-one rule keeps the last user turn verbatim.
- **Model switch mid-chat** → threshold uses the currently selected model's window; summary is plain text, model-agnostic.
- **Bridge/cache (no changes needed, verified):** prompt-cache breakpoints recompute per request — tools+system segments still hit; conversation segment takes ONE cache write (~1.25× input once) then re-converges; Claude thinking-splice no-ops for dropped turns; post-cut turns keep re-splicing; OpenAI `prompt_cache_key` chat affinity stable.
- **Excluded:** `local:` chats, subagent/delegated chats, auxiliary task calls, Ultra multi-agent (own budgets), mid-tool-loop rounds.
- Today's terminal overflow error remains the last-resort backstop in v1.

### 2.9 Files to touch

| Layer | File | Change |
|---|---|---|
| LLM Routing | `src/patches/backend/open_webui/utils/chat_compaction.py` | NEW pure engine |
| LLM Routing | `src/patches/backend/open_webui/utils/middleware.py` | seam after `:9598`; knob helpers near `:7040`; `log_only` hook in `background_tasks_handler` |
| LLM Routing | `src/patches/backend/open_webui/routers/tasks.py` | `run_chat_compaction` + `/compaction/completions` |
| LLM Routing | `src/patches/backend/open_webui/main.py` | pop `max_context_tokens` into metadata; config exposure |
| Chat UI | `src/patches/frontend/src/lib/utils/chatCompaction.ts` | NEW svelte-free logic |
| Chat UI | `src/patches/frontend/src/lib/apis/chatCompaction.ts` | NEW API client |
| Chat UI | `Chat.svelte`, `Messages.svelte`, `CompactionMarker.svelte` (NEW), `MessageInput.svelte`, `ComposerMetrics.svelte` | pre-send trigger + progress bar, marker row, socket event, button |
| Observability | `src/event_publisher.py` | `publish_compaction_event` (Redis envelope + TTL detail key, no file writes) |
| Observability | `llm-debug-monitor/backend/models.py`, `backend/server.py` | `ChatCompactionData`, timeline inclusion |
| Observability | `llm-debug-monitor/src/types/events.ts` + timeline/detail components | compaction marker chip, detail panel, pre/post request links, applied badges |
| Config | `optimization_flags.json`, `docker-compose.yml` | flags/knobs |

## Verification

- **Tier-1 python unittest** (behavioral; source-pin assertions banned): NEW `tests/test_chat_compaction_engine.py` — direct import of the pure module (retention walk, anchor normalization, cut-finding incl. edit-invalidation and shrink-by-one, splice invariants: system preserved / post-cut byte-identical / pending user survives, multi-compaction marker exclusion). NEW `tests/test_chat_compaction_seam.py` via the AST-extract harness (`tests/helpers/middleware_replay_extract.py`): post-splice payload satisfies `verify_followup_history_fidelity`; engine failure returns original messages.
- **Tier-2 `tests/integration-chat` (mock-bedrock)**: scenario D-C1 manual — seed multi-turn tool chat, `api.compactChat(chatId)`, dispatch next turn, assert via `analyzeBedrockPayload`: `flat` contains SUMMARY_PREFIX, `messageCount` dropped, old `toolUseIds` absent, while `api.getChat` still shows the full tree + `compaction.records[0]`. Scenario D-C2 auto — threshold knob at 1%, assert record lands and next dispatch is compacted; a racing send goes out uncompacted. Both under `make chat-repro-report`.
- **Frontend**: NEW `tests/test_chat_compaction_frontend.cjs` esbuild-bundles `chatCompaction.ts` (marker map, gauge override, warning threshold, ETA/progress estimator). Explicit invariant test: full-history rendering input (`createMessagesList` output length) is unaffected by any number of compaction records.
- **Privacy (PORTICO-265 regression guard)**: extend `tests/reporting-payload-privacy.unit.test.js` + `tests/llm-debug-monitor-event-store.unit.test.js`: `chat_compaction` pubsub envelopes carry no `summary_text`/message content (numbers + enums only); detail blob lives only in TTL'd Redis keys; no reporting-dir writes are introduced.
- **Live e2e**: attach to the running dev app via CDP `127.0.0.1:9223` (never spawn/kill instances per OAuth rule): drive a long chat, click "Compact now", screenshot progress bar + in-chat marker, confirm the full transcript still shows every old message; then open llm-debug-monitor (8879) and verify the compaction chip in the chat timeline, the pre/post request link, and that the post request payload shows SUMMARY_PREFIX with reduced message count.
