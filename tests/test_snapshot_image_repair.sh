#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPAIR_SCRIPT="$PROJECT_ROOT/src/scripts/repair-missing-overlayfs-snapshot-images.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

docker() {
    printf '[ERROR] unexpected direct Docker executable path\n' >&2
    return 98
}

# Load the real behavior, then replace its Docker boundary with an in-process
# fixture. No Docker binary, daemon, context, container, or image is touched.
source "$REPAIR_SCRIPT"

readonly REDIS_ID="sha256:$(printf 'a%.0s' {1..64})"
readonly AGENT_ID="sha256:$(printf 'b%.0s' {1..64})"
readonly OTHER_ID="sha256:$(printf 'c%.0s' {1..64})"
readonly DRIFT_ID="sha256:$(printf 'd%.0s' {1..64})"
readonly PARENT_ID="sha256:$(printf '9%.0s' {1..64})"
readonly REDIS_DIGEST="redis@sha256:$(printf 'e%.0s' {1..64})"
readonly CAPTURED_ENDPOINT="unix:///var/run/docker.sock"
SCENARIO_COUNT=0

fail_test() {
    printf '[ERROR] %s\n' "$*" >&2
    exit 1
}

reset_fixture() {
    SCENARIO_COUNT=$((SCENARIO_COUNT + 1))
    unset DOCKER_HOST DOCKER_CONTEXT
    FAKE_CONTEXT="default"
    FAKE_CONTEXT_HOST="$CAPTURED_ENDPOINT"
    FAKE_DAEMON_ID="daemon-a"
    FAKE_IMAGES="$(printf 'redis\t7-alpine\t%s\nexample/unrelated\tlatest\t%s\nexample/parent\tlatest\t%s\n' "$REDIS_ID" "$OTHER_ID" "$PARENT_ID")"
    FAKE_DIGESTS="$(printf '%s\t%s\n' "$REDIS_ID" "$REDIS_DIGEST")"
    FAKE_CONTAINERS=""
    FAKE_CONTEXT_SHOW_FAIL=false
    FAKE_CONTEXT_INSPECT_FAIL=false
    FAKE_CONTEXT_HOST_SWITCH_AT=0
    FAKE_INFO_FAIL_AT=0
    FAKE_DAEMON_SWITCH_AT=0
    FAKE_IMAGE_LS_FAIL_AT=0
    FAKE_IMAGE_DRIFT_AT=0
    FAKE_IMAGE_ALIAS_DRIFT_AT=0
    FAKE_IMAGE_INSPECT_FAIL=false
    FAKE_REF_RETARGET_AT=0
    FAKE_IDENTITY_EXTRA_TAG_AT=0
    FAKE_IDENTITY_EXTRA_DIGEST_AT=0
    FAKE_IMAGE_RM_FAIL=false
    FAKE_IMAGE_RM_PARTIAL=false
    FAKE_COLLATERAL_PARENT_PRUNED=false
    FAKE_CONTAINER_LS_FAIL_AT=0
    FAKE_CONTAINER_DRIFT_AT=0
    FAKE_CONTAINER_NAME_DRIFT_AT=0
    FAKE_CONTAINER_INSPECT_FAIL=false
    IMAGE_LS_COUNT_FILE="$TMP_DIR/image-ls-count"
    INFO_COUNT_FILE="$TMP_DIR/info-count"
    IMAGE_INSPECT_COUNT_FILE="$TMP_DIR/image-inspect-count"
    REF_INSPECT_COUNT_FILE="$TMP_DIR/ref-inspect-count"
    CONTAINER_LS_COUNT_FILE="$TMP_DIR/container-ls-count"
    CONTEXT_INSPECT_COUNT_FILE="$TMP_DIR/context-inspect-count"
    COMMAND_LOG="$TMP_DIR/commands"
    printf '0\n' >"$IMAGE_LS_COUNT_FILE"
    printf '0\n' >"$INFO_COUNT_FILE"
    printf '0\n' >"$IMAGE_INSPECT_COUNT_FILE"
    printf '0\n' >"$REF_INSPECT_COUNT_FILE"
    printf '0\n' >"$CONTAINER_LS_COUNT_FILE"
    printf '0\n' >"$CONTEXT_INSPECT_COUNT_FILE"
    : >"$COMMAND_LOG"
}

