#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREREQ_SCRIPT="$PROJECT_ROOT/src/scripts/prereq-dependencies.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

make_fake_node_toolchain() {
  local bin_dir="$1"
  local version="${2:-v20.19.0}"
  mkdir -p "$bin_dir"

  cat > "$bin_dir/node" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  printf '%s\n' "$version"
  exit 0
fi
exit 0
SH
  cat > "$bin_dir/npm" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  printf '10.9.0\n'
  exit 0
fi
exit 0
SH
  cat > "$bin_dir/npx" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  printf '10.9.0\n'
  exit 0
fi
exit 0
SH
  chmod +x "$bin_dir/node" "$bin_dir/npm" "$bin_dir/npx"
}

test_source_does_not_execute_main() {
  local output
  output="$(bash -c 'set -euo pipefail; source "$1"; echo sourced-ok' bash "$PREREQ_SCRIPT")"
  [ "$output" = "sourced-ok" ] || fail "sourcing prereq-dependencies.sh executed main()"
}

test_request_command_line_tools_install_logs_output_and_exit_code() {
  (
    source "$PREREQ_SCRIPT"

    xcode-select() {
      printf 'xcode-select: note: install requested\n' >&2
      return 1
    }

    local output_file output status
    output_file="$(mktemp)"
    request_command_line_tools_install >"$output_file" 2>&1
    status=$?
    output="$(cat "$output_file")"
    rm -f "$output_file"

    [ "$status" -eq 0 ] \
      || fail "expected request_command_line_tools_install to preserve its log-only return contract"
    [ "${LAST_XCODE_SELECT_INSTALL_STATUS}" -eq 1 ] \
      || fail "expected request_command_line_tools_install to capture the xcode-select exit code"
    printf '%s' "${LAST_XCODE_SELECT_INSTALL_OUTPUT}" | grep -q 'xcode-select: note: install requested' \
      || fail "expected request_command_line_tools_install to capture xcode-select output"

    printf '%s' "$output" | grep -q 'xcode-select --install: xcode-select: note: install requested' \
      || fail "expected request_command_line_tools_install to log xcode-select output"
    printf '%s' "$output" | grep -q 'xcode-select --install exit code: 1' \
      || fail "expected request_command_line_tools_install to log the xcode-select exit code"
  )
}

test_command_line_tools_installed_accepts_system_clt_dir_without_receipt_when_binaries_exist() {
  (
    source "$PREREQ_SCRIPT"

    local output

    xcode-select() {
      if [ "${1:-}" = "-p" ]; then
        printf '/Library/Developer/CommandLineTools\n'
        return 0
      fi
      return 1
    }

    pkgutil() {
      return 1
    }

    command_line_tools_probe_binary() {
      printf '/Library/Developer/CommandLineTools/usr/bin/clang\n'
      return 0
    }

    output="$(command_line_tools_installed true 2>&1)" \
      || fail "expected usable system Command Line Tools to satisfy CLT detection without the receipt"

    printf '%s' "$output" | grep -Fq 'xcode-select -p resolved to: /Library/Developer/CommandLineTools' \
      || fail "expected CLT detection logs to include the system Command Line Tools path"
    printf '%s' "$output" | grep -Fq 'Command Line Tools probe passed via /Library/Developer/CommandLineTools/usr/bin/clang without CLTools_Executables receipt' \
      || fail "expected CLT detection to accept a usable system CLT install without the receipt"
  )
}

test_command_line_tools_installed_accepts_alternate_xcode_developer_dir() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir developer_path output
    tmp_dir="$(mktemp -d)"
    developer_path="$tmp_dir/Applications/Xcode-beta.app/Contents/Developer"
    mkdir -p "$developer_path/usr/bin"
    : > "$developer_path/usr/bin/clang"
    chmod +x "$developer_path/usr/bin/clang"

    xcode-select() {
      if [ "${1:-}" = "-p" ]; then
        printf '%s\n' "$developer_path"
        return 0
      fi
      return 1
    }

    pkgutil() {
      return 1
    }

    output="$(command_line_tools_installed true 2>&1)" \
      || fail "expected alternate Xcode developer directory to satisfy CLT detection"

    printf '%s' "$output" | grep -Fq "xcode-select -p resolved to: $developer_path" \
      || fail "expected CLT detection logs to include the selected developer directory"
    printf '%s' "$output" | grep -Fq "Command Line Tools probe passed via ${developer_path}/usr/bin/clang" \
      || fail "expected CLT detection to accept clang under an alternate Xcode developer directory"
  )
}

test_command_line_tools_installed_logs_probe_failure_for_invalid_developer_dir() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir developer_path output status
    tmp_dir="$(mktemp -d)"
    developer_path="$tmp_dir/Applications/Xcode-beta.app/Contents/Developer"
    mkdir -p "$developer_path"

    xcode-select() {
      if [ "${1:-}" = "-p" ]; then
        printf '%s\n' "$developer_path"
        return 0
      fi
      return 1
    }

    pkgutil() {
      return 1
    }

    set +e
    output="$(command_line_tools_installed true 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "invalid developer directory unexpectedly satisfied CLT detection"
    printf '%s' "$output" | grep -Fq "xcode-select -p resolved to: $developer_path" \
      || fail "expected CLT detection logs to include the invalid selected developer directory"
    printf '%s' "$output" | grep -Fq "Command Line Tools probe failed: no supported toolchain binaries found under $developer_path" \
      || fail "expected CLT detection failure logs to describe the missing toolchain binaries"
  )
}

test_repair_stale_command_line_tools_only_targets_system_clt_dir() {
  (
    source "$PREREQ_SCRIPT"

    local output_file output status remove_calls=0

    xcode-select() {
      if [ "${1:-}" = "-p" ]; then
        printf '/Applications/Xcode-beta.app/Contents/Developer\n'
        return 0
      fi
      return 1
    }

    pkgutil() {
      return 1
    }

    command_line_tools_probe_binary() {
      return 1
    }

    remove_system_command_line_tools_directory() {
      remove_calls=$((remove_calls + 1))
      return 0
    }

    LAST_XCODE_SELECT_INSTALL_STATUS=1
    LAST_XCODE_SELECT_INSTALL_OUTPUT='xcode-select: note: Command line tools are already installed.'

    output_file="$(mktemp)"
    set +e
    repair_stale_command_line_tools >"$output_file" 2>&1
    status=$?
    set -e
    output="$(cat "$output_file")"
    rm -f "$output_file"

    [ "$status" -ne 0 ] || fail "alternate developer directories should never be auto-repaired via deletion"
    [ "$remove_calls" -eq 0 ] || fail "repair_stale_command_line_tools should not delete a non-system developer directory"
  )
}

