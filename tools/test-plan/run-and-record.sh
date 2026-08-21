#!/usr/bin/env bash

set -uo pipefail

# Wrapper that:
#   1. Inspects the trailing command for any token that looks like a test path.
#   2. Asks lib/match.mjs which scenario IDs cite those paths.
#   3. Executes the underlying command verbatim.
#   4. On exit, records Pass (exit 0) or Fail (exit != 0) for every matched
#      scenario, and re-renders docs/testing/.
#
# Usage examples:
#   tools/test-plan/run-and-record.sh node --test electron-app/src/services/foo.test.js
#   tools/test-plan/run-and-record.sh ./run-tests.sh --no-rust --no-shell
#   tools/test-plan/run-and-record.sh bash tests/test_docker_compose_runtime_secrets.sh
#
# Environment overrides (forwarded to record.mjs):
#   portico_RECORD_VERBOSE=1   Print the matched scenario IDs and the recording payload.
#   portico_RECORD_NOTES=...   Override notes (default: command + duration + exit code).
#   portico_AGENT=1            Mark the executor as "agent".
#   portico_EXECUTOR=...       Override executor.

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <cmd> [args...]" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "${NODE_BIN}" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [[ -x /usr/local/bin/node ]]; then
    NODE_BIN=/usr/local/bin/node
  elif [[ -x /opt/homebrew/bin/node ]]; then
    NODE_BIN=/opt/homebrew/bin/node
  else
    echo "run-and-record: 'node' not found on PATH; set NODE_BIN to override." >&2
    exit 127
  fi
fi

VERBOSE="${portico_RECORD_VERBOSE:-0}"

# Resolve scenario IDs before running the command (so a partial run still
# leaves something to record).
MATCH_OUTPUT="$("$NODE_BIN" "$ROOT_DIR/tools/test-plan/lib/match.mjs" "$@" || true)"
SCENARIO_IDS=()
while IFS=$'\t' read -r id _coverage _path; do
  [[ -z "$id" ]] && continue
  SCENARIO_IDS+=("$id")
done <<< "$MATCH_OUTPUT"

if [[ "$VERBOSE" == "1" ]]; then
  echo "[run-and-record] matched scenario IDs: ${SCENARIO_IDS[*]:-<none>}" >&2
fi

if [[ ${#SCENARIO_IDS[@]} -eq 0 ]]; then
  echo "[run-and-record] warning: no scenarios cite any test path in: $*" >&2
  echo "[run-and-record] warning: running the command but NOT recording any results." >&2
fi

CMD_LINE="$*"
START_TS=$(date +%s)
"$@"
EXIT_CODE=$?
END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

if [[ ${#SCENARIO_IDS[@]} -eq 0 ]]; then
  exit "$EXIT_CODE"
fi

if [[ "$EXIT_CODE" -eq 0 ]]; then
  STATUS="Pass"
  DEFAULT_NOTES="${CMD_LINE} -- ${DURATION}s"
elif [[ "$EXIT_CODE" -eq 5 && "$CMD_LINE" == *"pytest"* ]]; then
  # pytest exit code 5 = "no tests collected"; treat as Skipped, not Fail.
  STATUS="Skipped"
  DEFAULT_NOTES="${CMD_LINE} -- pytest collected 0 tests (exit 5)"
else
  STATUS="Fail"
  DEFAULT_NOTES="${CMD_LINE} exited ${EXIT_CODE} after ${DURATION}s"
fi
NOTES="${portico_RECORD_NOTES:-$DEFAULT_NOTES}"

# Build a single batch payload, upsert all matched IDs in one call, then render.
TMPFILE="$(mktemp -t portico-record.XXXXXX.json)"
trap 'rm -f "$TMPFILE"' EXIT

{
  printf '{\n  "scenarios": {\n'
  count=${#SCENARIO_IDS[@]}
  i=0
  for id in "${SCENARIO_IDS[@]}"; do
    i=$((i+1))
    json_notes=$(printf '%s' "$NOTES" | "$NODE_BIN" -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(d)))')
    if [[ "$i" -lt "$count" ]]; then
      printf '    "%s": {"status": "%s", "notes": %s},\n' "$id" "$STATUS" "$json_notes"
    else
      printf '    "%s": {"status": "%s", "notes": %s}\n' "$id" "$STATUS" "$json_notes"
    fi
  done
  printf '  }\n}\n'
} > "$TMPFILE"

"$NODE_BIN" "$ROOT_DIR/tools/test-plan/record.mjs" --batch "$TMPFILE"

exit "$EXIT_CODE"