lookup_container_field() {
    local container_id="$1"
    local field_number="$2"
    printf '%s\n' "$FAKE_CONTAINERS" \
        | awk -F '\t' -v id="$container_id" -v field="$field_number" '$1 == id { print $field; found = 1 } END { exit found ? 0 : 1 }'
}

lookup_image_id() {
    local target_ref="$1"
    if is_valid_image_id "$target_ref"; then
        printf '%s\n' "$FAKE_IMAGES" \
            | awk -F '\t' -v id="$target_ref" '$3 == id { print id; found = 1; exit } END { exit found ? 0 : 1 }'
        return
    fi
    printf '%s\n' "$FAKE_IMAGES" \
        | awk -F '\t' -v ref="$target_ref" '$1 ":" $2 == ref { print $3; found = 1 } END { exit found ? 0 : 1 }'
}

lookup_image_tags() {
    local image_id="$1"
    printf '%s\n' "$FAKE_IMAGES" \
        | awk -F '\t' -v id="$image_id" '$3 == id && $1 != "<none>" && $2 != "<none>" { print $1 ":" $2 }'
}

lookup_image_digests() {
    local image_id="$1"
    printf '%s\n' "$FAKE_DIGESTS" \
        | awk -F '\t' -v id="$image_id" '$1 == id { print $2 }'
}

