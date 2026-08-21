#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SOURCEGRAPH_IMAGE="registry.example.invalid/sourcegraph-mcp-server:latest"
PLATFORM_IMAGE="harbor.example.invalid/example/platform-specific-mcp:latest"

setup_case_dir() {
  local case_name="$1"
  local case_dir="$TMP_DIR/$case_name"

  mkdir -p "$case_dir/bin" "$case_dir/app" "$case_dir/tmp-configs"
  cp "$PROJECT_ROOT/src/scripts/start-mcpo.sh" "$case_dir/start-mcpo.sh"

  cat >"$case_dir/bin/envsubst" <<'EOF'
#!/bin/sh
cat
EOF

  cat >"$case_dir/bin/mcpo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

: "${MCPO_LOG_PATH:?}"
printf '%s\n' "$*" >>"$MCPO_LOG_PATH"
EOF

  cat >"$case_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

: "${DOCKER_LOG_PATH:?}"

in_list() {
  local needle="$1"
  local list_file="$2"
  [ -n "$list_file" ] || return 1
  [ -f "$list_file" ] || return 1
  grep -Fxq "$needle" "$list_file"
}

case "${1:-}" in
  pull)
    shift
    platform="default"
    if [ "${1:-}" = "--platform" ]; then
      platform="${2:-}"
      shift 2
    fi
    image="${1:-}"
    printf 'pull|%s|%s\n' "$platform" "$image" >>"$DOCKER_LOG_PATH"
    if in_list "pull|$platform|$image" "${DOCKER_FAIL_PATH:-}"; then
      exit 1
    fi
    exit 0
    ;;
  image)
    if [ "${2:-}" != "inspect" ]; then
      echo "Unexpected docker command: $*" >&2
      exit 99
    fi
    shift 2
    platform="default"
    if [ "${1:-}" = "--platform" ]; then
      platform="${2:-}"
      shift 2
    fi
    image="${1:-}"
    printf 'inspect|%s|%s\n' "$platform" "$image" >>"$DOCKER_LOG_PATH"
    if in_list "inspect|$platform|$image" "${DOCKER_LOCAL_PATH:-}"; then
      exit 0
    fi
    exit 1
    ;;
  *)
    echo "Unexpected docker command: $*" >&2
    exit 99
    ;;
esac
EOF

  chmod +x "$case_dir/bin/envsubst" "$case_dir/bin/mcpo" "$case_dir/bin/docker"
  : >"$case_dir/docker.log"
  : >"$case_dir/mcpo.log"
}

run_case() {
  local case_name="$1"
  local case_dir="$TMP_DIR/$case_name"
  local output_file="$case_dir/output.log"

  set +e
  PATH="$case_dir/bin:$PATH" \
    MCPO_APP_ROOT="$case_dir/app" \
    MCPO_TEMP_DIR="$case_dir/tmp-configs" \
    DOCKER_LOG_PATH="$case_dir/docker.log" \
    DOCKER_FAIL_PATH="${DOCKER_FAIL_PATH:-}" \
    DOCKER_LOCAL_PATH="${DOCKER_LOCAL_PATH:-}" \
    MCPO_LOG_PATH="$case_dir/mcpo.log" \
    bash "$case_dir/start-mcpo.sh" >"$output_file" 2>&1
  local status=$?
  set -e

  printf '%s\n' "$status"
}

assert_file_contains() {
  local file_path="$1"
  local expected="$2"

  if ! grep -Fq -- "$expected" "$file_path"; then
    echo "Expected '$expected' in $file_path"
    cat "$file_path"
    exit 1
  fi
}

assert_file_not_contains() {
  local file_path="$1"
  local unexpected="$2"

  if grep -Fq -- "$unexpected" "$file_path"; then
    echo "Did not expect '$unexpected' in $file_path"
    cat "$file_path"
    exit 1
  fi
}

assert_count() {
  local expected_count="$1"
  local needle="$2"
  local file_path="$3"
  local actual_count

  actual_count="$(grep -Fc -- "$needle" "$file_path" || true)"
  if [ "$actual_count" != "$expected_count" ]; then
    echo "Expected '$needle' to appear $expected_count time(s) in $file_path, found $actual_count"
    cat "$file_path"
    exit 1
  fi
}

