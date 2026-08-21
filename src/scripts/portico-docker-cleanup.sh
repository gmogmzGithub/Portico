#!/usr/bin/env bash

# portico-docker-cleanup — reclaim old Portico Docker image tags (PORTICO-205).
#
# Selects images by Harbor repo/tag identity (never labels — the historical
# backlog is unlabeled), always retains the current AND previous release, and
# FAILS CLOSED (deletes nothing) when release detection is not possible.
#
# The recurring cleanup contract is images/tags ONLY: this script never
# touches containers, volumes (named or anonymous), or BuildKit build cache.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./mcp-orc-backend.sh
source "$SCRIPT_DIR/mcp-orc-backend.sh"

MANAGED_DIR="${PORTICO_MANAGED_DIR:-$HOME/portico/portico-managed}"

# Release build tags look like MMDDYYYY-<short sha>, e.g. 09172025-53f6ab6b.
RELEASE_TAG_PATTERN='^[0-9]{8}-[0-9a-f]+$'
DOCKER_IMAGE_INSPECT_FORMAT='{{.Id}}{{"\t"}}{{.Size}}{{"\t"}}{{.Created}}'

usage() {
  cat <<'EOF'
Usage: portico-docker-cleanup.sh [--apply]
       [--expected-current-tag TAG --expected-previous-tag TAG] [-h|--help]

Reports old, unused Portico Docker image tags and the disk space they
hold. DRY-RUN BY DEFAULT: nothing is deleted unless --apply is passed.

Selection and safety rules:
  - Images are selected by Harbor repo/tag identity only
    (harbor.example.invalid/portico/*, portico-*, agent-vm:*).
  - The current AND previous release build tags are always retained, as are
    release tags newer than the current one (in-flight/MR builds).
  - Release detection FAILS CLOSED: if the managed runtime or its compose
    image set cannot be resolved, the script deletes nothing and exits 3.
  - Image tags referenced by any container (including stopped ones) are
    never removed, and `docker image rm` is never forced.
  - Containers, volumes, and BuildKit build cache are never touched.
  - On hosts without a release install (local `:latest` images only), the two
    newest release build tags found locally are retained instead.

Options:
  --apply     Delete the selected image tags. Without this flag the script
              only reports what it would delete.
  --expected-current-tag TAG
  --expected-previous-tag TAG
              Pin cleanup to an audited release transition. These options
              must be supplied together with distinct release-format tags.
  -h, --help  Show this help.

Environment:
  PORTICO_MANAGED_DIR  Managed runtime directory
                              (default: ~/portico/portico-managed)
  portico_ORBSTACK_DATA_IMG       Override path of the OrbStack data image used
                              for host-level disk reporting.

Exit codes:
  0    success (including "nothing to delete")
  1    docker unavailable, or at least one deletion failed
  2    usage error
  3    release detection failed — nothing was deleted (fail closed)
  125  no Docker Compose frontend available — nothing was deleted
EOF
}

APPLY_MODE=false
EXPECTED_CURRENT_TAG=""
EXPECTED_PREVIOUS_TAG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY_MODE=true
      shift
      ;;
    --expected-current-tag)
      [ "$#" -ge 2 ] || { echo "--expected-current-tag requires TAG" >&2; exit 2; }
      EXPECTED_CURRENT_TAG="$2"
      shift 2
      ;;
    --expected-previous-tag)
      [ "$#" -ge 2 ] || { echo "--expected-previous-tag requires TAG" >&2; exit 2; }
      EXPECTED_PREVIOUS_TAG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if { [ -n "$EXPECTED_CURRENT_TAG" ] && [ -z "$EXPECTED_PREVIOUS_TAG" ]; } \
  || { [ -z "$EXPECTED_CURRENT_TAG" ] && [ -n "$EXPECTED_PREVIOUS_TAG" ]; }; then
  echo "--expected-current-tag and --expected-previous-tag must be supplied together" >&2
  exit 2
fi
if [ -n "$EXPECTED_CURRENT_TAG" ]; then
  if ! [[ "$EXPECTED_CURRENT_TAG" =~ $RELEASE_TAG_PATTERN ]] \
    || ! [[ "$EXPECTED_PREVIOUS_TAG" =~ $RELEASE_TAG_PATTERN ]]; then
    echo "expected tags must use release format MMDDYYYY-<hex sha>" >&2
    exit 2
  fi
  if [ "$EXPECTED_CURRENT_TAG" = "$EXPECTED_PREVIOUS_TAG" ]; then
    echo "expected current and previous tags must be distinct" >&2
    exit 2
  fi
fi

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed or not on PATH." >&2
    exit 1
  fi
}

# Resolve a working python3, bypassing asdf/mise shims (install_v2.sh pattern).
resolve_python3() {
  local candidate
  for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  return 1
}

is_portico_ref() {
  case "$1" in
    harbor.example.invalid/portico/*|portico-*|agent-vm:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_current_or_alias_ref() {
  case "$1" in
    *:latest|*:\<none\>|\<none\>:\<none\>)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_release_tag() {
  [[ "$1" =~ $RELEASE_TAG_PATTERN ]]
}

# MMDDYYYY-<sha> -> sortable YYYYMMDD date key.
release_tag_date_key() {
  local tag="$1"
  printf '%s%s%s' "${tag:4:4}" "${tag:0:2}" "${tag:2:2}"
}

format_bytes() {
  awk -v bytes="${1:-0}" '
    BEGIN {
      split("B KB MB GB TB", units, " ")
      value = bytes + 0
      unit = 1
      while (value >= 1024 && unit < 5) {
        value = value / 1024
        unit++
      }
      if (unit == 1) {
        printf "%d %s", value, units[unit]
      } else if (value >= 10) {
        printf "%.1f %s", value, units[unit]
      } else {
        printf "%.2f %s", value, units[unit]
      }
    }
  '
}

fail_closed() {
  echo "FAIL-CLOSED: $1" >&2
  echo "Nothing was deleted. Fix the condition above (or set PORTICO_MANAGED_DIR) and re-run." >&2
  exit 3
}

fail_closed_during_apply() {
  echo "FAIL-CLOSED: $1" >&2
  echo "Cleanup stopped before touching that ref; earlier selected refs may already have been removed safely." >&2
  exit 3
}

fail_unsafe_docker_target() {
  echo "ERROR: $1" >&2
  echo "Nothing was deleted. Point Docker at the local OrbStack/Docker Desktop engine and re-run." >&2
  exit 1
}

require_local_docker_target() {
  local active_context context_host

  if [ -n "${DOCKER_HOST:-}" ]; then
    fail_unsafe_docker_target "DOCKER_HOST is set ('$DOCKER_HOST'); Docker commands may target a remote/shared engine."
  fi

  active_context="$(docker context show 2>/dev/null || true)"
  if [ -z "$active_context" ]; then
    fail_unsafe_docker_target "Could not determine the active Docker context."
  fi

  context_host="$(docker context inspect "$active_context" \
    --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null || true)"
  context_host="$(printf '%s\n' "$context_host" | sed -n '1p')"
  case "$context_host" in
    unix://*)
      ;;
    *)
      fail_unsafe_docker_target "Docker context '$active_context' points at '${context_host:-unknown}', not a local Unix socket."
      ;;
  esac
}

resolve_orbstack_data_img() {
  if [ -n "${portico_ORBSTACK_DATA_IMG:-}" ]; then
    if [ -f "$portico_ORBSTACK_DATA_IMG" ]; then
      printf '%s\n' "$portico_ORBSTACK_DATA_IMG"
      return 0
    fi
    return 1
  fi
  local match
  for match in "$HOME/Library/Group Containers/"*orbstack*/data/data.img.raw; do
    if [ -f "$match" ]; then
      printf '%s\n' "$match"
      return 0
    fi
  done
  return 1
}

report_host_level_usage() {
  local label="$1"
  local data_img allocated_kib
  if data_img="$(resolve_orbstack_data_img)"; then
    allocated_kib="$(du -k "$data_img" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [ -n "$allocated_kib" ]; then
      echo "macOS host-level OrbStack data image ($label): $(format_bytes $((allocated_kib * 1024))) allocated"
      return 0
    fi
  fi
  echo "macOS host-level OrbStack data image ($label): n/a (no OrbStack data image found)"
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

all_images_file="$tmp_dir/all-images.tsv"
candidate_file="$tmp_dir/candidates.tsv"
keep_refs_file="$tmp_dir/keep-refs.txt"
protected_tags_file="$tmp_dir/protected-tags.txt"
release_tags_file="$tmp_dir/release-tags.tsv"
used_ids_file="$tmp_dir/used-ids.txt"
blocked_ids_file="$tmp_dir/blocked-ids.txt"
reclaimable_ids_file="$tmp_dir/reclaimable-ids.tsv"
tag_only_file="$tmp_dir/tag-only.tsv"
cleanup_refs_file="$tmp_dir/cleanup-refs.txt"
failed_refs_file="$tmp_dir/failed-refs.txt"

touch "$all_images_file" "$candidate_file" "$keep_refs_file" \
  "$protected_tags_file" "$release_tags_file" "$used_ids_file" \
  "$blocked_ids_file" "$reclaimable_ids_file" "$tag_only_file" \
  "$cleanup_refs_file" "$failed_refs_file"

require_docker
require_local_docker_target
require_docker_compose_frontend

# ---------------------------------------------------------------------------
# Release detection — FAIL CLOSED on any failure (PORTICO-205 requirement).
# ---------------------------------------------------------------------------

if [ ! -d "$MANAGED_DIR" ]; then
  fail_closed "managed runtime directory not found: $MANAGED_DIR"
fi

compose_rc=0
compose_images="$(
  cd "$MANAGED_DIR" 2>/dev/null || exit 9
  set -- -f docker-compose.yml
  [ -f docker-compose.advanced.yml ] && set -- "$@" -f docker-compose.advanced.yml
  [ -f docker-compose.override.yml ] && set -- "$@" -f docker-compose.override.yml
  [ -f docker-compose.harbor.yml ] && set -- "$@" -f docker-compose.harbor.yml
  run_docker_compose "$@" config --images 2>/dev/null
)" || compose_rc=$?

if [ "$compose_rc" -ne 0 ]; then
  fail_closed "could not resolve the managed compose image set (docker compose config --images failed in $MANAGED_DIR)"
fi

printf '%s\n' "$compose_images" | sed '/^$/d' | sort -u > "$keep_refs_file"

if [ ! -s "$keep_refs_file" ]; then
  fail_closed "the managed compose image set is empty in $MANAGED_DIR"
fi

if [ -n "$EXPECTED_CURRENT_TAG" ]; then
  build_info_file="$MANAGED_DIR/electron-app/build-info.json"
  [ -f "$build_info_file" ] || fail_closed "managed build-info.json is missing in exact transition mode"
  PYTHON3="$(resolve_python3)" || fail_closed "python3 is required to validate managed build-info.json"
  build_number="$("$PYTHON3" - "$build_info_file" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        print(str(json.load(fh).get("buildNumber", "")).strip())
except Exception:
    pass
PY
  )"
  [ "$build_number" = "$EXPECTED_CURRENT_TAG" ] \
    || fail_closed "managed build-info.json does not match expected current tag $EXPECTED_CURRENT_TAG"

  managed_ref_count=0
  while IFS= read -r ref; do
    is_portico_ref "$ref" || continue
    managed_ref_count=$((managed_ref_count + 1))
    [ "${ref##*:}" = "$EXPECTED_CURRENT_TAG" ] \
      || fail_closed "managed compose image '$ref' does not use expected current tag $EXPECTED_CURRENT_TAG"
  done < "$keep_refs_file"
  [ "$managed_ref_count" -gt 0 ] \
    || fail_closed "managed compose contains no Portico image refs in exact transition mode"
