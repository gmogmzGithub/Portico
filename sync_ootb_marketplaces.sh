#!/usr/bin/env bash
# sync_ootb_marketplaces.sh — OPERATOR/ENGINEER TOOL.
#
# One-way mirror of this machine's live skills-marketplace state into the
# committed OOTB defaults: wipes marketplaces-ootb/skills-marketplace/ and
# re-emits marketplaces-ootb/marketplaces.json from ./marketplaces.json +
# ./skills-marketplace/.
#
# Deliberately CWD-relative (unlike other root scripts): it operates on the
# marketplace folders of whatever repo checkout you run it from.
#
# The emitted result is a FILTERED, TRANSFORMED mirror — the release
# validator's contract (src/scripts/validate-release-payload.py) forbids a
# verbatim copy:
#   - Solutions Marketplace installs (marketplaceId "ai-marketplace" or any
#     id without a marketplace entry) are excluded: they cannot reference a
#     listed marketplace and hard-fail validation.
#   - Machine-local freshness state is stripped (skillFreshnessShas,
#     contentHeadSha, remoteUpdatedAt; hasUpdate forced false).
#   - installedVersion/lastCheckedVersion and every baseline are RECOMPUTED
#     from the copied bytes (stale baselines fail the signed-package job).
#   - .DS_Store/AppleDouble junk is never copied (coverage sweep rejects it).
#   - Every included marketplace is stamped ootb: true — everything emitted
#     becomes permanently seeded and UNDELETABLE in shipped builds.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./sync_ootb_marketplaces.sh [--yes] [--rename FROM=TO ...] [--acknowledge-removal MP/SKILL ...]

Mirrors ./skills-marketplace + ./marketplaces.json (live, this machine) into
./marketplaces-ootb (committed OOTB defaults). WIPES the target first.

Seed lifecycle bookkeeping (diffed against the PREVIOUS committed bundle):
  - A seed whose (marketplaceId, skillId) survives but whose pluginName or
    skillPath moved gets a seedMigrations alias generated AUTOMATICALLY.
  - A seed key that VANISHES must be dispositioned: pair it to a new identity
    (a rename — emits a seedMigrations alias) or acknowledge it as a
    deliberate removal. Interactive runs prompt per key (with baseline-hash
    evidence when it exists); --yes runs hard-fail unless every vanished key
    is covered by --rename / --acknowledge-removal.
  - The alias map rolls FORWARD: prior aliases are carried, repointed through
    new renames (flat map — one hop for any build jump), retired when their
    old identity reappears as a live seed, and pruned when their target
    stops shipping.

Options:
  --yes, -y                    Skip interactive confirmation (CI / scripted).
  --rename FROM=TO             Declare a vanished-seed rename. Identities are
                               marketplaceId/pluginName/skillId (empty plugin
                               allowed: mp//skill). Repeatable.
  --acknowledge-removal MP/SKILL
                               Declare a vanished seed as deliberately
                               removed. Repeatable.
  --help, -h                   This text.

Run from a repo root: ./marketplaces.json, ./skills-marketplace/ and
./marketplaces-ootb/ must all exist in the current directory.
EOF
}

ASSUME_YES=0
RENAMES=()
REMOVALS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --rename)
      [ $# -ge 2 ] || { echo "--rename requires a FROM=TO value" >&2; exit 2; }
      RENAMES+=("$2"); shift ;;
    --rename=*) RENAMES+=("${1#--rename=}") ;;
    --acknowledge-removal)
      [ $# -ge 2 ] || { echo "--acknowledge-removal requires a MP/SKILL value" >&2; exit 2; }
      REMOVALS+=("$2"); shift ;;
    --acknowledge-removal=*) REMOVALS+=("${1#--acknowledge-removal=}") ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SYNC_RENAMES=""