test_ensure_command_line_tools_repairs_stale_system_clt_before_waiting() {
  (
    source "$PREREQ_SCRIPT"

    local output_file output status tmp_dir
    local request_calls=0
    local remove_calls=0
    local wait_dialog_calls=0
    local wait_install_calls=0

    tmp_dir="$(mktemp -d)"
    SYSTEM_COMMAND_LINE_TOOLS_DIR="$tmp_dir/Library/Developer/CommandLineTools"
    mkdir -p "$SYSTEM_COMMAND_LINE_TOOLS_DIR"
    trap 'rm -rf "$tmp_dir"' EXIT

    xcode-select() {
      if [ "${1:-}" = "-p" ]; then
        printf '%s\n' "$SYSTEM_COMMAND_LINE_TOOLS_DIR"
        return 0
      fi
      return 1
    }

    pkgutil() {
      return 1
    }

    command_line_tools_probe_binary() {
      return 1
    }

    request_command_line_tools_install() {
      request_calls=$((request_calls + 1))
      if [ "$request_calls" -eq 1 ]; then
        LAST_XCODE_SELECT_INSTALL_STATUS=1
        LAST_XCODE_SELECT_INSTALL_OUTPUT='xcode-select: note: Command line tools are already installed. Use "Software Update" in System Settings or the softwareupdate command line interface to install updates'
      else
        LAST_XCODE_SELECT_INSTALL_STATUS=0
        LAST_XCODE_SELECT_INSTALL_OUTPUT=''
      fi
      log_info "xcode-select --install exit code: ${LAST_XCODE_SELECT_INSTALL_STATUS}"
    }

    remove_system_command_line_tools_directory() {
      remove_calls=$((remove_calls + 1))
      return 0
    }

    wait_for_command_line_tools_dialog() {
      wait_dialog_calls=$((wait_dialog_calls + 1))
      return 0
    }

    wait_for_command_line_tools() {
      wait_install_calls=$((wait_install_calls + 1))
      return 0
    }

    output_file="$(mktemp)"
    if ensure_command_line_tools >"$output_file" 2>&1; then
      status=0
    else
      status=$?
    fi
    output="$(cat "$output_file")"
    rm -f "$output_file"

    [ "$status" -eq 0 ] || fail "expected ensure_command_line_tools to recover from a stale system CLT install"
    [ "$request_calls" -eq 2 ] || fail "expected stale CLT recovery to retry xcode-select --install once"
    [ "$remove_calls" -eq 1 ] || fail "expected stale CLT recovery to remove the system CLT directory exactly once"
    [ "$wait_dialog_calls" -eq 1 ] || fail "expected ensure_command_line_tools to wait for the Apple installer only after a successful retry"
    [ "$wait_install_calls" -eq 1 ] || fail "expected ensure_command_line_tools to wait for installation completion after the retry"
    printf '%s' "$output" | grep -Fq "Command Line Developer Tools look partially installed. Portico will request administrator access once to repair them and retry Apple's installer." \
      || fail "expected stale CLT recovery to warn before requesting admin access"
  )
}

test_ensure_command_line_tools_fails_fast_for_unusable_non_system_developer_dir() {
  (
    source "$PREREQ_SCRIPT"

    local output_file output status
    local wait_dialog_calls=0
    local wait_install_calls=0

    xcode-select() {
      if [ "${1:-}" = "-p" ]; then
        printf '/Applications/Xcode-beta.app/Contents/Developer\n'
        return 0
      fi
      if [ "${1:-}" = "--install" ]; then
        printf 'xcode-select: note: Command line tools are already installed. Use "Software Update" in System Settings or the softwareupdate command line interface to install updates\n' >&2
        return 1
      fi
      return 1
    }

    pkgutil() {
      return 1
    }

    command_line_tools_probe_binary() {
      return 1
    }

    request_command_line_tools_install() {
      LAST_XCODE_SELECT_INSTALL_STATUS=1
      LAST_XCODE_SELECT_INSTALL_OUTPUT='xcode-select: note: Command line tools are already installed. Use "Software Update" in System Settings or the softwareupdate command line interface to install updates'
      log_info "xcode-select --install exit code: ${LAST_XCODE_SELECT_INSTALL_STATUS}"
    }

    wait_for_command_line_tools_dialog() {
      wait_dialog_calls=$((wait_dialog_calls + 1))
      return 0
    }

    wait_for_command_line_tools() {
      wait_install_calls=$((wait_install_calls + 1))
      return 0
    }

    output_file="$(mktemp)"
    if ensure_command_line_tools >"$output_file" 2>&1; then
      status=0
    else
      status=$?
    fi
    output="$(cat "$output_file")"
    rm -f "$output_file"

    [ "$status" -ne 0 ] || fail "expected ensure_command_line_tools to fail fast for an unusable non-system developer directory"
    [ "$wait_dialog_calls" -eq 0 ] || fail "ensure_command_line_tools should not wait for the Apple installer when installation never started"
    [ "$wait_install_calls" -eq 0 ] || fail "ensure_command_line_tools should not enter the long CLT wait loop when installation never started"
    printf '%s' "$output" | grep -Fq 'The selected Apple developer directory (/Applications/Xcode-beta.app/Contents/Developer) is not usable.' \
      || fail "expected a precise fail-fast error for an unusable selected developer directory"
    printf '%s' "$output" | grep -Fq '[PREREQ:STEP:command_line_tools:FAILED]' \
      || fail "expected the command_line_tools step to be marked failed on fail-fast errors"
  )
}

