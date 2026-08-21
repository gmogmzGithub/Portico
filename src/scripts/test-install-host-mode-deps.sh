#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$ROOT_DIR/install-host-mode-deps.sh"
# shellcheck source=tests/helpers/parallel-shell-tests.sh
source "$ROOT_DIR/tests/helpers/parallel-shell-tests.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

write_fake_toolchain() {
  local fake_bin="$1"
  mkdir -p "$fake_bin"

  cat > "$fake_bin/uname" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
  *) /usr/bin/uname "$@" ;;
esac
SH
  chmod +x "$fake_bin/uname"

  cat > "$fake_bin/sw_vers" <<'SH'
#!/usr/bin/env bash
echo 14.0
SH
  chmod +x "$fake_bin/sw_vers"

  cat > "$fake_bin/node" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo v20.19.0
  exit 0
fi
exit 0
SH
  chmod +x "$fake_bin/node"

  cat > "$fake_bin/npx" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo 10.8.2
  exit 0
fi
exit 0
SH
  chmod +x "$fake_bin/npx"

  cat > "$fake_bin/npm" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo 10.8.2
  exit 0
fi
exit 0
SH
  chmod +x "$fake_bin/npm"
}

write_fake_node_runtime() {
  local bin_dir="$1"
  local version="$2"
  mkdir -p "$bin_dir"

  cat > "$bin_dir/node" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "$version"
  exit 0
fi
exit 0
SH
  cat > "$bin_dir/npm" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo 10.8.2
  exit 0
fi
exit 0
SH
  cat > "$bin_dir/npx" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo 10.8.2
  exit 0
fi
exit 0
SH
  chmod +x "$bin_dir/node" "$bin_dir/npm" "$bin_dir/npx"
}

run_installer_for_managed_dir() {
  local managed_dir="$1"
  local fake_bin="$2"
  local home_dir="${3:-}"
  local usr_local_bin_dir="${4:-}"
  if [ -z "$home_dir" ]; then
    home_dir="$(mktemp -d)/home"
  fi
  if [ -z "$usr_local_bin_dir" ]; then
    usr_local_bin_dir="$(mktemp -d)/usr-local-bin"
  fi
  mkdir -p "$home_dir" "$usr_local_bin_dir"
  env \
    HOME="$home_dir" \
    PATH="$fake_bin:/usr/bin:/bin" \
    portico_USR_LOCAL_BIN_DIR="$usr_local_bin_dir" \
    MANAGED_DIR="$managed_dir" \
    NODE_VERSION=v20.19.0 \
    bash "$INSTALLER" 2>&1
}

assert_host_mode_true_file() {
  local host_mode_file="$1"
  [ -f "$host_mode_file" ] || fail "expected HOST_MODE to be a file"
  [ ! -d "$host_mode_file" ] || fail "expected HOST_MODE not to be a directory"
  [ "$(cat "$host_mode_file")" = "TRUE" ] || fail "expected HOST_MODE content to be TRUE"
}

test_writes_missing_host_mode_file() {
  local tmp_dir managed_dir fake_bin home_dir usr_local_bin_dir
  tmp_dir="$(mktemp -d)"
  managed_dir="$tmp_dir/managed"
  fake_bin="$tmp_dir/bin"
  home_dir="$tmp_dir/home"
  usr_local_bin_dir="$tmp_dir/usr-local-bin"
  write_fake_toolchain "$fake_bin"

  run_installer_for_managed_dir "$managed_dir" "$fake_bin" "$home_dir" "$usr_local_bin_dir" >/dev/null
  assert_host_mode_true_file "$managed_dir/HOST_MODE"
}

test_preserves_valid_true_host_mode_file() {
  local tmp_dir managed_dir fake_bin home_dir usr_local_bin_dir output
  tmp_dir="$(mktemp -d)"
  managed_dir="$tmp_dir/managed"
  fake_bin="$tmp_dir/bin"
  home_dir="$tmp_dir/home"
  usr_local_bin_dir="$tmp_dir/usr-local-bin"
  write_fake_toolchain "$fake_bin"
  mkdir -p "$managed_dir"
  printf 'TRUE\n' > "$managed_dir/HOST_MODE"

  output="$(run_installer_for_managed_dir "$managed_dir" "$fake_bin" "$home_dir" "$usr_local_bin_dir")"
  assert_host_mode_true_file "$managed_dir/HOST_MODE"
  printf '%s' "$output" | grep -q 'HOST_MODE=TRUE already set' \
    || fail "expected installer to recognize existing HOST_MODE=TRUE"
}

test_normalizes_lowercase_true_host_mode_file() {
  local tmp_dir managed_dir fake_bin home_dir usr_local_bin_dir
  tmp_dir="$(mktemp -d)"
  managed_dir="$tmp_dir/managed"
  fake_bin="$tmp_dir/bin"
  home_dir="$tmp_dir/home"
  usr_local_bin_dir="$tmp_dir/usr-local-bin"
  write_fake_toolchain "$fake_bin"
  mkdir -p "$managed_dir"
  printf 'true\n' > "$managed_dir/HOST_MODE"

  run_installer_for_managed_dir "$managed_dir" "$fake_bin" "$home_dir" "$usr_local_bin_dir" >/dev/null
  assert_host_mode_true_file "$managed_dir/HOST_MODE"
}