run_docker() {
    printf '%s\n' "$*" >>"$COMMAND_LOG"

    local pinned_endpoint=""
    if [ "${1:-}" = "--host" ]; then
        [ "$#" -ge 3 ] || return 97
        pinned_endpoint="$2"
        shift 2
        [ "$pinned_endpoint" = "$CAPTURED_ENDPOINT" ] || return 97
    elif [ "${1:-} ${2:-}" != "context show" ] && [ "${1:-} ${2:-}" != "context inspect" ]; then
        # Every authoritative command after context discovery must stay bound
        # to the captured local Unix endpoint.
        return 97
    fi

    case "$1 $2" in
        "context show")
            [ "$FAKE_CONTEXT_SHOW_FAIL" = false ] || return 1
            printf '%s\n' "$FAKE_CONTEXT"
            ;;
        "context inspect")
            [ "$FAKE_CONTEXT_INSPECT_FAIL" = false ] || return 1
            local context_inspect_count=""
            context_inspect_count="$(cat "$CONTEXT_INSPECT_COUNT_FILE")"
            context_inspect_count=$((context_inspect_count + 1))
            printf '%s\n' "$context_inspect_count" >"$CONTEXT_INSPECT_COUNT_FILE"
            if [ "$FAKE_CONTEXT_HOST_SWITCH_AT" -eq "$context_inspect_count" ]; then
                printf 'unix:///tmp/switched-docker.sock\n'
            else
                printf '%s\n' "$FAKE_CONTEXT_HOST"
            fi
            ;;
        "info --format")
            local info_count=""
            info_count="$(cat "$INFO_COUNT_FILE")"
            info_count=$((info_count + 1))
            printf '%s\n' "$info_count" >"$INFO_COUNT_FILE"
            [ "$FAKE_INFO_FAIL_AT" -ne "$info_count" ] || return 1
            if [ "$FAKE_DAEMON_SWITCH_AT" -eq "$info_count" ]; then
                printf 'daemon-b\n'
            else
                printf '%s\n' "$FAKE_DAEMON_ID"
            fi
            ;;
        "image ls")
            local count=""
            count="$(cat "$IMAGE_LS_COUNT_FILE")"
            count=$((count + 1))
            printf '%s\n' "$count" >"$IMAGE_LS_COUNT_FILE"
            if [ "$FAKE_IMAGE_LS_FAIL_AT" -eq "$count" ]; then
                return 1
            fi
            printf '%s\n' "$FAKE_IMAGES"
            if [ "$FAKE_IMAGE_DRIFT_AT" -eq "$count" ]; then
                printf 'example/drift\tlatest\t%s\n' "$DRIFT_ID"
            fi
            if [ "$FAKE_IMAGE_ALIAS_DRIFT_AT" -eq "$count" ]; then
                printf 'example/raced\tlatest\t%s\n' "$REDIS_ID"
            fi
            ;;
        "image inspect")
            [ "$FAKE_IMAGE_INSPECT_FAIL" = false ] || return 1
            local inspect_count=""
            inspect_count="$(cat "$IMAGE_INSPECT_COUNT_FILE")"
            inspect_count=$((inspect_count + 1))
            printf '%s\n' "$inspect_count" >"$IMAGE_INSPECT_COUNT_FILE"

            local target="$3"
            local ref_count=0
            if ! is_valid_image_id "$target"; then
                ref_count="$(cat "$REF_INSPECT_COUNT_FILE")"
                ref_count=$((ref_count + 1))
                printf '%s\n' "$ref_count" >"$REF_INSPECT_COUNT_FILE"
            fi

            local resolved_id=""
            resolved_id="$(lookup_image_id "$target")" || return 1
            if [ "$FAKE_REF_RETARGET_AT" -eq "$ref_count" ] && [ "$ref_count" -ne 0 ]; then
                resolved_id="$OTHER_ID"
            fi
            if [ "$5" = '{{.Id}}' ]; then
                printf '%s\n' "$resolved_id"
                return 0
            fi

            printf '%s\n' "$resolved_id"
            while IFS= read -r image_ref; do
                [ -n "$image_ref" ] && printf 'tag\t%s\n' "$image_ref"
            done < <(lookup_image_tags "$resolved_id")
            if [ "$FAKE_IDENTITY_EXTRA_TAG_AT" -eq "$inspect_count" ]; then
                printf 'tag\texample/raced:latest\n'
            fi
            while IFS= read -r digest_ref; do
                [ -n "$digest_ref" ] && printf 'digest\t%s\n' "$digest_ref"
            done < <(lookup_image_digests "$resolved_id")
            if [ "$FAKE_IDENTITY_EXTRA_DIGEST_AT" -eq "$inspect_count" ]; then
                printf 'digest\texample/raced@sha256:%s\n' "$(printf 'f%.0s' {1..64})"
            fi
            ;;
        "image rm")
            [ "$FAKE_IMAGE_RM_FAIL" = false ] || return 1
            shift 2
            local no_prune=false
            local -a target_ids=()
            local target_id=""
            for target_id in "$@"; do
                case "$target_id" in
                    --no-prune) no_prune=true ;;
                    --force|-f) return 96 ;;
                    *)
                        is_valid_image_id "$target_id" || return 95
                        target_ids+=("$target_id")
                        ;;
                esac
            done
            [ "${#target_ids[@]}" -gt 0 ] || return 95

            if [ "$no_prune" != true ]; then
                # Model Docker's default parent pruning so a regression that
                # omits --no-prune visibly mutates an unrelated image.
                FAKE_COLLATERAL_PARENT_PRUNED=true
                FAKE_IMAGES="$(printf '%s\n' "$FAKE_IMAGES" | awk -F '\t' -v id="$PARENT_ID" '$3 != id')"
            fi

            local removal_index=0
            for target_id in "${target_ids[@]}"; do
                removal_index=$((removal_index + 1))
                FAKE_IMAGES="$(printf '%s\n' "$FAKE_IMAGES" | awk -F '\t' -v id="$target_id" '$3 != id')"
                FAKE_DIGESTS="$(printf '%s\n' "$FAKE_DIGESTS" | awk -F '\t' -v id="$target_id" '$1 != id')"
                if [ "$FAKE_IMAGE_RM_PARTIAL" = true ] && [ "$removal_index" -eq 1 ]; then
                    return 1
                fi
            done
            ;;
        "container ls")
            local container_ls_count=""
            container_ls_count="$(cat "$CONTAINER_LS_COUNT_FILE")"
            container_ls_count=$((container_ls_count + 1))
            printf '%s\n' "$container_ls_count" >"$CONTAINER_LS_COUNT_FILE"
            [ "$FAKE_CONTAINER_LS_FAIL_AT" -ne "$container_ls_count" ] || return 1
            printf '%s\n' "$FAKE_CONTAINERS" | awk -F '\t' 'NF { print $1 }'
            if [ "$FAKE_CONTAINER_DRIFT_AT" -eq "$container_ls_count" ]; then
                printf 'raced-container\n'
            fi
            ;;
        "container inspect")
            [ "$FAKE_CONTAINER_INSPECT_FAIL" = false ] || return 1
            local format="${5:-}"
            case "$format" in
                *'.Image'*) lookup_container_field "$3" 2 ;;
                *'com.docker.compose.project'*) lookup_container_field "$3" 3 ;;
                *'.Name'*)
                    if [ "$FAKE_CONTAINER_NAME_DRIFT_AT" -eq "$(cat "$CONTAINER_LS_COUNT_FILE")" ]; then
                        printf '/open-webui\n'
                    else
                        lookup_container_field "$3" 4
                    fi
                    ;;
                *) return 1 ;;
            esac
            ;;
        *)
            return 99
            ;;
    esac
}

