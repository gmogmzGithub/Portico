#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MARK_SCRIPT="$PROJECT_ROOT/mark_cloudsmith_release_eol.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  local message="$3"
  grep -Fq "$expected" "$file" || fail "$message"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  local message="$3"
  ! grep -Fq "$unexpected" "$file" || fail "$message"
}

assert_json_tags() {
  local file="$1"
  local expected_action="$2"
  shift 2

  python3 - "$file" "$expected_action" "$@" <<'PY'
import json
import sys

path = sys.argv[1]
expected_action = sys.argv[2]
expected_tags = set(sys.argv[3:])
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

actual_tags = set(payload.get("tags") or [])
if payload.get("action") != expected_action:
    raise SystemExit(f"expected action {expected_action!r}, got {payload.get('action')!r}")
if payload.get("is_immutable") is not False:
    raise SystemExit("expected mutable tag operation")
if actual_tags != expected_tags:
    raise SystemExit(f"expected tags {sorted(expected_tags)!r}, got {sorted(actual_tags)!r}")
PY
}

write_fake_curl() {
  local fake_bin="$1"
  mkdir -p "$fake_bin"
  cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

method="GET"
output_file=""
body_file=""
url=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_file="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    -X)
      method="$2"
      shift 2
      ;;
    -H)
      shift 2
      ;;
    --data-binary)
      body_file="${2#@}"
      shift 2
      ;;
    -s|-S|-sS|-fsS|-f)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

[ -n "$output_file" ] || exit 97
[ -n "$url" ] || exit 98
mkdir -p "${FAKE_CURL_STATE:?}"

write_json() {
  local status="$1"
  local body="$2"
  printf '%s' "$body" >"$output_file"
  printf '%s' "$status"
}

package_json() {
  local package_name="$1"
  local build_id="$2"
  local slug="$3"
  local tag_mode="${4:-none}"
  python3 - "$package_name" "$build_id" "$slug" "$tag_mode" "${FAKE_MISSING_SLUG:-0}" <<'PY'
import json
import sys

package_name, build_id, slug, tag_mode, missing_slug = sys.argv[1:6]
tags = {}
if tag_mode == "routing":
    tags = {
        "info": [
            "portico-routing-v1",
            "portico-eol-true",
            "portico-force-update-true",
            "portico-redirect-portico_dev",
        ],
        "version": ["latest"],
    }
package = {
    "name": package_name,
    "version": build_id,
    "filename": f"{package_name}-{build_id}.zip",
    "uploaded_at": "2026-03-06T12:00:00.000Z",
    "tags": tags,
}
if missing_slug != "1":
    package["slug_perm"] = slug
print(json.dumps([package], separators=(",", ":")))
PY
}

if [[ "$url" == *"/api/v1/packages/portico/portico/"*"/tag/" ]]; then
  printf '%s %s %s\n' "$method" "$url" "${body_file:-}" >>"$FAKE_CURL_STATE/tag-requests.log"
  case "$url" in
    *"/beta-latest-slug/tag/"*)
      if [ -n "$body_file" ]; then
        python3 - "$body_file" "$FAKE_CURL_STATE" <<'PY'
import json
import os
import shutil
import sys

body_file, state_dir = sys.argv[1:3]
with open(body_file, "r", encoding="utf-8") as fh:
    payload = json.load(fh)
action = payload.get("action")
if action == "Add":
    target = "tag-add-body.json"
elif action == "Remove":
    target = "tag-remove-body.json"
else:
    target = "tag-unknown-body.json"
shutil.copyfile(body_file, os.path.join(state_dir, target))
PY
      fi
      write_json 200 '{"ok":true}'
      ;;
    *"/beta-exact-slug/tag/"*)
      [ -n "$body_file" ] && cp "$body_file" "$FAKE_CURL_STATE/tag-add-body.json"
      write_json 200 '{"ok":true}'
      ;;
    *)
      write_json 404 '{"detail":"Unknown package slug."}'
      ;;
  esac
  exit 0
fi

if [[ "$url" == *"/api/v1/packages/"* ]]; then
  if [[ "$url" == *"portico_dev"* ]]; then
    if [ "${FAKE_NO_DEV:-0}" = "1" ]; then
      write_json 200 '[]'
    else
      write_json 200 "$(package_json portico_dev 03172026-cccccccc dev-slug)"
    fi
    exit 0
  fi
  if [[ "$url" == *"03152026-aaaaaaaa"* ]]; then
    write_json 200 "$(package_json portico_beta 03152026-aaaaaaaa beta-exact-slug)"
    exit 0
  fi
  write_json 200 "$(package_json portico_beta 03162026-bbbbbbbb beta-latest-slug routing)"
  exit 0
fi

if [[ "$url" == *"/api/v2/metadata/"* ]]; then
  write_json 500 '{"detail":"metadata must not be used"}'
  exit 0
fi

write_json 404 '{"detail":"unknown fake curl route"}'
SH
  chmod +x "$fake_bin/curl"
}

run_marker() {
  local fixture="$1"
  shift
  FAKE_CURL_STATE="$fixture/state" \
  PATH="$fixture/bin:$PATH" \
  CLOUDSMITH_API_KEY="test-cloudsmith-key" \
  CLOUDSMITH_OWNER="portico" \
  CLOUDSMITH_REPO="portico" \
  CLOUDSMITH_API_BASE="https://fake.cloudsmith.test/api/v1" \
  "$MARK_SCRIPT" "$@"
}