fi

# Current release tag: newest release-format tag among the compose refs,
# falling back to buildNumber from the managed build-info.json (local
# ':latest' installs keep compose refs untagged by build).
current_tag="$EXPECTED_CURRENT_TAG"
while IFS= read -r ref; do
  tag="${ref##*:}"
  if [ -z "$EXPECTED_CURRENT_TAG" ] && is_release_tag "$tag"; then
    if [ -z "$current_tag" ] \
      || [ "$(release_tag_date_key "$tag")" \> "$(release_tag_date_key "$current_tag")" ]; then
      current_tag="$tag"
    fi
  fi
done < "$keep_refs_file"

if [ -z "$current_tag" ]; then
  build_info_file="$MANAGED_DIR/electron-app/build-info.json"
  if [ -f "$build_info_file" ] && PYTHON3="$(resolve_python3)"; then
    build_number="$(
      "$PYTHON3" - "$build_info_file" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        print(str(json.load(fh).get("buildNumber", "")).strip())
except Exception:
    pass
PY
    )"
    if [ -n "$build_number" ] && is_release_tag "$build_number"; then
      current_tag="$build_number"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Inventory: every local image tag with ID, size, and creation time.
# ---------------------------------------------------------------------------

image_refs_file="$tmp_dir/image-refs.txt"
container_ids_file="$tmp_dir/container-ids.txt"
if ! docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}}' > "$image_refs_file" 2>/dev/null; then
  [ "$APPLY_MODE" = false ] || fail_closed "Docker image inventory could not be listed"
