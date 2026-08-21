#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
LOG_FILE="$TMP_DIR/docker.log"
FAKE_BIN_DIR="$TMP_DIR/bin"
GENERATOR_FIXTURE="$TMP_DIR/generator-project"
REPO_ENV="$REPO_ROOT/.env"
REPO_ENV_BACKUP="$TMP_DIR/repo.env"
REPO_ENV_STATE="missing"
mkdir -p "$FAKE_BIN_DIR"
chmod 700 "$TMP_DIR"

# shellcheck source=src/scripts/protected-repository-env.sh
source "$REPO_ROOT/src/scripts/protected-repository-env.sh"

if [[ -f "$REPO_ENV" ]]; then
  cp -p "$REPO_ENV" "$REPO_ENV_BACKUP"
  chmod 600 "$REPO_ENV_BACKUP"
  REPO_ENV_STATE="file"
elif [[ -e "$REPO_ENV" ]]; then
  echo "Repository .env must be a regular file" >&2
  exit 1
fi

# shellcheck source=src/scripts/mcp-orc-generator-test-lib.sh
source "$REPO_ROOT/src/scripts/mcp-orc-generator-test-lib.sh"

restore_repo_env_snapshot() {
  if portico_repository_cloudsmith_assignment_changed \
    "$REPO_ENV" \
    "$REPO_ENV_BACKUP" \
    "$TMP_DIR/protected-key-check"; then
    echo "Repository .env CLOUDSMITH_API_KEY changed while the compose test ran; leaving the current file untouched" >&2
    return 1
  fi

  if [[ "$REPO_ENV_STATE" == "file" ]]; then
    if [[ ! -f "$REPO_ENV" ]] || ! cmp -s "$REPO_ENV_BACKUP" "$REPO_ENV"; then
      cp -p "$REPO_ENV_BACKUP" "$REPO_ENV"
      chmod 600 "$REPO_ENV"
    fi
  elif [[ -e "$REPO_ENV" ]]; then
    rm -f "$REPO_ENV"
  fi
}

