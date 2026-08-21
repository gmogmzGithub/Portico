#!/usr/bin/env bash
# Behavioral tests for sync_ootb_marketplaces.sh: refusal-without-confirm
# leaves the target untouched; --yes wipes + mirrors with the release-contract
# transforms (Solutions installs excluded, junk excluded, freshness stripped,
# baselines/versions recomputed, ootb stamped); symlinks and missing SKILL.md
# hard-fail BEFORE any wipe.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_SCRIPT="$PROJECT_ROOT/sync_ootb_marketplaces.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_exists() {
  [ -f "$1" ] || fail "expected file to exist: $1 ($2)"
}

assert_not_exists() {
  [ ! -e "$1" ] || fail "expected path to be gone: $1 ($2)"
}

make_fixture() {
  local fixture="$1"
  mkdir -p "$fixture"
  : > "$fixture/package_for_release.sh"

  # Live skill payloads: plugin-layout alpha (with junk), flat beta.
  mkdir -p "$fixture/skills-marketplace/good-mp/pluginx/alpha/references"
  cat > "$fixture/skills-marketplace/good-mp/pluginx/alpha/SKILL.md" <<'EOF'
---
name: alpha
metadata:
  version: "2.3.4"
---
Alpha body.
EOF
  echo "ref doc" > "$fixture/skills-marketplace/good-mp/pluginx/alpha/references/notes.md"
  : > "$fixture/skills-marketplace/good-mp/pluginx/alpha/.DS_Store"

  mkdir -p "$fixture/skills-marketplace/personal-mp/beta"
  cat > "$fixture/skills-marketplace/personal-mp/beta/SKILL.md" <<'EOF'
---
name: beta
version: 1.2.0
---
Beta body.
EOF

  # Solutions install payload — must NEVER be mirrored.
  mkdir -p "$fixture/skills-marketplace/ai-marketplace/gamma"
  cat > "$fixture/skills-marketplace/ai-marketplace/gamma/SKILL.md" <<'EOF'
---
name: gamma
---
Gamma body.
EOF

  # Live registry: stale baseline, machine-local freshness fields, a
  # freshness-sha cache, and an excluded Solutions record.
  cat > "$fixture/marketplaces.json" <<'EOF'
{
  "version": "1.0",
  "marketplaces": [
    {
      "id": "good-mp",
      "name": "Good Marketplace",
      "source": { "type": "github", "repo": "org/good" },
      "ootb": true
    },
    {
      "id": "personal-mp",
      "name": "Personal Marketplace",
      "source": { "type": "gitlab", "repoUrl": "https://example.com/p.git" }
    }
  ],
  "installedSkills": [
    {
      "skillId": "alpha",
      "marketplaceId": "good-mp",
      "pluginName": "pluginx",
      "skillPath": "./pluginx/skills/alpha",
      "installedAt": "2026-01-01T00:00:00Z",
      "installedVersion": "0.0.1",
      "localPath": "skills-marketplace/good-mp/pluginx/alpha",
      "lastCheckedVersion": "0.0.1",
      "hasUpdate": true,
      "contentHeadSha": "deadbeef",
      "remoteUpdatedAt": "2026-01-02T00:00:00Z",
      "baseline": {
        "files": [{ "path": "SKILL.md", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }],
        "generatedAt": "2026-01-01T00:00:00Z",
        "sourceRef": "release-branch",
        "version": "0.0.1"
      }
    },
    {
      "skillId": "beta",
      "marketplaceId": "personal-mp",
      "pluginName": null,
      "skillPath": "./beta",
      "installedAt": "2026-01-03T00:00:00Z",
      "installedVersion": "0.0.2",
      "localPath": "skills-marketplace/personal-mp/beta",
      "lastCheckedVersion": "0.0.2",
      "hasUpdate": false
    },
    {
      "skillId": "gamma",
      "marketplaceId": "ai-marketplace",
      "pluginName": null,
      "skillPath": "./gamma",
      "installedAt": "2026-01-04T00:00:00Z",
      "installedVersion": "1.0",
      "localPath": "skills-marketplace/ai-marketplace/gamma",
      "skillSource": { "type": "ai-marketplace-solution", "solutionId": "1234" }
    }
  ],
  "skillFreshnessShas": { "github:org/good@main": "cafebabe" }
}
EOF

  # Pre-existing OOTB content that the wipe must remove.
  mkdir -p "$fixture/marketplaces-ootb/skills-marketplace/old-stuff"
  echo "stale" > "$fixture/marketplaces-ootb/skills-marketplace/old-stuff/file.txt"
  echo '{"version":"1.0","marketplaces":[],"installedSkills":[]}' \
    > "$fixture/marketplaces-ootb/marketplaces.json"
}

test_refusal_leaves_target_untouched() {
  local fixture rc before after
  fixture="$(mktemp -d -t sync-ootb-refuse.XXXXXX)"
  trap 'rm -rf "$fixture"' RETURN
  make_fixture "$fixture"

  before="$(cd "$fixture/marketplaces-ootb" && find . -type f | sort && cat marketplaces.json)"
  rc=0
  (cd "$fixture" && bash "$SYNC_SCRIPT" </dev/null >/dev/null 2>&1) || rc=$?
  [ "$rc" -eq 3 ] || fail "refusal should exit 3, got $rc"
  after="$(cd "$fixture/marketplaces-ootb" && find . -type f | sort && cat marketplaces.json)"
  [ "$before" = "$after" ] || fail "refusal must leave marketplaces-ootb byte-identical"
  echo "PASS: refusal leaves the target untouched"
}

