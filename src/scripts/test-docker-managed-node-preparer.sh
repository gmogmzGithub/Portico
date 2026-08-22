#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TMP_DIR/bin"
LOG_FILE="$TMP_DIR/docker.log"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "$FAKE_BIN_DIR"
cat >"$FAKE_BIN_DIR/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"

if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then
  exit 0
fi

if [ "${1:-}" = "run" ]; then
  args="$*"
  npmrc_mount=""
  case "$args" in
    *"/.npmrc:/work/.npmrc"*|*"/.npmrc:/root/.npmrc"*|*"NODE_AUTH_TOKEN"*|*"NPM_TOKEN"*|*"NPM_CONFIG_GLOBALCONFIG"*)
      echo "forbidden npm credential exposure in docker run args" >&2
      exit 31
      ;;
  esac
  case "$args" in
    *".docker-preparer:/work/open-webui-data/managed-node-mcp-package-acquisition"*)
      echo "temporary npmrc directory must not be exposed through acquisition scratch" >&2
      exit 35
      ;;
  esac
  case "$args" in
    *":/run/managed-node-preparer/npmrc:ro"* ) ;;
    * ) echo "expected temporary npmrc secret mount" >&2; exit 32 ;;
  esac
  for arg in "$@"; do
    case "$arg" in
      *:/run/managed-node-preparer/npmrc:ro)
        npmrc_mount="${arg%:/run/managed-node-preparer/npmrc:ro}"
        ;;
    esac
  done
  [ -f "$npmrc_mount" ] || { echo "temporary npmrc mount source is missing" >&2; exit 36; }
  grep -Eq '^[[:space:]]*registry[[:space:]]*=' "$npmrc_mount" \
    || { echo "temporary npmrc is missing its registry" >&2; exit 37; }
  cp "$npmrc_mount" "${CAPTURED_NPMRC:?}"
  case "$args" in
    *"portico_MANAGED_NODE_DIRECT_NPM=1"* ) ;;
    * ) echo "expected direct npm mode for Docker preparer" >&2; exit 33 ;;
  esac
  case "$args" in
    *"HOST_NODE_PATH=/usr/local/bin/node"* ) ;;
    * ) echo "expected explicit trusted node path for Docker preparer" >&2; exit 38 ;;
  esac
  case "$args" in
    *"portico_MANAGED_NODE_NPM_BIN=/usr/local/bin/npm"* ) ;;
    * ) echo "expected explicit trusted npm path for Docker preparer" >&2; exit 39 ;;
  esac
  case "$args" in
    *":/work/health-status:rw"* ) ;;
    * ) echo "expected health-status mount for Docker preparer" >&2; exit 40 ;;
  esac
  case "$args" in
    *"prepare-managed-node-packages --enabled-only --deployment-type docker --project-root /work"* ) ;;
    * ) echo "expected scoped Docker package preparation command" >&2; exit 34 ;;
  esac
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 99
SH
chmod +x "$FAKE_BIN_DIR/docker"

fixture="$TMP_DIR/project"
mkdir -p "$fixture/mcp-configs-user/docker-node" "$fixture/electron-app"
cat >"$fixture/mcp-configs-user/docker-node/docker-node.yaml" <<'YAML'
name: docker-node
id: docker-node
deployment_type: docker
required_env_vars: []
YAML
cat >"$fixture/mcp-configs-user/docker-node/docker-node.fragment" <<'JSON'
{"command":"npx","args":["-y","@portico/docker-node-demo@1.2.3"]}
JSON
cat >"$fixture/mcp_toggles.json" <<'JSON'
{"docker-node":true}
JSON
cat >"$fixture/electron-app/.npmrc" <<'NPMRC'
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=packaged-test-token
NPMRC
cat >"$fixture/electron-app/build-info.json" <<'JSON'
{"buildNumber":"dev-build"}
JSON

