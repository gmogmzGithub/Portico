# Subagent Token Optimizations

This document started as the writeup for the original 14 token, latency, and
stability optimizations added to handle heavy delegated-subagent workloads
(parallel research/report chats like 5x5 EJS/EJG sweeps).

Update 2026-03-16: several of the optimizations described later in this file
have since been removed. The current authoritative state is:

- Removed flagged optimizations:
  - `company_knowledge_external_retrieval_budget_guard`
  - `code_execution_pdf_helper_guidance`
  - `parent_post_subagent_synthesis_lock`
  - `same_server_tool_call_serialization`
- Removed always-on heuristics:
  - local chat-stream meaningful-progress timeout / retry logic in `middleware.py`
  - `raw_overflow_bash_shape_guard`
- Current checked-in optimization flags: `10`
- New GPT routing toggle: `GPT_OPENAI_ROUTE_MODE=direct|bifrost`

Treat the detailed sections below as a mix of current notes and historical
context. The progress update immediately below is the best summary of the
current system behavior.

## Progress Update - 2026-03-16

### What Changed

- Added `GPT_OPENAI_ROUTE_MODE=direct|bifrost` so GPT-5.4 can be switched
  between the direct Portico LLM Proxy Responses path and a Bifrost-backed GPT
  path without code edits.
- Confirmed that the latest released Bifrost supports GPT-5.4
  `/openai/v1/responses` with namespace metadata, deferred tool loading, and
  `tool_search`, even though it still rejects namespaced tools on legacy
  `/v1/chat/completions`.
- Kept the direct path as the default, but updated GPT Bifrost routing so
  `GPT_OPENAI_ROUTE_MODE=bifrost` now uses Bifrost Responses for GPT-5.4
  instead of falling back to the older flat chat-completions GPT path.
- Removed the explicit numeric retrieval-budget guidance from
  `skills/company-knowledge/SKILL.md` that previously capped things like
  `glean_search`, follow-up doc reads, and `vm_read_file_chunk` counts.
- Increased the Company Knowledge runner completion timeout from 300 seconds to
  3600 seconds via `OWUI_COMPANY_KNOWLEDGE_TIMEOUT_SECONDS` /
  `--timeout-seconds`, so long-running chats are no longer misclassified as
  runner failures.
- Hardened direct GPT streaming earlier in this work so missing terminal events
  become explicit `incomplete_stream` outcomes instead of fake `length`
  continuations.

### Test Matrix

Prompt for all comparison batches below:

`What's going on at Portico this week?`

Quality rubric used for manual scoring:

- `9-10`: directly answers the prompt, broad enough to feel company-level,
  current-week grounded, and supported by specific internal sources
- `7-8`: useful answer with solid evidence, but somewhat narrow or missing some
  breadth
- `5-6`: partial answer; helpful but too generic, too team-specific, or too
  caveated
- `3-4`: mostly apology / weak synthesis with little actionable weekly signal
- `0-2`: failed, empty, or clearly did not answer the prompt

| Group | Route / build | Guidance | Outcome | Quality | Notes |
|---|---|---|---|---|---|
| Bifrost pre-latest release | `bifrost` | original company-knowledge skill | 5/5 completed | avg `4.0/10` | Reliable completion, but 3 of 5 answers were mostly apologies or weak weekly synthesis |
| Direct pre-timeout-fix | `direct` | original company-knowledge skill | 1/5 runner-complete before the old 300s cutoff | avg `3.2/10` | This batch was confounded by the old runner timeout and later service restarts, so it is useful mainly as historical context |
| Latest released Bifrost baseline | `bifrost` + fresh `build --pull` | original company-knowledge skill | 5/5 completed | avg `4.6/10` | More stable than direct on the same prompt; one runner artifact file was blank, but the chat completed and was recovered from chat history |
| Direct rerun with 1h timeout | `direct` | original company-knowledge skill | 2/5 completed (`1` perfect, `1` warning-only detour), `3/5` upstream failures | avg `2.6/10` | This is the cleanest apples-to-apples direct comparison against the latest Bifrost baseline |
| Bifrost Responses + deferred loading/tool_search | latest Bifrost `v1.4.12`, `bifrost` route, GPT via `/openai/v1/responses` | original company-knowledge skill | 5/5 user-visible completions, `0/5` runner-perfect | avg `6.8/10` | Best overall answer quality so far; the old runner contract marked all runs failed because GPT switched to subagent-first orchestration instead of direct top-level `glean_search` |
| Atlas Opus 4.6 comparator | latest Bifrost / Anthropic path | original company-knowledge skill | `1/1` runner-perfect | `5/10` | Fastest clean run (`64.0s`) and matched the old runner contract, but the answer quality was lower than the best GPT Bifrost-responses runs because evidence selection was narrower and noisier |
| Final frozen-state Atlas Opus 4.6 | latest Bifrost / Anthropic path | numeric company-knowledge call caps removed | `1/1` runner-perfect | `4/10` | Still naturally stayed on a compact Glean path, so removing the caps did not improve answer quality here |
| Final frozen-state GPT-5.4 Bifrost | latest Bifrost `v1.4.12`, `bifrost` route, GPT via `/openai/v1/responses` | numeric company-knowledge call caps removed | `1/1` completed, `0/1` runner-perfect | `6/10` | Still chose subagents instead of top-level Glean, but produced a usable concise answer |
| Final frozen-state GPT-5.4 direct | direct Portico LLM Proxy Responses path | numeric company-knowledge call caps removed | `0/1` completed | `1/10` | Long tool-call churn followed by the same upstream provider stream failure banner as before |

### Latest Bifrost Baseline Notes

Latest released Bifrost baseline chat IDs:

- `0412f416-cff4-4069-885c-92c207257eaf` -> quality `2/10`
- `9951849f-58cd-4037-a09e-682a495138b4` -> quality `5/10`
- `43c5cea8-1753-4756-baea-e403bf8dcb42` -> quality `3/10`
- `95e70034-a4d8-42d1-b20c-a86cc35a42e8` -> quality `6/10`
- `eebd3ac7-debd-44c4-a587-c3c8d62c81a9` -> quality `7/10`

Pattern:

- Bifrost usually completed cleanly.
- The main weakness was answer quality, not completion. Several chats found
  evidence but still backed off into "I can't safely summarize this" language.
- The best Bifrost answers pulled from `Portico Weekly`, leadership brief, or
  product-update style artifacts and were materially closer to the user prompt.

### Direct Rerun Notes

Direct rerun chat IDs:

- `f18cabec-706d-4bb5-99bb-63739732d4d1` -> completed, quality `6/10`
- `a8866969-a73a-4331-a33d-f938601e7195` -> completed with Google Workspace
  activation detour, quality `6/10`
- `11e341c5-a566-43d3-a87a-297334cf3fd9` -> upstream error, quality `1/10`
- `55ebd3bd-9b83-447e-bd1c-b19f185e2700` -> upstream error, quality `0/10`
- `6f35cd93-5828-4c54-b7c8-3726109d5bc3` -> upstream error, quality `0/10`

Pattern:

- The longer timeout removed the false failure mode from the earlier batch and
  exposed the real issue: direct GPT-5.4 is materially more failure-prone than
  Bifrost on this workload right now.
- `3/5` direct chats ended in a real provider-facing error banner:
  `Upstream model provider stream failed. Please retry.`
- The one strong direct completion (`f18cabec...`) still took 441 seconds,
  issued 10 Glean searches, activated `code-execution`, and spun up a Atlas
  subagent before producing a final answer.
- The other direct completion (`a886...`) reached a usable answer, but only
  after activating Google Workspace and then thrashing through repeated
  `mcp_assistant_get_chat_tools` / `skills_get_activated_skills` calls. I am
  treating that as a warning-level completion issue rather than a hard failure.

### Earlier Guided Bifrost Batch

Before the production-prompt freeze, I also captured one 5-run latest-Bifrost
batch while `company-knowledge/SKILL.md` briefly encouraged broader synthesis
behavior more than the original baseline wording.

Results from that existing batch:

- Route: latest released Bifrost
- Completion: `5/5`
- Average elapsed time: `144.8s`
- Average quality: `5.8/10`

Manual quality scores:

- `755a74f1-8612-4f68-8b93-c30a26d200f2` -> `7/10`
- `87b90174-c285-49f7-870e-ce08ad173bda` -> `3/10`
- `6ce46f3b-d112-4305-b5ce-e93aaa6c5c04` -> `4/10`
- `7d5a34b9-edd6-4fa4-8c56-a0347275b193` -> `8/10`
- `f1cbdec4-b7e0-48c1-b0c7-56787fa05291` -> `7/10`

Important caveat:

- This batch did **not** materially shift the model into a clearly different
  tool strategy.
- Average `glean_search` calls actually stayed slightly higher than the latest
  baseline (`6.8` vs `6.2`).
- Average `glean_chat` use only rose from `0.0` to `0.4` per run, and only
  `2/5` chats called `glean_chat` at all.

Interpretation:

- The guided batch did show a modest answer-quality lift relative to the latest
  Bifrost baseline (`5.8/10` vs `4.6/10`) without hurting completion.
- However, because the model still mostly stayed on the same
  search/overflow-reduction path, this is suggestive evidence rather than proof
  that stronger `glean_chat` encouragement was the causal improvement.
- With production prompts now frozen, this batch is the best available proxy
  for that idea, but it should not be treated as a clean post-freeze A/B.

### Bifrost Responses Deferred-Tool Wave

After upgrading to the latest released Bifrost, I tested whether GPT-5.4 could
keep the newer namespace metadata, deferred-loading tool specs, and
`tool_search` while still routing through Bifrost.

Protocol findings:

- Legacy Bifrost `/v1/chat/completions` still rejects namespaced GPT tools with
  `Invalid value: 'namespace'. Supported values are: 'function' and 'custom'.`
- Bifrost `/openai/v1/responses` now accepts the same GPT namespaced/deferred
  payload shape and streams valid Responses SSE events.
- The bridge logs for the 5-chat final wave consistently showed:
  - `route="responses_api"`
  - `endpoint="bifrost responses"`
  - `namespace_metadata_entries=12`
  - `core_namespace_entries=6`
  - `non_core_namespace_entries=6`
  - `deferred_function_tools=8`
  - `tool_search_enabled=true`
  - clean terminal `response.completed` events

Sanity run before the parallel wave:

- `c297a99f-d4e3-4d34-99b3-733a4ddb9200` -> quality `7/10`

Parallel final-wave chat IDs and manual quality scores:

- `c0caec31-417d-4ffc-b297-c18a87838a8c` -> quality `6/10`
- `31ee7519-0e35-4fa9-b18d-142fe8f242e5` -> quality `7/10`
- `995ac0cd-6017-44f4-a410-ce1888737e1b` -> quality `6/10`
- `9b723a5d-813a-4e09-b8b4-cb9316d43e20` -> quality `7/10`
- `3a8d5c11-a33c-4c6a-9f30-fa1ed7fee248` -> quality `8/10`

Aggregate:

- Completion: `5/5`
- Average elapsed time: `236.5s`
- Average quality: `6.8/10`

Observed behavior shift:

- GPT-5.4 did not behave like the earlier Bifrost baseline. It usually chose
  `subagents_run_subagent` immediately, and in `2/5` runs it first called
  `subagents_list_available_tools` and then launched a subagent.