run_repair() {
    local output_file="$1"
    if main --apply-missing-overlayfs-parent-repair >"$output_file" 2>&1; then
        return 0
    else
        local status=$?
        return "$status"
    fi
}

assert_no_image_removal() {
    if grep -Eq '(^| )image rm( |$)' "$COMMAND_LOG"; then
        fail_test "fixture observed image removal after a refused repair"
    fi
}

[ "$(type -t run_docker)" = "function" ] || fail_test "Docker fixture seam is not active"
[ "$(type -t docker)" = "function" ] || fail_test "direct Docker fail-closed sentinel is not active"

reset_fixture
run_docker --host "$CAPTURED_ENDPOINT" image rm "$REDIS_ID" >/dev/null || fail_test "collateral-pruning fixture did not model default removal"
[ "$FAKE_COLLATERAL_PARENT_PRUNED" = true ] || fail_test "fixture did not model collateral parent pruning when --no-prune was absent"
if printf '%s\n' "$FAKE_IMAGES" | grep -Fq "$PARENT_ID"; then
    fail_test "collateral-pruning fixture retained the modeled parent image"
fi

reset_fixture
if main >"$TMP_DIR/missing-flag.log" 2>&1; then
    fail_test "repair accepted execution without the explicit flag"
fi
[ ! -s "$COMMAND_LOG" ] || fail_test "missing explicit flag reached Docker inventory"

reset_fixture
FAKE_IMAGES="$(printf 'redis\t7-alpine\t%s\nharbor.example.invalid/portico/agent-vm\tbuild-1\t%s\nexample/unrelated\tlatest\t%s\nexample/parent\tlatest\t%s\n' "$REDIS_ID" "$AGENT_ID" "$OTHER_ID" "$PARENT_ID")"
run_repair "$TMP_DIR/success.log" || fail_test "safe fixed-allowlist repair failed"
grep -Fqx -- "--host $CAPTURED_ENDPOINT image rm --no-prune $REDIS_ID $AGENT_ID" "$COMMAND_LOG" || fail_test "repair did not remove the revalidated immutable IDs with --no-prune in one non-force call"
[ "$FAKE_COLLATERAL_PARENT_PRUNED" = false ] || fail_test "repair pruned an unrelated parent image"
if awk -v host="--host $CAPTURED_ENDPOINT " '$0 !~ /^context (show|inspect)( |$)/ && index($0, host) != 1 { exit 1 }' "$COMMAND_LOG"; then
    :
else
    fail_test "an authoritative Docker operation escaped the captured local endpoint"
fi
if awk '/ image ls / && $0 !~ / image ls --all --no-trunc / { exit 1 }' "$COMMAND_LOG"; then
    :