fi
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  [ "$ref" != '<none>:<none>' ] || continue
  if ! image_info="$(docker image inspect --format "$DOCKER_IMAGE_INSPECT_FORMAT" "$ref" 2>/dev/null)"; then
    [ "$APPLY_MODE" = false ] || fail_closed "Docker image inspect failed for $ref"
    continue
  fi
  IFS=$'\t' read -r image_id image_size image_created extra <<< "$image_info"
  if [ -z "$image_id" ] || [ -z "$image_size" ] || [ -z "$image_created" ] || [ -n "${extra:-}" ]; then
    [ "$APPLY_MODE" = false ] || fail_closed "Docker image inspect returned an incomplete inventory for $ref"
    continue
  fi
  printf '%s\t%s\t%s\t%s\n' "$ref" "$image_id" "$image_size" "$image_created" >> "$all_images_file"
done < "$image_refs_file"

if ! docker ps -aq > "$container_ids_file" 2>/dev/null; then
  [ "$APPLY_MODE" = false ] || fail_closed "Docker container inventory could not be listed"
fi
while IFS= read -r container_id; do
  [ -n "$container_id" ] || continue
  if ! image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null)" \
    || [ -z "$image_id" ]; then
    [ "$APPLY_MODE" = false ] || fail_closed "Docker container inspect failed for $container_id"
    continue
  fi
  printf '%s\n' "$image_id" >> "$used_ids_file"