# shellcheck source=src/scripts/mcp-orc-backend.sh
source "$REPO_ROOT/src/scripts/mcp-orc-backend.sh"
# shellcheck source=src/scripts/mcp-orc-cli.sh
source "$REPO_ROOT/src/scripts/mcp-orc-cli.sh"

unset portico_MANAGED_NODE_NPMRC NPM_CONFIG_GLOBALCONFIG npm_config_globalconfig

ambient_npmrc="$TMP_DIR/ambient-global.npmrc"
cat >"$ambient_npmrc" <<'NPMRC'
registry=https://ambient.example.com/npm/
//ambient.example.com/npm/:_authToken=ambient-test-token
NPMRC
export NPM_CONFIG_GLOBALCONFIG="$ambient_npmrc"

CAPTURED_NPMRC="$TMP_DIR/captured.npmrc"

run_preparer() {
  local explicit_npmrc="${1:-}"

  : >"$LOG_FILE"
  rm -f "$CAPTURED_NPMRC"
  if [ -n "$explicit_npmrc" ]; then
    PATH="$FAKE_BIN_DIR:/usr/bin:/bin" \
      LOG_FILE="$LOG_FILE" \
      CAPTURED_NPMRC="$CAPTURED_NPMRC" \
      portico_MANAGED_NODE_NPMRC="$explicit_npmrc" \
      portico_MANAGED_NODE_PREPARER_IMAGE="portico-mcp-orc-rust:test" \
      run_mcp_orc_docker_managed_node_preparer "$fixture" --enabled-only --deployment-type docker
  else
    PATH="$FAKE_BIN_DIR:/usr/bin:/bin" \
      LOG_FILE="$LOG_FILE" \
      CAPTURED_NPMRC="$CAPTURED_NPMRC" \
      portico_MANAGED_NODE_PREPARER_IMAGE="portico-mcp-orc-rust:test" \
      run_mcp_orc_docker_managed_node_preparer "$fixture" --enabled-only --deployment-type docker
  fi
}

assert_preparer_contract() {
  grep -q '^image inspect portico-mcp-orc-rust:test$' "$LOG_FILE" \
    || fail "expected preparer image inspection"
  grep -q '^run ' "$LOG_FILE" \
    || fail "expected one-shot docker run"
  if grep -q ':/work/.npmrc' "$LOG_FILE"; then
    fail "project .npmrc must not be mounted into the Docker preparer"
  fi
  if find "$fixture/open-webui-data/managed-node-mcp-package-acquisition" -name managed-node-install.npmrc -print | grep -q .; then
    fail "temporary npmrc must be removed after Docker preparation"
  fi
  if grep -q -- '-test-token' "$LOG_FILE"; then
    fail "npm credentials must not be exposed in Docker command logs"
  fi
}

run_preparer
assert_preparer_contract
grep -q 'packaged-test-token' "$CAPTURED_NPMRC" \
  || fail "packaged electron-app/.npmrc should be used when root .npmrc is absent"
if grep -q 'ambient-test-token' "$CAPTURED_NPMRC"; then
  fail "global npm config must not override the packaged project config"
fi

cat >"$fixture/.npmrc" <<'NPMRC'
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=root-test-token
NPMRC
run_preparer
assert_preparer_contract
grep -q 'root-test-token' "$CAPTURED_NPMRC" \
  || fail "root .npmrc should take precedence over packaged electron-app/.npmrc"
if grep -q 'packaged-test-token' "$CAPTURED_NPMRC"; then
  fail "packaged npm config must not override an available root .npmrc"
fi
if grep -q 'ambient-test-token' "$CAPTURED_NPMRC"; then
  fail "global npm config must not override an available root .npmrc"
fi

