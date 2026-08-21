#!/usr/bin/env bash

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:4583}"
GATEWAY_CURL_MAX_TIME_SECONDS="${GATEWAY_CURL_MAX_TIME_SECONDS:-90}"
PROMPT_CACHE_SETTLE_SECONDS="${PROMPT_CACHE_SETTLE_SECONDS:-2}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d%H%M%S)}"
OUT_JSON="${OUT_JSON:-/tmp/bifrost-prompt-cache-report-${RUN_ID}.json}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

require_tool() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 1
  }
}

require_tool curl
require_tool jq
require_tool python3

trim_secret() {
  tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

resolve_gateway_bearer_token() {
  local value
  for env_key in BIFROST_GATEWAY_BEARER_TOKEN BIFROST_BRIDGE_LOCAL_API_KEY; do
    value="${!env_key:-}"
    if [[ -n "${value}" ]]; then
      printf '%s' "${value}" | trim_secret
      return 0
    fi
  done

  for file_key in BIFROST_GATEWAY_BEARER_TOKEN_FILE BIFROST_BRIDGE_LOCAL_API_KEY_FILE; do
    value="${!file_key:-}"
    if [[ -n "${value}" && -r "${value}" ]]; then
      trim_secret <"${value}"
      return 0
    fi
  done

  if command -v docker >/dev/null 2>&1; then
    value="$(
      docker exec llm-gateway sh -lc '
        if [ -n "${BIFROST_BRIDGE_LOCAL_API_KEY:-}" ]; then
          printf "%s" "$BIFROST_BRIDGE_LOCAL_API_KEY"
        elif [ -n "${BIFROST_BRIDGE_LOCAL_API_KEY_FILE:-}" ] && [ -r "$BIFROST_BRIDGE_LOCAL_API_KEY_FILE" ]; then
          cat "$BIFROST_BRIDGE_LOCAL_API_KEY_FILE"
        fi
      ' 2>/dev/null || true
    )"
    if [[ -n "${value}" ]]; then
      printf '%s' "${value}" | trim_secret
      return 0
    fi
  fi

  return 0
}

GATEWAY_BEARER_TOKEN="${GATEWAY_BEARER_TOKEN:-$(resolve_gateway_bearer_token)}"
GATEWAY_AUTH_CONFIG=""
if [[ -n "${GATEWAY_BEARER_TOKEN}" ]]; then
  GATEWAY_AUTH_CONFIG="${TMP_DIR}/gateway-auth.curl"
  umask 077
  printf 'header = "Authorization: Bearer %s"\n' "${GATEWAY_BEARER_TOKEN}" >"${GATEWAY_AUTH_CONFIG}"
fi

gateway_curl() {
  if [[ -n "${GATEWAY_AUTH_CONFIG}" ]]; then
    curl --config "${GATEWAY_AUTH_CONFIG}" --connect-timeout 10 --max-time "${GATEWAY_CURL_MAX_TIME_SECONDS}" "$@"
  else
    curl --connect-timeout 10 --max-time "${GATEWAY_CURL_MAX_TIME_SECONDS}" "$@"
  fi
}

http_post_json_to_file() {
  local url="$1"
  local payload_file="$2"
  local body_file="$3"
  local status="000"
  if status="$(gateway_curl -sS -o "${body_file}" -w '%{http_code}' "${url}" \
    -H 'Content-Type: application/json' \
    --data @"${payload_file}")"; then
    :
  fi
  printf '%s\n' "${status:-000}"
}

http_status_is_success() {
  local status="$1"
  [[ "$status" =~ ^[0-9]+$ ]] && (( status >= 200 && status < 300 ))
}

read_body_file() {
  local body_file="$1"
  if [[ -f "${body_file}" ]]; then
    cat "${body_file}"
  fi
}

json_or_null_from_file() {
  local body_file="$1"
  jq -cRs 'fromjson? // null' <"${body_file}"
}

