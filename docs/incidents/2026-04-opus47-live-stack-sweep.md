# Opus 4.7 Live Stack Sweep Report - 2026-04-18

## Executive Summary

We ran the EJS/EJG live-stack stress prompt against the local Open WebUI stack with Atlas Opus 4.7 as the parent model and Atlas Opus 4.7 as the spawned subagent model. The sweep varied matching parent and subagent reasoning effort across `low`, `medium`, `high`, and `max`.

The completed dataset contains 69 parent chats:

- 60 runs from three complete 20-run sweeps: the original sweep plus two full repeats.
- 9 additional completed runs from the third repeat before the user stopped the campaign.
- 50 of 69 runs passed the harness validation.
- 19 of 69 runs failed validation or timed out.
- The exact original transport symptom, `error decoding response body` / `error reading a body from connection`, was not reproduced in the captured harness failures.
- One run did produce `Upstream model provider stream failed. Please retry.`, and two runs hit the harness completion timeout.
- No observed container restarts occurred for `portico-open-webui`, `mcpo`, `mcpo-group-core`, or `llm-gateway`.

The strongest signal is effort-correlated instability. `low` had the best success rate and shortest latency. `max` had the worst success rate, worst latency, over-delegation, wrong model/effort drift, and long-tail completion behavior.

## Data sources

The sweep produced three full 20-run sweeps plus a partial third repeat (stopped by the operator while a `medium` run was in flight). Aggregate counts in this report exclude in-flight runs from the partial sweep; only completed `run_finished` records contribute to the totals.

## Aggregate Results

| Effort | Runs | Passes | Failures | Pass Rate | P50 Seconds | Min Seconds | Max Seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `low` | 20 | 18 | 2 | 90.0% | 300.6 | 236.9 | 849.5 |
| `medium` | 19 | 15 | 4 | 78.9% | 393.5 | 300.2 | 2401.8 |
| `high` | 15 | 10 | 5 | 66.7% | 496.2 | 313.8 | 986.3 |
| `max` | 15 | 7 | 8 | 46.7% | 876.8 | 541.2 | 2401.7 |
| Total | 69 | 50 | 19 | 72.5% | n/a | 236.9 | 2401.8 |

## Sweep breakdown

| Sweep | Completed Runs | Passes | Failures | Notes |
| --- | ---: | ---: | ---: | --- |
| Original | 20 | 15 | 5 | First full baseline sweep. |
| Repeat 1 | 20 | 15 | 5 | Reproduced high-effort tool fragility and max over-delegation. |
| Repeat 2 | 20 | 14 | 6 | Included one upstream stream failure and one max timeout. |
| Repeat 3 (partial) | 9 | 6 | 3 | Stopped while `medium` run 5 was active. Included one medium timeout and one Atlassian 504. |

## Failure Taxonomy

| Failure Class | Count | Representative Symptoms |
| --- | ---: | --- |
| Child agent tool failure | 3 | `agent_vm_bash` or related VM tool failed with non-zero exit. |
| JQ / JSON shape error | 3 | Child agent assumed the wrong JIRA or Slack JSON shape, for example indexing a string or array as an object. |
| Malformed or truncated tool call | 2 | Tool call missing `vm_id`, with error text indicating generation may have ended mid-tool-call. |
| MCP tool timeout / 504 | 1 | Atlassian JIRA search returned `HTTP error 504`, `tool call exceeded configured timeout (60s)`. |
| Other validation failure | 1 | Child chats returned 0-character responses. |
| Parent completion timeout | 2 | Harness timed out waiting for completion at about 2400s. |
| Parent subagent/model/effort drift | 3 | Parent spawned too many subagents, used wrong model, or used wrong subagent reasoning effort. |
| Unsupported skill script arguments | 3 | Child agent hallucinated unsupported flags for helper scripts. |
| Upstream stream failure | 1 | Parent response reported `Upstream model provider stream failed. Please retry.` |

Most failures were not transport-level bridge failures. They were agentic workflow failures: bad tool arguments, incorrect JSON assumptions, malformed tool calls, extra subagents, or wrong child model/effort.

## Notable failure cases