test_ensure_command_line_tools_emits_early_warning_when_window_is_not_detected() {
  (
    source "$PREREQ_SCRIPT"

    command_line_tools_installed() { return 1; }
    request_command_line_tools_install() {
      LAST_XCODE_SELECT_INSTALL_STATUS=0
      LAST_XCODE_SELECT_INSTALL_OUTPUT=""
      log_info "stub install request"
    }
    wait_for_command_line_tools_dialog() { return 1; }
    wait_for_command_line_tools() { return 0; }

    local output
    output="$(ensure_command_line_tools 2>&1)"

    printf '%s' "$output" | grep -q 'Apple Command Line Developer Tools / Software Update window did not appear yet' \
      || fail "expected an early warning when the Apple installer window is not detected"
    printf '%s' "$output" | grep -q '\[PREREQ:WARNING:Apple Command Line Developer Tools / Software Update window did not appear yet' \
      || fail "expected the early CLT warning marker to be emitted"
  )
}

test_ensure_command_line_tools_timeout_warning_names_the_apple_window() {
  (
    source "$PREREQ_SCRIPT"

    command_line_tools_installed() { return 1; }
    request_command_line_tools_install() {
      LAST_XCODE_SELECT_INSTALL_STATUS=0
      LAST_XCODE_SELECT_INSTALL_OUTPUT=""
      log_info "stub install request"
    }
    wait_for_command_line_tools_dialog() { return 1; }
    wait_for_command_line_tools() { return 1; }

    local output
    set +e
    output="$(ensure_command_line_tools 2>&1)"
    local status=$?
    set -e
    set -e

    [ "$status" -ne 0 ] || fail "ensure_command_line_tools unexpectedly succeeded on timeout"
    printf '%s' "$output" | grep -q 'Please complete the Apple Command Line Developer Tools / Software Update window, then click Retry\.' \
      || fail "expected the timeout warning to reference the Apple CLT / Software Update window"
  )
}

test_create_sudo_askpass_generates_valid_executable_helper() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir askpass_script askpass_copy cache_file fake_osascript output
    tmp_dir="$(mktemp -d)"
    askpass_script="$(create_sudo_askpass)"
    askpass_copy="$tmp_dir/askpass-helper"
    fake_osascript="$tmp_dir/osascript"
    cache_file="$(sed -n 's/^cache_file="\([^"]*\)"$/\1/p' "$askpass_script")"

    cleanup_generated_askpass_test() {
      rm -rf "$tmp_dir"
      rm -f "$askpass_script"
      if [ -n "$cache_file" ]; then
        rm -f "$cache_file"
      fi
    }
    trap cleanup_generated_askpass_test EXIT

    [ -x "$askpass_script" ] \
      || fail "expected create_sudo_askpass to generate an executable helper"
    bash -n "$askpass_script" \
      || fail "expected generated askpass helper to pass bash syntax validation"
    grep -Fq "output=\$(/usr/bin/osascript 2>&1 <<'OSA'" "$askpass_script" \
      || fail "expected generated askpass helper to retain the osascript command substitution"
    grep -Fq 'display dialog "Portico needs your computer password to continue installation."' "$askpass_script" \
      || fail "expected generated askpass helper to retain the AppleScript dialog"
    [ -n "$cache_file" ] \
      || fail "expected generated askpass helper to contain a cache file path"

    cat > "$fake_osascript" <<'SH'
#!/usr/bin/env bash
set -e
script="$(cat)"
case "$script" in
  *'display dialog "Portico needs your computer password to continue installation."'*'end try'*)
    printf 'fake-password\n'
    ;;
  *)
    printf 'missing expected AppleScript body\n' >&2
    exit 1
    ;;
esac
SH
    chmod +x "$fake_osascript"
    sed "s#/usr/bin/osascript#$fake_osascript#" "$askpass_script" > "$askpass_copy"
    chmod +x "$askpass_copy"

    output="$("$askpass_copy")"
    [ "$output" = "fake-password" ] \
      || fail "expected generated askpass helper to return the osascript password"
  )
}

test_install_homebrew_emits_dialog_cancelled_code_and_diagnostics() {
  (
    source "$PREREQ_SCRIPT"

    command_exists() {
      return 1
    }

    create_sudo_askpass() {
      printf '/tmp/fake-askpass\n'
    }

    detect_brew_prefix() {
      return 1
    }

    verify_homebrew_sudo_access() {
      LAST_HOMEBREW_SUDO_STATUS=1
      LAST_HOMEBREW_SUDO_OUTPUT=$'sudo: a password is required\nASKPASS_DIALOG_CANCELLED status=1 detail=execution error: User canceled. (-128)'
      LAST_HOMEBREW_AUTH_ELAPSED_SECONDS=11
      return 1
    }

    probe_osascript_context() {
      LAST_OSASCRIPT_CONTEXT_PROBE_STATUS=0
      LAST_OSASCRIPT_CONTEXT_PROBE_OUTPUT='ok'
      return 0
    }

    is_admin_user() {
      return 0
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected install_homebrew to fail on dialog cancellation"
    printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_auth_dialog_cancelled\]' \
      || fail "expected dialog-cancelled code marker"
    printf '%s' "$output" | grep -q '\[PREREQ:DETAIL:sudo -A -v exit code: 1\]' \
      || fail "expected sudo exit detail marker"
    printf '%s' "$output" | grep -q '\[PREREQ:DETAIL:sudo -A -v elapsed: 11s\]' \
      || fail "expected sudo elapsed detail marker"
  )
}

test_install_homebrew_skips_repeated_auth_when_retry_flag_is_set() {
  (
    source "$PREREQ_SCRIPT"

    local askpass_calls=0

    command_exists() {
      return 1
    }

    create_sudo_askpass() {
      askpass_calls=$((askpass_calls + 1))
      printf '/tmp/fake-askpass\n'
    }

    detect_brew_prefix() {
      return 1
    }

    GUIDED_SETUP_SKIP_HOMEBREW_AUTH=true
    GUIDED_SETUP_HOMEBREW_FAILURE_CODE=homebrew_sudo_validation_failed

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected install_homebrew to fail fast when auth retry is suppressed"
    [ "$askpass_calls" -eq 0 ] || fail "expected auth retry suppression to skip askpass creation"
    printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_sudo_validation_failed\]' \
      || fail "expected repeated failure to re-emit the previous Homebrew failure code"
  )
}

