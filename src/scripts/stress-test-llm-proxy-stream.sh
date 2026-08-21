#!/usr/bin/env bash
# stress-test-llm-proxy-stream.sh
#
# Bypass the ai-chat stack (Bifrost bridge/OWUI) and hit llm-proxy directly
# to isolate abrupt stream termination: is it llm-proxy or ai-chat?
#
# ⚠ DO NOT EDIT THIS SCRIPT WHILE IT IS RUNNING. Bash reads scripts from disk
#   by byte offset, not by line. Any in-place edit shifts subsequent offsets and
#   the running shell will land mid-token, producing baffling errors like
#   "syntax error near unexpected token `do`" at lines that look syntactically
#   fine. Stop the run first (Ctrl-C), edit the file, then start a new run.
#
# Usage:
#   ./src/scripts/stress-test-llm-proxy-stream.sh [OPTIONS]
#
# Options:
#   --model MODEL          Model to test (default: atlas-opus-5)
#   --concurrency N        Parallel requests per wave (default: 5)
#   --iterations N         Number of waves (default: 20)
#   --max-tokens N         Max tokens in response (default: 2048)
#   --thinking EFFORT      Reasoning effort: low, medium, high, xhigh, max (default: off)
#   --user ID              LDAP username for x-portico-userid (default: stress-test)
#   --track TRACK          Build track: sandbox, dev-build, integration (default: sandbox)
#   --proxy-url URL        Override the llm-proxy base URL (auto-detected from model)
#   --stall-timeout SECS   Kill request if no data received for N seconds (default: 30)
#   --max-time SECS        Hard cap on total request time (default: 300)
#   --output-dir DIR       Directory to save responses (default: /tmp/llm-proxy-stress-TIMESTAMP/)
#   --help                 Show this help
#
# Examples:
#   ./src/scripts/stress-test-llm-proxy-stream.sh --thinking max
#   ./src/scripts/stress-test-llm-proxy-stream.sh --model atlas-opus-4-8 --thinking max --concurrency 3 --iterations 5
#   ./src/scripts/stress-test-llm-proxy-stream.sh --model gpt-5.6-sol --concurrency 10 --iterations 50
#   ./src/scripts/stress-test-llm-proxy-stream.sh --model atlas-sonnet-4-6 --thinking high --max-tokens 4096
#
# Environment:
#   PORTICO_LLM_API_KEY  — (required) auto-obtained from running docker-compose stack, see below
#
# How to get PORTICO_LLM_API_KEY:
#   The key is auto-decrypted at runtime by src/scripts/docker-compose.sh and injected
#   into Docker containers — it is never stored in .env files.
#
#   Option 1 — Extract from a running container:
#     docker exec portico-llm-gateway-1 printenv PORTICO_LLM_API_KEY
#
#   Option 2 — Source the decryption function directly:
#     source src/scripts/docker-compose.sh 2>/dev/null
#     export PORTICO_LLM_API_KEY=$(decrypt_shared_api_key)
#
# Available models:
#   Bedrock/Atlas:  atlas-opus-5, atlas-opus-4-8, atlas-opus-4-7, atlas-opus-4-6, atlas-sonnet-4-6, atlas-haiku-4-5
#   OpenAI:          gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.6-sol-pro

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────────
CONCURRENCY=5
ITERATIONS=20
MODEL="atlas-opus-5"
MAX_TOKENS=128000
PORTICO_USER_ID="stress-test"
PORTICO_BUILD_TRACK="sandbox"
THINKING_EFFORT=""
PROXY_URL=""
STALL_TIMEOUT=30
MAX_TIME=600
OUTPUT_DIR=""

# ── Parse flags ─────────────────────────────────────────────────────────────────
show_help() {
  sed -n '2,/^[^#]/{ s/^# \?//p; }' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)        MODEL="$2"; shift 2 ;;
    --concurrency)  CONCURRENCY="$2"; shift 2 ;;
    --iterations)   ITERATIONS="$2"; shift 2 ;;
    --max-tokens)   MAX_TOKENS="$2"; shift 2 ;;
    --thinking)     THINKING_EFFORT="$2"; shift 2 ;;
    --user)         PORTICO_USER_ID="$2"; shift 2 ;;
    --track)        PORTICO_BUILD_TRACK="$2"; shift 2 ;;
    --proxy-url)    PROXY_URL="$2"; shift 2 ;;
    --stall-timeout) STALL_TIMEOUT="$2"; shift 2 ;;
    --max-time)     MAX_TIME="$2"; shift 2 ;;
    --output-dir)   OUTPUT_DIR="$2"; shift 2 ;;
    --help|-h)      show_help ;;
    *)              echo "Unknown option: $1 (use --help)" >&2; exit 1 ;;
  esac
