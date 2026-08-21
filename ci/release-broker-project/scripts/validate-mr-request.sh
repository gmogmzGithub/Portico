#!/usr/bin/env bash

set -euo pipefail

EXPECTED_PROJECT_PATH="${portico_EXPECTED_SOURCE_PROJECT_PATH:-portico/portico}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

for command in curl jq; do
  command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
done

[[ "${portico_SOURCE_PROJECT_ID:-}" =~ ^[1-9][0-9]*$ ]] || die "invalid source project id"
[[ "${portico_MR_IID:-}" =~ ^[1-9][0-9]*$ ]] || die "invalid merge request iid"
[[ "${portico_SOURCE_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || die "invalid source SHA"
[ "${portico_SOURCE_PROJECT_PATH:-}" = "$EXPECTED_PROJECT_PATH" ] \
  || die "source project path is not authorized"
[ "${portico_MR_REF_PATH:-}" = "refs/merge-requests/${portico_MR_IID}/head" ] \
  || die "merge request ref path is invalid"
[ -n "${portico_TARGET_BRANCH:-}" ] || die "target branch is required"
[ -n "${CI_API_V4_URL:-}" ] || die "CI_API_V4_URL is required"
[ -n "${CI_JOB_TOKEN:-}" ] || die "CI_JOB_TOKEN is required"

response_file="$(mktemp "${TMPDIR:-/tmp}/portico-mr-response.XXXXXX")"
cleanup() { rm -f "$response_file"; }
trap cleanup EXIT HUP INT TERM

http_status="$(curl --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --header "JOB-TOKEN: ${CI_JOB_TOKEN}" \
  "${CI_API_V4_URL}/projects/${portico_SOURCE_PROJECT_ID}/merge_requests/${portico_MR_IID}")" \
  || die "GitLab merge request lookup failed"
[ "$http_status" = 200 ] || die "GitLab merge request lookup returned HTTP $http_status"

state="$(jq -er '.state' "$response_file")" || die "merge request response has no state"
iid="$(jq -er '.iid' "$response_file")" || die "merge request response has no iid"
source_project_id="$(jq -er '.source_project_id' "$response_file")" \
  || die "merge request response has no source project id"
target_project_id="$(jq -er '.target_project_id' "$response_file")" \
  || die "merge request response has no target project id"
source_sha="$(jq -er '.sha // .diff_refs.head_sha' "$response_file")" \
  || die "merge request response has no head SHA"
target_branch="$(jq -er '.target_branch' "$response_file")" \
  || die "merge request response has no target branch"

[ "$state" = opened ] || die "merge request is not open"
[ "$iid" = "$portico_MR_IID" ] || die "merge request iid mismatch"
[ "$source_project_id" = "$portico_SOURCE_PROJECT_ID" ] \
  || die "fork merge requests are not authorized"
[ "$target_project_id" = "$portico_SOURCE_PROJECT_ID" ] \
  || die "cross-project merge requests are not authorized"
[ "$source_sha" = "$portico_SOURCE_SHA" ] || die "merge request head is stale"
[ "$target_branch" = "$portico_TARGET_BRANCH" ] || die "merge request target branch mismatch"

printf 'Validated open same-project merge request !%s at %s.\n' "$portico_MR_IID" "$portico_SOURCE_SHA"