build_http_error_json() {
  local status="$1"
  local phase="$2"
  local body_file="$3"
  jq -cn \
    --argjson status "${status}" \
    --arg phase "${phase}" \
    --rawfile raw_body "${body_file}" '
      ($raw_body | fromjson? // {raw: $raw_body}) as $parsed
      | {
          phase: $phase,
          http_status: $status,
          response: $parsed
        }
    '
}

http_error_is_access_denied() {
  local error_json="$1"
  jq -e '
    [
      .response.error.message?,
      .response.error?,
      .response.message?,
      .response.raw?
    ]
    | map(select(type == "string"))
    | join(" ")
    | ascii_downcase
    | (
        contains("accessdeniedexception")
        or contains("access denied")
        or contains("aws-marketplace:subscribe")
        or contains("aws marketplace")
        or contains("viewsubscriptions")
      )
  ' <<<"${error_json}" >/dev/null
}

build_static_context() {
  local model="$1"
  local count="$2"
  local nonce="$3"
  python3 - "$model" "$count" "$nonce" <<'PY'
import sys

model = sys.argv[1]
count = int(sys.argv[2])
nonce = sys.argv[3]
parts = [f"MODEL {model} RUN {nonce} START"]
for i in range(1, count + 1):
    parts.append(
        f"STATICSEG{i:04d} lorem ipsum dolor sit amet consectetur adipiscing elit "
        f"sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."
    )
parts.append(f"MODEL {model} RUN {nonce} END")
print(" ".join(parts))
PY
}

max_field_for_model() {
  local model="$1"
  if [[ "$model" == Atlas* ]]; then
    printf '%s\n' "max_tokens"
  else
    printf '%s\n' "max_completion_tokens"
  fi
}

max_value_for_model() {
  local model="$1"
  if [[ "$model" == Atlas* ]]; then
    printf '%s\n' "64"
  else
    printf '%s\n' "64"
  fi
}

candidate_sizes_for_model() {
  local model="$1"
  case "$model" in
    "GPT-5.5"|"GPT-5.6 Sol"|"GPT-5.6 Sol Pro"|"GPT-5.6 Terra"|"GPT-5.6 Luna")
      printf '%s\n' "240 320"
      ;;
    "Gemini 3.6 Flash"|"Gemini 3.5 Flash"|"Gemini 3.1 Pro Preview"|"Gemini 3.5 Flash-Lite"|"Gemini 3.1 Flash-Lite")
      printf '%s\n' "160 240 320"
      ;;
    Atlas*)
      printf '%s\n' "120 160 200"
      ;;
    *)
      printf '%s\n' "160"
      ;;
  esac
}

expected_cache_mode() {
  local model="$1"
  case "$model" in
    "GPT-5.6 Sol"|"GPT-5.6 Sol Pro"|"GPT-5.6 Terra"|"GPT-5.6 Luna")
      printf '%s\n' "populate-read"
      ;;
    Atlas*)
      printf '%s\n' "write-read"
      ;;
    "GPT-5.5")
      printf '%s\n' "read-only"
      ;;
    "Gemini 3.6 Flash"|"Gemini 3.5 Flash"|"Gemini 3.1 Pro Preview"|"Gemini 3.5 Flash-Lite"|"Gemini 3.1 Flash-Lite")
      printf '%s\n' "none"
      ;;
    *)
      echo "no prompt-cache expectation is defined for model: ${model}" >&2
      return 1
      ;;
  esac
}

build_chat_payload() {
  local model="$1"
  local static_context="$2"
  local dynamic_context="$3"
  local chat_id="$4"
  local stream="$5"
  local max_field
  local max_value
  max_field="$(max_field_for_model "$model")"
  max_value="$(max_value_for_model "$model")"

  jq -n \
    --arg model "$model" \
    --arg static "$static_context" \
    --arg dynamic "$dynamic_context" \
    --arg chat_id "$chat_id" \
    --arg max_field "$max_field" \
    --argjson max_value "$max_value" \
    --argjson stream_flag "$stream" '
      {
        model: $model,
        chat_id: $chat_id,
        messages: [
          {
            role: "system",
            content: "You are Portico. Reply with exactly ok."
          },
          {
            role: "system",
            content: ("<static_context>\n" + $static + "\n</static_context>")
          },
          {
            role: "system",
            content: ("<dynamic_context>\n" + $dynamic + "\n</dynamic_context>")
          },
          {
            role: "user",
            content: "Reply with exactly ok."
          }
        ]
      }
      + (if $max_field == "max_tokens" then {max_tokens: $max_value} else {max_completion_tokens: $max_value} end)
      + (if $stream_flag then {stream: true, stream_options: {include_usage: true}} else {} end)
    '
}