test_yes_mirrors_with_transforms() {
  local fixture rc
  fixture="$(mktemp -d -t sync-ootb-yes.XXXXXX)"
  trap 'rm -rf "$fixture"' RETURN
  make_fixture "$fixture"

  rc=0
  (cd "$fixture" && bash "$SYNC_SCRIPT" --yes >/dev/null 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || fail "--yes run should succeed, got $rc"

  assert_not_exists "$fixture/marketplaces-ootb/skills-marketplace/old-stuff" "wipe removes prior payload"
  assert_file_exists "$fixture/marketplaces-ootb/skills-marketplace/.gitkeep" "gitkeep recreated"
  assert_file_exists "$fixture/marketplaces-ootb/skills-marketplace/good-mp/pluginx/alpha/SKILL.md" "plugin-layout copy"
  assert_file_exists "$fixture/marketplaces-ootb/skills-marketplace/good-mp/pluginx/alpha/references/notes.md" "nested copy"
  assert_file_exists "$fixture/marketplaces-ootb/skills-marketplace/personal-mp/beta/SKILL.md" "flat copy"
  assert_not_exists "$fixture/marketplaces-ootb/skills-marketplace/good-mp/pluginx/alpha/.DS_Store" "junk excluded"
  assert_not_exists "$fixture/marketplaces-ootb/skills-marketplace/ai-marketplace" "Solutions payload excluded"

  python3 - "$fixture" <<'PYCHECK'
import hashlib, json, os, sys

fixture = sys.argv[1]
with open(os.path.join(fixture, "marketplaces-ootb", "marketplaces.json")) as f:
    emitted = json.load(f)

assert emitted["version"] == "1.0", emitted["version"]
assert "skillFreshnessShas" not in emitted, "freshness cache must be stripped"
assert sorted(entry["id"] for entry in emitted["marketplaces"]) == ["good-mp", "personal-mp"]
assert all(entry["ootb"] is True for entry in emitted["marketplaces"]), "ootb stamp"

records = {record["skillId"]: record for record in emitted["installedSkills"]}
assert sorted(records) == ["alpha", "beta"], sorted(records)

alpha = records["alpha"]
assert "contentHeadSha" not in alpha and "remoteUpdatedAt" not in alpha
assert alpha["hasUpdate"] is False
assert alpha["installedVersion"] == "2.3.4", alpha["installedVersion"]
assert alpha["lastCheckedVersion"] == "2.3.4"
assert alpha["baseline"]["version"] == "2.3.4"
assert alpha["baseline"]["sourceRef"] == "release-branch", "live sourceRef carried"
paths = [entry["path"] for entry in alpha["baseline"]["files"]]
assert paths == sorted(paths) and "SKILL.md" in paths and "references/notes.md" in paths, paths
for entry in alpha["baseline"]["files"]:
    disk = os.path.join(
        fixture, "marketplaces-ootb", "skills-marketplace",
        "good-mp", "pluginx", "alpha", entry["path"],
    )
    digest = hashlib.sha256(open(disk, "rb").read()).hexdigest()
    assert digest == entry["sha256"], f"baseline hash mismatch for {entry['path']}"

beta = records["beta"]
assert beta["installedVersion"] == "1.2.0", beta["installedVersion"]
assert beta["baseline"]["sourceRef"] == "main", "missing live baseline falls back to main"
print("registry transforms OK")
PYCHECK
  echo "PASS: --yes mirrors with the release-contract transforms"
}

test_symlink_fails_before_wipe() {
  local fixture rc
  fixture="$(mktemp -d -t sync-ootb-symlink.XXXXXX)"
  trap 'rm -rf "$fixture"' RETURN
  make_fixture "$fixture"
  ln -s /etc/hosts "$fixture/skills-marketplace/good-mp/pluginx/alpha/escape"

  rc=0
  (cd "$fixture" && bash "$SYNC_SCRIPT" --yes >/dev/null 2>&1) || rc=$?
  [ "$rc" -eq 2 ] || fail "symlink should preflight-fail with exit 2, got $rc"
  assert_file_exists "$fixture/marketplaces-ootb/skills-marketplace/old-stuff/file.txt" "no wipe on preflight failure"
  echo "PASS: symlinks hard-fail before any wipe"
}

test_missing_skill_md_fails_before_wipe() {
  local fixture rc
  fixture="$(mktemp -d -t sync-ootb-noskill.XXXXXX)"
  trap 'rm -rf "$fixture"' RETURN
  make_fixture "$fixture"
  rm "$fixture/skills-marketplace/personal-mp/beta/SKILL.md"

  rc=0
  (cd "$fixture" && bash "$SYNC_SCRIPT" --yes >/dev/null 2>&1) || rc=$?
  [ "$rc" -eq 2 ] || fail "missing SKILL.md should preflight-fail with exit 2, got $rc"
  assert_file_exists "$fixture/marketplaces-ootb/skills-marketplace/old-stuff/file.txt" "no wipe on preflight failure"
  echo "PASS: missing SKILL.md hard-fails before any wipe"
}

test_refusal_leaves_target_untouched
test_yes_mirrors_with_transforms
test_symlink_fails_before_wipe
test_missing_skill_md_fails_before_wipe

echo "All sync_ootb_marketplaces regressions passed."
