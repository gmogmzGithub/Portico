#!/usr/bin/env bash

set -euo pipefail

REMOTE="origin"
BRANCH=""
SOURCE_REVISION=""

usage() {
  cat <<'EOF'
Usage: assert-release-branch-tip.sh --branch <name> --source-revision <sha> [--remote <name>]

Exit status 3 means the branch resolved successfully but no longer points to
the expected source revision. Other nonzero statuses are validation or lookup
failures.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

stale() {
  printf 'Error: %s\n' "$*" >&2
  exit 3
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch)
      [ "$#" -ge 2 ] || die "--branch requires a value"
      BRANCH="$2"
      shift 2
      ;;
    --source-revision)
      [ "$#" -ge 2 ] || die "--source-revision requires a value"
      SOURCE_REVISION="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      shift 2
      ;;
    --remote)
      [ "$#" -ge 2 ] || die "--remote requires a value"
      REMOTE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--branch is invalid"
[[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]] \
  || die "--source-revision must be a full lowercase git SHA"

remote_line="$(git ls-remote --exit-code "$REMOTE" "refs/heads/${BRANCH}")" \
  || die "unable to resolve ${REMOTE}/${BRANCH}"
remote_revision="$(printf '%s\n' "$remote_line" | awk 'NR == 1 { print tolower($1) }')"
[ -n "$remote_revision" ] || die "${REMOTE}/${BRANCH} did not resolve to a commit"
[ "$remote_revision" = "$SOURCE_REVISION" ] \
  || stale "stale release pipeline: ${REMOTE}/${BRANCH} is ${remote_revision}, expected ${SOURCE_REVISION}"

printf 'Verified %s/%s at %s.\n' "$REMOTE" "$BRANCH" "$SOURCE_REVISION"
