#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FAKE_BIN_DIR/uname" <<'EOF'
#!/usr/bin/env bash
printf 'arm64\n'
EOF
chmod +x "$FAKE_BIN_DIR/uname"

cat >"$FAKE_BIN_DIR/sleep" <<'EOF'
#!/usr/bin/env bash
LOG_FILE="${LOG_FILE:-}"
if [ -n "$LOG_FILE" ]; then
  printf 'sleep %s\n' "$*" >>"$LOG_FILE"
fi
exit 0
EOF
chmod +x "$FAKE_BIN_DIR/sleep"

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:?}"
DOCKER_FAKE_MODE="${DOCKER_FAKE_MODE:-stale}"
ATTEMPT_FILE="${DOCKER_FAKE_ATTEMPT_FILE:-}"

printf '%s\n' "$*" >>"$LOG_FILE"
args="$*"

if [[ "$1" == "info" ]]; then
  exit 0
fi

if [[ "$1" == "image" && "${2:-}" == "inspect" ]]; then
  if [[ "$args" == *"--format"* && "$args" == *"Architecture"* ]]; then
    printf 'arm64\n'
  fi
  exit 0
fi

if [[ "$1" == "inspect" ]]; then
  printf 'running\n'
  exit 0
fi

if [[ "$1" == "exec" && "${2:-}" == "llm-gateway" ]]; then
  exit 0
fi

if [[ "$1" == "exec" && "${2:-}" == "-u" && "${3:-}" == "0" ]]; then
  # Core runtime secret mounts are healthy in this stale-container fixture.
  exit 0
fi

if [[ "$1" == "rm" ]]; then
  exit 0
fi

if [[ "$1" == "ps" ]]; then
  if [[ "$DOCKER_FAKE_MODE" == "status_snapshot" && "$args" == *"--format"* && "$args" == *"State"* ]]; then
    printf 'llm-gateway\trunning\n'
    printf 'mcpo\texited\n'
    printf 'portico-open-webui\trunning\n'
    printf 'mcpo-slack\trunning\n'
    printf 'mcpo-retired\texited\n'
    exit 0
  fi

  if [[ "$args" == *"ancestor=registry.example.invalid/sourcegraph-mcp-server:latest"* ]]; then
    if [[ "$DOCKER_FAKE_MODE" == "stale" ]]; then
      printf 'nifty_brown\n'
    fi
    exit 0
  fi

  if [[ "$args" == *"label=com.docker.compose.service=mcpo-sourcegraph"* ]]; then
    if [[ "$DOCKER_FAKE_MODE" == "stale" ]]; then
      printf 'portico-mcpo-sourcegraph-1\n'
    fi
    exit 0
  fi

  if [[ "$args" == *"label=com.docker.compose.service="* ]]; then
    exit 0
  fi

  if [[ "$args" == *"label=com.docker.compose.project=portico"* && "$args" != *"label=com.docker.compose.service="* ]]; then
    if [[ "$DOCKER_FAKE_MODE" == "stale" ]]; then
      printf 'mcpo-retired\n'
    fi
    exit 0
  fi

  if [[ "$args" == *'--format {{.Names}}'* ]]; then
    if [[ "$DOCKER_FAKE_MODE" == "stale" ]]; then
      printf 'mcpo-sourcegraph\n'
    fi
    exit 0
  fi

  exit 0
fi