explicit_npmrc="$TMP_DIR/explicit.npmrc"
cat >"$explicit_npmrc" <<'NPMRC'
registry=https://packages.example.com/npm/
//packages.example.com/npm/:_authToken=explicit-test-token
NPMRC
run_preparer "$explicit_npmrc"
assert_preparer_contract
grep -q 'explicit-test-token' "$CAPTURED_NPMRC" \
  || fail "portico_MANAGED_NODE_NPMRC should take precedence over project configs"
if grep -Eq '(root|packaged)-test-token' "$CAPTURED_NPMRC"; then
  fail "explicit npm config must not be merged with project npm credentials"
fi

rm -f "$fixture/.npmrc" "$fixture/electron-app/.npmrc"
global_npmrc="$TMP_DIR/global.npmrc"
cat >"$global_npmrc" <<'NPMRC'
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=global-test-token
NPMRC
: >"$LOG_FILE"
rm -f "$CAPTURED_NPMRC"
PATH="$FAKE_BIN_DIR:/usr/bin:/bin" \
  LOG_FILE="$LOG_FILE" \
  CAPTURED_NPMRC="$CAPTURED_NPMRC" \
  NPM_CONFIG_GLOBALCONFIG="$global_npmrc" \
  portico_MANAGED_NODE_PREPARER_IMAGE="portico-mcp-orc-rust:test" \
  run_mcp_orc_docker_managed_node_preparer "$fixture" --enabled-only --deployment-type docker
assert_preparer_contract
grep -q 'global-test-token' "$CAPTURED_NPMRC" \
  || fail "global npm config fallback should remain supported"

rm -f "$global_npmrc"
unset NPM_CONFIG_GLOBALCONFIG npm_config_globalconfig
: >"$LOG_FILE"
rm -f "$CAPTURED_NPMRC"
if PATH="$FAKE_BIN_DIR:/usr/bin:/bin" \
  LOG_FILE="$LOG_FILE" \
  CAPTURED_NPMRC="$CAPTURED_NPMRC" \
  portico_MANAGED_NODE_PREPARER_IMAGE="portico-mcp-orc-rust:test" \
  run_mcp_orc_docker_managed_node_preparer "$fixture" --enabled-only --deployment-type docker; then
  fail "missing npm registry should fail closed"
fi
if [ -s "$LOG_FILE" ]; then
  fail "missing npm registry should fail before inspecting or pulling the preparer image"
fi
if [ -e "$fixture/open-webui-data/managed-node-mcp-package-acquisition/.docker-preparer" ]; then
  fail "failed npm registry validation should remove temporary credentials"
fi

cat >"$fixture/electron-app/.npmrc" <<'NPMRC'
registry=https://packages.example.com/npm/
//packages.example.com/npm/:_authToken=external-test-token
NPMRC
run_preparer
assert_preparer_contract
grep -q 'external-test-token' "$CAPTURED_NPMRC" \
  || fail "an alternate HTTPS npm registry should be supported"

cat >"$fixture/electron-app/.npmrc" <<'NPMRC'
registry=http://registry.npmjs.org/
NPMRC
: >"$LOG_FILE"
rm -f "$CAPTURED_NPMRC"
if PATH="$FAKE_BIN_DIR:/usr/bin:/bin" \
  LOG_FILE="$LOG_FILE" \
  CAPTURED_NPMRC="$CAPTURED_NPMRC" \
  portico_MANAGED_NODE_PREPARER_IMAGE="portico-mcp-orc-rust:test" \
  run_mcp_orc_docker_managed_node_preparer "$fixture" --enabled-only --deployment-type docker; then
  fail "an insecure npm registry should fail closed"
fi
if [ -s "$LOG_FILE" ]; then
  fail "insecure npm registry should fail before inspecting or pulling the preparer image"
fi
if [ -e "$fixture/open-webui-data/managed-node-mcp-package-acquisition/.docker-preparer" ]; then
  fail "insecure npm registry validation should remove temporary credentials"
fi

echo "PASS: Docker managed Node preparer uses provider-neutral HTTPS registries, strict precedence, and temporary credentials"