if [ ${#RENAMES[@]} -gt 0 ]; then
  SYNC_RENAMES=$(printf '%s\n' "${RENAMES[@]}")
fi
SYNC_REMOVALS=""
if [ ${#REMOVALS[@]} -gt 0 ]; then
  SYNC_REMOVALS=$(printf '%s\n' "${REMOVALS[@]}")
fi
export SYNC_RENAMES SYNC_REMOVALS

for required in marketplaces.json skills-marketplace marketplaces-ootb package_for_release.sh; do
  if [ ! -e "./$required" ]; then
    echo "ERROR: ./$required not found — run this from a repo root checkout." >&2
    exit 2
  fi
done

# The python program rides fd 3 so real stdin stays attached to the operator:
# interactive prompts (rename pairing, the 'sync' confirmation) read stdin,
# which a plain `python3 <<'PY'` heredoc would have swallowed.
SYNC_ASSUME_YES="$ASSUME_YES" python3 /dev/fd/3 3<<'PY'
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

ROOT = os.getcwd()
LIVE_REGISTRY = os.path.join(ROOT, "marketplaces.json")
LIVE_SKILLS = os.path.join(ROOT, "skills-marketplace")
OOTB_DIR = os.path.join(ROOT, "marketplaces-ootb")
OOTB_REGISTRY = os.path.join(OOTB_DIR, "marketplaces.json")
OOTB_SKILLS = os.path.join(OOTB_DIR, "skills-marketplace")

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
JUNK_NAMES = {".DS_Store"}
JUNK_PREFIXES = ("._",)

RECORD_KEY_ORDER = [
    "skillId",
    "marketplaceId",
    "pluginName",
    "skillPath",
    "skillSource",
    "installedAt",
    "installedVersion",
    "localPath",
    "lastCheckedVersion",
    "hasUpdate",
    "updatedAt",
    "baseline",
]


def die(msg, code=2):
    print(f"\nERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def is_junk(name):
    return name in JUNK_NAMES or name.startswith(JUNK_PREFIXES)


def skill_key(record):
    parts = [record["marketplaceId"]]
    if record.get("pluginName"):
        parts.append(record["pluginName"])
    parts.append(record["skillId"])
    return "/".join(parts)


def frontmatter_version(skill_md_path):
    """Mirror skill-frontmatter.js: metadata.version || version || "1.0"."""
    try:
        with open(skill_md_path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return "1.0"
    if not text.startswith("---"):
        return "1.0"
    end = text.find("\n---", 3)
    if end == -1:
        return "1.0"
    block = text[3:end]

    def clean(value):
        return value.strip().strip("\"'").strip()

    nested = re.search(
        r"^metadata:\s*$(?:\n(?:[ \t]+.*)?)*?\n[ \t]+version:[ \t]*(.+)$",
        block,
        re.M,
    )
    if nested:
        value = clean(nested.group(1))
        if value:
            return value
    top = re.search(r"^version:[ \t]*(.+)$", block, re.M)
    if top:
        value = clean(top.group(1))
        if value:
            return value
    return "1.0"


def walk_files(root):
    collected = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not is_junk(d))
        for name in sorted(filenames):
            if is_junk(name):
                continue
            collected.append(os.path.join(dirpath, name))
    return collected


def find_symlinks(root):
    links = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            if os.path.islink(path):
                links.append(os.path.relpath(path, ROOT))
    return links


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def baseline_files(skill_dir):
    entries = []
    for path in walk_files(skill_dir):
        rel = os.path.relpath(path, skill_dir).replace(os.sep, "/")
        entries.append({"path": rel, "sha256": sha256_of(path)})
    entries.sort(key=lambda entry: entry["path"])
    return entries


# ── Load + preflight ────────────────────────────────────────────────────────

try:
    with open(LIVE_REGISTRY, "r", encoding="utf-8") as f:
        registry = json.load(f)
except (OSError, ValueError) as exc:
    die(f"cannot read ./marketplaces.json: {exc}")

marketplaces = registry.get("marketplaces") or []
installed = registry.get("installedSkills") or []
if not isinstance(marketplaces, list) or not marketplaces:
    die("live registry has no marketplaces to mirror")

included_ids = []
problems = []
for entry in marketplaces:
    mp_id = entry.get("id")
    if not isinstance(mp_id, str) or not ID_RE.match(mp_id):
        problems.append(f"marketplace id fails the release-validator regex: {mp_id!r}")
        continue
    included_ids.append(mp_id)
if len(set(included_ids)) != len(included_ids):
    problems.append("duplicate marketplace ids in the live registry")

included_set = set(included_ids)
included_records = []
excluded_records = []
seen_keys = set()
seen_seed_pairs = set()
for record in installed:
    mp_id = record.get("marketplaceId")
    if mp_id not in included_set:
        excluded_records.append(record)
        continue
    for field in ("skillId", "marketplaceId"):
        value = record.get(field)
        if not isinstance(value, str) or not ID_RE.match(value):
            problems.append(f"{field} fails the id regex: {value!r}")
    plugin = record.get("pluginName")
    if plugin is not None and (not isinstance(plugin, str) or not ID_RE.match(plugin)):
        problems.append(f"pluginName fails the id regex: {plugin!r}")
    key = skill_key(record)
    if key in seen_keys:
        problems.append(f"duplicate installed skill key: {key}")
    seen_keys.add(key)
    # The client seed merge AND seedMigrations both key on (marketplaceId,
    # skillId) — two plugins shipping the same leaf in one marketplace would
    # make that join ambiguous on every user machine. Never emit it.
    seed_pair = (record.get("marketplaceId"), record.get("skillId"))
    if seed_pair in seen_seed_pairs:
        problems.append(
            f"duplicate (marketplaceId, skillId) across plugins: {seed_pair[0]}/{seed_pair[1]}"
        )
    seen_seed_pairs.add(seed_pair)
    expected_local = f"skills-marketplace/{key}"
    if record.get("localPath") != expected_local:
        problems.append(
            f"{key}: localPath {record.get('localPath')!r} != expected {expected_local!r}"
        )
        continue
    source_dir = os.path.join(ROOT, expected_local)
    if not os.path.isfile(os.path.join(source_dir, "SKILL.md")):
        problems.append(f"{key}: missing {expected_local}/SKILL.md on disk")
        continue
    links = find_symlinks(source_dir)
    if links:
        problems.append(f"{key}: symlinks are forbidden in release payloads: {links}")
        continue
    included_records.append(record)

if problems:
    print("\nPreflight failed — nothing was modified:", file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}", file=sys.stderr)
    sys.exit(2)

# ── Seed lifecycle: diff vs the previous bundle, build the alias map ─────────
#
# The PREVIOUS committed bundle is the reference: seed keys (marketplaceId,
# skillId) that survive with a moved identity get an automatic seedMigrations
# alias; keys that vanish must be dispositioned (rename or acknowledged
# removal); prior aliases roll forward flat (repointed through new renames,
# retired when their identity reappears, pruned when their target stops
# shipping). Clients apply aliases only when the target is a current seed, so
# everything emitted here must stay internally coherent — the self-check
# below enforces it.


def norm_plugin(value):
    return value if isinstance(value, str) and value.strip() else None


def norm_skill_path(value):
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.rstrip("/")


def record_triple(record):
    return (
        record.get("marketplaceId"),
        norm_plugin(record.get("pluginName")),
        record.get("skillId"),
    )


def fmt_triple(triple):
    mp, plugin, skill = triple
    return f"{mp}/{plugin or ''}/{skill}"


def parse_triple(text):
    parts = str(text).split("/")
    if len(parts) != 3 or not parts[0] or not parts[2]:
        return None
    return (parts[0], parts[1] or None, parts[2])


def endpoint_from_triple(triple, skill_path=None):
    endpoint = {"marketplaceId": triple[0], "skillId": triple[2]}
    if triple[1]:
        endpoint["pluginName"] = triple[1]
    if skill_path:
        endpoint["skillPath"] = skill_path
    return endpoint


def endpoint_triple(endpoint):
    return (
        endpoint.get("marketplaceId"),
        norm_plugin(endpoint.get("pluginName")),
        endpoint.get("skillId"),
    )


def normalize_alias(raw):
    """Mirror the client's tolerant normalizeSeedMigrations for one entry."""
    from_raw = raw.get("from") if isinstance(raw, dict) else None
    to_raw = raw.get("to") if isinstance(raw, dict) else None
    if not isinstance(from_raw, dict) or not isinstance(to_raw, dict):
        return None
    from_triple = endpoint_triple(from_raw)
    to_triple = endpoint_triple(to_raw)
    if not all([from_triple[0], from_triple[2], to_triple[0], to_triple[2]]):
        return None
    from_path = norm_skill_path(from_raw.get("skillPath"))
    if from_triple == to_triple and not from_path:
        return None
    return {
        "from": endpoint_from_triple(from_triple, from_path),
        "to": endpoint_from_triple(to_triple),
    }


def alias_from_key(alias):
    return (endpoint_triple(alias["from"]), alias["from"].get("skillPath"))


prev_bundle = {}
try:
    with open(OOTB_REGISTRY, "r", encoding="utf-8") as f:
        prev_bundle = json.load(f)
except (OSError, ValueError):
    prev_bundle = {}
prev_seeds = [
    record
    for record in (prev_bundle.get("installedSkills") or [])
    if isinstance(record, dict) and record.get("marketplaceId") and record.get("skillId")
]
prev_aliases = []
for raw in prev_bundle.get("seedMigrations") or []:
    normalized = normalize_alias(raw)
    if normalized is not None:
        prev_aliases.append(normalized)

prev_by_key = {(r["marketplaceId"], r["skillId"]): r for r in prev_seeds}
new_by_key = {(r["marketplaceId"], r["skillId"]): r for r in included_records}

new_migrations = []

# 1) Same-key identity drift: (mp, skillId) survives, identity moved.
for key, new_rec in sorted(new_by_key.items()):
    prev_rec = prev_by_key.get(key)
    if prev_rec is None:
        continue
    prev_plugin = norm_plugin(prev_rec.get("pluginName"))
    new_plugin = norm_plugin(new_rec.get("pluginName"))
    prev_path = norm_skill_path(prev_rec.get("skillPath"))
    new_path = norm_skill_path(new_rec.get("skillPath"))
    if prev_plugin != new_plugin:
        new_migrations.append({
            "from": endpoint_from_triple((key[0], prev_plugin, key[1])),
            "to": endpoint_from_triple((key[0], new_plugin, key[1])),
        })
    elif prev_path and new_path and prev_path != new_path:
        # Same triple, moved repo path: the skillPath discriminator scopes the
        # alias to records still pinned to the old path.
        new_migrations.append({
            "from": endpoint_from_triple((key[0], prev_plugin, key[1]), prev_path),
            "to": endpoint_from_triple((key[0], new_plugin, key[1])),
        })

# 2) Vanished / appeared keys need an operator disposition.
vanished_keys = sorted(k for k in prev_by_key if k not in new_by_key)
appeared_keys = sorted(k for k in new_by_key if k not in prev_by_key)

declared_renames = {}
for spec in filter(None, os.environ.get("SYNC_RENAMES", "").split("\n")):
    left, sep, right = spec.partition("=")
    from_triple = parse_triple(left)
    to_triple = parse_triple(right) if sep else None
    if not from_triple or not to_triple:
        die(
            "--rename expects marketplaceId/pluginName/skillId=marketplaceId/pluginName/skillId"
            f" (got {spec!r})"
        )
    declared_renames[(from_triple[0], from_triple[2])] = (from_triple, to_triple)

declared_removals = set()
for spec in filter(None, os.environ.get("SYNC_REMOVALS", "").split("\n")):
    parts = str(spec).split("/")
    if len(parts) != 2 or not all(parts):
        die(f"--acknowledge-removal expects marketplaceId/skillId (got {spec!r})")
    declared_removals.add((parts[0], parts[1]))


def baseline_sha_set(record):
    files = (record.get("baseline") or {}).get("files") or []
    return {
        entry.get("sha256")
        for entry in files
        if isinstance(entry, dict) and entry.get("sha256")
    }


def propose_pair(vanished_key):
    """Best appeared candidate by baseline sha overlap; None without evidence."""
    vanished_shas = baseline_sha_set(prev_by_key[vanished_key])
    if not vanished_shas:
        return None, 0.0
    best_key, best_score = None, 0.0
    for appeared_key in appeared_keys:
        candidate = new_by_key[appeared_key]
        candidate_dir = os.path.join(ROOT, candidate["localPath"])
        candidate_shas = {entry["sha256"] for entry in baseline_files(candidate_dir)}
        if not candidate_shas:
            continue
        overlap = len(vanished_shas & candidate_shas) / min(
            len(vanished_shas), len(candidate_shas)
        )
        if overlap > best_score:
            best_key, best_score = appeared_key, overlap
    if best_key is not None and best_score >= 0.5:
        return best_key, best_score
    return None, 0.0


def resolve_rename_target(to_triple, context):
    target = new_by_key.get((to_triple[0], to_triple[2]))
    if target is None:
        die(f"{context}: rename target {fmt_triple(to_triple)} is not an emitted seed")
    target_plugin = norm_plugin(target.get("pluginName"))
    if target_plugin != to_triple[1]:
        die(
            f"{context}: rename target {fmt_triple(to_triple)} does not match the emitted"
            f" seed identity {fmt_triple(record_triple(target))}"
        )
    return to_triple


acknowledged_removals = []
interactive = os.environ.get("SYNC_ASSUME_YES") != "1"
unresolved_keys = []
for vanished_key in vanished_keys:
    prev_rec = prev_by_key[vanished_key]
    from_triple = record_triple(prev_rec)
    if vanished_key in declared_renames:
        declared_from, declared_to = declared_renames[vanished_key]
        if declared_from != from_triple:
            die(
                f"--rename {fmt_triple(declared_from)}: previous bundle identity is"
                f" {fmt_triple(from_triple)} — declare exactly that"
            )
        resolve_rename_target(declared_to, f"--rename {fmt_triple(declared_from)}")
        new_migrations.append({
            "from": endpoint_from_triple(from_triple),
            "to": endpoint_from_triple(declared_to),
        })
        continue
    if vanished_key in declared_removals:
        acknowledged_removals.append(from_triple)
        continue
    if not interactive:
        unresolved_keys.append(vanished_key)
        continue

    proposal_key, proposal_score = propose_pair(vanished_key)
    while True:
        if proposal_key is not None:
            proposal_triple = record_triple(new_by_key[proposal_key])
            prompt = (
                f"\nSeed {fmt_triple(from_triple)} vanished from the live state.\n"
                f"  Evidence suggests it moved to {fmt_triple(proposal_triple)}"
                f" (baseline overlap {proposal_score:.0%}).\n"
                "  [y] accept rename  [r] type another identity  [d] deliberate removal  [a] abort: "
            )
        else:
            prompt = (
                f"\nSeed {fmt_triple(from_triple)} vanished from the live state"
                " (no rename evidence found).\n"
                "  [r] type the new identity  [d] deliberate removal  [a] abort: "
            )
        try:
            answer = input(prompt).strip().lower()
        except EOFError:
            answer = "a"
        if answer == "y" and proposal_key is not None:
            new_migrations.append({
                "from": endpoint_from_triple(from_triple),
                "to": endpoint_from_triple(record_triple(new_by_key[proposal_key])),
            })
            break
        if answer == "r":
            typed = input("  New identity (marketplaceId/pluginName/skillId): ").strip()
            typed_triple = parse_triple(typed)
            if not typed_triple:
                print("  Not a valid identity — expected marketplaceId/pluginName/skillId.")
                continue
            resolve_rename_target(typed_triple, f"rename of {fmt_triple(from_triple)}")
            new_migrations.append({
                "from": endpoint_from_triple(from_triple),
                "to": endpoint_from_triple(typed_triple),
            })
            break
        if answer == "d":
            acknowledged_removals.append(from_triple)
            break
        if answer == "a":
            print("Aborted — nothing was modified.")
            sys.exit(3)

if unresolved_keys:
    lines = []
    for key in unresolved_keys:
        triple = record_triple(prev_by_key[key])
        lines.append(
            f"  --rename {fmt_triple(triple)}=<new mp/plugin/skill>"
            f"   or   --acknowledge-removal {key[0]}/{key[1]}"
        )
    die(
        "vanished seeds need an explicit disposition in --yes mode:\n" + "\n".join(lines)
    )

# 3) Roll the alias map forward: carry, repoint, upsert, retire, prune.
alias_map = [dict(alias, **{"from": dict(alias["from"]), "to": dict(alias["to"])}) for alias in prev_aliases]
repointed_aliases = []
for entry in new_migrations:
    entry_from_triple = endpoint_triple(entry["from"])
    for alias in alias_map:
        if endpoint_triple(alias["to"]) == entry_from_triple:
            repointed_aliases.append((fmt_triple(endpoint_triple(alias["from"])), fmt_triple(endpoint_triple(entry["to"]))))
            alias["to"] = dict(entry["to"])
    replaced = False
    for index, alias in enumerate(alias_map):
        if alias_from_key(alias) == alias_from_key(entry):
            alias_map[index] = entry
            replaced = True
            break
    if not replaced:
        alias_map.append(entry)

current_identities = {record_triple(record) for record in included_records}
current_paths_by_triple = {
    record_triple(record): norm_skill_path(record.get("skillPath"))
    for record in included_records
}

retired_aliases = []
pruned_aliases = []
kept_aliases = []
for alias in alias_map:
    from_triple = endpoint_triple(alias["from"])
    from_path = alias["from"].get("skillPath")
    if from_triple in current_identities and (
        not from_path or from_path == current_paths_by_triple.get(from_triple)
    ):
        retired_aliases.append(alias)
        continue
    if endpoint_triple(alias["to"]) not in current_identities:
        pruned_aliases.append(alias)
        continue
    kept_aliases.append(alias)

# Dedup + degenerate filter, mirroring the client parser.
seed_migrations_out = []
seen_from_keys = set()
for alias in kept_aliases:
    key = alias_from_key(alias)
    if key in seen_from_keys:
        continue
    if endpoint_triple(alias["from"]) == endpoint_triple(alias["to"]) and not alias["from"].get("skillPath"):
        continue
    seen_from_keys.add(key)
    seed_migrations_out.append(alias)

new_migration_keys = {alias_from_key(entry) for entry in new_migrations}

# ── Inventory + confirmation ────────────────────────────────────────────────

counts = {}
for record in included_records:
    counts[record["marketplaceId"]] = counts.get(record["marketplaceId"], 0) + 1

print("One-way sync: ./skills-marketplace + ./marketplaces.json  →  ./marketplaces-ootb")
print(f"\nMarketplaces to mirror ({len(marketplaces)}):")
non_ootb = []
for entry in marketplaces:
    mp_id = entry["id"]
    flag = "" if entry.get("ootb") is True else "   ⚠ not currently ootb:true"
    if entry.get("ootb") is not True:
        non_ootb.append(mp_id)
    print(f"  - {mp_id}: {counts.get(mp_id, 0)} installed skill(s){flag}")
print(f"\nTotal installed skills mirrored: {len(included_records)}")
if excluded_records:
    print(f"\nEXCLUDED ({len(excluded_records)}) — no marketplace entry can exist for these")
    print("(Solutions Marketplace installs are per-user and cannot ship as OOTB):")
    for record in excluded_records:
        print(f"  - {record.get('marketplaceId')}/{record.get('skillId')}")
if non_ootb:
    print(
        f"\n⚠ WARNING: {', '.join(non_ootb)} will be stamped ootb:true by this sync.\n"
        "  Everything emitted becomes permanently seeded and UNDELETABLE on every\n"
        "  installation that ships this repo state — including personal repos."
    )

# Seed lifecycle plan — the human-reviewed control point for the alias map.
if not prev_seeds:
    print("\nSeed lifecycle: no previous bundle seeds found — alias map starts empty.")
else:

    def alias_line(alias, marker):
        from_path = alias["from"].get("skillPath")
        suffix = f" @ {from_path}" if from_path else ""
        return (
            f"  [{marker}] {fmt_triple(endpoint_triple(alias['from']))}{suffix}"
            f"  →  {fmt_triple(endpoint_triple(alias['to']))}"
        )

    if seed_migrations_out:
        print(f"\nSeed migrations emitted to the bundle ({len(seed_migrations_out)}):")
        for alias in seed_migrations_out:
            marker = "new" if alias_from_key(alias) in new_migration_keys else "carried"
            print(alias_line(alias, marker))
    else:
        print("\nSeed migrations emitted to the bundle: none")
    if repointed_aliases:
        print(f"Aliases repointed through new renames ({len(repointed_aliases)}):")
        for from_label, to_label in repointed_aliases:
            print(f"  {from_label}  →  {to_label}")
    if acknowledged_removals:
        print(f"Removals acknowledged ({len(acknowledged_removals)}) — seeds stop shipping;")
        print("existing installs stay until a destructive sync resolves them:")
        for triple in acknowledged_removals:
            print(f"  - {fmt_triple(triple)}")
    if retired_aliases:
        print(
            f"⚠ Aliases RETIRED ({len(retired_aliases)}) — their old identity is a live seed"
        )
        print("  again (previously renamed/removed identity reappeared):")
        for alias in retired_aliases:
            print(alias_line(alias, "retired"))
    if pruned_aliases:
        print(f"Aliases pruned ({len(pruned_aliases)}) — target no longer ships:")
        for alias in pruned_aliases:
            print(alias_line(alias, "pruned"))

print("\nThis WIPES marketplaces-ootb/skills-marketplace/ and rewrites")
print("marketplaces-ootb/marketplaces.json.")

if os.environ.get("SYNC_ASSUME_YES") != "1":
    try:
        answer = input("\nType 'sync' to proceed: ").strip().lower()
    except EOFError:
        answer = ""
    if answer != "sync":
        print("Aborted — nothing was modified.")
        sys.exit(3)

# ── Emit ────────────────────────────────────────────────────────────────────

if os.path.isdir(OOTB_SKILLS):
    shutil.rmtree(OOTB_SKILLS)
os.makedirs(OOTB_SKILLS)
with open(os.path.join(OOTB_SKILLS, ".gitkeep"), "w", encoding="utf-8"):
    pass

now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

emitted_records = []
for record in included_records:
    key = skill_key(record)
    source_dir = os.path.join(ROOT, "skills-marketplace", key)
    target_dir = os.path.join(OOTB_SKILLS, key)
    for source_path in walk_files(source_dir):
        rel = os.path.relpath(source_path, source_dir)
        target_path = os.path.join(target_dir, rel)
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        shutil.copy2(source_path, target_path)

    version = frontmatter_version(os.path.join(target_dir, "SKILL.md"))
    live_baseline = record.get("baseline") or {}
    source_ref = live_baseline.get("sourceRef") or "main"

    transformed = dict(record)
    transformed.pop("contentHeadSha", None)
    transformed.pop("remoteUpdatedAt", None)
    transformed["hasUpdate"] = False
    transformed["installedVersion"] = version
    transformed["lastCheckedVersion"] = version
    transformed["baseline"] = {
        "files": baseline_files(target_dir),
        "generatedAt": now_iso,
        "sourceRef": source_ref,
        "version": version,
    }

    ordered = {}
    for field in RECORD_KEY_ORDER:
        if field in transformed:
            ordered[field] = transformed[field]
    for field, value in transformed.items():
        if field not in ordered:
            ordered[field] = value
    emitted_records.append(ordered)

emitted_marketplaces = []
for entry in marketplaces:
    stamped = dict(entry)
    stamped["ootb"] = True
    emitted_marketplaces.append(stamped)

payload = {
    "version": "1.0",
    "marketplaces": emitted_marketplaces,
    "installedSkills": emitted_records,
}
if seed_migrations_out:
    payload["seedMigrations"] = seed_migrations_out
with open(OOTB_REGISTRY, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")

# ── Self-check (mirrors validate-release-payload.py invariants) ─────────────

errors = []
with open(OOTB_REGISTRY, "r", encoding="utf-8") as f:
    emitted = json.load(f)

emitted_ids = {entry["id"] for entry in emitted["marketplaces"]}
listed_keys = set()
for record in emitted["installedSkills"]:
    key = skill_key(record)
    listed_keys.add(key)
    if record["marketplaceId"] not in emitted_ids:
        errors.append(f"{key}: marketplaceId not in emitted marketplaces")
    if record["marketplaceId"] == "ai-marketplace":
        errors.append(f"{key}: Solutions install leaked into the mirror")
    if record.get("localPath") != f"skills-marketplace/{key}":
        errors.append(f"{key}: emitted localPath mismatch")
    skill_dir = os.path.join(OOTB_SKILLS, key)
    if not os.path.isfile(os.path.join(skill_dir, "SKILL.md")):
        errors.append(f"{key}: SKILL.md missing from the emitted payload")
        continue
    recomputed = baseline_files(skill_dir)
    if recomputed != record["baseline"]["files"]:
        errors.append(f"{key}: baseline does not match emitted bytes")

# Coverage sweep: every payload file must live under a listed skill root.
for dirpath, dirnames, filenames in os.walk(OOTB_SKILLS, followlinks=False):
    for name in filenames:
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, OOTB_SKILLS).replace(os.sep, "/")
        if rel == ".gitkeep":
            continue
        if not any(rel == k or rel.startswith(f"{k}/") for k in listed_keys):
            errors.append(f"unlisted payload file: {rel}")

# Alias-map coherence: clients apply an alias only when its target is a
# current seed, so an incoherent map ships as dead weight at best and a
# mis-migration at worst. Enforce: flat (no chains), unique froms, every
# target emitted, no plain-triple from shadowing a live seed identity.
emitted_identities = {record_triple(record) for record in emitted["installedSkills"]}
emitted_aliases = emitted.get("seedMigrations") or []
seen_alias_froms = set()
alias_from_triples = set()
for alias in emitted_aliases:
    from_triple = endpoint_triple(alias.get("from") or {})
    to_triple = endpoint_triple(alias.get("to") or {})
    from_key = (from_triple, (alias.get("from") or {}).get("skillPath"))
    if from_key in seen_alias_froms:
        errors.append(f"duplicate seedMigrations from: {fmt_triple(from_triple)}")
    seen_alias_froms.add(from_key)
    if not (alias.get("from") or {}).get("skillPath"):
        alias_from_triples.add(from_triple)
    if to_triple not in emitted_identities:
        errors.append(
            f"seedMigrations target is not an emitted seed: {fmt_triple(to_triple)}"
        )
    if from_triple in emitted_identities and not (alias.get("from") or {}).get("skillPath"):
        errors.append(
            f"seedMigrations from shadows a live seed identity: {fmt_triple(from_triple)}"
        )
for alias in emitted_aliases:
    if endpoint_triple(alias.get("to") or {}) in alias_from_triples:
        errors.append(
            "seedMigrations map is not flat: "
            f"{fmt_triple(endpoint_triple(alias.get('to') or {}))} is both a target and a from"
        )

if errors:
    print("\nSelf-check FAILED after emit (target left in place for inspection):", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    sys.exit(4)

print(f"\n✔ Synced {len(emitted_records)} skills across {len(emitted_marketplaces)} marketplaces.")
if seed_migrations_out:
    print(f"✔ Emitted {len(seed_migrations_out)} seedMigrations alias(es).")
if acknowledged_removals:
    print(f"✔ Acknowledged {len(acknowledged_removals)} seed removal(s).")
print("✔ Self-check passed (ids, references, baselines, coverage sweep, alias map).")
print(
    "\nNext steps:\n"
    "  python3 -m pytest tests/test_validate_release_payload.py -q\n"
    "  bash tests/test_package_for_release.sh\n"
    "  ./run-tests.sh\n"
    "\nHeads-up: these curation-pin suites encode OOTB policy and may fail\n"
    "DELIBERATELY when the synced content changes — update them consciously\n"
    "or prune the live installs first:\n"
    "  electron-app/src/services/marketplace-ootb-assets.unit.test.js\n"
    "    (version pins; knowledge-work-plugins ships zero installs today)\n"
    "  electron-app/src/services/glean-integration-skills.unit.test.js\n"
    "    (using-zoom / using-asana must not ship)"
)
PY
