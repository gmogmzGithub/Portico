#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

  chmod +x "$case_dir/bin/envsubst" "$case_dir/bin/mcpo"
  : >"$case_dir/mcpo.log"
}

patch_case_script() {
  local case_dir="$1"

  python3 - "$case_dir/start-mcpo.sh" <<'PY'
import sys
from pathlib import Path

script_path = Path(sys.argv[1])
source = script_path.read_text()
anchor = '\nif [ "${portico_PREINSTALL_RUNTIME_MCPS_ONLY:-0}" = "1" ]; then\n'
insertion = """
if [ -n "${TEST_RUNTIME_MCP_ZIP:-}" ] && [ -n "${TEST_RUNTIME_MCP_TARGET_DIR:-}" ]; then
install_runtime_mcp \
    --server-id "test_runtime" \
    --display-name "Test Runtime MCP" \
    --zip-path "$TEST_RUNTIME_MCP_ZIP" \
    --target-dir "$TEST_RUNTIME_MCP_TARGET_DIR" \
    --zip-internal-dir "${TEST_RUNTIME_MCP_HINT:-}"
fi
"""

if anchor not in source:
    raise SystemExit(f"missing injection anchor in {script_path}")

script_path.write_text(source.replace(anchor, f"{insertion}{anchor}", 1))
PY
}

create_runtime_zip() {
  local zip_path="$1"

  python3 - "$zip_path" <<'PY'
import sys
import zipfile
from pathlib import Path

zip_path = Path(sys.argv[1])
root_name = "test-runtime-feature-inline-images"
files = {
    f"{root_name}/.cursor/.iago-framework": "feature-branch\n",
    f"{root_name}/README.md": "runtime mcp fixture\n",
    f"{root_name}/server.py": "print('ok')\n",
}

with zipfile.ZipFile(zip_path, "w") as archive:
    for name, content in files.items():
        archive.writestr(name, content)
PY
}

seed_stale_extracted_root() {
  local case_dir="$1"

  mkdir -p "$case_dir/app/mcp-servers/test-runtime-feature-inline-images/.cursor"
  printf 'stale-root\n' >"$case_dir/app/mcp-servers/test-runtime-feature-inline-images/.cursor/.iago-framework"
}

