#!/usr/bin/env bash
# PORTICO-246: the single-server path must apply the same default-disabled tools as
# the mcp-orc generator. If the two disagree, a dev/OAuth-bootstrap launch
# re-exposes google_workspace's start_google_auth, whose authorize URL Google
# always rejects (http://0.0.0.0:8080/oauth2callback, no PKCE).
#
# merge_default_disabled_tools had no coverage at all before this, including for
# the pre-existing glean default, so both are asserted here.
#
# The function is extracted rather than sourced because
# start-single-mcp-server.sh parses argv and exits at load time, so it cannot be
# sourced. Extraction keeps the assertions behavioral: the real function body is
# what runs.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT_DIR/src/scripts/start-single-mcp-server.sh"

if ! command -v jq >/dev/null 2>&1; then
    echo "SKIP: jq not available"
    exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

# Pull out the two functions under test plus the flag helper they call.
awk '/^merge_default_disabled_tools\(\)/,/^}/' "$TARGET" > "$WORK/fn.sh"
if [ ! -s "$WORK/fn.sh" ]; then
    fail "could not extract merge_default_disabled_tools from $TARGET"
fi

# Stub the optimization-flag lookup: the real one reads repo state, and the
# glean branch's flag defaults to true.
cat > "$WORK/harness.sh" <<'SH'
optimization_flag_enabled() {
    local flag_name="$1"
    local default_value="$2"
    if [ -n "${STUB_FLAG_VALUE:-}" ]; then
        [ "$STUB_FLAG_VALUE" = "true" ]
        return
    fi
    [ "$default_value" = "true" ]
}
SH

run_merge() {
    local server_id="$1"
    local json="$2"
    bash -c "
        set -euo pipefail
        source '$WORK/harness.sh'
        source '$WORK/fn.sh'
        merge_default_disabled_tools '$server_id' '$json'
    "
}

# --- google_workspace: start_google_auth is disabled by default -------------
out="$(run_merge google_workspace '[]')"
echo "$out" | jq -e 'index("start_google_auth") != null' >/dev/null \
    || fail "google_workspace with no user config should disable start_google_auth, got: $out"

# --- user choices survive ---------------------------------------------------
out="$(run_merge google_workspace '["send_gmail_message"]')"
echo "$out" | jq -e 'index("start_google_auth") != null and index("send_gmail_message") != null' >/dev/null \
    || fail "user-disabled tools must be preserved alongside the default, got: $out"

# --- no duplicate when the user already disabled it ------------------------
out="$(run_merge google_workspace '["start_google_auth"]')"
count="$(echo "$out" | jq -r '[.[] | select(. == "start_google_auth")] | length')"
[ "$count" = "1" ] || fail "expected exactly one start_google_auth entry, got $count in: $out"

# --- other servers are untouched -------------------------------------------
out="$(run_merge slack '[]')"
echo "$out" | jq -e 'index("start_google_auth") == null' >/dev/null \
    || fail "the google_workspace default must not leak to slack, got: $out"

# --- pre-existing glean default still applies ------------------------------
out="$(STUB_FLAG_VALUE=true run_merge glean '[]')"
echo "$out" | jq -e 'index("read_document") != null' >/dev/null \
    || fail "glean read_document default regressed, got: $out"

out="$(STUB_FLAG_VALUE=false run_merge glean '[]')"
echo "$out" | jq -e 'index("read_document") == null' >/dev/null \
    || fail "glean read_document must stay enabled when the flag is off, got: $out"

echo "PASS: single-server default disabled-tools regression tests"
