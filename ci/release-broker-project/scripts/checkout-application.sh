#!/usr/bin/env bash

set -euo pipefail
umask 077

PROJECT_PATH=""
REVISION=""
OUTPUT=""
REQUIRE_SHA=false

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-path) PROJECT_PATH="${2:-}"; shift 2 ;;
    --revision) REVISION="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --require-sha) REQUIRE_SHA=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$PROJECT_PATH" =~ ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$ ]] \
  || die "project path is invalid"
[ -n "$REVISION" ] || die "revision is required"
if [ "$REQUIRE_SHA" = true ]; then
  [[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || die "revision must be a full lowercase SHA"
else
  git check-ref-format --branch "$REVISION" >/dev/null 2>&1 || die "revision branch is invalid"
fi
[ -n "$OUTPUT" ] || die "output is required"
[ ! -e "$OUTPUT" ] || die "checkout output already exists: $OUTPUT"
[ -n "${CI_SERVER_PROTOCOL:-}" ] || die "CI_SERVER_PROTOCOL is required"
[ -n "${CI_SERVER_HOST:-}" ] || die "CI_SERVER_HOST is required"
[ -n "${CI_JOB_TOKEN:-}" ] || die "CI_JOB_TOKEN is required"

askpass_dir="$(mktemp -d "${TMPDIR:-/tmp}/portico-git-askpass.XXXXXX")"
askpass="$askpass_dir/askpass.sh"
cat >"$askpass" <<'SH'
#!/usr/bin/env bash
case "$1" in
  *sername*) printf '%s\n' gitlab-ci-token ;;
  *assword*) printf '%s\n' "${CI_JOB_TOKEN:?}" ;;
  *) exit 1 ;;
esac
SH
chmod 700 "$askpass"
cleanup() { rm -rf "$askpass_dir"; }
trap cleanup EXIT HUP INT TERM

repository_url="${CI_SERVER_PROTOCOL}://${CI_SERVER_HOST}/${PROJECT_PATH}.git"
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git clone \
  --no-checkout --filter=blob:none "$repository_url" "$OUTPUT" >/dev/null
if [ "$REQUIRE_SHA" = true ]; then
  GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -C "$OUTPUT" fetch \
    --depth=1 origin "$REVISION" >/dev/null
  GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -C "$OUTPUT" checkout \
    --detach FETCH_HEAD >/dev/null
  [ "$(git -C "$OUTPUT" rev-parse HEAD)" = "$REVISION" ] \
    || die "checked out source does not match requested SHA"
else
  GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -C "$OUTPUT" fetch \
    --depth=1 origin "refs/heads/${REVISION}" >/dev/null
  GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -C "$OUTPUT" checkout \
    --detach FETCH_HEAD >/dev/null
fi
git -C "$OUTPUT" remote set-url origin "$repository_url"