else
    fail_test "an image inventory omitted --all or --no-trunc"
fi
removal_line="$(grep -n -F -- "--host $CAPTURED_ENDPOINT image rm --no-prune" "$COMMAND_LOG" | cut -d: -f1)"
[ -n "$removal_line" ] || fail_test "image removal was not observed"
previous_line="$(sed -n "$((removal_line - 1))p" "$COMMAND_LOG")"
[ "$previous_line" = "--host $CAPTURED_ENDPOINT info --format {{.ID}}" ] || fail_test "the pinned daemon-ID read was not immediately adjacent to image removal"
if grep -q -- '--force' "$COMMAND_LOG"; then
    fail_test "repair used a force option"
fi
if grep -Eq '(^| )(prune|volume rm|network rm|builder prune|container rm)( |$)' "$COMMAND_LOG"; then
    fail_test "repair invoked a forbidden Docker mutation"
fi

reset_fixture
FAKE_CONTAINERS="$(printf 'container-a\t%s\tportico\t/portico-open-webui\n' "$OTHER_ID")"
run_repair "$TMP_DIR/portico-container.log" && fail_test "repair accepted an PORTICO container"
assert_no_image_removal

reset_fixture
FAKE_CONTAINERS="$(printf 'container-name-only\t%s\tother-project\t/portico-worker\n' "$OTHER_ID")"
run_repair "$TMP_DIR/portico-container-name.log" && fail_test "repair accepted an PORTICO-named container"
assert_no_image_removal

for portico_container_name in docker-socket-proxy open-webui; do
    reset_fixture
    FAKE_CONTAINERS="$(printf 'container-name-only\t%s\tother-project\t/%s\n' "$OTHER_ID" "$portico_container_name")"
    run_repair "$TMP_DIR/portico-${portico_container_name}.log" && fail_test "repair accepted the unlabeled PORTICO container $portico_container_name"
    assert_no_image_removal
done

reset_fixture
FAKE_CONTAINERS="$(printf 'container-b\t%s\tother-project\t/unrelated\n' "$REDIS_ID")"
run_repair "$TMP_DIR/referenced.log" && fail_test "repair accepted a referenced candidate image"
assert_no_image_removal

reset_fixture
FAKE_CONTEXT_HOST="tcp://docker.example.test:2376"
run_repair "$TMP_DIR/remote.log" && fail_test "repair accepted a remote Docker context"
assert_no_image_removal

reset_fixture
DOCKER_HOST="tcp://docker.example.test:2376"
run_repair "$TMP_DIR/remote-env.log" && fail_test "repair accepted a remote DOCKER_HOST"
assert_no_image_removal

reset_fixture
DOCKER_HOST="unix:///tmp/different-docker.sock"
run_repair "$TMP_DIR/local-env-mismatch.log" && fail_test "repair accepted a local DOCKER_HOST that differed from the inspected context"
assert_no_image_removal

reset_fixture
DOCKER_CONTEXT="another-context"
run_repair "$TMP_DIR/context-mismatch.log" && fail_test "repair accepted a mismatched DOCKER_CONTEXT"
assert_no_image_removal

reset_fixture
FAKE_CONTEXT_INSPECT_FAIL=true
run_repair "$TMP_DIR/context-inspect.log" && fail_test "repair accepted failed context inspection"
assert_no_image_removal

reset_fixture
FAKE_CONTEXT_SHOW_FAIL=true
run_repair "$TMP_DIR/context-show.log" && fail_test "repair accepted failed context discovery"
assert_no_image_removal

reset_fixture
FAKE_INFO_FAIL_AT=1
run_repair "$TMP_DIR/daemon-inventory.log" && fail_test "repair accepted failed daemon inventory"
assert_no_image_removal

reset_fixture
FAKE_IMAGES="$(printf 'redis\t7-alpine\t%s\nexample/shared\tlatest\t%s\n' "$REDIS_ID" "$REDIS_ID")"
run_repair "$TMP_DIR/alias.log" && fail_test "repair accepted a candidate tagged outside the allowlist"
assert_no_image_removal