new_fixture() {
  local name="$1"
  local fixture="$TMP_DIR/$name"
  mkdir -p "$fixture/state"
  write_fake_curl "$fixture/bin"
  printf '%s\n' "$fixture"
}

test_latest_adds_routing_tags() {
  local fixture output
  fixture="$(new_fixture latest-add)"
  output="$fixture/output.txt"

  run_marker "$fixture" --channel beta --latest --redirect-channel dev --reason "retire beta" --yes >"$output" 2>&1

  [ -f "$fixture/state/tag-add-body.json" ] || fail "latest marker did not add tags"
  assert_json_tags "$fixture/state/tag-add-body.json" Add \
    portico-routing-v1 \
    portico-eol-true \
    portico-force-update-true \
    portico-redirect-portico_dev
  assert_contains "$output" "Source package: portico_beta-03162026-bbbbbbbb.zip" "latest source package was not selected"
  assert_contains "$output" "Reason: retire beta" "reason was not logged for operator context"
  assert_not_contains "$fixture/state/tag-add-body.json" "retire beta" "reason was stored in Cloudsmith tag payload"
  assert_not_contains "$output" "test-cloudsmith-key" "script printed Cloudsmith API key"
}

test_exact_build_adds_routing_tags() {
  local fixture output
  fixture="$(new_fixture exact-add)"
  output="$fixture/output.txt"

  run_marker "$fixture" --channel beta --build-id 03152026-aaaaaaaa --redirect-channel dev --yes >"$output" 2>&1

  [ -f "$fixture/state/tag-add-body.json" ] || fail "exact build marker did not add tags"
  assert_json_tags "$fixture/state/tag-add-body.json" Add \
    portico-routing-v1 \
    portico-eol-true \
    portico-force-update-true \
    portico-redirect-portico_dev
  assert_contains "$output" "Source package: portico_beta-03152026-aaaaaaaa.zip" "exact source package was not selected"
}

test_clear_removes_only_routing_tags() {
  local fixture output
  fixture="$(new_fixture clear)"
  output="$fixture/output.txt"

  run_marker "$fixture" --channel beta --latest --clear --yes >"$output" 2>&1

  [ -f "$fixture/state/tag-remove-body.json" ] || fail "clear did not remove tags"
  assert_json_tags "$fixture/state/tag-remove-body.json" Remove \
    portico-routing-v1 \
    portico-eol-true \
    portico-force-update-true \
    portico-redirect-portico_dev
  assert_not_contains "$fixture/state/tag-remove-body.json" '"latest"' "clear tried to remove an unrelated latest tag"
  assert_contains "$output" "Removed EOL routing tags" "clear did not report tag removal"
}

test_dry_run_does_not_mutate() {
  local fixture output
  fixture="$(new_fixture dry-run)"
  output="$fixture/output.txt"

  run_marker "$fixture" --channel beta --latest --redirect-channel dev --dry-run >"$output" 2>&1

  [ ! -f "$fixture/state/tag-add-body.json" ] || fail "dry-run added tags"
  [ ! -f "$fixture/state/tag-remove-body.json" ] || fail "dry-run removed tags"
  assert_contains "$output" "Dry run: no Cloudsmith tag changes will be made." "dry-run did not report preview mode"
  assert_contains "$output" "portico-redirect-portico_dev" "dry-run did not print redirect tag"
}

test_mutation_requires_yes() {
  local fixture output
  fixture="$(new_fixture requires-yes)"
  output="$fixture/output.txt"

  if run_marker "$fixture" --channel beta --latest --redirect-channel dev >"$output" 2>&1; then
    fail "mutation without --yes unexpectedly succeeded"
  fi

  [ ! -f "$fixture/state/tag-add-body.json" ] || fail "mutation without --yes added tags"
  assert_contains "$output" "Real Cloudsmith mutations require --yes" "missing --yes failure was not actionable"
}

test_missing_target_fails_before_mutation() {
  local fixture output
  fixture="$(new_fixture missing-target)"
  output="$fixture/output.txt"

  if FAKE_NO_DEV=1 run_marker "$fixture" --channel beta --latest --redirect-channel dev --yes >"$output" 2>&1; then
    fail "missing target package unexpectedly succeeded"
  fi

  [ ! -f "$fixture/state/tag-add-body.json" ] || fail "missing target added tags"
  [ ! -f "$fixture/state/tag-remove-body.json" ] || fail "missing target removed tags"
  assert_contains "$output" "No downloadable target package found" "missing target failure was not actionable"
}

test_missing_source_slug_fails() {
  local fixture output
  fixture="$(new_fixture missing-slug)"
  output="$fixture/output.txt"

  if FAKE_MISSING_SLUG=1 run_marker "$fixture" --channel beta --latest --clear --yes >"$output" 2>&1; then
    fail "missing source slug unexpectedly succeeded"
  fi

  assert_contains "$output" "Cloudsmith package identifier is missing" "missing source slug failure was not actionable"
}

test_latest_adds_routing_tags
test_exact_build_adds_routing_tags
test_clear_removes_only_routing_tags
test_dry_run_does_not_mutate
test_mutation_requires_yes
test_missing_target_fails_before_mutation
test_missing_source_slug_fails

echo "PASS: mark_cloudsmith_release_eol shell tests"