done < "$container_ids_file"
sort -u "$used_ids_file" -o "$used_ids_file"

# ---------------------------------------------------------------------------
# Release retention: keep current + previous release tags and any release
# tags newer than current. Tags (refs) are protected, not image IDs, because
# --retag-only releases can share one image ID across build tags.
# ---------------------------------------------------------------------------

# Distinct release tags found on PORTICO images: tag <TAB> date-key <TAB> created,
# newest first (date key, then image creation time for same-day builds).
while IFS=$'\t' read -r ref image_id image_size image_created; do
  [ -n "$ref" ] || continue
  is_portico_ref "$ref" || continue
  tag="${ref##*:}"
  is_release_tag "$tag" || continue
  printf '%s\t%s\t%s\n' "$tag" "$(release_tag_date_key "$tag")" "$image_created"
done < "$all_images_file" \
  | sort -t "$(printf '\t')" -k1,1 -k3,3r \
  | awk -F '\t' '!seen[$1]++' \
  | sort -t "$(printf '\t')" -k2,2r -k3,3r > "$release_tags_file"

previous_tag=""
if [ -n "$current_tag" ]; then
  current_key="$(release_tag_date_key "$current_tag")"
  if [ -n "$EXPECTED_PREVIOUS_TAG" ]; then
    previous_tag="$EXPECTED_PREVIOUS_TAG"
    printf '%s\n' "$previous_tag" >> "$protected_tags_file"
  fi
  while IFS=$'\t' read -r tag date_key created; do
    [ -n "$tag" ] || continue
    if [ "$tag" = "$current_tag" ]; then
      printf '%s\n' "$tag" >> "$protected_tags_file"
      continue
    fi
    if [ "$date_key" \> "$current_key" ]; then
      # Newer than the current release (in-flight/MR/future build): retain.
      printf '%s\n' "$tag" >> "$protected_tags_file"
      continue
    fi
    if [ "$date_key" = "$current_key" ]; then
      # Creation timestamps do not establish release ordering. Preserve every
      # tag with the current release's date (including prepared/future tags).
      printf '%s\n' "$tag" >> "$protected_tags_file"
      continue
    fi
    if [ -z "$EXPECTED_PREVIOUS_TAG" ] && [ -z "$previous_tag" ]; then
      # Newest release tag strictly older than current: the previous release.
      previous_tag="$tag"
      printf '%s\n' "$tag" >> "$protected_tags_file"
    fi
  done < "$release_tags_file"
  # The current tag is protected even when no local image carries it yet.
  printf '%s\n' "$current_tag" >> "$protected_tags_file"
else
  # No release install detected (local ':latest' mode): retain the two newest
  # release tags present locally — degrades toward keeping more, never less.
  head -n 2 "$release_tags_file" | cut -f1 >> "$protected_tags_file"
fi

sort -u "$protected_tags_file" -o "$protected_tags_file"

is_protected_tag() {
  grep -Fxq "$1" "$protected_tags_file"
}