test_install_homebrew_accepts_detected_brew_after_nonzero_installer_exit() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir fake_prefix detect_calls_file
    tmp_dir="$(mktemp -d)"
    fake_prefix="$tmp_dir/homebrew"
    detect_calls_file="$tmp_dir/detect_calls"
    mkdir -p "$fake_prefix/bin"
    printf '0\n' > "$detect_calls_file"
    HOME="$tmp_dir/home"
    mkdir -p "$HOME"
    : > "$HOME/.zshrc"
    : > "$HOME/.bash_profile"

    cat >"$fake_prefix/bin/brew" <<EOF
#!/bin/bash
if [ "\${1:-}" = "shellenv" ]; then
  echo "export PATH=\"$fake_prefix/bin:\$PATH\""
  exit 0
fi
if [ "\${1:-}" = "--version" ]; then
  echo "Homebrew 4.5.0"
  exit 0
fi
exit 0
EOF
    chmod +x "$fake_prefix/bin/brew"

    command_exists() {
      return 1
    }

    create_sudo_askpass() {
      printf '/tmp/fake-askpass\n'
    }

    verify_homebrew_sudo_access() {
      LAST_HOMEBREW_SUDO_STATUS=0
      LAST_HOMEBREW_SUDO_OUTPUT=''
      LAST_HOMEBREW_AUTH_ELAPSED_SECONDS=1
      return 0
    }

    detect_brew_prefix() {
      local detect_calls
      detect_calls="$(cat "$detect_calls_file")"
      detect_calls=$((detect_calls + 1))
      printf '%s\n' "$detect_calls" > "$detect_calls_file"
      if [ "$detect_calls" -eq 1 ]; then
        return 1
      fi
      printf '%s\n' "$fake_prefix"
    }

    curl() {
      printf 'exit 1\n'
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -eq 0 ] || fail "expected install_homebrew to accept a detected brew after a nonzero installer exit"
    printf '%s' "$output" | grep -q 'Homebrew installer exited non-zero, but Homebrew is now present' \
      || fail "expected install_homebrew to log the recovered nonzero installer exit"
    printf '%s' "$output" | grep -q '\[PREREQ:STEP:homebrew:COMPLETE\]' \
      || fail "expected homebrew step to complete after detecting brew"
  )
}

test_node_runtime_resolver_finds_nvm_runtime_with_minimal_path() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir expected resolved
    tmp_dir="$(mktemp -d)"
    HOME="$tmp_dir/home"
    expected="$HOME/.nvm/versions/node/v999.0.0/bin"
    make_fake_node_toolchain "$expected" "v999.0.0"

    PATH="/usr/bin:/bin"
    portico_NODE_INSTALL_ROOTS="$tmp_dir/empty-managed"
    NVM_DIR="$HOME/.nvm"
    NODE_VERSION_REQUIRED="999.0.0"

    resolved="$(resolve_node_runtime_bin_dir)" \
      || fail "expected prereq Node resolver to find nvm runtime"
    [ "$resolved" = "$expected" ] \
      || fail "expected nvm Node runtime, got $resolved"
  )
}

test_node_runtime_resolver_prefers_nvm_over_legacy_managed_root() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir expected managed resolved
    tmp_dir="$(mktemp -d)"
    HOME="$tmp_dir/home"
    expected="$HOME/.nvm/versions/node/v999.1.0/bin"
    managed="$tmp_dir/usr-local/lib/nodejs/node-v999.0.0-darwin-arm64/bin"
    make_fake_node_toolchain "$expected" "v999.1.0"
    make_fake_node_toolchain "$managed" "v999.0.0"

    PATH="/usr/bin:/bin"
    portico_NODE_INSTALL_ROOTS="$tmp_dir/usr-local/lib/nodejs"
    NVM_DIR="$HOME/.nvm"
    NODE_VERSION_REQUIRED="999.0.0"

    resolved="$(resolve_node_runtime_bin_dir)" \
      || fail "expected prereq Node resolver to find nvm runtime"
    [ "$resolved" = "$expected" ] \
      || fail "expected nvm Node runtime to win over legacy managed root, got $resolved"
  )
}

test_node_cleanup_removes_only_portico_profile_entries_and_symlinks() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir profile symlink_bin output
    tmp_dir="$(mktemp -d)"
    HOME="$tmp_dir/home"
    symlink_bin="$tmp_dir/usr-local-bin"
    mkdir -p "$HOME" "$symlink_bin"
    profile="$HOME/.zshrc"

    cat > "$profile" <<EOF
export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:\$PATH"

# Node.js (installed by Portico)
export PATH="/usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin:\$PATH"
export PATH="$HOME/.local/lib/nodejs/node-v20.19.0-darwin-arm64/bin:\$PATH" # portico HOST mode PATH (managed by install-host-mode-deps.sh)
export PATH="/opt/custom-node/bin:\$PATH"
EOF
    ln -s "/usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node" "$symlink_bin/node"
    ln -s "$HOME/.local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/npm" "$symlink_bin/npm"
    ln -s "/opt/custom-node/bin/npx" "$symlink_bin/npx"

    portico_USR_LOCAL_BIN_DIR="$symlink_bin"
    output="$(cleanup_portico_node_shell_integration 2>&1)"

    printf '%s' "$output" | grep -q 'Removed Portico Node.js PATH entries' \
      || fail "expected cleanup to log profile cleanup"
    grep -Fq "$HOME/.nvm/versions/node/v22.11.0/bin" "$profile" \
      || fail "expected cleanup to preserve nvm PATH entry"
    grep -Fq "/opt/custom-node/bin" "$profile" \
      || fail "expected cleanup to preserve custom PATH entry"
    if grep -Fq "Node.js (installed by Portico)" "$profile"; then
      fail "expected cleanup to remove PORTICO Node profile comment"
    fi
    if grep -Fq "/usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin" "$profile"; then
      fail "expected cleanup to remove legacy PORTICO Node PATH entry"
    fi
    if grep -Fq "portico HOST mode PATH" "$profile"; then
      fail "expected cleanup to remove host-mode PORTICO Node PATH entry"
    fi
    [ ! -e "$symlink_bin/node" ] \
      || fail "expected cleanup to remove PORTICO-managed node symlink"
    [ ! -e "$symlink_bin/npm" ] \
      || fail "expected cleanup to remove PORTICO-managed npm symlink"
    [ -L "$symlink_bin/npx" ] \
      || fail "expected cleanup to preserve non-PORTICO npx symlink"
  )
}

