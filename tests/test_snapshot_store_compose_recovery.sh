#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SKIP_MAIN_EXECUTION=1

docker() {
    printf '[ERROR] unexpected direct Docker executable path\n' >&2
    return 98
}

# Source the production owner and replace every command boundary in-process.
# The tests do not invoke Docker, Compose, sleep, or the repair script.
source "$PROJECT_ROOT/src/scripts/docker-compose.sh" >/dev/null 2>&1

readonly EXACT_SIGNATURE='Error response from daemon: failed to stat parent: stat /var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/1137/fs: no such file or directory'
SCENARIO_COUNT=0

fail_test() {
    printf '[ERROR] %s\n' "$*" >&2
    exit 1
}

reset_fixture() {
    SCENARIO_COUNT=$((SCENARIO_COUNT + 1))
    COMPOSE_RESULTS=""
    REPAIR_CALLS=0
    REPAIR_RESULT=0
    SLEEP_CALLS=0
    LAYER_CLEANUP_CALLS=0
    COMPOSE_CALLS_FILE="$TMP_DIR/compose-calls"
    printf '0\n' >"$COMPOSE_CALLS_FILE"
}

next_compose_result() {
    printf '%s\n' "$COMPOSE_RESULTS" | sed -n "${1}p"
}

compose_call_count() {
    cat "$COMPOSE_CALLS_FILE"
}

run_docker_compose() {
    if printf '%s\n' "$*" | grep -q 'config --services'; then
        printf 'open-webui\n'
        return 0
    fi

    local compose_calls=""
    compose_calls="$(compose_call_count)"
    compose_calls=$((compose_calls + 1))
    printf '%s\n' "$compose_calls" >"$COMPOSE_CALLS_FILE"
    local result=""
    result="$(next_compose_result "$compose_calls")"
    case "$result" in
        success)
            printf 'Compose started\n'
            return 0
            ;;
        exact)
            printf '%s\n' "$EXACT_SIGNATURE" >&2
            return 1
            ;;
        exact-pair)
            printf ' Container open-webui-health-check %s \n' "$EXACT_SIGNATURE" >&2
            printf '%s\n' "$EXACT_SIGNATURE" >&2
            return 1
            ;;
        exact-progress)
            printf ' Container portico-open-webui Recreated\n' >&2
            printf ' Container open-webui-health-check %s \n' "$EXACT_SIGNATURE" >&2
            printf '%s\n' "$EXACT_SIGNATURE" >&2
            return 1
            ;;
        other)
            printf 'unrelated Compose failure\n' >&2
            return 1
            ;;
        mixed)
            printf '%s\n' "$EXACT_SIGNATURE" >&2
            printf 'unauthorized: authentication required\n' >&2
            return 1
            ;;
        mixed-register)
            printf '%s\n' "$EXACT_SIGNATURE" >&2
            printf 'failed to register layer: unrelated terminal failure\n' >&2
            return 1
            ;;
        decorated-register)
            printf '\033[31m%s\033[0m   \n' "$EXACT_SIGNATURE" >&2
            printf 'failed to register layer: unrelated terminal failure\n' >&2
            return 1
            ;;
        near-register)
            printf '%s\n' "${EXACT_SIGNATURE/snapshots\/1137/snapshots\/not-numeric}" >&2
            printf 'failed to register layer: unrelated terminal failure\n' >&2
            return 1
            ;;
        wrong-case-register)
            printf '%s\n' "${EXACT_SIGNATURE/failed to stat parent/Failed to stat parent}" >&2
            printf 'failed to register layer: unrelated terminal failure\n' >&2
            return 1
            ;;
        split-register)
            printf '%s\n' "${EXACT_SIGNATURE/parent: stat/parent:}" >&2
            printf 'stat /var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/1137/fs: no such file or directory\n' >&2
            printf 'failed to register layer: unrelated terminal failure\n' >&2
            return 1
            ;;
        same-line-mixed)
            printf 'unauthorized: %s\n' "$EXACT_SIGNATURE" >&2
            return 1
            ;;
        no-space)
            printf '%s\n' "$EXACT_SIGNATURE" >&2
            printf 'no space left on device\n' >&2
            return 1
            ;;
        unexpected-eof)
            printf '%s\n' "$EXACT_SIGNATURE" >&2
            printf 'unexpected EOF\n' >&2
            return 1
            ;;
        near)
            printf '%s\n' "${EXACT_SIGNATURE/snapshots\/1137/snapshots\/not-numeric}" >&2
            return 1
            ;;
        suffix)
            printf '%s.bak\n' "$EXACT_SIGNATURE" >&2
            return 1
            ;;
        wrong-case)
            printf '%s\n' "${EXACT_SIGNATURE/failed to stat parent/Failed to stat parent}" >&2
            return 1
            ;;
        split)
            printf '%s\n' "${EXACT_SIGNATURE/parent: stat/parent:}" >&2
            printf 'stat /var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/1137/fs: no such file or directory\n' >&2
            return 1
            ;;
        *)
            printf 'missing fixture response for Compose call %s\n' "$compose_calls" >&2
            return 97
            ;;
    esac
}