| Effort | Elapsed | Class | Summary |
| --- | ---: | --- | --- |
| `low` | 849.5 s | Upstream stream failure | Harness saw `Upstream model provider stream failed. Please retry.` |
| `max` | 2401.7 s | Parent completion timeout | Harness timed out waiting for completion. |
| `medium` | 2401.8 s | Parent completion timeout | Harness timed out waiting for completion in the partial third repeat. |
| `medium` | 397.0 s | MCP tool timeout / 504 | Child JIRA search hit Atlassian MCP 60-s timeout. |
| `max` | 950.1 s | Parent subagent drift | Expected 3 subagents, saw 9; extra subagents used `high` instead of `max`. |
| `max` | 981.6 s | Parent subagent drift | Expected 3 subagents, saw 9. |
| `max` | 991.8 s | Parent model/effort drift | Expected 3 subagents, saw 4; extra subagent used `Atlas Haiku 4.5` and `low`. |

## Observability Notes

Bifrost and the Rust bridge now emit enough correlation fields to follow a request through the bridge layers:

- `chat_id`
- `message_id`
- `session_id`
- `debug_request_id`
- `upstream_request_id`
- `request_phase`
- `followup_index`
- provider model and route
- `output_config_effort`
- upstream response headers and first body chunk timing

For the single upstream stream failure, bridge logs showed the request was routed as `Atlas Opus 4.7` against `us.anthropic.atlas-opus-4-7`, the initial upstream response returned `200 OK`, and the bridge observed response headers and the first body chunk before the stream failed later in the workflow. So this was not a no-header / no-first-byte failure on the first parent request — it appeared after streaming had already been established at least once for that chat.

For the two harness timeouts, the failure mode is less definitive. The harness stopped waiting at roughly 2400 s. These should be treated as completion-state stalls until we inspect the exact chat state and final stream state at timeout time.

For the Atlassian 504, the failure was a downstream MCP / tool timeout rather than an LLM-proxy or Bifrost transport failure. `mcpo` logs around that window also show a short `mcp-atlassian` availability blip followed by cache invalidation and restart handling.

## Interpretation

The original suspected body-read failure was not reproduced as the dominant failure mode in this campaign. Across 69 completed runs, the dominant pattern is agentic workflow instability under large tool surfaces and higher reasoning effort.

The highest-confidence findings are:

- `max` effort is unsafe for this workflow today. It had a 46.7% pass rate, much worse tail latency, and repeated instruction drift.
- `low` effort was the most reliable, with 18/20 passes and a 300.6s median.
- `medium` is not immune to stalls. It had one 2401.8s timeout in the partial third repeat.
- Tool/schema robustness is a major issue. The agents repeatedly guessed helper-script flags or JSON structures instead of using the actual contract.
- Over-delegation is real and repeated. The parent spawned 9 subagents in two max runs and 4 subagents with the wrong model/effort in another max run.
- A single upstream stream failure occurred, but it was isolated in this dataset and did not match the earlier exact body-read string.

## Recommendations

1. Do not use `max` effort for parent orchestration of subagent fan-out until over-delegation and tool-call truncation are fixed.
2. Add hard server-side validation for the subagent tool: enforce the requested child model, child reasoning effort, and maximum number of subagents for prompts that request an exact count.
3. Make helper scripts more tolerant or more discoverable. Either add aliases for common hallucinated flags such as `--max-matches`, `--snippet-chars`, `--max-section-chars`, and `--channel`, or make the skill docs force `--help` before use.
4. Add normalized compactors for JIRA and Slack data so agents do not hand-roll brittle `jq` expressions against variable output shapes.
5. For harness timeouts, capture a timeout bundle automatically: parent chat state, active tool calls, child chat states, last stream event timestamp, `done` flag, and bridge correlation IDs.
6. Surface bridge correlation IDs in the harness result JSON so each failed run can be looked up in Datadog by `chat_id`, `message_id`, `debug_request_id`, and `upstream_request_id`.
7. Investigate the isolated upstream stream failure with the captured bridge correlation IDs.

## Bottom Line

The live stack did show real reliability issues, but the main observed root cause in this run set is not the earlier body-read transport failure. The primary issue is that large-tool, multi-agent Opus 4.7 workflows become increasingly fragile as reasoning effort increases, especially at `max`, where the parent and child agents drift from exact instructions, emit invalid tool calls, and occasionally run into completion-scale stalls.