test_repairs_directory_host_mode_sentinel() {
  local tmp_dir managed_dir fake_bin home_dir usr_local_bin_dir output
  tmp_dir="$(mktemp -d)"
  managed_dir="$tmp_dir/managed"
  fake_bin="$tmp_dir/bin"
  home_dir="$tmp_dir/home"
  usr_local_bin_dir="$tmp_dir/usr-local-bin"
  write_fake_toolchain "$fake_bin"
  mkdir -p "$managed_dir/HOST_MODE"
  printf 'bad state\n' > "$managed_dir/HOST_MODE/stale"

  output="$(run_installer_for_managed_dir "$managed_dir" "$fake_bin" "$home_dir" "$usr_local_bin_dir")"
  assert_host_mode_true_file "$managed_dir/HOST_MODE"
  printf '%s' "$output" | grep -q 'removing invalid HOST_MODE sentinel' \
    || fail "expected installer to log HOST_MODE directory repair"
}

test_preserves_user_profile_when_node_is_already_available() {
  local tmp_dir managed_dir fake_bin home_dir usr_local_bin_dir profile before after
  tmp_dir="$(mktemp -d)"
  managed_dir="$tmp_dir/managed"
  fake_bin="$tmp_dir/bin"
  home_dir="$tmp_dir/home"
  usr_local_bin_dir="$tmp_dir/usr-local-bin"
  profile="$home_dir/.zshrc"
  write_fake_toolchain "$fake_bin"
  mkdir -p "$home_dir"
  printf 'export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"\n' > "$profile"
  before="$(cat "$profile")"

  run_installer_for_managed_dir "$managed_dir" "$fake_bin" "$home_dir" "$usr_local_bin_dir" >/dev/null
  after="$(cat "$profile")"

  [ "$after" = "$before" ] \
    || fail "expected install-host-mode-deps.sh to leave shell profile unchanged"
  [ ! -e "$usr_local_bin_dir/node" ] \
    || fail "did not expect install-host-mode-deps.sh to create node symlink"
}

test_resolver_prefers_nvm_over_legacy_managed_root() {
  (
    local tmp_dir helper_source expected managed resolved
    tmp_dir="$(mktemp -d)"
    export HOME="$tmp_dir/home"
    expected="$HOME/.nvm/versions/node/v999.1.0/bin"
    managed="$tmp_dir/usr-local/lib/nodejs/node-v999.0.0-darwin-arm64/bin"
    mkdir -p "$HOME"
    write_fake_node_runtime "$expected" "v999.1.0"
    write_fake_node_runtime "$managed" "v999.0.0"

    helper_source="$(awk '/^# -------- semver helpers/{capture=1} /^# -------- npx sanity check/{exit} capture {print}' "$INSTALLER")"
    eval "$helper_source"
    PATH="/usr/bin:/bin"
    HOST_NODE_INSTALL_ROOTS="$tmp_dir/usr-local/lib/nodejs"
    NVM_DIR="$HOME/.nvm"
    NODE_VERSION_MIN="999.0.0"
    resolved="$(resolve_node_runtime_bin_dir)" \
      || fail "expected install-host-mode-deps.sh resolver to find nvm runtime"
    [ "$resolved" = "$expected" ] \
      || fail "expected nvm Node runtime to win over legacy managed root, got $resolved"
  )
}

test_cleans_portico_profile_entries_and_preserves_user_entries() {
  local tmp_dir managed_dir fake_bin home_dir usr_local_bin_dir profile output
  tmp_dir="$(mktemp -d)"
  managed_dir="$tmp_dir/managed"
  fake_bin="$tmp_dir/bin"
  home_dir="$tmp_dir/home"
  usr_local_bin_dir="$tmp_dir/usr-local-bin"
  profile="$home_dir/.zshrc"
  write_fake_toolchain "$fake_bin"
  mkdir -p "$home_dir" "$usr_local_bin_dir"
  cat > "$profile" <<EOF
export PATH="$home_dir/.nvm/versions/node/v22.11.0/bin:\$PATH"
# Node.js (installed by Portico)
export PATH="/usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin:\$PATH"
export PATH="$home_dir/.local/lib/nodejs/node-v20.19.0-darwin-arm64/bin:\$PATH" # portico HOST mode PATH (managed by install-host-mode-deps.sh)
EOF
  ln -s "/usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node" "$usr_local_bin_dir/node"

  output="$(run_installer_for_managed_dir "$managed_dir" "$fake_bin" "$home_dir" "$usr_local_bin_dir")"

  printf '%s' "$output" | grep -q 'Removed Portico Node.js PATH entries' \
    || fail "expected installer to clean PORTICO profile entries"
  grep -Fq "$home_dir/.nvm/versions/node/v22.11.0/bin" "$profile" \
    || fail "expected installer to preserve user nvm entry"
  if grep -Fq 'Node.js (installed by Portico)' "$profile"; then
    fail "expected installer to remove PORTICO profile comment"
  fi
  if grep -Fq 'portico HOST mode PATH' "$profile"; then
    fail "expected installer to remove PORTICO host-mode profile marker"
  fi
  [ ! -e "$usr_local_bin_dir/node" ] \
    || fail "expected installer to remove PORTICO-managed node symlink"
}

install_host_mode_test_functions=(
  test_writes_missing_host_mode_file
  test_preserves_valid_true_host_mode_file
  test_normalizes_lowercase_true_host_mode_file
  test_repairs_directory_host_mode_sentinel
  test_preserves_user_profile_when_node_is_already_available
  test_resolver_prefers_nvm_over_legacy_managed_root
  test_cleans_portico_profile_entries_and_preserves_user_entries
)
run_shell_test_functions_parallel \
  "${INSTALL_HOST_MODE_TEST_CONCURRENCY:-7}" \
  "${install_host_mode_test_functions[@]}"

echo "install-host-mode-deps.sh HOST_MODE handling tests passed"