done

# ── Config ──────────────────────────────────────────────────────────────────────
API_KEY="${PORTICO_LLM_API_KEY:?PORTICO_LLM_API_KEY is required — see header comments for how to obtain it}"

# Output directory for saved responses
if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="/tmp/llm-proxy-stress-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$OUTPUT_DIR"

# ── Model → API mapping ────────────────────────────────────────────────────────
LLM_PROXY_BASE="https://llm-proxy-standard.sandbox.example.invalid"
API_MODE=""  # "bedrock" or "openai"
PRO_MODE=false

resolve_model() {
	  case "$MODEL" in
	    atlas-opus-5)
	      MODEL_ID="us.anthropic.atlas-opus-5"
	      API_MODE="bedrock"
	      THINKING_STYLE="adaptive"  # uses output_config.effort
	      RESOLVED_URL="${PROXY_URL:-${LLM_PROXY_BASE}/bedrock/converse}"
	      ;;
	    atlas-opus-4-8)
	      MODEL_ID="us.anthropic.atlas-opus-4-8"
	      API_MODE="bedrock"
	      THINKING_STYLE="adaptive"  # uses output_config.effort
	      RESOLVED_URL="${PROXY_URL:-${LLM_PROXY_BASE}/bedrock/converse}"
	      ;;
	    atlas-opus-4-7)
	      MODEL_ID="us.anthropic.atlas-opus-4-7"
      API_MODE="bedrock"
      THINKING_STYLE="adaptive"  # uses output_config.effort
      RESOLVED_URL="${PROXY_URL:-${LLM_PROXY_BASE}/bedrock/converse}"
      ;;
    atlas-opus-4-6)
      MODEL_ID="us.anthropic.atlas-opus-4-6-v1"
      API_MODE="bedrock"
      THINKING_STYLE="adaptive"
      RESOLVED_URL="${PROXY_URL:-${LLM_PROXY_BASE}/bedrock/converse}"
      ;;
    atlas-sonnet-4-6)
      MODEL_ID="us.anthropic.atlas-sonnet-4-6"
      API_MODE="bedrock"
      THINKING_STYLE="budget"  # uses thinking.budget_tokens
      RESOLVED_URL="${PROXY_URL:-${LLM_PROXY_BASE}/bedrock/converse}"
      ;;
    atlas-haiku-4-5)
      MODEL_ID="us.anthropic.atlas-haiku-4-5-20251001-v1:0"
      API_MODE="bedrock"
      THINKING_STYLE="budget"
      RESOLVED_URL="${PROXY_URL:-${LLM_PROXY_BASE}/bedrock/converse}"
      ;;
    gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5.6-sol-pro)
      if [[ "$MODEL" == "gpt-5.6-sol-pro" ]]; then
        MODEL_ID="gpt-5.6-sol"
        PRO_MODE=true
      else
        MODEL_ID="$MODEL"
      fi
      API_MODE="openai"
      RESOLVED_URL="${PROXY_URL:-${LLM_PROXY_BASE}/openai/v1/responses}"
      ;;
    *)
      echo "Unknown model: $MODEL" >&2
	      echo "Supported: atlas-opus-5, atlas-opus-4-8, atlas-opus-4-7, atlas-opus-4-6, atlas-sonnet-4-6, atlas-haiku-4-5, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.6-sol-pro" >&2
      exit 1
      ;;
  esac
}
resolve_model

# ── Persist run parameters ──────────────────────────────────────────────────────
# Drop a parameters.json next to the saved responses so that any later analysis
# (or rerun) can recover the exact inputs used for this run without re-deriving
# them from shell history.
RUN_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "${OUTPUT_DIR}/parameters.json" <<EOF
{
  "timestamp": "${RUN_TIMESTAMP}",
  "model": "${MODEL}",
  "modelId": "${MODEL_ID}",
  "apiMode": "${API_MODE}",
  "thinkingEffort": "${THINKING_EFFORT}",
  "thinkingStyle": "${THINKING_STYLE:-}",
  "concurrency": ${CONCURRENCY},
  "iterations": ${ITERATIONS},
  "totalRequests": $((CONCURRENCY * ITERATIONS)),
  "maxTokens": ${MAX_TOKENS},
  "stallTimeoutSecs": ${STALL_TIMEOUT},
  "maxTimeSecs": ${MAX_TIME},
  "proxyUrl": "${PROXY_URL}",
  "resolvedUrl": "${RESOLVED_URL}",
  "porticoUserId": "${PORTICO_USER_ID}",
  "porticoBuildTrack": "${PORTICO_BUILD_TRACK}",
  "appId": "portico-stream-stress",
  "outputDir": "${OUTPUT_DIR}"
}
EOF

