# Backlog: Tool-schema compaction parity for Claude / Gemini

**Status: IMPLEMENTED, ON BY DEFAULT (2026-08-07)** — `tool_slimming: true` is set on
every Claude and Gemini alias in `model_catalog.yaml` (owner decision after the
31-run full-model matrix verified substance parity; `BRIDGE_TOOL_SLIMMING=off` is the
fleet kill-switch). Originally landed dark 2026-08-06 as
`slim_tool_definitions` in `src/bifrost-bridge-rust/src/prompt_cache.rs` (Plan A of the
tool-spec tokenomics work; Plan D is `plans/DeferredToolLoading.md`). **The bridge owns
this transform now — do NOT also widen the OWUI gate** (the "pick one, do not stack"
rule below; the bridge slimmer is idempotent, so accidental stacking is harmless but
still wrong). Details:

- Runs in the `AnthropicConverse` arm of `apply_prompt_cache_and_reasoning` (before the
  canonical tool sort and the last-tool `cache_control`) and in the `GeminiVertex` arm
  (OpenAI-format tools, i.e. before Bifrost's Vertex conversion and the 512-cap).
- Knobs: per-alias `tool_slimming: true` in `model_catalog.yaml` (default false =
  dark), env `BRIDGE_TOOL_SLIMMING=on|off` fleet override,
  `BRIDGE_TOOL_SLIMMING_MODE=parity|retain-param-descriptions` (retain mode keeps
  parameter descriptions trimmed to 120 chars — the fallback if evals show
  argument-construction regressions).
- Blocker status: (1) selection-quality eval — protocol + vehicle defined in the
  tokenomics suite (`src/scripts/run_tokenomics_chat_consistency.py`,
  `tests/tokenomics/README.md`; T-args is the argument-quality canary); (2) one-time
  cache invalidation — flip per-alias, low-traffic window (sequencing in the approved
  Plan A); (3) rollout knob — see above; measured before/after lands in
  `tests/tokenomics/baseline-*.json`.

Original entry follows (measurements remain the baseline of record).

---

**Original status: BACKLOGGED** (2026-08-01, by explicit decision during the Sol Pro response-handling fix round). No code change ships with this entry; it records a verified cost asymmetry and the constraints any future fix must satisfy.

## The asymmetry (verified)

For one and the same conversation history with 247 MCP tools enabled, the billed prompt tokens per provider were:

| Provider | Billed prompt tokens | Tools JSON on the wire |
|---|---|---|
| GPT-5.6 Luna (Responses API) | 56,202 | 141 KB compacted, 101 eager + 146 deferred |
| Gemini 3.6 Flash | 127,648 | 345 KB verbatim |
| Claude Opus 5 | 210,175 | 345 KB verbatim (byte-identical to Gemini's) |

Two compaction layers exist and both are **GPT-only**:

1. **OWUI middleware** — gate `_is_openai_prompt_cache_tool_model` (`src/patches/backend/open_webui/utils/middleware.py` ~2736, matches `gpt-5*`/`gpt-4.1*`) feeds `_build_openai_function_tools_payload` (~3113): 240-char description trim + verbose-schema stripping. Result: 141 KB vs 345 KB tools JSON.
2. **Bridge Responses route** — `chat_tools_to_responses_tools` (`src/bifrost-bridge-rust/src/main.rs` ~7536) buckets non-core namespaces with `defer_loading: true` + a `tool_search` entry, excluding deferred schemas from the billed prompt.

Claude (`/internal/anthropic` → Bedrock converse, `converse.rs` ~429) and Gemini (`gemini_vertex_prepare_payload`, `main.rs` ~4742, 512-declaration cap not binding) send the full flat schemas every round. The residual Claude-vs-Gemini gap is tokenizer density on schema-heavy JSON (~2.65 vs ~4.38 chars/token). The numbers are real context, not an accounting artifact (Bifrost's `prompt_tokens` for converse is the inclusive input+cache-write+cache-read sum).

Practical impact: Claude turns in tool-heavy chats carry roughly 2× the tokens they need; the first Opus turn in the measured chat wrote a 210k-token 1h-TTL cache ($1.31 of cache-write premium at current rates).

## Candidate implementations (pick one, do not stack)

- **OWUI gate extension**: widen/replace the gate at middleware.py ~2736 so `_build_openai_function_tools_payload` (~3113), the followup path (~3207), and ~4491 apply to Claude/Gemini too. Broadest consistency; every provider sees identical compacted tools.
- **Bridge-side slimming** (OWUI untouched): trim descriptions/schemas in the AnthropicConverse arm of `normalize_chat_payload_for_provider` (`prompt_cache.rs` ~791-898) and in `gemini_vertex_prepare_payload` (`main.rs` ~4742). Narrower blast radius than patching converse.rs itself (which also serves other `/internal/anthropic` consumers).

## Why it is backlogged — blockers to clear first

1. **Tool-selection quality eval.** 240-char description truncation changes what Claude/Gemini see for every tool in every chat. Needs an eval comparing tool-selection accuracy before/after on representative prompts (the existing `run_subagent` tool-selection e2e harness is a candidate vehicle).
2. **Anthropic prompt-cache invalidation.** Tools sit at the top of Anthropic's cache hierarchy (`prompt_cache.rs` ~867 sorts them for prefix stability); changing their serialization one-time-invalidates the cached prefix of every active Claude chat (full re-write at cache-write premium rates).
3. **Rollout guard.** Should ship behind a config knob with a measured before/after token+quality comparison, not as a silent default flip.