test_harbor_refresh_dedupes_and_preserves_platform() {
  local case_name="dedupe-and-platform"
  local case_dir="$TMP_DIR/$case_name"
  local status

  setup_case_dir "$case_name"

  cat >"$case_dir/app/mcp_config.json" <<JSON
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
        "$SOURCEGRAPH_IMAGE",
        "serve",
        "--transport",
        "stdio"
      ]
    },
    "sourcegraph-copy": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "$SOURCEGRAPH_IMAGE",
        "serve",
        "--transport",
        "stdio"
      ]
    },
    "platform-docker": {
      "command": "docker",
      "args": [
        "run",
        "--platform",
        "linux/amd64",
        "-i",
        "--rm",
        "$PLATFORM_IMAGE"
      ]
    },
    "external-docker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "docker.io/library/busybox:latest"
      ]
    },
    "python-server": {
      "command": "python",
      "args": ["server.py"]
    }
  }
}
JSON

  status="$(run_case "$case_name")"
  if [ "$status" -ne 0 ]; then
    echo "Expected Harbor refresh success for $case_name"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_count 1 "pull|default|$SOURCEGRAPH_IMAGE" "$case_dir/docker.log"
  assert_count 1 "pull|linux/amd64|$PLATFORM_IMAGE" "$case_dir/docker.log"
  assert_file_not_contains "$case_dir/docker.log" "busybox:latest"
  assert_file_contains "$case_dir/mcpo.log" "--config $case_dir/tmp-configs/mcp_config.json"
}

test_refresh_falls_back_to_cached_platform_image() {
  local case_name="fallback-to-cache"
  local case_dir="$TMP_DIR/$case_name"
  local status

  setup_case_dir "$case_name"

  cat >"$case_dir/app/mcp_config.json" <<JSON
{
  "mcpServers": {
    "platform-docker": {
      "command": "docker",
      "args": [
        "run",
        "--platform",
        "linux/amd64",
        "-i",
        "--rm",
        "$PLATFORM_IMAGE"
      ]
    }
  }
}
JSON

  printf 'pull|linux/amd64|%s\n' "$PLATFORM_IMAGE" >"$case_dir/docker-fail.txt"
  printf 'inspect|linux/amd64|%s\n' "$PLATFORM_IMAGE" >"$case_dir/docker-local.txt"

  status="$(
    DOCKER_FAIL_PATH="$case_dir/docker-fail.txt" \
    DOCKER_LOCAL_PATH="$case_dir/docker-local.txt" \
    run_case "$case_name"
  )"
  if [ "$status" -ne 0 ]; then
    echo "Expected cached-image fallback success for $case_name"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_file_contains "$case_dir/output.log" "continuing with cached local image"
  assert_file_contains "$case_dir/docker.log" "pull|linux/amd64|$PLATFORM_IMAGE"
  assert_file_contains "$case_dir/docker.log" "inspect|linux/amd64|$PLATFORM_IMAGE"
  assert_file_contains "$case_dir/mcpo.log" "--config $case_dir/tmp-configs/mcp_config.json"
}

test_refresh_fails_closed_without_usable_local_image() {
  local case_name="pull-failure-no-cache"
  local case_dir="$TMP_DIR/$case_name"
  local status

  setup_case_dir "$case_name"

  cat >"$case_dir/app/mcp_config.json" <<JSON
{
  "mcpServers": {
    "sourcegraph": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "$SOURCEGRAPH_IMAGE",
        "serve",
        "--transport",
        "stdio"
      ]
    }
  }
}
JSON

  printf 'pull|default|%s\n' "$SOURCEGRAPH_IMAGE" >"$case_dir/docker-fail.txt"

  status="$(
    DOCKER_FAIL_PATH="$case_dir/docker-fail.txt" \
    run_case "$case_name"
  )"
  if [ "$status" -eq 0 ]; then
    echo "Expected startup failure when pull fails and no cache is available"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_file_contains "$case_dir/output.log" "no usable local image was found"
  if [ -s "$case_dir/mcpo.log" ]; then
    echo "mcpo should not start when Harbor image refresh fails without a cache"
    cat "$case_dir/mcpo.log"
    exit 1
  fi
}
test_n8n_uses_hosted_oauth_transport() {
  local fragment="$PROJECT_ROOT/mcp-configs/mcp-n8n/mcp-n8n.fragment"

  assert_file_contains "$fragment" '"type": "streamable-http"'
  assert_file_contains "$fragment" '"url": "https://n8n.example.invalid/mcp-server/http"'
  assert_file_contains "$fragment" '"server_url": "https://n8n.example.invalid"'
  assert_file_not_contains "$fragment" '"command": "docker"'
  assert_file_not_contains "$fragment" 'harbor.example.invalid/n8n/n8n-mcp'
  assert_file_not_contains "$fragment" 'N8N_API_KEY'
}

test_n8n_uses_hosted_oauth_transport

test_harbor_refresh_dedupes_and_preserves_platform
test_refresh_falls_back_to_cached_platform_image
test_refresh_fails_closed_without_usable_local_image

echo "start-mcpo Harbor Docker image refresh handling looks correct."