# ── Counters (temp files for cross-process aggregation) ─────────────────────────
RESULTS_DIR="$(mktemp -d)"
trap 'rm -rf "${RESULTS_DIR}"' EXIT

# ── Build request payload ───────────────────────────────────────────────────────
build_thinking_fields() {
  if [[ -z "$THINKING_EFFORT" ]]; then
    echo ""
    return
  fi
  if [[ "$THINKING_STYLE" == "adaptive" ]]; then
    # Opus 4.7/4.6: adaptive thinking with effort level
    # Must mirror Bifrost: anthropic_beta at BOTH top-level and inside additionalModelRequestFields
    cat <<EOF
  "anthropic_beta": ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"],
  "additionalModelRequestFields": {
    "output_config": {"effort": "${THINKING_EFFORT}"},
    "thinking": {"type": "adaptive", "display": "summarized"},
    "anthropic_beta": ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"]
  },
EOF
  else
    # Sonnet/Haiku: budget_tokens based thinking
    local budget
    case "$THINKING_EFFORT" in
      low)    budget=1024 ;;
      medium) budget=4096 ;;
      high)   budget=10000 ;;
      max)    budget=31999 ;;
      *)      budget=10000 ;;
    esac
    cat <<EOF
  "anthropic_beta": ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"],
  "additionalModelRequestFields": {
    "thinking": {"type": "enabled", "budget_tokens": ${budget}},
    "anthropic_beta": ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"]
  },
EOF
  fi
}

build_payload() {
  local prompt
  prompt=$(cat <<'PROMPT'
You are given 8 servers labeled A through H in a distributed system. Each server has a local clock that drifts at a unique rate. The following constraints must ALL be satisfied simultaneously:

1. Server A must replicate to exactly 3 other servers, and the total network latency of those 3 links must be minimized.
2. No server may be more than 3 hops from any other server.
3. The system must tolerate any 2 simultaneous server failures while maintaining connectivity for the remaining servers.
4. Servers A, D, and G run a Paxos consensus group. Prove whether adding server B to this group improves or worsens availability given that B has a 15% independent failure probability vs 10% for the others.
5. Design a vector clock scheme for this topology. Then trace through this exact sequence of events and give the final vector clock state for every server: A sends to B, B sends to D, C sends to A, D sends to G, A sends to H, G sends to E, E sends to F, F sends to C, H sends to B, B sends to G.
6. Now assume network partitions can occur. The system splits into {A,B,C,H} and {D,E,F,G}. Describe exactly which operations succeed and fail under linearizable consistency vs eventual consistency for each partition.
7. Calculate the theoretical maximum throughput in operations/second if each server processes 1000 ops/sec locally, each network link adds 5ms latency, and the consensus protocol requires 2 round trips.

Show all work. Prove each claim. Identify any contradictions between constraints and explain how you resolved them.
PROMPT
  )
  # JSON-escape the prompt (handle newlines and special chars)
  local escaped_prompt
  escaped_prompt=$(printf '%s' "$prompt" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()), end="")')

  if [[ "$API_MODE" == "bedrock" ]]; then
    local thinking_json
    thinking_json=$(build_thinking_fields)
    cat <<EOF
{
  "modelId": "${MODEL_ID}",
  "messages": [{"role": "user", "content": [{"text": ${escaped_prompt}}]}],
  "inferenceConfig": {"maxTokens": ${MAX_TOKENS}},
${thinking_json}  "stream": true
}
EOF
  else
    local reasoning_json=""
    local effort="${THINKING_EFFORT:-medium}"
    if [[ "$PRO_MODE" == true ]]; then
      reasoning_json="  \"reasoning\": {\"effort\": \"${effort}\", \"mode\": \"pro\"},"
    elif [[ -n "$THINKING_EFFORT" ]]; then
      reasoning_json="  \"reasoning\": {\"effort\": \"${effort}\"},"
    fi
    cat <<EOF
{
  "model": "${MODEL_ID}",
  "input": ${escaped_prompt},
  "max_output_tokens": ${MAX_TOKENS},
${reasoning_json}
  "stream": true
}
EOF
  fi
}