# ---------------------------------------------------------------------------
# Candidate selection.
# ---------------------------------------------------------------------------

while IFS=$'\t' read -r ref image_id image_size image_created; do
  [ -n "$ref" ] || continue

  if ! is_portico_ref "$ref"; then
    continue
  fi

  if is_current_or_alias_ref "$ref"; then
    continue
  fi

  if grep -Fxq "$ref" "$keep_refs_file"; then
    continue
  fi

  if is_protected_tag "${ref##*:}"; then
    continue
  fi

  if grep -Fxq "$image_id" "$used_ids_file"; then
    continue
  fi

  printf '%s\t%s\t%s\n' "$ref" "$image_id" "$image_size" >> "$candidate_file"
done < "$all_images_file"

# Image IDs that must survive: every ID carried by at least one non-candidate
# ref. Candidates whose ID is blocked are tag-only aliases (no reclaimed
# bytes); deleting the tag never deletes the image data.
while IFS=$'\t' read -r ref image_id image_size image_created; do
  [ -n "$ref" ] || continue

  if grep -Fxq "$image_id" "$used_ids_file"; then
    printf '%s\n' "$image_id"
    continue
  fi

  if grep -Fxq "$ref" "$keep_refs_file"; then
    printf '%s\n' "$image_id"
    continue
  fi

  if ! is_portico_ref "$ref"; then
    printf '%s\n' "$image_id"
    continue
  fi

  if is_current_or_alias_ref "$ref"; then
    printf '%s\n' "$image_id"
    continue
  fi

  if is_protected_tag "${ref##*:}"; then
    printf '%s\n' "$image_id"
    continue
  fi
done < "$all_images_file" | sort -u > "$blocked_ids_file"

while IFS=$'\t' read -r ref image_id image_size; do
  [ -n "$ref" ] || continue

  if grep -Fxq "$image_id" "$blocked_ids_file"; then
    printf '%s\t%s\t%s\n' "$ref" "$image_id" "$image_size" >> "$tag_only_file"
    continue
  fi

  if ! grep -Fq "$(printf '%s\t' "$image_id")" "$reclaimable_ids_file"; then
    printf '%s\t%s\t%s\n' "$image_id" "$image_size" "$ref" >> "$reclaimable_ids_file"
  fi
done < "$candidate_file"

candidate_count="$(wc -l < "$candidate_file" | tr -d ' ')"
reclaimable_count="$(wc -l < "$reclaimable_ids_file" | tr -d ' ')"
tag_only_count="$(wc -l < "$tag_only_file" | tr -d ' ')"
total_bytes="$(
  awk -F '\t' '{ total += $2 } END { printf "%.0f\n", total + 0 }' "$reclaimable_ids_file"
)"

# ---------------------------------------------------------------------------
# Report.
# ---------------------------------------------------------------------------

echo "Portico Docker image cleanup report"
if [ "$APPLY_MODE" = true ]; then
  echo "Mode: APPLY (selected image tags will be deleted)"
else
  echo "Mode: DRY RUN (default — nothing will be deleted; re-run with --apply)"
fi
echo "Managed runtime: $MANAGED_DIR"
echo "Release retention: current=${current_tag:-<local :latest install>} previous=${previous_tag:-<none found>}"
if [ -z "$current_tag" ] && [ -s "$protected_tags_file" ]; then
  echo "Release retention fallback: keeping the two newest local release tags:"
  sed 's/^/  /' "$protected_tags_file"
fi
echo "Containers, volumes, and build cache are never touched by this tool."
echo
report_host_level_usage "before"
echo

if [ "$candidate_count" -eq 0 ]; then
  echo "No old, unused Portico Docker image tags were found."
  echo "Estimated reclaimable space: 0 B"
  exit 0
fi

echo "Old unused Portico image tags found: $candidate_count"
echo "Image objects that can reclaim space: $reclaimable_count"
echo "Tag-only aliases with no unique reclaimable bytes: $tag_only_count"
echo "Estimated reclaimable space: $(format_bytes "$total_bytes") ($total_bytes bytes)"
echo

echo "Image tags selected for cleanup:"
while IFS=$'\t' read -r ref image_id image_size; do
  [ -n "$ref" ] || continue
  printf '%s\t%s\n' "$ref" "$image_id" >> "$cleanup_refs_file"
  printf '  %s  %s\n' "$(format_bytes "$image_size")" "$ref"
done < "$candidate_file"
echo