run_case() {
  local case_name="$1"
  local case_dir="$TMP_DIR/$case_name"
  local output_file="$case_dir/output.log"

  set +e
  PATH="$case_dir/bin:$PATH" \
    MCPO_APP_ROOT="$case_dir/app" \
    MCPO_TEMP_DIR="$case_dir/tmp-configs" \
    MCPO_PRESYNC_MODE=none \
    MCPO_LOG_PATH="$case_dir/mcpo.log" \
    TEST_RUNTIME_MCP_ZIP="$case_dir/app/test-runtime.zip" \
    TEST_RUNTIME_MCP_TARGET_DIR="$case_dir/app/mcp-servers/test_runtime_mcp" \
    TEST_RUNTIME_MCP_HINT="test-runtime-main" \
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

assert_file_exists() {
  local file_path="$1"

  if [ ! -e "$file_path" ]; then
    echo "Expected $file_path to exist"
    exit 1
  fi
}

test_runtime_install_handles_root_mismatch_and_stale_partials() {
  local case_name="runtime-install"
  local case_dir="$TMP_DIR/$case_name"
  local status

  setup_case_dir "$case_name"
  patch_case_script "$case_dir"
  create_runtime_zip "$case_dir/app/test-runtime.zip"
  seed_stale_extracted_root "$case_dir"

  cat >"$case_dir/app/mcp_config.json" <<'JSON'
{
  "mcpServers": {
    "test_runtime": {
      "command": "python3",
      "args": ["-c", "print('ok')"]
    }
  }
}
JSON

  status="$(run_case "$case_name")"
  if [ "$status" -ne 0 ]; then
    echo "Expected first runtime install to succeed"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_file_contains "$case_dir/output.log" "Installing Test Runtime MCP for first time..."
  assert_file_contains "$case_dir/output.log" "Archive root test-runtime-main not found; auto-detecting extracted payload directory..."
  assert_file_contains "$case_dir/output.log" "Using detected archive root: test-runtime-feature-inline-images"
  assert_file_not_contains "$case_dir/output.log" "replace "
  assert_file_exists "$case_dir/app/mcp-servers/test_runtime_mcp/.installed_version"
  assert_file_contains "$case_dir/app/mcp-servers/test_runtime_mcp/.cursor/.iago-framework" "feature-branch"
  assert_file_contains "$case_dir/mcpo.log" "--config $case_dir/tmp-configs/mcp_config.json"

  status="$(run_case "$case_name")"
  if [ "$status" -ne 0 ]; then
    echo "Expected checksum-matched runtime install to short-circuit cleanly"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_file_contains "$case_dir/output.log" "Test Runtime MCP already installed"
  assert_file_not_contains "$case_dir/output.log" "Extracting Test Runtime MCP"
  assert_file_not_contains "$case_dir/output.log" "replace "

  rm "$case_dir/app/mcp-servers/test_runtime_mcp/.installed_version"

  status="$(run_case "$case_name")"
  if [ "$status" -ne 0 ]; then
    echo "Expected stale partial runtime install to be replaced"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_file_contains "$case_dir/output.log" "Removing stale partial installation..."
  assert_file_contains "$case_dir/output.log" "Installing Test Runtime MCP for first time..."
  assert_file_not_contains "$case_dir/output.log" "replace "
  assert_file_exists "$case_dir/app/mcp-servers/test_runtime_mcp/.installed_version"
  assert_file_contains "$case_dir/app/mcp-servers/test_runtime_mcp/.cursor/.iago-framework" "feature-branch"
}

test_runtime_install_keeps_disabled_preinstalled_payload() {
  local case_name="runtime-disabled-preinstalled"
  local case_dir="$TMP_DIR/$case_name"
  local target_dir="$case_dir/app/mcp-servers/test_runtime_mcp"
  local status

  setup_case_dir "$case_name"
  patch_case_script "$case_dir"
  create_runtime_zip "$case_dir/app/test-runtime.zip"

  mkdir -p "$target_dir"
  printf 'preinstalled-marker\n' >"$target_dir/.installed_version"
  printf 'preinstalled-payload\n' >"$target_dir/preinstalled.txt"

  cat >"$case_dir/app/mcp_config.json" <<'JSON'
{
  "mcpServers": {}
}
JSON

  status="$(run_case "$case_name")"
  if [ "$status" -ne 0 ]; then
    echo "Expected disabled runtime install to skip cleanly"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_file_contains "$case_dir/output.log" "Test Runtime MCP is disabled, skipping installation"
  assert_file_exists "$target_dir/.installed_version"
  assert_file_contains "$target_dir/preinstalled.txt" "preinstalled-payload"
  assert_file_contains "$case_dir/mcpo.log" "--config $case_dir/tmp-configs/mcp_config.json"
}

test_runtime_preinstall_mode_exits_before_mcpo_startup() {
  local case_name="runtime-preinstall-mode"
  local case_dir="$TMP_DIR/$case_name"
  local status

  setup_case_dir "$case_name"
  patch_case_script "$case_dir"
  create_runtime_zip "$case_dir/app/test-runtime.zip"

  cat >"$case_dir/app/mcp_config.json" <<'JSON'
{
  "mcpServers": {
    "test_runtime": {
      "command": "python3",
      "args": ["-c", "print('ok')"]
    }
  }
}
JSON

  status="$(portico_PREINSTALL_RUNTIME_MCPS_ONLY=1 run_case "$case_name")"
  if [ "$status" -ne 0 ]; then
    echo "Expected preinstall mode to exit successfully before mcpo startup"
    cat "$case_dir/output.log"
    exit 1
  fi

  assert_file_contains "$case_dir/output.log" "Test Runtime MCP installed successfully"
  assert_file_contains "$case_dir/output.log" "Runtime MCP preinstall complete; exiting before mcpo startup"
  assert_file_not_contains "$case_dir/mcpo.log" "--config"
}

test_runtime_install_handles_root_mismatch_and_stale_partials
test_runtime_install_keeps_disabled_preinstalled_payload
test_runtime_preinstall_mode_exits_before_mcpo_startup

echo "start-mcpo runtime MCP ZIP installation handling looks correct."