# ── Check stream completion ─────────────────────────────────────────────────────
# Bedrock Converse: stream is complete when we see "messageStop" in a chunk
# OpenAI Responses: stream is complete when we see "response.completed"
check_stream_complete() {
  local file="$1"
  if [[ "$API_MODE" == "bedrock" ]]; then
    grep -q '"messageStop"' "$file" 2>/dev/null
  else
    grep -qE '"type"[[:space:]]*:[[:space:]]*"response.completed"' "$file" 2>/dev/null
  fi
}

# Did the proxy emit a synthetic terminal error event (LLMP-2434 fix)?
# Bedrock native: serviceUnavailableException
# OpenAI-format : {"error":{"type":"stream_terminated", ...}} or "upstream_stream_terminated"
check_stream_terminated() {
  local file="$1"
  grep -qE '"(serviceUnavailableException|stream_terminated)"|upstream_stream_terminated|"code":"upstream_stream_terminated"|[A-Za-z]+Exception"' \
    "$file" 2>/dev/null
}

# Generate a per-request correlation id we can grep in proxy logs / Logrepo.
gen_correlation_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    echo "stress-$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    echo "stress-$(date +%s%N)-$RANDOM"
  fi
}

count_chunks() {
  local file="$1"
  # Both formats use SSE "data: {..." lines
  grep -c '^data: {' "$file" 2>/dev/null || echo 0
}

get_last_chunk() {
  local file="$1"
  if [[ "$API_MODE" == "bedrock" ]]; then
    grep -o '{[^}]*}' "$file" 2>/dev/null | tail -1 | head -c 200
  else
    grep '^data: ' "$file" 2>/dev/null | tail -1 | head -c 200
  fi
}

