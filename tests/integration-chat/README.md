# Tier-2 Headless Real-Chat Integration Repro Suite

Reproduces the confirmed LLM-routing defects (PORTICO-402/403 suite; prod chat
`c0127a20`, fixtures at `tests/fixtures/steer-seam-c0127a20/`) against the
REAL patched stack — Open WebUI (patched backend) → bifrost-bridge gateway →
Bedrock Converse — with only the model swapped for a scripted mock. Everything
below the model is real: background-task chat dispatch, the server-side tool
loop, direct OpenAPI tool execution, redis pending-steer state, steer
promotion/DB persistence, the OpenAI→Anthropic→Bedrock translation.

Architecture layers exercised: **LLM Routing** (middleware follow-up rebuild,
bridge translation), **State & Persistence** (chat history + redis
pending-work), **MCP Orchestration** (direct tool_servers execution path).

## Hard safety

Everything runs in the isolated compose project **`portico-integration`** with its
own named volumes and offset host ports (28080 OWUI, 29700 mock control,
24000 gateway). It never touches the developer stack, its containers, or the
dev `open-webui-data` volume. The OWUI backend patches are applied at boot
from a **git-HEAD snapshot** (`.runtime/patches`, generated per run), so the
concurrently edited working tree is never mounted.

## Run

```bash
# Expectation mode: exit 0 iff every scenario matches its EXPECTED status
# (expected-red observed red counts as a match). This is what
# `make chat-repro-integration` runs.
node tests/integration-chat/run.mjs

# Strict baseline-evidence mode: red scenarios are hard failures. Exit 0 only
# when EVERYTHING is green (i.e. after the fixes land). Use for the dated
# red/green evidence artifacts.
portico_REPRO_STRICT=1 node tests/integration-chat/run.mjs \
  --report tests/repro-artifacts/<date>-baseline
```

Env knobs:

| Var | Default | Meaning |
| --- | --- | --- |
| `portico_INT_IMAGE_TAG` | `repro-baseline` | Tag for `portico-open-webui` + `portico-bifrost-bridge` images. Point at freshly built tags for the post-fix green run. |
| `portico_REPRO_STRICT` | unset | `1` = red scenarios exit 1 (baseline evidence mode). |
| `portico_INT_PATCHES_SRC` | `git:HEAD` | Backend patch snapshot source: `git:HEAD`, `worktree` (copies the live tree — beware concurrent edits), or a path to a prepared snapshot dir. |
| `portico_INT_KEEP_STACK` | unset | `1` = skip `compose down -v` for debugging. Tear down manually with `docker compose -p portico-integration -f tests/integration-chat/docker-compose.yml down -v`. |

Artifacts land in `--report` (default `tests/integration-chat/artifacts/latest/`):
`report.json`, per-scenario outcome JSONs, per-scenario **full
`/bedrock/converse` request payload dumps** (the primary assertion surface),
and `stack.log`.

## Scenarios and what each proves

| Scenario | Expected (baseline) | Proves |
| --- | --- | --- |
| `S-0-smoke-end-turn` | green | Harness sanity: one scripted `end_turn` completion flows OWUI→gateway→mock and the reply persists to the chat. Any failure here is an ERROR, never a "red". |
| `B-I1-steer-seam` | **red** | Defect B: a steer consumed mid tool-loop (`promote_consumed_steer_to_live_turn`, middleware.py:12043) persists the pre-steer turn + steer to the DB but resets in-memory `content_blocks` (12227-12235); the next follow-up is rebuilt from the frozen request base (15222-15237). Signature: message count drops round-over-round (6→3 here; 224→106 in prod), the steer user message and ALL pre-steer toolUse/toolResult pairs vanish from post-steer payloads, while the chat DB keeps exactly one promoted steer turn (rollover itself is correct). |
| `B-I2-stream-continue-steer` | **red** | Defect B on the `stream_continue`/length seam: a `max_tokens` stop plus steer at the continue seam shows the same reset+frozen-base loss on the following round. |
| `B-I3-true-stop-then-new-completion` | green | Control: a true stop (`POST /api/tasks/stop/{task_id}`) is clean — stop is acknowledged, NO further `/bedrock/converse` request fires for the stopped turn (4s silence window), and a new completion carries the interrupted turn + correction. Distinguishes the steer seam-loss from ordinary cancellation. |
| `A-I1-thinking-echo` | **red** | Defect A: the model emits thinking+signature every tool round, but follow-up requests reaching Bedrock contain ZERO `reasoningContent` blocks — the replay converter strips reasoning (`strip_reasoning_blocks` in `convert_content_blocks_to_messages`) and OWUI→bridge replay is text+tool_calls only. Assertion: each prior tool turn must carry a byte-equal signature `reasoningContent.reasoningText` positioned before its `toolUse`. Baseline echoes 0/1, 0/2, 0/3. |
| `C-I1-webtools-truncation` | **red** | Defect C: a 24KB result from a server registered as id `web-tools` (via the real admin `POST /api/v1/configs/tool_servers` path) is compacted to a `{"truncated_tool_result":true,...}` ~4KB preview on follow-up replay because `_tool_result_overflow_exempt_for_metadata` (middleware.py:5711-5725) explicitly refuses to exempt `web-tools`. Assertion: the follow-up must carry the end-of-payload marker and no truncation marker. |

