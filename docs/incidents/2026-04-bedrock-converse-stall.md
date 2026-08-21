# Bedrock Converse Stream Stalls (April 2026)

**Layers affected:** LLM Routing (Rust bridge `/bedrock/converse` reader, retry policy, idle budgets), MCP Orchestration / Health Check (chat-completion path), and the upstream LLM Proxy infrastructure (`llm-proxy`, Service Mesh, sandbox-domain nginx).

**Status:** Local-side hardening landed (bridge incomplete-stream classifier, idle/total stream timeouts, route migration). Several upstream-side asks tracked in [Corrective actions](#corrective-actions) below.

## Symptom

Across five chats over April 17–19, 2026, the same failure class surfaced on Bedrock Converse streaming follow-up turns against `us.anthropic.atlas-opus-4-7`. User-visible behaviour ranged across:

- A finished assistant message with a terminal error after several minutes of silence.
- A 10-minute spinner followed by full successful completion (after a transparent retry).
- A finished message containing a synthesized `incomplete_stream` error.

In every case the underlying upstream stream had gone silent — no body bytes — for hundreds of seconds before the failure, while the bridge had no signal that anything was wrong.

## Root cause

A defect class shared across the LLM Proxy + bridge path: long-lived Bedrock Converse streams can sit silent for many minutes without anyone bounding, heartbeating, or classifying that silence. The five observed manifestations are:

| Manifestation | Mechanism |
|---|---|
| Chunked-body EOF on an active stream | Upstream stream went silent for ~600 s; an `llm-proxy` pod was terminated by either rollout or Karpenter underutilization-eviction during that silence; the chunked response was severed mid-frame and `reqwest` surfaced `error decoding response body` / `unexpected EOF during chunk size line`. |
| 10-minute "thinking" then recovery | Sandbox-domain nginx held attempt 1 for the full 600-s ingress timeout, returned a stock `504 Gateway Time-out`, the bridge retried, and attempt 2 succeeded in ~1.7 s. |
| Slow first-byte but ultimately fine | LLM Proxy / Bedrock took ~377 s to return response headers and first body bytes; the stream then completed normally and the chat finished. |
| Empty successful stream | LLM Proxy returned `200 OK` `text/event-stream` with `Content-Length: 0` after ~364 s, then EOF without any body chunks, usage, or `message_stop`. |

Contributing system properties:

- The Rust bridge intentionally has **no pre-header request timeout** for streaming Bedrock Converse calls (`request_timeout_seconds = (!is_stream).then_some(...)`).
- The bridge's post-progress idle budget for Bedrock Converse was `900 s` — long enough that a silent stream could overlap an upstream rollout / eviction window.
- `llm-proxy`'s Bedrock Converse path emits SSE response headers only after `await client.send(ConverseStreamCommand)` returns, so a slow stream-setup blocks the whole pre-header window. There is no per-stream no-chunk watchdog or heartbeat once the stream is open.
- LLM Proxy Service Mesh and nginx ingress are configured with 600-s timeouts; sandbox-domain access (`https://llm-proxy.sandbox.example.invalid`) is the experimental-tier fleet domain and is explicitly discouraged for chat-style clients.
- `llm-proxy` does not propagate a proxy request ID or Bedrock `response.$metadata.requestId` back to callers, so request-level attribution after the fact is blocked.

It is **not** a Chat-UI / Open WebUI frontend bug, a Bifrost orchestration bug, or a bridge SSE-parser bug — those layers reported the upstream symptom faithfully.

## Local-side fixes already shipped

- **Incomplete-stream hardening in the bridge.** A successful-but-empty `text/event-stream` response (no body chunks, no `message_stop`) is now synthesized into a terminal `incomplete_stream` error. Open WebUI persists the assistant message as `done=true` with the error rather than spinning forever.
- **Bridge-side stream timeouts.** `BIFROST_BRIDGE_STREAM_IDLE_TIMEOUT_SECONDS=90` is now the runtime default, with a configurable total stream timeout, so the bridge no longer waits 900 s after upstream progress has stopped.
- **LLM Proxy route migration.** `LLM_PROXY_BASE_URL` was moved from the experimental-tier sandbox domain (`https://llm-proxy.sandbox.example.invalid`) to the standard-tier sandbox domain (`https://llm-proxy-standard.sandbox.example.invalid`), in line with company guidance for non-mesh clients.
- **Cleanly retryable upstream 504.** When the upstream domain/nginx path returns `504 Gateway Time-out`, the bridge already classifies it as retryable, which produced the silent-recovery behaviour in the second incident.

## Corrective actions (upstream / infrastructure)

### Must-fix in `llm-proxy`

1. **Stream-setup timeout for Converse.** Bound `await client.send(ConverseStreamCommand)` for streaming requests and return a retryable timeout *before* nginx reaches 600 s.
2. **Per-stream progress watchdog.** Abort the AWS stream and return an explicit timeout/error when no upstream chunk arrives for a bounded interval after the first byte.
3. **Request correlation.** Surface a proxy request ID and Bedrock `response.$metadata.requestId` as response headers; record them in bridge logs and error artifacts.
4. **Stream-lifecycle telemetry.** Log/metric stream-received, provider-dispatch-start, provider-stream-setup-complete, headers-sent, first-chunk, last-chunk-age, completion, abort, provider request ID, model, pod, deployment-group, and route.

### Strongly recommended

- SSE heartbeat comments (or equivalent progress events) during long model-silent phases.
- Drain semantics that either preserve long-lived streams across rollout / eviction or proactively close them with a retryable error rather than mid-frame TCP severance.
- Distinguish model-side extended-reasoning silence from a dead provider stream via a proxy metric such as `seconds_since_last_provider_chunk`.
- For high-volume tool-orchestration chats, trim always-on tool lists, lower follow-up `max_tokens`, or split artifact-generation flows to reduce per-call blast radius.

## Why request-level attribution remains incomplete

Across all five incidents:

- No Bedrock provider request ID was returned by `llm-proxy`, so the AWS-side timeline cannot be reconstructed exactly.
- Datadog showed elevated aggregate latency for `modelid:us.anthropic.atlas-opus-4-7` in `us-east-1` during the window (bins above 100 s, max around 160 s) and non-zero Bedrock invocation server errors; this corroborates provider/model latency stress but does not prove per-request causation.
- For two of the five terminations, the exact `llm-proxy` pod that served the failing attempt could not be identified.

These gaps are addressed by the "request correlation" and "stream-lifecycle telemetry" items above.