# ── Single request ──────────────────────────────────────────────────────────────
run_one() {
  local label="$1"
  local tmp="${RESULTS_DIR}/body_${label}"
  local hdr="${RESULTS_DIR}/headers_${label}"
  local payload_file="${RESULTS_DIR}/payload_${label}"

  # Per-request correlation id — sent on the request and saved next to the
  # output so we can grep proxy logs / Logrepo by `stress-…` and tie a specific
  # truncated stream to a specific proxy span.
  local correlation_id
  correlation_id="$(gen_correlation_id)"

  build_payload > "$payload_file"

  # Capture HTTP code + elapsed time. -D writes response headers to $hdr so we
  # can extract the provider's `x-request-id` (= Logrepo `requestTrackingId`,
  # per the wiki "Finding Your Proxy Traces in Datadog APM and LLM Observability").
  local http_code="" start_time elapsed
  start_time=$(date +%s)
  http_code=$(curl -sS -o "$tmp" -D "$hdr" -w '%{http_code}' \
    --no-buffer \
    --speed-limit 1 --speed-time "${STALL_TIMEOUT}" \
    --max-time "${MAX_TIME}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "x-portico-appid: portico-stream-stress" \
    -H "x-portico-userid: ${PORTICO_USER_ID}" \
    -H "x-portico-redact-allow: *" \
    -H "x-portico-track: ${PORTICO_BUILD_TRACK}" \
    -H "x-correlation-id: ${correlation_id}" \
    -H "x-request-id: ${correlation_id}" \
    -d @"${payload_file}" \
    "${RESOLVED_URL}" 2>/dev/null) || http_code="000"
  elapsed=$(( $(date +%s) - start_time ))

  # Pull the provider's x-request-id out of the response headers (case-insensitive).
  # Wrap in `|| true` because grep exits 1 when there's no match, which under
  # `set -euo pipefail` would silently kill this backgrounded function.
  local response_request_id=""
  if [[ -f "$hdr" ]]; then
    response_request_id="$( { grep -i '^x-request-id:' "$hdr" 2>/dev/null \
      | tail -1 | awk '{print $2}' | tr -d '\r'; } || true )"
  fi

  # Analyze the response
  local status detail chunk_count response_kb
  if [[ ! -f "$tmp" || ! -s "$tmp" ]]; then
    status="EMPTY"
    detail="no response body received"
  elif [[ "$http_code" -ge 400 ]]; then
    status="HTTP_ERROR"
    detail="$(head -c 200 "$tmp")"
  elif check_stream_complete "$tmp"; then
    status="OK"
    chunk_count=$(count_chunks "$tmp")
    response_kb=$(( $(wc -c < "$tmp") / 1024 ))
    detail="${chunk_count} chunks, ${response_kb}KB"
  elif check_stream_terminated "$tmp"; then
    # The proxy detected the upstream drop and emitted a synthetic terminal
    # event (LLMP-2434). Distinct from INCOMPLETE — here the proxy *did* its job.
    status="TERMINATED_ERROR"
    chunk_count=$(count_chunks "$tmp")
    response_kb=$(( $(wc -c < "$tmp") / 1024 ))
    detail="${chunk_count} chunks, ${response_kb}KB, proxy emitted terminal error"
  else
    status="INCOMPLETE"
    detail="stream ended without terminal event"
  fi

  # Write result for summary
  echo "${status}" > "${RESULTS_DIR}/result_${label}"

  # Save raw stream + extracted content + correlation metadata
  local out_prefix="${OUTPUT_DIR}/request-${label}"
  cp "$tmp" "${out_prefix}.raw" 2>/dev/null || true
  cp "$hdr" "${out_prefix}.headers" 2>/dev/null || true
  {
    echo "label=${label}"
    echo "status=${status}"
    echo "elapsed_seconds=${elapsed}"
    echo "http_code=${http_code}"
    echo "correlation_id=${correlation_id}"
    echo "response_x_request_id=${response_request_id}"
    echo "url=${RESOLVED_URL}"
  } > "${out_prefix}.meta"

  # Extract thinking and response text into a readable file
  python3 -c "
import json

thinking_parts = []
response_parts = []
stop_reason = None
api_mode = '${API_MODE}'

with open('${out_prefix}.raw') as f:
    for line in f:
        line = line.strip()
        if not line.startswith('data: '):
            continue
        payload = line[6:]
        if payload == '[DONE]':
            break
        try:
            chunk = json.loads(payload)
        except Exception:
            continue

        if api_mode == 'bedrock':
            # Bedrock Converse SSE format
            delta = (chunk.get('contentBlockDelta') or {}).get('delta', {})
            rc = delta.get('reasoningContent', {})
            if rc.get('text'):
                thinking_parts.append(rc['text'])
            elif delta.get('text'):
                response_parts.append(delta['text'])
            ms = chunk.get('messageStop', {})
            if ms.get('stopReason'):
                stop_reason = ms['stopReason']
        else:
            # OpenAI Responses SSE format
            event_type = chunk.get('type')
            if event_type == 'response.output_text.delta' and chunk.get('delta'):
                response_parts.append(chunk['delta'])
            elif (
                event_type == 'response.reasoning_summary_text.delta'
                and chunk.get('delta')
            ):
                thinking_parts.append(chunk['delta'])
            elif event_type == 'response.completed':
                stop_reason = 'completed'

with open('${out_prefix}.txt', 'w') as f:
    if thinking_parts:
        f.write('=== THINKING ===\n')
        f.write(''.join(thinking_parts))
        f.write('\n\n')
    f.write('=== RESPONSE ===\n')
    f.write(''.join(response_parts) if response_parts else '(none — model may have exhausted max_tokens during thinking)\n')
    f.write('\n')
    if stop_reason:
        f.write(f'\n=== STOP REASON: {stop_reason} ===\n')
" 2>/dev/null || true

  # Print — one line per request, including the response x-request-id (which
  # is what you paste into Logrepo `requestTrackingId:…` or APM
  # `@http.request.request_id:…` to find the proxy's view of this exact call).
  local icon
  case "$status" in
    OK)               icon="\033[32m✓\033[0m" ;;
    TERMINATED_ERROR) icon="\033[33m✗\033[0m" ;;
    INCOMPLETE)       icon="\033[31m✗\033[0m" ;;
    HTTP_ERROR)       icon="\033[33m⚠\033[0m" ;;
    EMPTY)            icon="\033[31m✗\033[0m" ;;
  esac
  local trace_suffix=""
  if [[ -n "$response_request_id" ]]; then
    trace_suffix="  x-request-id=${response_request_id}"
  else
    trace_suffix="  corr=${correlation_id}"
  fi
  echo -e "  ${icon} #${label}  ${elapsed}s  ${status}  ${detail}${trace_suffix}"

  rm -f "$tmp" "$hdr" "$payload_file"
}