if [[ "$1" == "compose" ]]; then
  if [[ "${2:-}" == "version" ]]; then
    if [[ "$DOCKER_FAKE_MODE" == "compose_unavailable" ]]; then
      printf 'docker: unknown command: docker compose\n' >&2
      exit 1
    fi
    printf 'Docker Compose version v2.39.1\n'
    exit 0
  fi

  if [[ "$args" == *"config --images"* ]]; then
    if [[ "$DOCKER_FAKE_MODE" == "compose_config_fail" ]]; then
      printf 'validating %s/docker-compose.yml: services.llm-gateway.extra_hosts array items[0,1] must be unique\n' "$PWD" >&2
      exit 14
    fi

    if [[ "$DOCKER_FAKE_MODE" == "stale" ]]; then
      printf 'harbor.example.invalid/portico/open-webui:04182026-147fd34b\n'
      printf 'harbor.example.invalid/portico/health-check:04182026-147fd34b\n'
    fi
    exit 0
  fi

  if [[ "$args" == *"config --services"* ]]; then
    printf 'redis\nmongodb\nopen-webui\nhealth-check\nllm-gateway\nmcpo-sourcegraph\n'
    exit 0
  fi

  if [[ "$args" == *" config"* ]]; then
    printf 'services:\n  redis:\n    image: redis\n  mongodb:\n    image: mongo\n  mcpo-sourcegraph:\n    image: mcpo\n'
    exit 0
  fi

  if [[ "$args" == *" up -d"* ]]; then
    if [[ "$DOCKER_FAKE_MODE" == "conflict" ]]; then
      current_attempt=0
      if [[ -n "$ATTEMPT_FILE" && -f "$ATTEMPT_FILE" ]]; then
        current_attempt="$(cat "$ATTEMPT_FILE")"
      fi
      next_attempt=$((current_attempt + 1))
      if [[ -n "$ATTEMPT_FILE" ]]; then
        printf '%s\n' "$next_attempt" >"$ATTEMPT_FILE"
      fi
      if [[ "$next_attempt" -eq 1 ]]; then
        printf 'Error response from daemon: Conflict. The container name "/mcpo-sourcegraph" is already in use by container "old".\n' >&2
        printf 'Error response from daemon: Conflict. The container name "/postgres" is already in use by container "external".\n' >&2
        exit 1
      fi
    fi
    exit 0
  fi
fi

printf 'unexpected docker invocation: %s\n' "$args" >&2
exit 99
EOF
chmod +x "$FAKE_BIN_DIR/docker"

cat >"$FAKE_BIN_DIR/docker-compose" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker-compose %s\n' "$*" >>"${LOG_FILE:?}"
printf 'docker-compose: command not found\n' >&2
exit 127
EOF
chmod +x "$FAKE_BIN_DIR/docker-compose"

create_fixture() {
  local fixture_dir="$1"
  local build_number="$2"

  mkdir -p \
    "$fixture_dir/src/scripts" \
    "$fixture_dir/electron-app" \
    "$fixture_dir/mcpo-configs-generated"

  cp "$REPO_ROOT/src/scripts/docker-compose.sh" "$fixture_dir/src/scripts/docker-compose.sh"
  chmod +x "$fixture_dir/src/scripts/docker-compose.sh"

  cp "$REPO_ROOT/src/scripts/mcp-orc-backend.sh" "$fixture_dir/src/scripts/mcp-orc-backend.sh"
  cp "$REPO_ROOT/src/scripts/agent-vm-image-resolve.sh" "$fixture_dir/src/scripts/agent-vm-image-resolve.sh"

  cat >"$fixture_dir/src/scripts/mcp-orc-cli.sh" <<'EOF'
export_mcp_orc_compose_env() {
  export MCP_ORC_MODE_RESOLVED="${MCP_ORC_MODE:-rust-full}"
}

export_mcp_orc_harbor_env() {
  local build_number="$1"
  export MCPO_HARBOR_IMAGE="harbor.example.invalid/portico/mcpo:${build_number}"
  export MCPO_CORE_HARBOR_IMAGE="harbor.example.invalid/portico/mcpo-core:${build_number}"
  export MCPO_CONTROL_PLANE_HARBOR_IMAGE="harbor.example.invalid/portico/mcpo-control-plane-rust:${build_number}"
  export OPENAPI_AGGREGATOR_HARBOR_IMAGE="harbor.example.invalid/portico/openapi-aggregator:${build_number}"
}

resolve_mcp_orc_generator_binary() {
  return 1
}

run_mcp_orc_generator() {
  if [ "${2:-}" = "prepare-managed-node-packages" ]; then
    return 0
  fi
  return 1
}
EOF

  cat >"$fixture_dir/src/scripts/managed-runtime-integrity.sh" <<'EOF'
managed_runtime_is_packaged_runtime() {
  return 1
}

managed_runtime_self_heal_packaged_runtime() {
  return 0
}
EOF

  cat >"$fixture_dir/src/scripts/runtime-secrets.sh" <<'EOF'
ensure_runtime_secret_env() {
  export PORTICO_LLM_API_KEY="${PORTICO_LLM_API_KEY:-stub-portico-llm-key}"
  export LOCAL_STACK_API_KEY="${LOCAL_STACK_API_KEY:-stub-local-stack-key}"
  export INTERNAL_OPENAI_API_KEY="$LOCAL_STACK_API_KEY"
  export OPENAI_API_KEY="$LOCAL_STACK_API_KEY"
  export BIFROST_BRIDGE_LOCAL_API_KEY="${BIFROST_BRIDGE_LOCAL_API_KEY:-stub-bifrost-local-key}"
  return 0
}

is_malformed_upstream_key() {
  return 1
}
EOF

  cat >"$fixture_dir/electron-app/build-info.json" <<EOF
{"buildNumber":"$build_number"}
EOF

  cat >"$fixture_dir/mcpo-configs-generated/sourcegraph.json" <<'EOF'
{
  "mcpServers": {
    "sourcegraph": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--init",
        "-e",
        "SOURCEGRAPH_TOKEN",
        "-e",
        "SOURCEGRAPH_URL",
        "registry.example.invalid/sourcegraph-mcp-server:latest",
        "serve",
        "--transport",
        "stdio"
      ]
    }
  }
}
EOF

  touch \
    "$fixture_dir/.env" \
    "$fixture_dir/docker-compose.yml" \
    "$fixture_dir/docker-compose.advanced.yml" \
    "$fixture_dir/docker-compose.override.yml" \
    "$fixture_dir/docker-compose.harbor.yml"
}