run_chat_json() {
  local payload_file="$1"
  local body_file="$2"
  http_post_json_to_file "${GATEWAY_URL}/v1/chat/completions" "${payload_file}" "${body_file}"
}

run_chat_stream_usage() {
  local payload_file="$1"
  local sse_file="$2"
  local status
  status="$(http_post_json_to_file "${GATEWAY_URL}/v1/chat/completions" "${payload_file}" "${sse_file}")"
  if ! http_status_is_success "${status}"; then
    printf '%s\n' "${status}"
    return 0
  fi
  sed -n 's/^data: //p' "${sse_file}" \
    | jq -cRs '
        split("\n")
        | map(select(length > 0 and . != "[DONE]"))
        | map(fromjson?)
        | map(select(type == "object" and .usage != null))
        | last
      '
  printf '\n%s\n' "${status}"
}

usage_summary() {
  local response_json="$1"
  jq -c '
    (.usage // {}) as $u
    | {
        prompt_tokens: ($u.prompt_tokens // 0),
        completion_tokens: ($u.completion_tokens // 0),
        total_tokens: ($u.total_tokens // 0),
        cost: ($u.cost // null),
        cached_tokens: ($u.prompt_tokens_details.cached_tokens // 0),
        cached_read_tokens: ($u.prompt_tokens_details.cached_read_tokens // 0),
        cached_write_tokens: ($u.prompt_tokens_details.cached_write_tokens // 0),
        reasoning_tokens: ($u.completion_tokens_details.reasoning_tokens // 0)
      }
  ' <<<"${response_json}"
}

check_cache_success() {
  local expected="$1"
  local call1="$2"
  local call2="$3"
  local call1_prompt call1_write call2_read call2_cached
  call1_prompt="$(jq -r '.prompt_tokens // 0' <<<"${call1}")"
  call1_write="$(jq -r '.cached_write_tokens // 0' <<<"${call1}")"
  call2_read="$(jq -r '.cached_read_tokens // 0' <<<"${call2}")"
  call2_cached="$(jq -r '.cached_tokens // 0' <<<"${call2}")"

  case "$expected" in
    disabled)
      [[ "$call1_write" == "0" && "$call2_read" == "0" && "$call2_cached" == "0" ]]
      ;;
    write-read)
      [[ "$call1_write" != "0" && "$call2_read" != "0" ]]
      ;;
    populate-read)
      [[ "$call1_prompt" != "0" && ( "$call2_read" != "0" || "$call2_cached" != "0" ) ]]
      ;;
    read-only)
      [[ "$call2_read" != "0" || "$call2_cached" != "0" ]]
      ;;
    none)
      [[ "$call1_write" == "0" && "$call2_read" == "0" && "$call2_cached" == "0" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

run_model_matrix() {
  local model="$1"
  local expected
  expected="$(expected_cache_mode "$model")"
  local chosen=""
  local attempts='[]'
  local counts
  counts="$(candidate_sizes_for_model "$model")"

  for count in $counts; do
    local nonce="run-${RUN_ID}-$(printf '%s' "$model" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')-${count}-${RANDOM}"
    local chat_id="cache-${RUN_ID}-$(printf '%s' "$model" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')-${count}-${RANDOM}"
    local static_context
    static_context="$(build_static_context "$model" "$count" "$nonce")"
    local dynamic_context_1="chat=${chat_id} variant=initial model=${model}"
    local dynamic_context_2="chat=${chat_id} variant=followup model=${model}"

    local payload1_file="${TMP_DIR}/payload1-$(printf '%s' "$chat_id" | tr -cd 'a-zA-Z0-9-').json"
    local payload2_file="${TMP_DIR}/payload2-$(printf '%s' "$chat_id" | tr -cd 'a-zA-Z0-9-').json"
    build_chat_payload "$model" "$static_context" "$dynamic_context_1" "$chat_id" false >"${payload1_file}"
    build_chat_payload "$model" "$static_context" "$dynamic_context_2" "$chat_id" false >"${payload2_file}"

    local response1_file="${TMP_DIR}/response1-$(printf '%s' "$chat_id" | tr -cd 'a-zA-Z0-9-').json"
    local response2_file="${TMP_DIR}/response2-$(printf '%s' "$chat_id" | tr -cd 'a-zA-Z0-9-').json"
    local response1_status response2_status
    response1_status="$(run_chat_json "${payload1_file}" "${response1_file}")"
    if [[ "${PROMPT_CACHE_SETTLE_SECONDS}" != "0" ]]; then
      sleep "${PROMPT_CACHE_SETTLE_SECONDS}"
    fi
    response2_status="$(run_chat_json "${payload2_file}" "${response2_file}")"
    local response1 response2 usage1 usage2
    response1="$(read_body_file "${response1_file}")"
    response2="$(read_body_file "${response2_file}")"

    if ! http_status_is_success "${response1_status}" || ! http_status_is_success "${response2_status}"; then
      local call1_error call2_error
      call1_error="$(build_http_error_json "${response1_status}" "chat_call_1" "${response1_file}")"
      call2_error="$(build_http_error_json "${response2_status}" "chat_call_2" "${response2_file}")"
      attempts="$(jq -cn \
        --argjson attempts "${attempts}" \
        --argjson count "${count}" \
        --argjson call1_error "${call1_error}" \
        --argjson call2_error "${call2_error}" '
          $attempts + [{
            prompt_size: $count,
            success: false,
            call1_error: $call1_error,
            call2_error: $call2_error
          }]
        ')"

      if http_error_is_access_denied "${call1_error}" || http_error_is_access_denied "${call2_error}"; then
        chosen="$(jq -n \
          --arg model "$model" \
          --arg expected "$expected" \
          --argjson attempts "${attempts}" '
            {
              model: $model,
              expected_cache_mode: $expected,
              success: false,
              skipped: true,
              reason: "model_access_denied",
              attempts: $attempts
            }
          ')"
        break
      fi
      continue
    fi

    usage1="$(usage_summary "${response1}")"
    usage2="$(usage_summary "${response2}")"

    local success=false
    if check_cache_success "$expected" "$usage1" "$usage2"; then
      success=true
      local stream_payload_file="${TMP_DIR}/payload-stream-$(printf '%s' "$chat_id" | tr -cd 'a-zA-Z0-9-').json"
      local sse_file="${TMP_DIR}/stream-$(printf '%s' "$chat_id" | tr -cd 'a-zA-Z0-9-').sse"
      build_chat_payload "$model" "$static_context" "$dynamic_context_2" "$chat_id" true >"${stream_payload_file}"
      local stream_response stream_usage stream_status
      stream_response="$(run_chat_stream_usage "${stream_payload_file}" "${sse_file}")"
      stream_status="$(tail -n 1 <<<"${stream_response}")"
      stream_response="$(sed '$d' <<<"${stream_response}")"
      local stream_error='null'
      if http_status_is_success "${stream_status}"; then
        stream_usage="$(usage_summary "${stream_response:-null}")"
      else
        stream_usage='{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"cost":null,"cached_tokens":0,"cached_read_tokens":0,"cached_write_tokens":0,"reasoning_tokens":0}'
        stream_error="$(build_http_error_json "${stream_status}" "chat_stream" "${sse_file}")"
      fi
      attempts="$(jq -cn \
        --argjson attempts "${attempts}" \
        --argjson usage1 "${usage1}" \
        --argjson usage2 "${usage2}" \
        --argjson stream_usage "${stream_usage}" \
        --argjson stream_error "${stream_error}" \
        --argjson count "${count}" '
          $attempts + [{
            prompt_size: $count,
            call1_usage: $usage1,
            call2_usage: $usage2,
            stream_usage: $stream_usage,
            stream_error: $stream_error,
            success: true
          }]
        ')"
      chosen="$(jq -n \
        --arg model "$model" \
        --arg expected "$expected" \
        --argjson count "${count}" \
        --argjson usage1 "${usage1}" \
        --argjson usage2 "${usage2}" \
        --argjson stream_usage "${stream_usage}" \
        --argjson stream_error "${stream_error}" '
          {
            model: $model,
            expected_cache_mode: $expected,
            prompt_size: $count,
            call1_usage: $usage1,
            call2_usage: $usage2,
            stream_usage: $stream_usage,
            stream_error: $stream_error,
            success: true
          }
        ')"
      break
    fi

    attempts="$(jq -cn \
      --argjson attempts "${attempts}" \
      --argjson usage1 "${usage1}" \
      --argjson usage2 "${usage2}" \
      --argjson count "${count}" '
        $attempts + [{
          prompt_size: $count,
          call1_usage: $usage1,
          call2_usage: $usage2,
          success: false
        }]
      ')"
  done

  if [[ -z "${chosen}" ]]; then
    chosen="$(jq -n \
      --arg model "$model" \
      --arg expected "$expected" \
      --argjson attempts "${attempts}" '
        {
          model: $model,
          expected_cache_mode: $expected,
          success: false,
          attempts: $attempts
        }
      ')"
  else
    chosen="$(jq -n \
      --argjson result "${chosen}" \
      --argjson attempts "${attempts}" '
        $result + {attempts: $attempts}
      ')"
  fi

  printf '%s\n' "${chosen}"
}

run_embedding_probe() {
  local payload
  payload="$(jq -n '{
    model: "text-embedding-3-large",
    input: ["cache metrics embedding smoke test"]
  }')"
  local payload_file="${TMP_DIR}/embedding-payload.json"
  local body_file="${TMP_DIR}/embedding-response.json"
  printf '%s\n' "${payload}" >"${payload_file}"

  local status
  status="$(http_post_json_to_file "${GATEWAY_URL}/v1/embeddings" "${payload_file}" "${body_file}")"
  if ! http_status_is_success "${status}"; then
    build_http_error_json "${status}" "embedding_probe" "${body_file}" \
      | jq '. + {model: "text-embedding-3-large", success: false}'
    return 0
  fi

  local response
  response="$(json_or_null_from_file "${body_file}")"
  jq -n --argjson response "${response}" '
    {
      model: "text-embedding-3-large",
      success: true,
      usage: {
        prompt_tokens: ($response.usage.prompt_tokens // 0),
        total_tokens: ($response.usage.total_tokens // 0),
        cost: ($response.usage.cost // null)
      }
    }
  '
}

main() {
  local health
  health="$(gateway_curl -sf "${GATEWAY_URL}/health")"
  local models
  models="$(gateway_curl -sf "${GATEWAY_URL}/v1/models" | jq -r '.data[].id')"

  local results='[]'
  while IFS= read -r model; do
    [[ -z "${model}" ]] && continue
    if [[ "${model}" == "text-embedding-3-large" ]]; then
      continue
    fi
    echo "testing ${model}" >&2
    local model_result
    model_result="$(run_model_matrix "${model}")"
    results="$(jq -cn --argjson results "${results}" --argjson result "${model_result}" '$results + [$result]')"
  done <<<"${models}"

  local successful_chat_models
  successful_chat_models="$(jq -r '[ .[] | select(.success == true) ] | length' <<<"${results}")"
  if [[ "${successful_chat_models}" == "0" ]]; then
    echo "No chat models completed the prompt-cache probe successfully." >&2
    return 1
  fi

  local embedding_result
  if grep -Fxq "text-embedding-3-large" <<<"${models}"; then
    embedding_result="$(run_embedding_probe)"
  else
    embedding_result="$(jq -n '{
      model: "text-embedding-3-large",
      success: false,
      skipped: true,
      reason: "model_not_available"
    }')"
  fi

  jq -n \
    --arg run_id "${RUN_ID}" \
    --arg gateway_url "${GATEWAY_URL}" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson health "${health}" \
    --argjson chat_results "${results}" \
    --argjson embedding_result "${embedding_result}" '
      {
        run_id: $run_id,
        generated_at: $generated_at,
        gateway_url: $gateway_url,
        health: $health,
        chat_results: $chat_results,
        embedding_result: $embedding_result
      }
    ' | tee "${OUT_JSON}"

  echo "wrote ${OUT_JSON}" >&2
}

main "$@"