# ── Main ────────────────────────────────────────────────────────────────────────
total=$((CONCURRENCY * ITERATIONS))
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " LLM Proxy Stream Stress Test"
echo " URL:         ${RESOLVED_URL}"
echo " Model:       ${MODEL} (${MODEL_ID})"
echo " API mode:    ${API_MODE}"
if [[ -n "$THINKING_EFFORT" ]]; then
echo " Thinking:    ${THINKING_EFFORT} (${THINKING_STYLE:-n/a})"
fi
echo " Concurrency: ${CONCURRENCY}"
echo " Iterations:  ${ITERATIONS}  (total requests: ${total})"
echo " Max tokens:  ${MAX_TOKENS}"
echo " App ID:      portico-stream-stress"
echo " User ID:     ${PORTICO_USER_ID}"
echo " Track:       ${PORTICO_BUILD_TRACK}"
echo " Output:      ${OUTPUT_DIR}/"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

completed=0
for iter in $(seq 1 "$ITERATIONS"); do
  echo ""
  echo "── Wave ${iter}/${ITERATIONS}  (sending ${CONCURRENCY} parallel requests) ──"
  for j in $(seq 1 "$CONCURRENCY"); do
    run_one "${iter}-${j}" &
  done
  wait
  completed=$((completed + CONCURRENCY))
  echo "   ${completed}/${total} requests done"
done

# ── Summary ─────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok_count=$(grep -rl "^OK$" "${RESULTS_DIR}"/result_* 2>/dev/null | wc -l | tr -d ' ')
terminated_count=$(grep -rl "^TERMINATED_ERROR$" "${RESULTS_DIR}"/result_* 2>/dev/null | wc -l | tr -d ' ')
incomplete_count=$(grep -rl "^INCOMPLETE$" "${RESULTS_DIR}"/result_* 2>/dev/null | wc -l | tr -d ' ')
error_count=$(grep -rl "^HTTP_ERROR$" "${RESULTS_DIR}"/result_* 2>/dev/null | wc -l | tr -d ' ')
empty_count=$(grep -rl "^EMPTY$" "${RESULTS_DIR}"/result_* 2>/dev/null | wc -l | tr -d ' ')

echo " Results: ${ok_count}/${total} OK, ${terminated_count} TERMINATED_ERROR, ${incomplete_count} INCOMPLETE, ${error_count} HTTP errors, ${empty_count} empty"

if [[ "$incomplete_count" -gt 0 ]]; then
  echo -e " \033[31m⚠ Silent stream truncation detected — proxy never emitted a terminal event!\033[0m"
  echo "   → Either the proxy did not detect the upstream drop, or an external middlebox"
  echo "     (envoy / NLB / k8s ingress) closed the client connection without warning."
  echo "   → To find the proxy's view of each truncated request:"
  echo "       cat ${OUTPUT_DIR}/request-*.meta | grep -E 'status|x_request_id|correlation_id'"
  echo "       Then in Datadog: search Logrepo by requestTrackingId:<x-request-id>"
  echo "                        or APM by @http.request.request_id:<x-request-id>"
elif [[ "$terminated_count" -gt 0 ]]; then
  echo -e " \033[33m⚠ Proxy detected stream drops and emitted synthetic terminal events (LLMP-2434).\033[0m"
  echo "   → The proxy is doing its job — surface these as upstream/Bedrock errors."
elif [[ "$error_count" -gt 0 ]]; then
  echo -e " \033[33m⚠ HTTP errors detected — may indicate rate limiting or proxy issues\033[0m"
else
  echo -e " \033[32m✓ All streams completed cleanly — llm-proxy is fine\033[0m"
  echo "   → If ai-chat still drops streams, the issue is in the Bifrost bridge or middleware"
fi
echo ""
echo " Saved responses:"
echo "   ${OUTPUT_DIR}/request-*.raw      — raw streamed bytes"
echo "   ${OUTPUT_DIR}/request-*.txt      — extracted thinking + response text"
echo "   ${OUTPUT_DIR}/request-*.headers  — full HTTP response headers (for x-request-id, ratelimit, etc.)"
echo "   ${OUTPUT_DIR}/request-*.meta     — label, status, elapsed, http_code, correlation_id, response x-request-id, url"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