STATUS_FIXTURE="$TMP_DIR/status"
STATUS_LOG="$TMP_DIR/status-docker.log"
create_fixture "$STATUS_FIXTURE" "dev-build"
status_output="$(
  cd "$STATUS_FIXTURE" &&
    PATH="$FAKE_BIN_DIR:$PATH" \
      LOG_FILE="$STATUS_LOG" \
      DOCKER_FAKE_MODE=status_snapshot \
      MCPO_SKIP_GENERATED_OVERRIDE_REFRESH=1 \
      LLM_GATEWAY_MODE=bifrost \
      MCP_ORC_MODE=rust-full \
      bash src/scripts/docker-compose.sh status 2>/dev/null
)"

[ "$status_output" = '{"llm-gateway":"running","mcpo":"stopped","portico-open-webui":"running","open-webui-health-check":"not_found","mcpo-slack":"running"}' ]
[ "$(grep -c '^ps -a --format' "$STATUS_LOG")" -eq 1 ]

STALE_FIXTURE="$TMP_DIR/stale"
STALE_LOG="$TMP_DIR/stale-docker.log"
create_fixture "$STALE_FIXTURE" "04182026-147fd34b"
(
  cd "$STALE_FIXTURE"
  PATH="$FAKE_BIN_DIR:$PATH" \
    LOG_FILE="$STALE_LOG" \
    DOCKER_FAKE_MODE=stale \
    MCPO_SKIP_GENERATED_OVERRIDE_REFRESH=1 \
    LLM_GATEWAY_MODE=bifrost \
    MCP_ORC_MODE=rust-full \
    bash src/scripts/docker-compose.sh start advanced >/dev/null
)

grep -q '^rm -f portico-mcpo-sourcegraph-1$' "$STALE_LOG"
grep -q '^rm -f mcpo-sourcegraph$' "$STALE_LOG"
grep -q '^rm -f mcpo-retired$' "$STALE_LOG"
grep -q '^rm -f nifty_brown$' "$STALE_LOG"
grep -Eq 'compose .* up -d --force-recreate' "$STALE_LOG"

CONFLICT_FIXTURE="$TMP_DIR/conflict"
CONFLICT_LOG="$TMP_DIR/conflict-docker.log"
CONFLICT_ATTEMPTS="$TMP_DIR/conflict-attempts"
create_fixture "$CONFLICT_FIXTURE" "dev-build"
(
  cd "$CONFLICT_FIXTURE"
  PATH="$FAKE_BIN_DIR:$PATH" \
    LOG_FILE="$CONFLICT_LOG" \
    DOCKER_FAKE_MODE=conflict \
    DOCKER_FAKE_ATTEMPT_FILE="$CONFLICT_ATTEMPTS" \
    MCPO_SKIP_GENERATED_OVERRIDE_REFRESH=1 \
    LLM_GATEWAY_MODE=bifrost \
    MCP_ORC_MODE=rust-full \
    bash src/scripts/docker-compose.sh start advanced >/dev/null
)