cleanup() {
  restore_repo_env_snapshot || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"

if [[ "$1" == "image" && "${2:-}" == "inspect" ]]; then
  exit 1
fi

if [[ "$1" == "info" ]]; then
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  if [[ "${2:-}" == "version" ]]; then
    printf 'Docker Compose version v2.39.1\n'
    exit 0
  fi

  if [[ "$*" == *"config --images"* ]]; then
    printf 'harbor.example.invalid/portico/open-webui-patched:dev-build\n'
    exit 0
  fi

  if [[ "$*" == *"config --services"* ]]; then
    printf 'mcpo\nhealth-check\n'
    exit 0
  fi
  echo "unexpected docker compose invocation: $*" >&2
  exit 97
fi

echo "unexpected docker invocation: $*" >&2
exit 98
EOF
chmod +x "$FAKE_BIN_DIR/docker"

(
  cd "$REPO_ROOT"
  PATH="$FAKE_BIN_DIR:$PATH" LOG_FILE="$LOG_FILE" \
    PORTICO_RUNTIME_DISABLE_KEYCHAIN=1 \
    PORTICO_RUNTIME_SECRET_CACHE_DIR="$TMP_DIR/runtime-secrets" \
    LOCAL_STACK_API_KEY=test-local-stack \
    INTERNAL_OPENAI_API_KEY=test-local-stack \
    OPENAI_API_KEY=test-local-stack \
    BIFROST_BRIDGE_LOCAL_API_KEY=test-bifrost \
    OWUI_AUTH_BRIDGE_SECRET=test-auth \
    WEBUI_SECRET_KEY=test-webui \
    PORTICO_LLM_API_KEY=11111111-1111-4111-8111-111111111111 \
    LLM_GATEWAY_MODE=bifrost MCP_ORC_MODE=rust-full \
    bash src/scripts/docker-compose.sh config --services >/dev/null
)

restore_repo_env_snapshot

expected_compose_files="compose -f docker-compose.yml -f docker-compose.advanced.yml"
if [[ -f "$REPO_ROOT/docker-compose.override.yml" ]]; then
  expected_compose_files+=" -f docker-compose.override.yml"
fi

if ! grep -Fxq "$expected_compose_files config --services" "$LOG_FILE" \
  && ! grep -Fxq "$expected_compose_files -f dev/docker-compose.debug-monitor.yml config --services" "$LOG_FILE"; then
  echo "docker-compose.sh did not resolve the expected runtime compose files" >&2
  exit 1
fi

read_extra_hosts_merge_state() {
  local compose_file="$1"
  awk '
    /^  llm-gateway:/ {
      in_service = 1
      next
    }
    in_service && /^  [^ ].*:/ {
      exit
    }
    in_service && /^    extra_hosts:/ {
      in_extra_hosts = 1
      if ($0 ~ /!override/) {
        override = 1
      }
      next
    }
    in_extra_hosts && /^    [^ ].*:/ {
      in_extra_hosts = 0
    }
    in_extra_hosts && /^      - / {
      count += 1
    }
    END {
      printf "%s %d\n", override ? "override" : "append", count
    }
  ' "$compose_file"
}

read -r base_extra_hosts_mode base_extra_hosts_count < <(read_extra_hosts_merge_state "$REPO_ROOT/docker-compose.yml")
[[ "$base_extra_hosts_mode" == "append" ]]
[[ "$base_extra_hosts_count" -eq 1 ]]
grep -F -q './health-status:/app/health-status:ro' "$REPO_ROOT/docker-compose.yml"

mcp_orc_test_prepare_project_root "$REPO_ROOT" "$GENERATOR_FIXTURE"
mcp_orc_test_copy_server_configs "$REPO_ROOT" "$GENERATOR_FIXTURE" \
  agent-vm \
  artifacts \
  mcp-assistant \
  scheduling \
  skills \
  subagents \
  web-tools \
  glean
cat >"$GENERATOR_FIXTURE/mcp_toggles.json" <<'JSON'
{
  "agent-vm": true,
  "artifacts": true,
  "mcp-assistant": true,
  "scheduling": true,
  "skills": true,
  "subagents": true,
  "web-tools": true,
  "glean": true
}
JSON

MCP_ORC_MODE=rust-full LLM_GATEWAY_MODE=bifrost \
  mcp_orc_test_run_generator "$REPO_ROOT" "$GENERATOR_FIXTURE" generate-docker-compose-override --force >/dev/null

grep -q 'healthcheck:' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q '/usr/bin/bash -lc' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'GET /health HTTP/1.1' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'interval: 30s' "$GENERATOR_FIXTURE/docker-compose.override.yml"
! grep -q 'supervisorctl -s unix:///tmp/supervisor.sock status aggregator-regular aggregator-core nginx' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'condition: service_healthy' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'NO_PROXY=.*llm-gateway.*open-webui-health-check.*host.docker.internal' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'NO_PROXY=.*mcpo-group-core' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'NO_PROXY=.*mcpo-glean' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'no_proxy=.*llm-gateway.*open-webui-health-check.*host.docker.internal' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'no_proxy=.*mcpo-group-core' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -q 'no_proxy=.*mcpo-glean' "$GENERATOR_FIXTURE/docker-compose.override.yml"
grep -F -q 'proxy_pass http://$upstream$request_uri;' \
  "$GENERATOR_FIXTURE/src/mcpo-nginx.conf" \
  "$GENERATOR_FIXTURE/src/mcpo-core-nginx.conf"

echo "docker-compose.sh config resolves the runtime compose files correctly"
echo "base docker-compose.yml keeps a single llm-gateway extra_hosts entry"
echo "base docker-compose.yml mounts the health snapshot read-only into open-webui"
echo "mcp-orc generate-docker-compose-override emits the lightweight mcpo health gating checks"
echo "generated compose override includes internal proxy bypass entries"
echo "generated nginx keeps the per-server prefix when proxying MCP tool routes"