test_install_node_uses_nvm_without_profile_or_usr_local_mutation() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir expected profile output
    tmp_dir="$(mktemp -d)"
    HOME="$tmp_dir/home"
    expected="$HOME/.nvm/versions/node/v22.11.0/bin"
    profile="$HOME/.zshrc"
    mkdir -p "$HOME"
    printf 'export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"\n' > "$profile"
    make_fake_node_toolchain "$expected" "v22.11.0"

    PATH="/usr/bin:/bin"
    portico_NODE_INSTALL_ROOTS="$tmp_dir/empty-managed"
    portico_USR_LOCAL_BIN_DIR="$tmp_dir/usr-local-bin"
    NVM_DIR="$HOME/.nvm"
    NODE_VERSION_REQUIRED="20.19.0"

    output="$(install_node_and_npm 2>&1)" \
      || fail "expected install_node_and_npm to accept nvm runtime"
    printf '%s' "$output" | grep -q 'Node.js runtime satisfies HOST mode requirement' \
      || fail "expected install_node_and_npm to reuse nvm runtime"
    if printf '%s' "$output" | grep -q 'Installing Node.js'; then
      fail "did not expect installer to download Node.js when nvm satisfies the requirement"
    fi
    [ "$(cat "$profile")" = 'export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"' ] \
      || fail "expected install_node_and_npm to leave user profile unchanged"
    [ ! -e "$portico_USR_LOCAL_BIN_DIR/node" ] \
      || fail "did not expect install_node_and_npm to create /usr/local/bin node symlink"
  )
}

test_install_node_source_has_no_persistent_path_writes() {
  if grep -q 'Created symlinks in /usr/local/bin' "$PREREQ_SCRIPT"; then
    fail "prereq-dependencies.sh should not create persistent /usr/local/bin Node symlinks"
  fi
  if grep -q 'Added Node.js to' "$PREREQ_SCRIPT"; then
    fail "prereq-dependencies.sh should not add managed Node to shell profiles"
  fi
  if grep -q 'ln -sf.*node_extract_dir' "$PREREQ_SCRIPT"; then
    fail "prereq-dependencies.sh should not symlink managed Node into /usr/local/bin"
  fi
}

test_install_homebrew_probes_and_completes_when_brew_config_ok() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    : > "$calls_file"
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }

    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      if [ "${1:-}" = "--version" ]; then
        echo "Homebrew 4.6.0"
      fi
      return 0
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -eq 0 ] || fail "expected install_homebrew to complete when brew config succeeds"
    printf '%s' "$output" | grep -q '\[PREREQ:STEP:homebrew:COMPLETE\]' \
      || fail "expected homebrew step to complete when brew is usable"
    grep -q '^brew config' "$calls_file" \
      || fail "expected install_homebrew to probe brew config"
    ! grep -q '^brew update' "$calls_file" \
      || fail "a healthy brew must not trigger an automatic update"
  )
}

test_install_homebrew_heals_outdated_brew_with_update() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file state_file outdated_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    state_file="$tmp_dir/brew-state"
    : > "$calls_file"
    printf 'broken\n' > "$state_file"
    outdated_error='/usr/local/Homebrew/Library/Homebrew/macos_version.rb:53:in `initialize'\'': unknown or unsupported macOS version: "26.5" (MacOSVersion::Error)'
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }
    start_heartbeat() { HEARTBEAT_PID=0; }
    stop_heartbeat() { :; }

    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "${1:-}" in
        --version)
          echo "Homebrew 4.4.14"
          ;;
        config)
          if [ "$(cat "$state_file")" = "broken" ]; then
            printf '%s\n' "$outdated_error" >&2
            return 1
          fi
          echo "HOMEBREW_VERSION: 4.6.0"
          ;;
        update)
          printf 'healed\n' > "$state_file"
          ;;
      esac
      return 0
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -eq 0 ] || fail "expected install_homebrew to complete after brew update heals the outdated brew"
    printf '%s' "$output" | grep -q '\[PREREQ:STEP:homebrew:COMPLETE\]' \
      || fail "expected homebrew step to complete after a successful self-update"
    printf '%s' "$output" | grep -q 'Homebrew updated and now supports this macOS version' \
      || fail "expected a heal success log"
    [ "$(grep -c '^brew update' "$calls_file")" -eq 1 ] \
      || fail "expected exactly one brew update call when the first attempt heals"
    ! printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_outdated\]' \
      || fail "a healed brew must not emit the homebrew_outdated code"
  )
}

test_install_homebrew_heals_outdated_brew_with_update_reset() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file state_file outdated_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    state_file="$tmp_dir/brew-state"
    : > "$calls_file"
    printf 'broken\n' > "$state_file"
    outdated_error='/usr/local/Homebrew/Library/Homebrew/macos_version.rb:53:in `initialize'\'': unknown or unsupported macOS version: "26.5" (MacOSVersion::Error)'
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }
    start_heartbeat() { HEARTBEAT_PID=0; }
    stop_heartbeat() { :; }

    # Plain `brew update` cannot advance this too-stale brew; only
    # `brew update-reset` heals it (PORTICO-229 follow-up).
    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "${1:-}" in
        --version)
          echo "Homebrew 4.4.14"
          ;;
        config)
          if [ "$(cat "$state_file")" = "broken" ]; then
            printf '%s\n' "$outdated_error" >&2
            return 1
          fi
          echo "HOMEBREW_VERSION: 4.6.0"
          ;;
        update-reset)
          printf 'healed\n' > "$state_file"
          ;;
      esac
      return 0
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -eq 0 ] \
      || fail "expected install_homebrew to complete after brew update-reset heals the outdated brew"
    printf '%s' "$output" | grep -q '\[PREREQ:STEP:homebrew:COMPLETE\]' \
      || fail "expected homebrew step to complete after a successful update-reset"
    printf '%s' "$output" | grep -q 'Homebrew reset and now supports this macOS version' \
      || fail "expected an update-reset heal success log"
    [ "$(grep -c '^brew update$' "$calls_file")" -eq 2 ] \
      || fail "expected two plain brew update attempts before update-reset"
    [ "$(grep -c '^brew update-reset$' "$calls_file")" -eq 1 ] \
      || fail "expected exactly one brew update-reset call"
    ! printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_outdated\]' \
      || fail "a brew healed by update-reset must not emit the homebrew_outdated code"
  )
}

