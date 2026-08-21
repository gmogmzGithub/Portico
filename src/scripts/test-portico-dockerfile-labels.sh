#!/usr/bin/env bash

# Regression tests for the PORTICO-205 ownership labels: every PORTICO Dockerfile's
# FINAL stage must carry com.portico.ai-chat.artifact="true" and a
# com.portico.ai-chat.image-role value, so cleanup tooling can select
# PORTICO-built images by label. Labels in non-final stages do not propagate to
# the image config, so placement after the last FROM is asserted explicitly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Dockerfile -> expected image-role value.
DOCKERFILE_ROLES="
Dockerfile.agent-vm=agent-vm
Dockerfile.bifrost-bridge=bifrost-bridge
Dockerfile.chat-state-api=chat-state-api
Dockerfile.health-check=health-check
Dockerfile.mcp-orc-rust=mcp-orc-rust
Dockerfile.mcp-orc-rust-core-group=mcp-orc-rust-core-group
Dockerfile.mcpo-control-plane-rust=mcpo-control-plane-rust
Dockerfile.open-webui-patched=open-webui-patched
Dockerfile.openapi-aggregator-rust=openapi-aggregator-rust
electron-app/Dockerfile.electron-build=electron-builder
electron-app/Dockerfile.build=electron-app-dist-build
llm-debug-monitor/Dockerfile=llm-debug-monitor
dev/Dockerfile.dev=open-webui-dev
"

# LABEL instructions may span multiple lines via trailing backslashes; find
# the line number of the label VALUE, which is what must sit after the last
# FROM to land in the final stage's image config.
label_value_line() {
  local file="$1" needle="$2"
  grep -nF "$needle" "$file" | head -1 | cut -d: -f1
}

checked=0
for entry in $DOCKERFILE_ROLES; do
  file="${entry%%=*}"
  role="${entry#*=}"
  path="$PROJECT_ROOT/$file"

  [ -f "$path" ] || fail "expected Dockerfile is missing: $file"

  last_from="$(grep -n '^FROM ' "$path" | tail -1 | cut -d: -f1)"
  [ -n "$last_from" ] || fail "$file has no FROM instruction"

  artifact_line="$(label_value_line "$path" 'com.portico.ai-chat.artifact="true"')"
  [ -n "$artifact_line" ] || fail "$file is missing the com.portico.ai-chat.artifact=\"true\" label"
  [ "$artifact_line" -gt "$last_from" ] \
    || fail "$file: com.portico.ai-chat.artifact label must be in the FINAL stage (after the last FROM at line $last_from, found at $artifact_line)"

  role_line="$(label_value_line "$path" "com.portico.ai-chat.image-role=\"$role\"")"
  [ -n "$role_line" ] || fail "$file is missing com.portico.ai-chat.image-role=\"$role\""
  [ "$role_line" -gt "$last_from" ] \
    || fail "$file: com.portico.ai-chat.image-role label must be in the FINAL stage (after the last FROM at line $last_from, found at $role_line)"

  checked=$((checked + 1))
done

[ "$checked" -eq 13 ] || fail "expected to check 13 Dockerfiles, checked $checked"

# The agent-vm role value has delete-semantics consumers (clean_full.sh,
# security-audit.sh filter image-role=agent-vm); it must never be reused.
role_dupes="$(grep -rhoF 'com.portico.ai-chat.image-role="agent-vm"' \
  "$PROJECT_ROOT"/Dockerfile.* \
  "$PROJECT_ROOT"/electron-app/Dockerfile.* \
  "$PROJECT_ROOT"/llm-debug-monitor/Dockerfile \
  "$PROJECT_ROOT"/dev/Dockerfile.dev | wc -l | tr -d ' ')"
[ "$role_dupes" -eq 1 ] \
  || fail "image-role=\"agent-vm\" must appear in exactly one Dockerfile (found $role_dupes)"

# No repository Dockerfile may be left out of the ownership contract.
unlabeled=""
for f in "$PROJECT_ROOT"/Dockerfile.* \
         "$PROJECT_ROOT"/electron-app/Dockerfile.* \
         "$PROJECT_ROOT"/llm-debug-monitor/Dockerfile \
         "$PROJECT_ROOT"/dev/Dockerfile.dev; do
  [ -f "$f" ] || continue
  grep -qF 'com.portico.ai-chat.artifact="true"' "$f" \
    || unlabeled="$unlabeled ${f#"$PROJECT_ROOT"/}"
done
[ -z "$unlabeled" ] || fail "Dockerfiles missing the ownership label:$unlabeled"

echo "PASS: PORTICO Dockerfile ownership label tests"