- Because the existing company-knowledge runner still expects a first-turn
  direct `glean_search`, it recorded all 5 runs as non-perfect even though the
  chats completed and the user-facing answers were materially better than the
  older Bifrost baselines.
- The best run in this batch (`3a8d5c11...`) surfaced an actual
  **Product Updates - Week of March 16, 2026** page and anchored the summary to
  a real current-week artifact, which none of the earlier baseline batches did
  consistently.

Interpretation:

- The latest Bifrost plus GPT Responses path appears to be the strongest
  current compromise: it preserved the newer deferred-loading/tool-search GPT
  architecture, completed all five chats, and materially improved answer
  quality relative to both older Bifrost baselines and the direct path.
- The main downside is orchestration drift, not transport instability. The
  runner's notion of a "perfect" company-knowledge run is now stale for this
  configuration because GPT often prefers delegating the company-knowledge work
  to a subagent instead of doing top-level direct Glean calls itself.

### Atlas Opus 4.6 Comparator

I also ran the same prompt once with `Atlas Opus 4.6` to get a non-GPT
comparison point on the current stack.

Run details:

- Chat ID: `101353e4-9ba6-41ac-a775-d3e2ffbc8344`
- Completion: `perfect=true`
- Elapsed time: `64.0s`
- Manual quality: `5/10`
- Usage:
  - `total_tokens=373218`
  - `cache_read_input_tokens=355987`
  - `cache_write_input_tokens=89079`

Observed behavior:

- Atlas followed the older company-knowledge runner contract almost exactly:
  - `glean_search`
  - `glean_search`
  - compact both overflow payloads with `compact_glean_payload.py`
  - inspect the compact JSON via `agent_vm_vm_read_file_chunk`
- It did not launch subagents, did not drift into other integrations, and
  completed much faster than the GPT Bifrost-responses wave.

Quality comparison:

- Despite the clean runner result, the answer quality was not as strong as the
  best GPT Bifrost-responses answers.
- Atlas surfaced some lower-signal evidence, including an
  **Portico Installation Guide** and team-specific DFR / leadership-sync
  artifacts, which made the summary feel narrower and less representative of
  "what's going on at Portico this week" for a general employee audience.
- By contrast, the best GPT Bifrost-responses runs were slower and used a
  different orchestration strategy, but they were more likely to surface
  current-week artifacts like **Product Updates - Week of March 16, 2026** and
  deliver a better company-level synthesis.

Bottom line:

- Atlas Opus 4.6 is currently a better **harness sanity** model for this
  prompt because it is fast, stable, and still matches the runner's older
  Glean-first expectations.
- GPT-5.4 on the new Bifrost Responses deferred-tool path is currently the
  better **answer-quality** model for this prompt, even though its tool
  strategy now makes the old runner contract under-report success.

### Final Frozen-State Serial Sweep

After removing the numeric company-knowledge retrieval caps from
`skills/company-knowledge/SKILL.md`, I froze the prompt/skill state and ran one
serial chat for each still-relevant variant:

- `Atlas Opus 4.6` on the Anthropic/Bifrost path
- `GPT-5.4` with `GPT_OPENAI_ROUTE_MODE=bifrost`
- `GPT-5.4` with `GPT_OPENAI_ROUTE_MODE=direct`

Runs and quality:

- `2acce143-f5d9-43e8-bdee-491333e3646a` — `Atlas Opus 4.6` — `74.5s` — quality `4/10`
- `a2f930d3-70b1-4a31-a3cd-dfc5b33b1123` — `GPT-5.4` Bifrost Responses — `244.0s` — quality `6/10`
- `db297de2-054a-4422-9fa0-25d003b38cdc` — `GPT-5.4` direct — `356.2s` — quality `1/10`

What changed:

- Atlas did **not** suddenly explode into wide retrieval after the caps were
  removed. It still made exactly two top-level `glean_search` calls, compacted
  both overflow payloads, and read the reduced JSON in small chunks. The
  answer was still noisy and too team-specific, so removing the caps did not
  improve its quality on this prompt.
- GPT-5.4 on Bifrost Responses also did **not** materially change strategy. It
  still skipped top-level `glean_search` and went straight into
  `subagents_run_subagent`, which means the old runner still marked it as
  non-perfect. The final answer was serviceable, but the skill change did not
  unlock a noticeably better orchestration pattern.
- GPT-5.4 direct remained the weakest path. It consumed `426255` total tokens,
  emitted only a short preamble in the stored assistant message, and then
  terminated with `Upstream model provider stream failed. Please retry.` The
  removed call-budget guidance did not fix the direct-path failure mode.

Important caveat:

- One reducer helper message still mentions “follow at most one current
  source-of-truth URL first.” That text came from the compaction script stdout,
  not the frozen `SKILL.md` body. I did not mutate that helper text during this
  sweep because the goal here was to keep the system fixed once the main
  company-knowledge prompt state was finalized.

Interpretation:

- The numeric company-knowledge retrieval caps were **not** the main reason the
  direct GPT path was failing. The direct path still failed in the same general
  way after those caps were removed.
- Those caps also do **not** appear to be the dominant explanation for Atlas's
  or GPT Bifrost's answer quality. Atlas naturally stayed compact anyway, and
  GPT Bifrost still preferred subagent orchestration.
- The strongest current runtime remains GPT-5.4 on Bifrost Responses with
  deferred loading + `tool_search`, and I restored the services to that mode
  after the sweep.

### Current Take

- If the goal is raw completion reliability, the direct GPT route is still the
  weakest option on this workload.
- If the goal is the best currently working GPT-5.4 path, the latest Bifrost
  Responses route with deferred loading + `tool_search` is now the most
  promising configuration I tested: `5/5` completed and `6.8/10` average
  quality.
- The older legacy-Bifrost chat-completions GPT path remains the most
  conservative fallback, but its answer quality lagged the new Bifrost
  Responses wave.