# PORTICO-436 follow-up: the reported machine's `brew --version` says
# "shallow or no git repository", and the recovery code's own comment says a plain
# `brew update` cannot advance from that state -- so update-reset must lead, not
# come third. `test_install_homebrew_heals_outdated_brew_with_update_reset` above
# is the other half of this pair: it proves a healthy checkout keeps update-first.
test_install_homebrew_resets_first_when_the_git_checkout_is_wedged() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file state_file outdated_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    state_file="$tmp_dir/brew-state"
    : > "$calls_file"
    printf 'broken\n' > "$state_file"
    outdated_error='/usr/local/Homebrew/Library/Homebrew/macos_version.rb:53:in `initialize'\'': unknown or unsupported macOS version: "26.5" (MacOSVersion::Error)'
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }
    start_heartbeat() { HEARTBEAT_PID=0; }
    stop_heartbeat() { :; }

    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "${1:-}" in
        --version)
          echo "Homebrew >=4.1.0 (shallow or no git repository)"
          ;;
        config)
          if [ "$(cat "$state_file")" = "broken" ]; then
            printf '%s\n' "$outdated_error" >&2
            return 1
          fi
          echo "HOMEBREW_VERSION: 4.6.0"
          ;;
        update-reset)
          printf 'healed\n' > "$state_file"
          ;;
      esac
      return 0
    }

    local output status first_recovery_call
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -eq 0 ] \
      || fail "expected install_homebrew to complete once update-reset heals a wedged checkout"
    first_recovery_call="$(grep -E '^brew (update|update-reset)$' "$calls_file" | head -1)"
    [ "$first_recovery_call" = "brew update-reset" ] \
      || fail "expected update-reset first on a wedged checkout, got '${first_recovery_call}'"
    [ "$(grep -c '^brew update$' "$calls_file")" -eq 0 ] \
      || fail "a wedged checkout healed by update-reset must not spend time on plain update first"
    printf '%s' "$output" | grep -q 'Homebrew reports a shallow or missing git checkout' \
      || fail "expected the reordering to be explained in the setup log"
    printf '%s' "$output" | grep -q 'Homebrew reset and now supports this macOS version' \
      || fail "expected an update-reset heal success log"
    ! printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_outdated\]' \
      || fail "a healed brew must not emit the homebrew_outdated code"
  )
}

# Reordering must not shrink the recovery plan: a wedged checkout that the reset
# cannot fix still gets both plain updates before we give up, so no machine loses
# an attempt it used to get.
test_install_homebrew_still_tries_updates_when_the_leading_reset_fails() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file outdated_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    : > "$calls_file"
    outdated_error='/usr/local/Homebrew/Library/Homebrew/macos_version.rb:53:in `initialize'\'': unknown or unsupported macOS version: "26.5" (MacOSVersion::Error)'
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }
    start_heartbeat() { HEARTBEAT_PID=0; }
    stop_heartbeat() { :; }

    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "${1:-}" in
        --version)
          echo "Homebrew/homebrew-core (no git repository)"
          ;;
        config)
          printf '%s\n' "$outdated_error" >&2
          return 1
          ;;
      esac
      return 0
    }

    local output status recovery_order
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected install_homebrew to fail when nothing heals the wedged brew"
    printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_outdated\]' \
      || fail "expected typed homebrew_outdated failure code"
    recovery_order="$(grep -E '^brew (update|update-reset)$' "$calls_file" | tr '\n' ' ')"
    [ "$recovery_order" = "brew update-reset brew update brew update " ] \
      || fail "expected reset-then-two-updates on a wedged checkout, got '${recovery_order}'"
    printf '%s' "$output" | grep -Fq '[PREREQ:DETAIL:brew recovery attempts: brew update-reset, brew update, brew update]' \
      || fail "expected the failure detail to record the order actually attempted"
    printf '%s' "$output" | grep -q 'attempt 2/2' \
      || fail "expected the update attempts to stay labelled out of two"
  )
}

test_install_homebrew_emits_outdated_code_when_update_cannot_heal() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file outdated_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    : > "$calls_file"
    outdated_error='/usr/local/Homebrew/Library/Homebrew/macos_version.rb:53:in `initialize'\'': unknown or unsupported macOS version: "26.5" (MacOSVersion::Error)'
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }
    start_heartbeat() { HEARTBEAT_PID=0; }
    stop_heartbeat() { :; }

    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "${1:-}" in
        --version)
          echo "Homebrew 4.4.14"
          ;;
        config)
          printf '%s\n' "$outdated_error" >&2
          return 1
          ;;
      esac
      return 0
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected install_homebrew to fail when brew stays unusable after updates"
    printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_outdated\]' \
      || fail "expected typed homebrew_outdated failure code"
    printf '%s' "$output" | grep -q '\[PREREQ:STEP:homebrew:FAILED\]' \
      || fail "expected homebrew step failure marker"
    printf '%s' "$output" | grep -q '\[PREREQ:DETAIL:brew config output:' \
      || fail "expected brew config output detail marker"
    [ "$(grep -c '^brew update$' "$calls_file")" -eq 2 ] \
      || fail "expected exactly two plain brew update attempts before update-reset"
    [ "$(grep -c '^brew update-reset$' "$calls_file")" -eq 1 ] \
      || fail "expected one brew update-reset attempt before giving up"
    ! printf '%s' "$output" | grep -Eqi 'xattr|spctl --add|codesign --force' \
      || fail "outdated brew failure must not recommend a security bypass"
  )
}