repair_missing_overlayfs_snapshot_images() {
    REPAIR_CALLS=$((REPAIR_CALLS + 1))
    return "$REPAIR_RESULT"
}

cleanup_failed_register_layer_images() {
    LAYER_CLEANUP_CALLS=$((LAYER_CLEANUP_CALLS + 1))
    return 0
}

sleep() {
    SLEEP_CALLS=$((SLEEP_CALLS + 1))
    return 0
}

run_owner() {
    run_compose_up_with_retry "-f docker-compose.yml" "" >"$1" 2>&1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

[ "$(type -t run_docker_compose)" = "function" ] || fail_test "Compose fixture seam is not active"
[ "$(type -t repair_missing_overlayfs_snapshot_images)" = "function" ] || fail_test "repair fixture seam is not active"
[ "$(type -t sleep)" = "function" ] || fail_test "sleep fixture seam is not active"
[ "$(type -t docker)" = "function" ] || fail_test "direct Docker fail-closed sentinel is not active"

reset_fixture
COMPOSE_RESULTS=$'exact\nsuccess'
run_owner "$TMP_DIR/recovered.log" || fail_test "Compose did not recover after one repair"
[ "$(compose_call_count)" -eq 2 ] || fail_test "expected one failed operation and one full replay"
[ "$REPAIR_CALLS" -eq 1 ] || fail_test "expected exactly one repair"
[ "$SLEEP_CALLS" -eq 0 ] || fail_test "permanent signature entered generic backoff"

reset_fixture
COMPOSE_RESULTS=$'exact-pair\nsuccess'
run_owner "$TMP_DIR/recovered-production-pair.log" || fail_test "Compose did not recognize the production two-line signature"
[ "$(compose_call_count)" -eq 2 ] || fail_test "production pair did not receive exactly one replay"
[ "$REPAIR_CALLS" -eq 1 ] || fail_test "production pair did not receive exactly one repair"
[ "$LAYER_CLEANUP_CALLS" -eq 0 ] || fail_test "production pair entered legacy layer cleanup"

reset_fixture
COMPOSE_RESULTS=$'exact-progress\nsuccess'
run_owner "$TMP_DIR/recovered-production-progress.log" || fail_test "Compose rejected benign progress around the production signature"
[ "$(compose_call_count)" -eq 2 ] || fail_test "production progress did not receive exactly one replay"
[ "$REPAIR_CALLS" -eq 1 ] || fail_test "production progress did not receive exactly one repair"
[ "$LAYER_CLEANUP_CALLS" -eq 0 ] || fail_test "production progress entered legacy layer cleanup"

reset_fixture
COMPOSE_RESULTS=$'exact\nexact'
run_owner "$TMP_DIR/repeated.log" && fail_test "repeated permanent signature was accepted"
[ "$(compose_call_count)" -eq 2 ] || fail_test "repeated signature was retried beyond one replay"
[ "$REPAIR_CALLS" -eq 1 ] || fail_test "repeated signature triggered another repair"
[ "$SLEEP_CALLS" -eq 0 ] || fail_test "repeated signature entered generic backoff"

reset_fixture
COMPOSE_RESULTS='exact'
REPAIR_RESULT=1
run_owner "$TMP_DIR/refused.log" && fail_test "unsafe repair failure was accepted"
[ "$(compose_call_count)" -eq 1 ] || fail_test "Compose replayed after repair refusal"
[ "$REPAIR_CALLS" -eq 1 ] || fail_test "repair refusal call count was incorrect"
[ "$SLEEP_CALLS" -eq 0 ] || fail_test "repair refusal entered generic backoff"

reset_fixture
COMPOSE_RESULTS=$'exact\nother'
run_owner "$TMP_DIR/replay-other.log" && fail_test "post-repair unrelated failure unexpectedly succeeded"
[ "$(compose_call_count)" -eq 2 ] || fail_test "post-repair unrelated failure escaped the terminal replay boundary"
[ "$REPAIR_CALLS" -eq 1 ] || fail_test "post-repair unrelated failure changed repair count"
[ "$SLEEP_CALLS" -eq 0 ] || fail_test "post-repair unrelated failure entered generic backoff"

reset_fixture
COMPOSE_RESULTS=$'other\nother\nother'
run_owner "$TMP_DIR/unrelated.log" && fail_test "unrelated failures unexpectedly succeeded"
[ "$(compose_call_count)" -eq 3 ] || fail_test "unrelated failure lost generic retries"
[ "$REPAIR_CALLS" -eq 0 ] || fail_test "unrelated failure triggered snapshot repair"
[ "$SLEEP_CALLS" -eq 2 ] || fail_test "unrelated failure lost generic backoff"

reset_fixture
COMPOSE_RESULTS=$'near\nnear\nnear'
run_owner "$TMP_DIR/near-miss.log" && fail_test "near-miss failures unexpectedly succeeded"
[ "$(compose_call_count)" -eq 1 ] || fail_test "signature-like near miss was retried"
[ "$REPAIR_CALLS" -eq 0 ] || fail_test "near-miss signature triggered snapshot repair"
[ "$SLEEP_CALLS" -eq 0 ] || fail_test "signature-like near miss entered generic backoff"
[ "$LAYER_CLEANUP_CALLS" -eq 0 ] || fail_test "signature-like near miss entered legacy layer cleanup"

reset_fixture
COMPOSE_RESULTS='mixed'
run_owner "$TMP_DIR/mixed.log" && fail_test "mixed failures unexpectedly succeeded"
[ "$(compose_call_count)" -eq 1 ] || fail_test "mixed failure was retried"
[ "$REPAIR_CALLS" -eq 0 ] || fail_test "mixed exact and unrelated failures triggered snapshot repair"
[ "$SLEEP_CALLS" -eq 0 ] || fail_test "mixed failure entered generic backoff"
[ "$LAYER_CLEANUP_CALLS" -eq 0 ] || fail_test "mixed failure entered legacy layer cleanup"

for mixed_failure in mixed-register decorated-register near-register wrong-case-register split-register same-line-mixed no-space unexpected-eof suffix; do
    reset_fixture
    COMPOSE_RESULTS="$mixed_failure"
    run_owner "$TMP_DIR/${mixed_failure}.log" && fail_test "$mixed_failure unexpectedly succeeded"
    [ "$(compose_call_count)" -eq 1 ] || fail_test "$mixed_failure was retried"
    [ "$REPAIR_CALLS" -eq 0 ] || fail_test "$mixed_failure triggered snapshot repair"
    [ "$SLEEP_CALLS" -eq 0 ] || fail_test "$mixed_failure entered generic backoff"
    [ "$LAYER_CLEANUP_CALLS" -eq 0 ] || fail_test "$mixed_failure entered legacy layer cleanup"
done

for near_miss in wrong-case split; do
    reset_fixture
    COMPOSE_RESULTS="$(printf '%s\n%s\n%s\n' "$near_miss" "$near_miss" "$near_miss")"
    run_owner "$TMP_DIR/${near_miss}.log" && fail_test "$near_miss signature unexpectedly succeeded"
    [ "$(compose_call_count)" -eq 1 ] || fail_test "$near_miss signature was retried"
    [ "$REPAIR_CALLS" -eq 0 ] || fail_test "$near_miss signature triggered snapshot repair"
    [ "$SLEEP_CALLS" -eq 0 ] || fail_test "$near_miss signature entered generic backoff"
    [ "$LAYER_CLEANUP_CALLS" -eq 0 ] || fail_test "$near_miss signature entered legacy layer cleanup"
done

printf '[OK] Compose snapshot-store recovery behavioral tests passed (%s scenarios)\n' "$SCENARIO_COUNT"