reset_fixture
FAKE_DIGESTS="$(printf '%s\texample/shared@sha256:%s\n' "$REDIS_ID" "$(printf 'f%.0s' {1..64})")"
run_repair "$TMP_DIR/digest-alias.log" && fail_test "repair accepted a RepoDigest outside the allowlist"
assert_no_image_removal

reset_fixture
FAKE_IMAGE_LS_FAIL_AT=1
run_repair "$TMP_DIR/inventory.log" && fail_test "repair accepted failed image inventory"
assert_no_image_removal

reset_fixture
FAKE_IMAGES="$(printf 'example/unrelated\tlatest\t%s\n' "$OTHER_ID")"
run_repair "$TMP_DIR/no-candidates.log" && fail_test "repair accepted an empty candidate set"
assert_no_image_removal

reset_fixture
FAKE_IMAGE_INSPECT_FAIL=true
run_repair "$TMP_DIR/image-inspect.log" && fail_test "repair accepted failed candidate inspection"
assert_no_image_removal

reset_fixture
FAKE_CONTAINER_LS_FAIL_AT=1
run_repair "$TMP_DIR/container-list.log" && fail_test "repair accepted failed container inventory"
assert_no_image_removal

reset_fixture
FAKE_CONTAINERS="$(printf 'container-c\t%s\tother-project\t/unrelated\n' "$OTHER_ID")"
FAKE_CONTAINER_INSPECT_FAIL=true
run_repair "$TMP_DIR/container-inspect.log" && fail_test "repair accepted failed container inspection"
assert_no_image_removal

reset_fixture
FAKE_IMAGE_DRIFT_AT=2
run_repair "$TMP_DIR/image-drift.log" && fail_test "repair accepted changing image inventory"
assert_no_image_removal

reset_fixture
FAKE_IMAGE_ALIAS_DRIFT_AT=2
run_repair "$TMP_DIR/new-alias.log" && fail_test "repair accepted a new image alias during validation"
assert_no_image_removal

reset_fixture
FAKE_IMAGE_ALIAS_DRIFT_AT=3
run_repair "$TMP_DIR/late-new-alias.log" && fail_test "repair accepted a new image alias at final revalidation"
assert_no_image_removal

reset_fixture
FAKE_REF_RETARGET_AT=2
run_repair "$TMP_DIR/retarget.log" && fail_test "repair accepted a tag retargeted after inventory"
assert_no_image_removal

reset_fixture
FAKE_REF_RETARGET_AT=3
run_repair "$TMP_DIR/late-retarget.log" && fail_test "repair accepted a tag retargeted at final revalidation"
assert_no_image_removal

reset_fixture
FAKE_IDENTITY_EXTRA_TAG_AT=3
run_repair "$TMP_DIR/hidden-tag-alias.log" && fail_test "repair accepted a new authoritative RepoTag during revalidation"
assert_no_image_removal

reset_fixture
FAKE_IDENTITY_EXTRA_DIGEST_AT=3
run_repair "$TMP_DIR/hidden-digest-alias.log" && fail_test "repair accepted a new authoritative RepoDigest during revalidation"
assert_no_image_removal

reset_fixture
FAKE_IDENTITY_EXTRA_TAG_AT=5
run_repair "$TMP_DIR/late-hidden-tag-alias.log" && fail_test "repair accepted a RepoTag added at final revalidation"
assert_no_image_removal

reset_fixture
FAKE_IDENTITY_EXTRA_DIGEST_AT=5
run_repair "$TMP_DIR/late-hidden-digest-alias.log" && fail_test "repair accepted a RepoDigest added at final revalidation"
assert_no_image_removal

reset_fixture
FAKE_DAEMON_SWITCH_AT=2
run_repair "$TMP_DIR/daemon-switch.log" && fail_test "repair accepted a daemon identity switch"
assert_no_image_removal