test_install_homebrew_fails_open_when_update_changes_the_error() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file state_file outdated_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    state_file="$tmp_dir/brew-state"
    : > "$calls_file"
    printf 'broken\n' > "$state_file"
    outdated_error='/usr/local/Homebrew/Library/Homebrew/macos_version.rb:53:in `initialize'\'': unknown or unsupported macOS version: "26.5" (MacOSVersion::Error)'
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }
    start_heartbeat() { HEARTBEAT_PID=0; }
    stop_heartbeat() { :; }

    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "${1:-}" in
        --version)
          echo "Homebrew 4.4.14"
          ;;
        config)
          if [ "$(cat "$state_file")" = "broken" ]; then
            printf '%s\n' "$outdated_error" >&2
          else
            echo "Error: HOMEBREW_CORE_GIT_REMOTE mismatch" >&2
          fi
          return 1
          ;;
        update)
          printf 'different\n' > "$state_file"
          ;;
      esac
      return 0
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -eq 0 ] || fail "expected install_homebrew to fail open when the post-update error is unrelated"
    printf '%s' "$output" | grep -q '\[PREREQ:STEP:homebrew:COMPLETE\]' \
      || fail "expected homebrew step to complete when the post-update error changed"
    [ "$(grep -c '^brew update' "$calls_file")" -eq 2 ] \
      || fail "expected both update attempts before the post-update fail-open check"
    ! printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_outdated\]' \
      || fail "a changed post-update error must not emit homebrew_outdated"
  )
}

test_install_homebrew_ignores_unrelated_brew_config_failure() {
  (
    source "$PREREQ_SCRIPT"

    local tmp_dir calls_file
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    : > "$calls_file"
    OSTYPE="darwin24"

    command_exists() { [ "${1:-}" = "brew" ]; }

    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "${1:-}" in
        --version)
          echo "Homebrew 4.6.0"
          ;;
        config)
          echo "Error: The Command Line Tools are outdated" >&2
          return 1
          ;;
      esac
      return 0
    }

    local output status
    set +e
    output="$(install_homebrew 2>&1)"
    status=$?
    set -e

    [ "$status" -eq 0 ] || fail "expected install_homebrew to fail open on an unrelated brew config error"
    printf '%s' "$output" | grep -q '\[PREREQ:STEP:homebrew:COMPLETE\]' \
      || fail "expected homebrew step to complete despite an unrelated brew config error"
    ! grep -q '^brew update' "$calls_file" \
      || fail "an unrelated brew config error must not trigger an automatic update"
    ! printf '%s' "$output" | grep -q '\[PREREQ:CODE:homebrew_outdated\]' \
      || fail "an unrelated brew config error must not emit homebrew_outdated"
  )
}

test_main_skips_rust_step_on_macos() {
  local output
  output="$(
    (
      source "$PREREQ_SCRIPT"

      ensure_command_line_tools() {
        emit_step_start "command_line_tools"
        emit_step_complete "command_line_tools"
      }
      install_homebrew() {
        emit_step_start "homebrew"
        emit_step_complete "homebrew"
      }
      install_jq() {
        emit_step_start "jq"
        emit_step_complete "jq"
      }
      install_node_and_npm() {
        emit_step_start "nodejs"
        emit_step_complete "nodejs"
      }
      install_uv() {
        emit_step_start "uv"
        emit_step_complete "uv"
      }

      OSTYPE="darwin-test"
      main
    ) 2>&1
  )"

  printf '%s' "$output" | grep -q '\[PREREQ:STEP:uv:COMPLETE\]' \
    || fail "expected the macOS phase-2 flow to reach the uv step"
  if printf '%s' "$output" | grep -q 'PREREQ:STEP:rust'; then
    fail "did not expect any Rust step markers in the macOS phase-2 flow"
  fi
}

test_main_skips_rust_step_on_linux() {
  local output
  output="$(
    (
      source "$PREREQ_SCRIPT"

      install_jq() {
        emit_step_start "jq"
        emit_step_complete "jq"
      }
      install_node_and_npm() {
        emit_step_start "nodejs"
        emit_step_complete "nodejs"
      }
      install_uv() {
        emit_step_start "uv"
        emit_step_complete "uv"
      }

      OSTYPE="linux-gnu"
      main
    ) 2>&1
  )"

  printf '%s' "$output" | grep -q '\[PREREQ:STEP:uv:COMPLETE\]' \
    || fail "expected the Linux phase-2 flow to reach the uv step"
  if printf '%s' "$output" | grep -q 'PREREQ:STEP:rust'; then
    fail "did not expect any Rust step markers in the Linux phase-2 flow"
  fi
}

test_source_does_not_execute_main
test_request_command_line_tools_install_logs_output_and_exit_code
test_command_line_tools_installed_accepts_system_clt_dir_without_receipt_when_binaries_exist
test_command_line_tools_installed_accepts_alternate_xcode_developer_dir
test_command_line_tools_installed_logs_probe_failure_for_invalid_developer_dir
test_repair_stale_command_line_tools_only_targets_system_clt_dir
test_ensure_command_line_tools_repairs_stale_system_clt_before_waiting
test_ensure_command_line_tools_fails_fast_for_unusable_non_system_developer_dir
test_ensure_command_line_tools_emits_early_warning_when_window_is_not_detected

# PORTICO-436: `hb_pid=$(start_heartbeat "...")` deadlocked forever, because command
# substitution waits for EOF on a pipe the backgrounded heartbeat loop holds open.
# Guided setup froze at 44% on the line right after "attempt 1/2", and every
# existing test stubbed start_heartbeat out, so the real function was never run.
#
# This drives the real function through a real caller under a watchdog: any return
# to a capturing pattern, in the helper or in a caller, hangs and fails here.
run_bounded() {
  # run_bounded <seconds> <command...>
  # Returns the command's own exit status, or 124 if it outlived the limit.
  # Propagating the status matters: a helper that reported success whenever the
  # command merely *finished* would pass even when the assertion inside it failed.
  local limit="$1"; shift
  local status_file
  status_file="$(mktemp)"
  ( "$@" >/dev/null 2>&1; printf '%s\n' "$?" > "$status_file" ) &
  local worker=$!
  local waited=0
  local status
  while [ "$waited" -lt "$limit" ]; do
    if [ -s "$status_file" ]; then
      status="$(cat "$status_file")"
      rm -f "$status_file"
      wait "$worker" 2>/dev/null || true
      return "${status:-1}"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL "$worker" 2>/dev/null || true
  rm -f "$status_file"
  return 124
}