compose_up_attempts="$(grep -Ec 'compose .* up -d' "$CONFLICT_LOG")"
[ "$compose_up_attempts" -eq 2 ]
grep -q '^rm -f mcpo-sourcegraph$' "$CONFLICT_LOG"
! grep -q '^rm -f postgres$' "$CONFLICT_LOG"

CONFIG_FAIL_FIXTURE="$TMP_DIR/config-fail"
create_fixture "$CONFIG_FAIL_FIXTURE" "05082026-aaf357b8"
cat >"$CONFIG_FAIL_FIXTURE/src/scripts/managed-runtime-integrity.sh" <<'EOF'
managed_runtime_is_packaged_runtime() {
  return 0
}

managed_runtime_self_heal_packaged_runtime() {
  return 0
}
EOF

set +e
config_fail_output="$(
  cd "$CONFIG_FAIL_FIXTURE" &&
    PATH="$FAKE_BIN_DIR:$PATH" \
      LOG_FILE="$TMP_DIR/config-fail-docker.log" \
      DOCKER_FAKE_MODE=compose_config_fail \
      MCPO_SKIP_GENERATED_OVERRIDE_REFRESH=1 \
      LLM_GATEWAY_MODE=bifrost \
      MCP_ORC_MODE=rust-full \
      bash src/scripts/docker-compose.sh start advanced 2>&1
)"
config_fail_status=$?
set -e

[ "$config_fail_status" -ne 0 ]
grep -q 'Docker compose config failed while probing Harbor images' <<<"$config_fail_output"
grep -q 'services.llm-gateway.extra_hosts array items\[0,1\] must be unique' <<<"$config_fail_output"
grep -q 'Packaged runtime requires Harbor images for build 05082026-aaf357b8' <<<"$config_fail_output"

COMPOSE_UNAVAILABLE_FIXTURE="$TMP_DIR/compose-unavailable"
COMPOSE_UNAVAILABLE_LOG="$TMP_DIR/compose-unavailable-docker.log"
create_fixture "$COMPOSE_UNAVAILABLE_FIXTURE" "05282026-c2bf1c8a"
cat >"$COMPOSE_UNAVAILABLE_FIXTURE/src/scripts/managed-runtime-integrity.sh" <<'EOF'
managed_runtime_is_packaged_runtime() {
  return 0
}

managed_runtime_self_heal_packaged_runtime() {
  return 0
}
EOF

set +e
compose_unavailable_output="$(
  cd "$COMPOSE_UNAVAILABLE_FIXTURE" &&
    PATH="$FAKE_BIN_DIR:$PATH" \
      LOG_FILE="$COMPOSE_UNAVAILABLE_LOG" \
      DOCKER_FAKE_MODE=compose_unavailable \
      MCPO_SKIP_GENERATED_OVERRIDE_REFRESH=1 \
      LLM_GATEWAY_MODE=bifrost \
      MCP_ORC_MODE=rust-full \
      bash src/scripts/docker-compose.sh start advanced 2>&1
)"
compose_unavailable_status=$?
set -e

[ "$compose_unavailable_status" -eq 125 ]
grep -q 'DOCKER_COMPOSE_UNAVAILABLE' <<<"$compose_unavailable_output"
! grep -q 'Packaged runtime requires Harbor images' <<<"$compose_unavailable_output"
! grep -q 'Starting docker compose (attempt' <<<"$compose_unavailable_output"
! grep -q 'config --images' "$COMPOSE_UNAVAILABLE_LOG"
! grep -q ' up -d' "$COMPOSE_UNAVAILABLE_LOG"

echo "docker-compose.sh removes stale app-owned MCP containers and retries expected name conflicts"
echo "docker-compose.sh surfaces compose config failures during packaged Harbor probes"
echo "docker-compose.sh fails unavailable Compose before Harbor probing or retry loops"
echo "docker-compose.sh status uses one daemon snapshot without grep pipelines"