- The remaining issue for the final wave is evaluation drift, not a transport
  bug: the current company-knowledge runner still treats subagent-first GPT
  behavior as a failure even when the final answer is good.
- Atlas Opus 4.6 is a useful control model here: it completed faster and more
  cleanly under the runner's old assumptions, but on this specific prompt its
  answer quality still trailed the best GPT Bifrost-responses results.
- After removing the numeric company-knowledge call caps, the overall ranking
  did not change: GPT-5.4 direct is still the least reliable, Atlas remains a
  useful stable control, and GPT-5.4 on Bifrost Responses is still the most
  promising balance of functionality and answer quality.

## The Problem

When multiple child chats run in parallel — each researching a topic and
reporting back to a parent — the system was failing in four predictable ways:

1. **Token explosion.** Subagents pulled huge documents into context via Glean,
   then re-read the same overflow files across multiple turns. A single
   delegated report could burn through its token budget before synthesizing
   anything.

2. **Scope creep.** Child chats discovered adjacent systems (Slack channels they
   weren't asked about, JIRA projects outside the brief) and started activating
   new integrations, running extra skills, and expanding their own tool surface
   without the parent's knowledge.

3. **Hangs.** Parent chats sat waiting with `done=false` even after their
   children had finished producing content, because the stream never closed
   cleanly or the parent tried to restart retrieval after children returned.

4. **Infrastructure exhaustion.** Parallel sweeps spun up enough Agent VM
   containers to exhaust the Docker network's `/24` address space, causing
   unrelated tool calls (reducers, PDF generation) to fail.

## Design Goals

The optimizations target a specific workflow:

```
1. Retrieve narrowly
2. Reduce aggressively (push large data into files, run compaction scripts)
3. Inspect reduced artifacts only when a named gap remains
4. Synthesize once the requested sections are covered
```

They are not trying to make the model "do less." They are trying to preserve:

- **Evidence quality** — the model still gathers what it needs
- **Deterministic completion under load** — sweeps finish instead of hanging
- **Sublinear token scaling** — doubling the data volume should not double the
  token cost

---

## Historical Summary: Original 14 Optimizations at a Glance

The optimizations fall into three groups based on how they are enforced. This
distinction matters because it tells you how much you can trust each
optimization to actually hold under pressure.

```
                        Can the model ignore it?

              YES                           NO
         +----------+              +------------------+
         | Group 1  |              |    Group 2       |
         | Prompt   |              |    Runtime       |
         | guidance |              |    enforcement   |
         |          |              |                  |
         | 4 items  |              | 8 items          |
         | All      |              | 3 flagged,       |
         | flagged  |              | 5 always-on      |
         +----------+              +------------------+

                        +------------------+
                        |    Group 3       |
                        |    Both layers   |
                        |                  |
                        |    2 items       |
                        |    All flagged   |
                        +------------------+
```

**Totals:** 9 flag-toggleable, 5 always-on. All flags
currently set to `true`.

### Group 1: Prompt-Only Guidance (soft — model can ignore)

These live entirely in skill `SKILL.md` files as `OPT_FLAG` blocks. They are
instructions to the model, not enforcement. If the model decides to ignore
them, nothing stops it. All are toggleable via `optimization_flags.json`.

**How it works:** `skill_manager.py` → `_apply_optimization_flags()` runs a
regex over each SKILL.md body at load time. For each
`<!-- OPT_FLAG:name START -->...<!-- OPT_FLAG:name END -->` block, it calls
`_optimization_flag_enabled(name)`. If the flag is `true`, the inner text is
kept; if `false`, the entire block is stripped. The model never sees removed
text — it is not being asked to ignore it, the instructions simply don't exist
in its prompt.

| # | What it does | Flag | How it works |
|---|---|---|---|
| 1.1 | Tells model to run reducer scripts on large Glean payloads before reasoning | `company_knowledge_compact_glean_overflow_guidance` | Single OPT_FLAG block (~140 lines) wrapping the entire "Handling Large Payloads" section in `company-knowledge/SKILL.md`. Includes compaction command templates, inline extract limits (<2000 chars), chunk read caps (<=8), and reducer-first workflow. This is the largest gated block, and it nests 1.2 inside it. |
| 1.2 | Tells model to use Google Workspace APIs instead of Glean for doc follow-up | `company_knowledge_prefer_google_workspace_doc_reads` | 7 scattered OPT_FLAG blocks across `company-knowledge/SKILL.md`. 4 of the 7 are nested inside the 1.1 block. Covers: Operating Rule 3 (prefer native integrations), Available Tools (mark `glean_read_document` as disabled), Google Workspace escalation ladder (summary-first, budget caps), and 13 hard restrictions on GWS usage. |
| 1.3 | Caps Slack searches, thread reads, and chunk reads for broad summaries | `slack_multi_channel_budget_guidance` | 4 OPT_FLAG blocks in `slack/SKILL.md` covering: search discipline (limit=20, 2/theme, 4 first-pass), thread discipline (3-6 reads, hard cap 12), payload handling (2 chunks/artifact, 6 total), and hard stops (synthesize after 3-5 strong themes). |
| 1.4 | Requires a cheap seed JIRA query before fan-out | `atlassian_seed_query_guidance` | Single OPT_FLAG block (5 lines) in `atlassian-portico/SKILL.md`. Three rules: start with 1 seed query (maxResults<=5), don't parallelize first-pass JQL, prefer `summary ~` over `text ~`. |

### Group 2: Runtime Enforcement (hard — code prevents/forces behavior)

These are in Rust or Python code. The model cannot opt out.

**Flagged (can be turned off):**

| # | What it does | Flag | How it works |
|---|---|---|---|
| 2.1 | Removes `read_document` from Glean's tool list | `disable_glean_read_document_by_default` | `generator.rs` → `disabled_tools()`: if `server_id == "glean"` and flag is true, appends `"read_document"` to the disabled tools list at MCP config generation time. The tool is never exposed to the model. Flag OFF → tool remains available. |
| 2.2 | Injects `code-execution` + `server:agent-vm` into subagent tool lists | `subagent_auto_enable_code_execution` | `middleware.py`: when processing a `run_subagent` tool call, calls `maybe_add_code_execution_to_subagent()` which appends the skill/tool to the call's arguments if missing (max 4 skills). Happens before persistence, so the child starts with local execution. Flag OFF → subagent only gets what the model explicitly requested. |
| 2.3 | Auto-retries transient tool execution failures | `retry_transient_tool_execution_failures` | `middleware.py` → `_get_transient_tool_execution_retry_max_attempts()`: flag ON returns 3 (exponential backoff: 0.5s, 1s, 2s cap); flag OFF returns 1 (no retries). Matches 429, 502, 503, 529, connection errors. |

**Always on (no toggle, change requires code or env var edit):**

| # | What it does | Where enforced | How it works |
|---|---|---|---|
| 2.4 | Tool results >4000 chars spill to overflow files | `middleware.py` + `overflow.rs` | Two parallel implementations (Python + Rust). Both: compare `len(result)` against threshold → write to `/work/.mcp-overflow/` in 32KB chunks via Agent VM → replace result with JSON pointer containing `read_hint`. Both use Redis-based distributed locking for VM creation. Tune via `OPENWEBUI_TOOL_RESULT_OVERFLOW_MAX_CHARS` / `MCP_ORC_TOOL_RESULT_OVERFLOW_MAX_CHARS`. |
| 2.5 | Child chat isn't "done" until it produces actual synthesis text | `subagents_chat.rs` | `message_is_complete()` rejects messages with: `finish_reason` in [length, max_tokens, tool_calls, ...], pending tool calls (checked via `has_pending_tool_calls`), or empty content. `extract_parent_facing_response()` strips tool transcript noise and anchors at first markdown heading. Polling continues until these checks pass or timeout. |
| 2.6 | Retries entire subagent on transient upstream failures | `subagents.rs` + `bifrost-bridge` | Two nested layers: (1) Bifrost bridge retries individual HTTP requests up to 5 times on 429/502/503/504 with exponential backoff (1s base, 5s cap, respects `Retry-After`). (2) If all 5 fail, error propagates to subagent layer which detects it via `is_transient_upstream_model_failure()` pattern matching and retries with a fresh child chat up to 3 times (linear backoff: 750ms x attempt). |
| 2.7 | Agent VMs get shorter lifetimes + dedicated Docker network | `agent_vm_core.rs` + Docker config | `create_vm()` attaches to `CORE_MCP_AGENT_VM_NETWORK` (default `portico-network`). `default_vm_timeout_hours()` reads env (default 4h, capped at 24h). `cleanup_agent_vms_once()` runs every 60s: removes expired VMs (last_activity > timeout), stale metadata (container stopped/missing), and orphaned containers (no Redis metadata). |
| 2.8 | Deduplicates overlapping system prompts | `system_prompt_merge.py` | `merge_model_and_request_system_prompt()`: if identical → keep one; if one contains the other → keep the longer; otherwise → concatenate with `## Request-Specific System Instructions` separator. Pure function, no flags, no external deps. |

### Group 3: Belt and Suspenders (prompt guidance backed by runtime enforcement)

The most robust — the skill text guides the model, and the runtime catches it
if it ignores the guidance. All are toggleable.

| # | What it does | Flag | Prompt layer | Runtime layer |
|---|---|---|---|---|
| 3.1 | Subagents can't activate new integrations | `subagent_integration_activation_restriction` | 2 OPT_FLAG blocks in `company-knowledge/SKILL.md` listing 5 forbidden tools (`skills_activate_skill`, `mcp_assistant_toggle/authorize/activate_integration`, `mcp_assistant_trigger_guided_setup`) | **Three enforcement points:** (A) `subagents.rs` stores `allowed_tool_server_ids` in Redis at spawn. (B) `mcp_assistant.rs` → `delegated_subagent_allowed_tool_server_ids()` reads Redis and rejects unlisted servers with `subagent_scope_locked`. (C) `middleware.py` strips the 5 locked tools from the tool spec before the LLM sees them, and returns `blocked_by_policy` if a call slips through. |

---

## How the Flag System Works

Most optimizations can be toggled without code changes via
[`optimization_flags.json`](../optimization_flags.json).

**Resolution order** (highest priority first):

1. Environment variable: `OWUI_OPT_<FLAG_NAME_IN_UPPERCASE>=true|false`
2. JSON file: `optimization_flags.json` key
3. Default: `true` (unknown flags are treated as enabled)

**How flags gate skill text:**

Skill `.md` files wrap conditional sections in HTML comment blocks:

```
<!-- OPT_FLAG:flag_name START -->
...instructions included only when flag is true...
<!-- OPT_FLAG:flag_name END -->
```

[`skill_manager.py`](../src/managers/skill_manager.py) strips these blocks at
skill-load time. When a flag is `false`, the entire block (delimiters and
content) is removed from the prompt the model sees. This means the model never
receives the instructions — it is not being asked to ignore them.

**Current flags** (all `true` in the checked-in config):

| Flag | Type | Value |
|------|------|-------|
| `disable_glean_read_document_by_default` | bool | `true` |
| `company_knowledge_compact_glean_overflow_guidance` | bool | `true` |
| `company_knowledge_prefer_google_workspace_doc_reads` | bool | `true` |
| `subagent_integration_activation_restriction` | bool | `true` |
| `subagent_auto_enable_code_execution` | bool | `true` |
| `retry_transient_tool_execution_failures` | bool | `true` |
| `atlassian_seed_query_guidance` | bool | `true` |
| `slack_multi_channel_budget_guidance` | bool | `true` |

---

## Detailed Breakdown

### Group 1: Prompt-Only Guidance

#### 1.1 Company Knowledge Compact-First Workflow

> Flag: `company_knowledge_compact_glean_overflow_guidance`

**What it does:** Tells the model to run reducer scripts on large Glean
payloads immediately after retrieval, before reasoning over the content. The
model is instructed to read the reducer's stdout summary first, and only
inspect small reduced artifacts when a specific named fact is still missing.

**Why it exists:** The worst token burn came from the model repeatedly walking
overflow files in tiny chunks. A single reducer pass carries enough signal
for synthesis in most report tasks. The goal is to convert large raw payloads
into short, high-signal local artifacts before the model starts reasoning.

**Files:**

| File | Role |
|------|------|
| `skills/company-knowledge/SKILL.md` | OPT_FLAG block wrapping ~140 lines of "Handling Large Payloads" instructions |
| `skills/company-knowledge/scripts/compact_glean_payload.py` | Reducer: compacts Glean search/activity/read overflow into small JSON + stdout summary. Auto-detects payload type. Limits to 10 items by default. |
| `skills/company-knowledge/scripts/compact_google_workspace_payload.py` | Reducer: walks Google Workspace outline trees, matches sections against keywords, outputs compact JSON |
| `skills/company-knowledge/scripts/extract_markdown_sections.py` | Reducer: extracts keyword-matched sections from plain markdown documents |

**Constraints enforced by the prompt (when enabled):**
- Inline extracts must be under 2,000 characters
- At most 8 `vm_read_file_chunk` calls against compacted artifacts
- Reducer stdout must be read before any file inspection

#### 1.2 Prefer Google Workspace for Specific Documents

> Flag: `company_knowledge_prefer_google_workspace_doc_reads`

**What it does:** When Glean search finds a Google Doc and Google Workspace is
already attached, the model is told to follow up via the narrower Google
Workspace APIs (`google_workspace_extract_document_summary`) instead of
reading the full document body through Glean.

**Why it exists:** The Google Workspace path returns focused summaries and
section-level content. The Glean path returns the entire document body. For
document follow-up after search, the narrow path is almost always sufficient
and dramatically cheaper.

**Files:**

| File | Role |
|------|------|
| `skills/company-knowledge/SKILL.md` | 8 separate OPT_FLAG blocks throughout the file governing the Google Workspace escalation ladder |
| `skills/company-knowledge/scripts/compact_glean_payload.py` | Stdout hints vary based on this flag (recommends Google Workspace vs Glean follow-up) |

**Constraints enforced by the prompt (when enabled):**
- Summary-first for all Google Docs found via Glean (not full content)
- At most 2 summary/content calls for multi-project reports
- At most 1 Google Doc content export on first pass
- No PDFs or slide decks on first pass when a Google Doc exists
- No raw bash/jq extraction against Google Workspace overflow payloads

#### 1.3 Slack Multi-Channel Budget

> Flag: `slack_multi_channel_budget_guidance`

**What it does:** Caps the number of searches, thread reads, history calls,
and artifact chunk reads that the model should use for broad multi-channel
Slack summaries. The skill prefers workspace-wide theme searches first, then
a small number of targeted thread follow-ups.

**Why it exists:** The model tended to explode a "7 channels over 2 weeks"
task into a keyword-times-channel matrix plus excessive thread reads. Slack
results are high volume and low precision when used this way. The better
tradeoff for synthesis is representative evidence, not channel exhaustiveness.

**Files:** `skills/slack/SKILL.md` (4 OPT_FLAG blocks covering search
discipline, thread discipline, payload handling, and hard stops)

**Caps (when enabled):**
- Search `limit=20`, 2 searches per theme, 4 total first-pass searches
- 3-6 thread reads (hard cap of 12 `slack_conversations_replies` total)
- 2 chunk reads per Slack artifact, 6 total `vm_read_file_chunk`
- 0 `slack_conversations_history` calls on first pass
- Stop retrieval once 3-5 strong themes have representative evidence

#### 1.4 Atlassian Seed-Query Guidance

> Flag: `atlassian_seed_query_guidance`

**What it does:** Requires starting any fresh JIRA investigation with a single
cheap seed query (`maxResults <= 5`, minimal fields) before launching broader
fan-out. Prefers `summary ~ "..."` over `text ~ "..."` on first pass.

**Why it exists:** Large fan-out JQL on a cold OAuth/session path is expensive
and fragile. JIRA payloads carry deeply nested structure the model rarely
needs. A seed-first strategy lowers tokens and catches stale auth early.

**Files:** `skills/atlassian-portico/SKILL.md` (single OPT_FLAG block in
"Exploratory Report Discipline")

### Group 2: Runtime Enforcement

#### Flagged (can be turned off)

#### 2.1 Disable Glean `read_document` at Config Generation

> Flag: `disable_glean_read_document_by_default`

**What it does:** The Rust MCP config generator strips `read_document` from
Glean's exposed tool list. The model never sees the tool, so it cannot call
it.

**Why it exists:** `glean_read_document` is the single easiest way for the
model to pull a huge document body into context. In live sweeps it caused
worse token blow-ups than `glean_search` plus reduction. Removing it at
config generation time is the cheapest possible enforcement — zero runtime
cost, zero model temptation.

**How it works:** `generator.rs` → `disabled_tools()` checks if the server is
`"glean"`, reads the flag, and appends `"read_document"` to the disabled list
if true.

**Files:** `generator.rs` (MCP Orchestration layer)

#### 2.2 Auto-Enable Code Execution for Subagents

> Flag: `subagent_auto_enable_code_execution`

**What it does:** When a parent spawns a delegated subagent, middleware
automatically adds `code-execution` skill and `server:agent-vm` to the
child's tool list if they are missing. This happens before the tool call is
persisted, so the child starts with a local execution path.

**Why it exists:** A recurring waste pattern: a research subagent receives
large payloads but has no local execution path to compact them, so it
re-reads raw MCP overflow files in the model loop instead. Auto-attaching
code execution makes file-based reduction the default.

**How it works:** `middleware.py` calls
`subagent_tooling.maybe_add_code_execution_to_subagent()` which injects
the skill/tool if the subagent has fewer than 4 skills.

**Files:** `middleware.py`, `subagent_tooling.py` (LLM Routing / Agent
VM layers)

#### 2.3 Transient Tool Execution Retries

> Flag: `retry_transient_tool_execution_failures`

**What it does:** External and MCP-backed tool calls that fail with retryable
transport or upstream errors (429, 502, 503, 529, connection errors) are
automatically retried with exponential backoff.

**Why it exists:** The worst recent sweep failures were not bad plans — they
were brief upstream 500s or disconnects while the model was otherwise on the
right path. Retrying at the tool execution layer prevents a transient
infrastructure blip from killing an otherwise-good subagent run.

**How it works:** `middleware.py` → `_is_retryable_tool_execution_error()`
identifies transient errors. When the flag is off, max attempts is set to 1
(effectively disabled).

**Files:** `middleware.py` (LLM Routing layer),
`tests/test_middleware_stream_recovery.py`

#### Always On (no toggle — requires code or env var changes)

#### 2.4 Overflow Threshold (4,000 chars)

**What it does:** Tool results exceeding the threshold are written to an
overflow file in the chat's Agent VM. The original result is replaced with a
compact JSON pointer containing a `read_hint` that instructs the model to use
`vm_read_file_chunk` or tiny `jq` slices and keep inline extracts under 2,000
characters.

**Why it exists:** The previous threshold (50k chars) allowed massive "still
inline" payloads to replay across every subsequent turn. The replay cost was
often worse than the original tool call. Spilling earlier forces reducers and
local file inspection as the default path.

**How it works:** Two parallel implementations — Python (`middleware.py` →
`_maybe_spill_large_tool_result()`) and Rust (`overflow.rs` →
`maybe_spill_large_tool_response()`). Both use Redis-based distributed
locking for Agent VM creation. Files are written in 32KB chunks to
`/work/.mcp-overflow/`.

**Env vars to tune:**
- `OPENWEBUI_TOOL_RESULT_OVERFLOW_MAX_CHARS` (Python path, default 4000)
- `MCP_ORC_TOOL_RESULT_OVERFLOW_MAX_CHARS` / `MCP_TOOL_RESULT_MAX_CHARS` (Rust path, default 4000)

**Files:** `middleware.py` (LLM Routing layer), `overflow.rs` (MCP
Orchestration layer)

#### 2.5 Child Completion Requires Real Synthesis

**What it does:** A child chat is not considered "done" until it has produced
an actual assistant text message — not just a tool call block. The Rust
subagents server rejects messages with `finish_reason=tool_calls`, pending
tool calls, or empty content.

**Why it exists:** GPT child chats in particular would sometimes return to the
parent right after the first tool call block, before generating any report
text. This produced zero-text child summaries, missing PDFs, and parent
follow-up confusion.

**How it works:** `subagents_chat.rs` → `message_is_complete()` checks
`finish_reason`, `stop_reason`, pending tool calls via
`has_pending_tool_calls()`, and content emptiness. `extract_parent_facing_response()`
additionally strips tool transcript noise (patterns like `to=functions.`,
`tool_call_id=`, `"vm_id":`) and anchors the response at the first markdown
heading or "Executive summary" marker.

**Files:** `subagents_chat.rs`, `subagents_chat_tests.rs` (Agent Skills layer)

#### 2.6 Transient Subagent Retry

**What it does:** Two retry layers for upstream model failures:

| Layer | Location | Max Attempts | Backoff | Scope |
|-------|----------|-------------|---------|-------|
| Subagent orchestration | `subagents.rs` | 3 | Linear: 750ms x attempt | Creates a fresh child chat per retry |
| LLM proxy | `bifrost-bridge-rust/src/main.rs` | 5 | Exponential: 1s base, 5s cap. Respects `Retry-After` header | Per-request retry at the proxy layer |

**Why it exists:** Hard subagent failures were unacceptable for parallel
delegated work. These errors were almost always transient network/provider
stream issues, not real task failures. Retrying at the right layer improved
reliability without changing prompt behavior.

**Retryable errors:** 429, 502, 503, 504, transport/DNS failures.

**Files:** `subagents.rs` (Agent Skills layer), `bifrost-bridge-rust/src/main.rs`
(LLM Routing layer)

#### 2.7 Agent VM Shorter Lifetime and Dedicated Network

**What it does:** Agent VMs created for overflow get shorter default lifetimes.
All Agent VM traffic is routed through a dedicated Docker network with a larger
address pool. A cleanup sweep runs every 60 seconds to remove expired, stale,
and orphaned VMs.

**Why it exists:** Parallel sweeps were exhausting the old shared `/24` Docker
network (254 usable addresses). Agent VMs were living longer than necessary for
report-generation workloads. This is primarily a stability optimization, but it
also prevents token-saving reducers and PDF generation from failing because
Docker ran out of IPs.

**How it works:** `agent_vm_core.rs` → `create_vm()` attaches to the
configured Docker network. `cleanup_agent_vms_once()` sweeps for containers
whose `last_activity` exceeds their `timeout_hours`. Redis metadata keys have
a TTL of `(timeout_hours + 1) * 3600s`.

**Env vars to tune:**
- `CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS` (default 4h)
- `CORE_MCP_AGENT_VM_NETWORK` (Docker network name)
- `OWUI_OVERFLOW_AGENT_VM_TIMEOUT_HOURS` (overflow-specific override)

**Files:** `agent_vm_core.rs` (Agent VM layer), `docker-compose.yml`,
`mcp-orc-cli generate-docker-compose-override` (Docker Orchestration layer)

#### 2.8 System Prompt Merge

**What it does:** Deduplicates overlapping model-level and request-level system
prompts. If they are identical or one contains the other, keeps the longer one.
Otherwise concatenates with a `## Request-Specific System Instructions`
separator.

**Why it exists:** Duplicate system instructions waste tokens and can make the
model over-interpret repeated guardrails. A cleaner merged prompt keeps the
strongest instruction set intact.

**How it works:** `system_prompt_merge.py` →
`merge_model_and_request_system_prompt()` — a pure function with no flag
dependencies and no external calls.

**Files:** `system_prompt_merge.py` (LLM Routing layer)

---

### Group 3: Belt and Suspenders

#### 3.1 Subagent Integration Activation Restriction

> Flag: `subagent_integration_activation_restriction`

**What it does:** Prevents delegated subagents from activating new
integrations, skills, or MCP servers that the parent did not include in the
original delegation.

**Prompt layer:** `company-knowledge/SKILL.md` tells the model not to call
`skills_activate_skill`, `mcp_assistant_toggle_integration`,
`mcp_assistant_authorize_integration`, `mcp_assistant_activate_integration`,
or `mcp_assistant_trigger_guided_setup`. If a Google Doc link appears in Glean
results and Google Workspace is not attached, the subagent must cite the
document and continue with compact Glean evidence.

**Runtime layer:** When a parent spawns a subagent, `subagents.rs` stores
`allowed_tool_server_ids` and `explicit_skill_ids` in Redis under
`subagent_chat:{chat_id}`. When the subagent tries to activate a new
integration, `mcp_assistant.rs` reads the Redis key, checks the requested
server against the allowed set, and rejects unlisted servers with:

```json
{
  "readiness_phase": "subagent_scope_locked",
  "error": "delegated_subagent_scope_locked",
  "message": "Delegated subagent tool surface is fixed by the parent task."
}
```

**Why it exists:** A large source of token waste was subagents discovering
adjacent systems and expanding into extra skills and integrations the parent
never asked for. This also caused startup churn and OAuth noise inside
subagent flows.

**Files (5 files, 3 languages):**

| File | Language | Role |
|------|----------|------|
| `skills/company-knowledge/SKILL.md` | Markdown | Prompt guidance (2 OPT_FLAG blocks) |
| `unified_context.py` | Python | Context filtering |
| `subagents.rs` | Rust | Stores allowed tool scope in Redis at spawn |
| `mcp_assistant.rs` | Rust | Enforces scope lock at integration activation time |
| `middleware.py` | Python | Flag check and delegation metadata |

## Operational Notes

### Where to tune behavior

| What | How |
|------|-----|
| Skill-level behavior (Groups 1 and 3 prompt layer) | [`optimization_flags.json`](../optimization_flags.json) |
| Any flag via environment | `OWUI_OPT_<FLAG_NAME_IN_UPPERCASE>=true\|false` |
| Overflow threshold (Python path) | `OPENWEBUI_TOOL_RESULT_OVERFLOW_MAX_CHARS` |
| Overflow threshold (Rust path) | `MCP_ORC_TOOL_RESULT_OVERFLOW_MAX_CHARS` |
| Overflow VM lifetime | `OWUI_OVERFLOW_AGENT_VM_TIMEOUT_HOURS` |
| Agent VM default timeout | `CORE_MCP_AGENT_VM_DEFAULT_TIMEOUT_HOURS` |
| Agent VM Docker network | `CORE_MCP_AGENT_VM_NETWORK` |
| Bifrost Bridge upstream retry attempts | `BIFROST_BRIDGE_UPSTREAM_RETRY_MAX_ATTEMPTS` |
| Bifrost Bridge upstream retry delays | `BIFROST_BRIDGE_UPSTREAM_RETRY_BASE_DELAY_MS` / `BIFROST_BRIDGE_UPSTREAM_RETRY_MAX_DELAY_MS` |
| Chat completion transient retry attempts | `OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS` |

### Architecture layers touched

| Layer | Optimizations |
|-------|---------------|
| Agent Skills | 1.1-1.4, 2.2, 2.5, 2.6, 3.1 |
| LLM Routing | 2.3, 2.4, 2.6, 2.8 |
| MCP Orchestration | 2.1, 2.4, 3.1 |
| Agent VM / Code Execution | 2.2, 2.4, 2.7 |
| Docker Orchestration | 2.7 |

### If something breaks

- **Subagent producing empty results?** Check 2.5 (child completion logic in
  `subagents_chat.rs`) and 2.6 (transient retry in `subagents.rs`).

- **Parent not synthesizing after children return?** Check 2.5 (child
  completion logic in `subagents_chat.rs`). If the parent keeps retrieving,
  inspect the delegated prompt and tool sequence rather than looking for an
  automatic synthesis lock.

- **Tool calls failing on overflow files?** Check 2.4 (overflow threshold) and
  the relevant skill guidance. Failures now surface directly instead of being
  converted into synthetic success guidance.

- **Sweep hanging?** Check 2.5 (child completion requires real synthesis) and
  2.6 (transient retry). If children are retrying endlessly, check upstream
  provider health.

- **Docker network exhaustion?** Check 2.7. Verify `CORE_MCP_AGENT_VM_NETWORK`
  points to a network with a large enough address pool. Verify the cleanup
  sweep is running (check logs for `cleanup_agent_vms_once`).