test_start_heartbeat_returns_immediately_and_emits_progress() {
  (
    source "$PREREQ_SCRIPT"

    HEARTBEAT_INTERVAL_SECONDS=1
    HEARTBEAT_PID=""

    local out_file
    out_file="$(mktemp)"

    # If start_heartbeat blocks, run_bounded returns 124 and this fails loudly
    # instead of hanging the suite.
    set +e
    run_bounded 10 bash -c '
      source "'"$PREREQ_SCRIPT"'"
      HEARTBEAT_INTERVAL_SECONDS=1
      start_heartbeat "probe"
      [ -n "$HEARTBEAT_PID" ] || exit 3
      sleep 3
      stop_heartbeat "$HEARTBEAT_PID"
    '
    local hb_status=$?
    set -e
    [ "$hb_status" -ne 124 ] \
      || fail "start_heartbeat did not return promptly (PORTICO-436 deadlock regression)"
    [ "$hb_status" -eq 0 ] \
      || fail "start_heartbeat did not set HEARTBEAT_PID (status $hb_status)"

    # Separately confirm the loop actually reaches the script's stdout. Under the
    # old capturing pattern its output vanished into the substitution pipe, which
    # is why 13 recorded sessions logged zero heartbeat lines.
    bash -c '
      source "'"$PREREQ_SCRIPT"'"
      HEARTBEAT_INTERVAL_SECONDS=1
      start_heartbeat "probe"
      sleep 3
      stop_heartbeat "$HEARTBEAT_PID"
    ' > "$out_file" 2>&1

    grep -q "probe still running\.\.\." "$out_file" \
      || fail "start_heartbeat produced no progress output on stdout"

    rm -f "$out_file"
  )
}

test_homebrew_self_heal_reaches_the_outdated_code_without_hanging() {
  (
    local tmp_dir calls_file out_file
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/brew-calls"
    out_file="$tmp_dir/out"
    : > "$calls_file"

    # Real start_heartbeat, fake brew that always reports the unsupported-macOS
    # crash. The self-heal must run its attempts and emit homebrew_outdated.
    set +e
    run_bounded 60 bash -c '
      source "'"$PREREQ_SCRIPT"'"
      HEARTBEAT_INTERVAL_SECONDS=1
      HOMEBREW_SELF_HEAL_TIMEOUT_SECONDS=3
      OSTYPE="darwin24"
      command_exists() { [ "${1:-}" = "brew" ] || [ "${1:-}" = "pkill" ]; }
      brew() {
        printf "brew %s\n" "$*" >> "'"$calls_file"'"
        if [ "${1:-}" = "config" ]; then
          echo "unknown or unsupported macOS version: \"26.5.2\" (MacOSVersion::Error)"
          return 1
        fi
        return 0
      }
      ensure_homebrew_supports_host_macos > "'"$out_file"'" 2>&1
    '
    local status=$?
    # 1 is the designed outcome here: the self-heal gives up and emits
    # homebrew_outdated. Only 124 means it hung, which is the PORTICO-436 regression.
    [ "$status" -ne 124 ] \
      || fail "homebrew self-heal hung under a watchdog (PORTICO-436 deadlock regression)"

    grep -q "PREREQ:CODE:homebrew_outdated" "$out_file" \
      || fail "self-heal did not reach the actionable homebrew_outdated code"
    grep -q "brew update$" "$calls_file" \
      || fail "self-heal never attempted brew update"
    grep -q "brew update-reset" "$calls_file" \
      || fail "self-heal never attempted brew update-reset"

    rm -rf "$tmp_dir"
  )
}

test_run_with_timeout_terminates_a_hung_command() {
  (
    source "$PREREQ_SCRIPT"

    local status
    set +e
    run_with_timeout 2 sleep 60 >/dev/null 2>&1
    status=$?
    set -e

    [ "$status" -eq 124 ] \
      || fail "run_with_timeout should return 124 on expiry, got $status"

    set +e
    run_with_timeout 10 true >/dev/null 2>&1
    status=$?
    set -e
    [ "$status" -eq 0 ] || fail "run_with_timeout should pass through success, got $status"
  )
}

test_ensure_command_line_tools_timeout_warning_names_the_apple_window
test_create_sudo_askpass_generates_valid_executable_helper
test_install_homebrew_emits_dialog_cancelled_code_and_diagnostics
test_install_homebrew_skips_repeated_auth_when_retry_flag_is_set
test_install_homebrew_accepts_detected_brew_after_nonzero_installer_exit
test_node_runtime_resolver_finds_nvm_runtime_with_minimal_path
test_node_runtime_resolver_prefers_nvm_over_legacy_managed_root
test_node_cleanup_removes_only_portico_profile_entries_and_symlinks
test_install_node_uses_nvm_without_profile_or_usr_local_mutation
test_install_node_source_has_no_persistent_path_writes
test_install_homebrew_probes_and_completes_when_brew_config_ok
test_install_homebrew_heals_outdated_brew_with_update
test_install_homebrew_heals_outdated_brew_with_update_reset
test_install_homebrew_resets_first_when_the_git_checkout_is_wedged
test_install_homebrew_still_tries_updates_when_the_leading_reset_fails
test_install_homebrew_emits_outdated_code_when_update_cannot_heal
test_install_homebrew_fails_open_when_update_changes_the_error
test_install_homebrew_ignores_unrelated_brew_config_failure
test_main_skips_rust_step_on_macos
test_main_skips_rust_step_on_linux
test_start_heartbeat_returns_immediately_and_emits_progress
test_homebrew_self_heal_reaches_the_outdated_code_without_hanging
test_run_with_timeout_terminates_a_hung_command


echo "PASS: prereq-dependencies shell tests"