if [ "$reclaimable_count" -gt 0 ]; then
  echo "Images contributing to the estimate:"
  while IFS=$'\t' read -r image_id image_size ref; do
    [ -n "$image_id" ] || continue
    printf '  %s  %s\n' "$(format_bytes "$image_size")" "$ref"
  done < "$reclaimable_ids_file"
else
  echo "No image objects would reclaim disk space; the matching tags are aliases of kept or current images."
fi

if [ "$tag_only_count" -gt 0 ]; then
  echo
  echo "Tag-only aliases selected for cleanup, but not counted as reclaimable bytes:"
  while IFS=$'\t' read -r ref image_id image_size; do
    [ -n "$ref" ] || continue
    printf '  %s  %s\n' "$(format_bytes "$image_size")" "$ref"
  done < "$tag_only_file"
fi

echo

if [ "$APPLY_MODE" = false ]; then
  echo "Dry run complete. No Docker images were deleted."
  echo "Re-run with --apply to delete the image tags listed above."
  exit 0
fi

# ---------------------------------------------------------------------------
# Apply.
# ---------------------------------------------------------------------------

current_image_id_for_ref() {
  local ref="$1"
  local image_info image_id image_size image_created extra
  if ! image_info="$(docker image inspect --format "$DOCKER_IMAGE_INSPECT_FORMAT" "$ref" 2>/dev/null)"; then
    return 1
  fi
  IFS=$'\t' read -r image_id image_size image_created extra <<< "$image_info"
  if [ -z "$image_id" ] || [ -z "$image_size" ] || [ -z "$image_created" ] || [ -n "${extra:-}" ]; then
    return 1
  fi
  printf '%s\n' "$image_id"
}

# Bind the destructive plan to the image IDs that were inventoried. A
# concurrent pull/build may move a tag after candidate selection; validate the
# complete plan before deleting anything, then validate each ref again at the
# last possible moment. Any missing, malformed, or rebound ref fails closed.
while IFS=$'\t' read -r ref inventoried_id; do
  [ -n "$ref" ] || continue
  if ! current_id="$(current_image_id_for_ref "$ref")"; then
    fail_closed "Docker image ref changed or became unreadable before cleanup: $ref"
  fi
  [ "$current_id" = "$inventoried_id" ] \
    || fail_closed "Docker image ref was rebound before cleanup: $ref"
done < "$cleanup_refs_file"

deleted_count=0
failed_count=0

while IFS=$'\t' read -r ref inventoried_id; do
  [ -n "$ref" ] || continue
  if ! current_id="$(current_image_id_for_ref "$ref")"; then
    fail_closed_during_apply "Docker image ref changed or became unreadable during cleanup: $ref"
  fi
  [ "$current_id" = "$inventoried_id" ] \
    || fail_closed_during_apply "Docker image ref was rebound during cleanup: $ref"
  if docker image rm "$ref"; then
    deleted_count=$((deleted_count + 1))
  else
    failed_count=$((failed_count + 1))
    printf '%s\n' "$ref" >> "$failed_refs_file"
  fi
done < "$cleanup_refs_file"

# Actual reclaim: reclaimable image objects none of whose tags failed to
# delete. failed-refs holds refs; candidates map ref -> id; reclaimable maps
# id -> unique size.
actual_bytes="$(
  awk -F '\t' '
    FILENAME == ARGV[1] { if ($0 != "") failed[$0] = 1; next }
    FILENAME == ARGV[2] { if ($1 in failed) id_failed[$2] = 1; next }
    { id_size[$1] = $2 }
    END {
      total = 0
      for (id in id_size) {
        if (!(id in id_failed)) total += id_size[id]
      }
      printf "%.0f\n", total
    }
  ' "$failed_refs_file" "$candidate_file" "$reclaimable_ids_file"
)"

echo
echo "Cleanup complete."
echo "Deleted image tags: $deleted_count"
echo "Reclaimed (Docker-reported image bytes): $(format_bytes "$actual_bytes") ($actual_bytes bytes)"
echo
docker system df 2>/dev/null || true
echo
report_host_level_usage "after"
echo "Note: OrbStack compacts its data image asynchronously — the host-level"
echo "number can lag the Docker-level reclaim by minutes."

if [ "$failed_count" -gt 0 ]; then
  echo "Failed to delete image tags: $failed_count"
  echo "Docker refused to delete these tags:"
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    printf '  %s\n' "$ref"
  done < "$failed_refs_file"
  exit 1
fi

echo "Docker reported no deletion failures."