Invariants are classified `defect` vs `harness`: a scenario is only **red**
when its defect invariants fail while ALL harness invariants (loop completed,
expected request count, tools actually executed, steer actually consumed,
no OWUI/gateway 5xx, no mock overrun) hold. Harness failures are reported as
`error` and never satisfy an expected-red — the red must be the right red.

## How it works

- **`mock-bedrock/server.mjs`** — zero-dep node server. `POST /bedrock/converse`
  pops the next scripted model turn and streams Bedrock Converse SSE chunks in
  the exact shapes `translate_bedrock_stream_chunk` (converse.rs) parses.
  Records every request payload per scenario. Also serves the mock OpenAPI
  tool server (`/mocktools/openapi.json` + `POST /mocktools/<op>`, including
  the 24KB `mock_bigfetch` payload). Turns can be **gated**: the stream holds
  open before `messageStop` until `POST /control/release`, which makes steer
  and stop timing fully deterministic (no sleeps racing the loop).
- **`docker-compose.yml`** — open-webui + llm-gateway (pinned images), a
  private redis, and the mock. Minimal env derived from the root compose with
  `LLM_PROXY_BASE_URL=http://mock-bedrock:9700`,
  `OPENAI_API_BASE_URL=http://llm-gateway:4000/v1`,
  `CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES=8`, title/tags/follow-up generation
  disabled (keeps auxiliary task-model calls out of the scripted request log).
  Throwaway secrets are generated per run under `.runtime/secrets/`.
- **`driver/api.mjs`** — headless OWUI client. First-signup admin auth; chats
  created with the Chat.svelte persistence shape (history map with
  parent/children links + `currentId` + flat `messages`) — required for steer
  promotion to verify its branch insert; completions dispatched exactly like
  the frontend (`session_id`+`chat_id`+`id` → background task; the endpoint
  returns `{status, task_id}` and the tool loop runs server-side, so the
  driver polls the mock request log + `GET /api/v1/chats/{id}/status` instead
  of consuming SSE — no socket.io client needed).
- **`scenarios.mjs`** — scenario scripts, gate hooks (steer PUT via the real
  `PUT /api/v1/chats/{id}/pending-steer` route, stop via
  `POST /api/tasks/stop/{task_id}`), and the invariant evaluation over the
  Bedrock request log.

## Baseline result (2026-08-06, images `repro-baseline`, patches git:HEAD)

```
SCENARIO                            EXPECTED  OBSERVED  MATCH
S-0-smoke-end-turn                  green     green     yes
B-I1-steer-seam                     red       red       yes   (6->3 msg drop; steer + pre-steer pairs lost)
B-I2-stream-continue-steer          red       red       yes   (5->3 msg drop after continue seam)
B-I3-true-stop-then-new-completion  green     green     yes
A-I1-thinking-echo                  red       red       yes   (0/1, 0/2, 0/3 signatures echoed)
C-I1-webtools-truncation            red       red       yes   (24KB -> 4116-char truncated_tool_result)
```

Evidence artifact: `tests/repro-artifacts/2026-08-06-head-baseline/`.