reset_fixture
FAKE_DAEMON_SWITCH_AT=3
run_repair "$TMP_DIR/late-daemon-switch.log" && fail_test "repair accepted a daemon switch immediately before final revalidation"
assert_no_image_removal

reset_fixture
FAKE_CONTEXT_HOST_SWITCH_AT=2
run_repair "$TMP_DIR/ambient-endpoint-switch.log" && fail_test "repair accepted an ambient context endpoint switch"
assert_no_image_removal
if awk -v host="--host $CAPTURED_ENDPOINT " '$0 !~ /^context (show|inspect)( |$)/ && index($0, host) != 1 { exit 1 }' "$COMMAND_LOG"; then
    :
else
    fail_test "ambient context drift redirected an authoritative operation away from the pinned endpoint"
fi

reset_fixture
FAKE_CONTAINER_DRIFT_AT=2
run_repair "$TMP_DIR/new-container.log" && fail_test "repair accepted a new container during validation"
assert_no_image_removal

reset_fixture
FAKE_CONTAINER_DRIFT_AT=3
run_repair "$TMP_DIR/late-new-container.log" && fail_test "repair accepted a new container at final revalidation"
assert_no_image_removal

reset_fixture
FAKE_CONTAINERS="$(printf 'container-c\t%s\tother-project\t/unrelated\n' "$OTHER_ID")"
FAKE_CONTAINER_NAME_DRIFT_AT=3
run_repair "$TMP_DIR/container-rename.log" && fail_test "repair accepted a container renamed to an PORTICO name at final revalidation"
assert_no_image_removal

reset_fixture
FAKE_CONTAINER_LS_FAIL_AT=2
run_repair "$TMP_DIR/container-readback.log" && fail_test "repair accepted failed container readback"
assert_no_image_removal

reset_fixture
FAKE_IMAGE_RM_FAIL=true
images_before_refusal="$FAKE_IMAGES"
run_repair "$TMP_DIR/removal.log" && fail_test "repair accepted failed image removal"
[ "$FAKE_IMAGES" = "$images_before_refusal" ] || fail_test "Docker refusal fixture mutated image inventory"
grep -Fqx -- "--host $CAPTURED_ENDPOINT image rm --no-prune $REDIS_ID" "$COMMAND_LOG" || fail_test "removal did not target the immutable candidate ID with --no-prune"
if grep -q -- '--force' "$COMMAND_LOG"; then
    fail_test "removal refusal used a force option"
fi

reset_fixture
FAKE_IMAGES="$(printf 'redis\t7-alpine\t%s\nharbor.example.invalid/portico/agent-vm\tbuild-1\t%s\nexample/unrelated\tlatest\t%s\nexample/parent\tlatest\t%s\n' "$REDIS_ID" "$AGENT_ID" "$OTHER_ID" "$PARENT_ID")"
FAKE_IMAGE_RM_PARTIAL=true
run_repair "$TMP_DIR/partial-removal.log" && fail_test "repair accepted a partial multi-ID image removal"
if printf '%s\n' "$FAKE_IMAGES" | grep -Fq "$REDIS_ID"; then
    fail_test "partial-removal fixture did not model the first immutable ID deletion"
fi
printf '%s\n' "$FAKE_IMAGES" | grep -Fq "$AGENT_ID" || fail_test "partial-removal fixture deleted more than its first immutable ID"
grep -Fqx -- "--host $CAPTURED_ENDPOINT image rm --no-prune $REDIS_ID $AGENT_ID" "$COMMAND_LOG" || fail_test "partial-removal path changed the bounded immutable-ID mutation"

reset_fixture
FAKE_IMAGE_LS_FAIL_AT=4
run_repair "$TMP_DIR/readback.log" && fail_test "repair accepted failed removal readback"

reset_fixture
FAKE_IMAGE_DRIFT_AT=4
run_repair "$TMP_DIR/post-removal-drift.log" && fail_test "repair accepted unrelated image drift after removal"

printf '[OK] snapshot image repair behavioral tests passed (%s scenarios)\n' "$SCENARIO_COUNT"
