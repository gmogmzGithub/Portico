#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
LAUNCH_LOG="$TMP_DIR/detached-launch.log"

cleanup() {
    if [[ -n "${DETACHED_PID:-}" ]] && kill -0 "$DETACHED_PID" 2>/dev/null; then
        kill "$DETACHED_PID" 2>/dev/null || true
        wait "$DETACHED_PID" 2>/dev/null || true
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

DETACHED_PID="$(
    bash -lc '
        set -euo pipefail
        cd "'"$REPO_ROOT"'"
        source ./install_v2.sh
        start_detached_process "'"$LAUNCH_LOG"'" bash -lc '"'"'echo detached-ok; sleep 5'"'"'
    ' | tail -n1
)"

if [[ ! "$DETACHED_PID" =~ ^[0-9]+$ ]]; then
    echo "expected numeric pid, got: $DETACHED_PID" >&2
    exit 1
fi

sleep 1

if ! kill -0 "$DETACHED_PID" 2>/dev/null; then
    echo "detached process did not survive parent shell exit" >&2
    exit 1
fi

if ! grep -q 'detached-ok' "$LAUNCH_LOG"; then
    echo "detached process did not write expected output" >&2
    exit 1
fi

echo "detached launch helper works (pid=$DETACHED_PID)"
