# Tokenomics problem-proof suite

Headless real-chat integration gates for the tool-spec tokenomics work:
**Plan A** (bridge-side tool-spec slimming for Claude/Gemini — `slim_tool_definitions`
in `src/bifrost-bridge-rust/src/prompt_cache.rs`, per-alias `tool_slimming` catalog
flag, `BRIDGE_TOOL_SLIMMING`/`BRIDGE_TOOL_SLIMMING_MODE` env knobs) and
**Plan D** (`plans/DeferredToolLoading.md`).

Driver: `src/scripts/run_tokenomics_chat_consistency.py` (house
`run_*_chat_consistency.py` pattern — OWUI backend API + llm-debug-monitor +
bridge logs + reporting events; no Electron, no Playwright).

## Red → green protocol

Every scenario asserts the DESIRED post-fix state. Before the fixes land, run

```bash
uv run --with httpx --with redis src/scripts/run_tokenomics_chat_consistency.py --capture-baseline
```

which records the failing measurements to a committed `baseline-<date>.json` —
the documentary proof the problems are real. Scenario tags (`A-claude`,
`A-gemini`, `D`) are expected-fail (xfail) until their rollout flips them via

```bash
uv run --with httpx --with redis src/scripts/run_tokenomics_chat_consistency.py --expect-pass A-claude --runs 3
```

An xfail scenario that PASSES exits non-zero (XPASS) so tag flips stay
deliberate. `guard`-tagged scenarios (T8 GPT non-regression, T9 cache health,
T-args argument quality) must pass in every mode.

## Scenarios

| id | tag | asserts |
|----|-----|---------|
| T1 | A-claude | fresh Claude chat, on-wire tools bytes ≤ 70KB (baseline ~116KB) |
| T2 | A-claude | attaching google_workspace adds ≤ 60KB (baseline +147KB); Plan D tightens to ≤ 8KB |
| T3 | A-claude | 3-server scenario billed prompt tokens ≤ 150k (baseline ~210k); Plan D ≤ 110k |
| T3g | A-gemini | same scenario on Gemini ≤ 95k (baseline ~127k) |
| T4 | D | per-request tool_count ≤ 130 (baseline 300+) |
| T5/T6/T7/T10 | D | discovery flow / sticky-replay / policy gate / subset hydration — runnable once `find_tools` ships |
| T8 | guard | GPT keeps namespaces + tool_search; billed within ±10% of baseline |
| T9 | guard | steady-state turn 2 shows prompt-cache reads |
| T-args | guard | schema-sensitive task still calls the right tool without retry loops |

Runs on demand as a rollout gate (real LLM cost — NOT per-MR CI). The only CI
piece is `test_report_schema.py` (pure logic).

## Sensitive-data rules (hard constraint)

Motivated by the raw-message filesystem leak incident: committed reports are
metrics-only, enforced mechanically by `report_schema.py` (allowlisted keys,
forbidden content-ish key names, no string > 200 chars — the writer refuses to
persist violations). Full payloads are read transiently from the debug monitor
and asserted in memory. Anything transcript-like requires an explicit flag and
lands only in the gitignored `artifacts/` directory.
