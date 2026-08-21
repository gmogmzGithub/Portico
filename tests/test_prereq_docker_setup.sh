#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREREQ_SCRIPT="$PROJECT_ROOT/src/scripts/prereq-docker-setup.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

source_prereq_docker_setup_for_tests() {
  # shellcheck source=/dev/null
  source "$PREREQ_SCRIPT"
}

configure_temp_orbstack_paths() {
  local tmp_dir="$1"
  ORBSTACK_SYSTEM_APP_PATH="$tmp_dir/system/Applications/OrbStack.app"
  ORBSTACK_USER_APP_PATH="$tmp_dir/home/Applications/OrbStack.app"
  set_orbstack_app_path "$ORBSTACK_SYSTEM_APP_PATH"
}

create_fake_orbstack_app() {
  local app_path="$1"
  mkdir -p \
    "$app_path/Contents/MacOS/bin" \
    "$app_path/Contents/MacOS/xbin"
  : > "$app_path/Contents/MacOS/bin/orbctl"
  : > "$app_path/Contents/MacOS/xbin/docker"
  chmod +x \
    "$app_path/Contents/MacOS/bin/orbctl" \
    "$app_path/Contents/MacOS/xbin/docker"
}

install_success_command_stubs() {
  local tmp_dir="$1"
  local calls_file="$2"
  TEST_ORBSTACK_DMG_PATH="$tmp_dir/OrbStack.dmg"
  : > "$TEST_ORBSTACK_DMG_PATH"

  brew() {
    printf 'brew %s\n' "$*" >> "$calls_file"
    if [ "$1" = "fetch" ]; then
      printf 'Downloaded and verified OrbStack\n'
      return 0
    fi
    if [ "$1" = "--cache" ]; then
      printf '%s\n' "$TEST_ORBSTACK_DMG_PATH"
      return 0
    fi
    return 1
  }
  hdiutil() {
    printf 'hdiutil %s\n' "$*" >> "$calls_file"
    if [ "$1" = "attach" ]; then
      local mount_point=""
      local previous=""
      for arg in "$@"; do
        if [ "$previous" = "-mountpoint" ]; then
          mount_point="$arg"
          break
        fi
        previous="$arg"
      done
      create_fake_orbstack_app "$mount_point/OrbStack.app"
    fi
    return 0
  }
  codesign() {
    printf 'codesign %s\n' "$*" >> "$calls_file"
    if [ "$1" = "-d" ]; then
      printf 'Identifier=%s\nTeamIdentifier=%s\n' \
        "$ORBSTACK_EXPECTED_IDENTIFIER" "$ORBSTACK_EXPECTED_TEAM_ID" >&2
    fi
    return 0
  }
  spctl() {
    printf 'spctl %s\n' "$*" >> "$calls_file"
    return 0
  }
  ditto() {
    printf 'ditto %s\n' "$*" >> "$calls_file"
    create_fake_orbstack_app "$2"
  }
  xattr() {
    printf 'xattr %s\n' "$*" >> "$calls_file"
    if [ "$1" = "-r" ]; then
      if [ ! -f "$2/.quarantine-cleared" ]; then
        printf '%s: com.apple.quarantine\n' "$2"
      fi
      return 0
    fi
    if [ "$1" = "-dr" ]; then
      : > "$3/.quarantine-cleared"
      return 0
    fi
    return 1
  }
}

test_source_does_not_execute_main() {
  (
    source_prereq_docker_setup_for_tests
    command -v install_orbstack >/dev/null 2>&1 \
      || fail "sourcing prereq-docker-setup.sh did not expose install_orbstack"
  )
}

test_resolve_orbstack_app_path_prefers_system_then_user() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    configure_temp_orbstack_paths "$tmp_dir"

    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    resolve_orbstack_app_path || fail "expected user-local OrbStack to resolve"
    [ "$ORBSTACK_APP_PATH" = "$ORBSTACK_USER_APP_PATH" ] \
      || fail "expected user-local OrbStack path"

    create_fake_orbstack_app "$ORBSTACK_SYSTEM_APP_PATH"
    resolve_orbstack_app_path || fail "expected system OrbStack to resolve"
    [ "$ORBSTACK_APP_PATH" = "$ORBSTACK_SYSTEM_APP_PATH" ] \
      || fail "system OrbStack should take precedence"
  )
}

test_verified_install_fetches_without_installing_cask() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file output
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"

    if ! download_and_install_orbstack >"$output_file" 2>&1; then
      cat "$output_file" >&2
      fail "verified user-local install should succeed"
    fi
    output="$(cat "$output_file")"

    [ -d "$ORBSTACK_USER_APP_PATH" ] \
      || fail "expected OrbStack in the user Applications folder"
    [ "$ORBSTACK_APP_PATH" = "$ORBSTACK_USER_APP_PATH" ] \
      || fail "installed path was not selected"
    grep -Fq 'brew fetch --cask --retry orbstack' "$calls_file" \
      || fail "expected fetch-only Homebrew command"
    grep -Fq 'brew --cache --cask orbstack' "$calls_file" \
      || fail "expected Homebrew cache resolution"
    ! grep -Fq 'brew install' "$calls_file" \
      || fail "must never run brew install for OrbStack"
    ! grep -Fq 'brew update' "$calls_file" \
      || fail "a successful fetch must not update Homebrew"
    grep -Fq 'hdiutil attach -readonly -nobrowse' "$calls_file" \
      || fail "expected read-only disk image mount"
    grep -Fq 'hdiutil detach' "$calls_file" \
      || fail "expected disk image detachment"
    [ "$(grep -c '^codesign --verify' "$calls_file")" -eq 2 ] \
      || fail "expected source and staged signature verification"
    [ "$(grep -c '^spctl --assess' "$calls_file")" -eq 2 ] \
      || fail "expected source and staged Gatekeeper assessment"
    grep -Fq 'xattr -dr com.apple.quarantine' "$calls_file" \
      || fail "expected recursive quarantine removal from the verified copy"
    local staged_spctl_line quarantine_clear_line
    staged_spctl_line="$(grep -n '^spctl --assess' "$calls_file" | tail -1 | cut -d: -f1)"
    quarantine_clear_line="$(grep -n '^xattr -dr com.apple.quarantine' "$calls_file" | cut -d: -f1)"
    [ "$staged_spctl_line" -lt "$quarantine_clear_line" ] \
      || fail "the staged app must pass Gatekeeper before quarantine is removed"
    [ "$(grep -c ': com.apple.quarantine' "$output_file")" -eq 0 ] \
      || fail "quarantine metadata must not be emitted to the setup log"
    printf '%s' "$output" | grep -Fq 'OrbStack installed securely' \
      || fail "expected secure install success log"
  )
}

test_verify_rejects_signature_identity_and_gatekeeper_failures() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir app_path
    tmp_dir="$(mktemp -d)"
    app_path="$tmp_dir/OrbStack.app"
    create_fake_orbstack_app "$app_path"

    codesign() { return 1; }
    spctl() { return 0; }
    verify_orbstack_app_bundle "$app_path" \
      && fail "invalid signature should fail verification"
    [ "$ORBSTACK_VERIFICATION_CODE" = "orbstack_signature_invalid" ] \
      || fail "expected signature failure code"

    codesign() {
      if [ "$1" = "-d" ]; then
        printf 'Identifier=wrong.bundle\nTeamIdentifier=WRONGTEAM\n' >&2
      fi
      return 0
    }
    verify_orbstack_app_bundle "$app_path" \
      && fail "identity mismatch should fail verification"
    [ "$ORBSTACK_VERIFICATION_CODE" = "orbstack_identity_mismatch" ] \
      || fail "expected identity failure code"

    codesign() {
      if [ "$1" = "-d" ]; then
        printf 'Identifier=%s\nTeamIdentifier=%s\n' \
          "$ORBSTACK_EXPECTED_IDENTIFIER" "$ORBSTACK_EXPECTED_TEAM_ID" >&2
      fi
      return 0
    }
    spctl() { echo 'rejected' >&2; return 1; }
    verify_orbstack_app_bundle "$app_path" \
      && fail "Gatekeeper rejection should fail verification"
    [ "$ORBSTACK_VERIFICATION_CODE" = "orbstack_gatekeeper_rejected" ] \
      || fail "expected Gatekeeper failure code"
  )
}

test_copy_failure_detaches_and_cleans_workspace() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    ditto() {
      printf 'ditto %s\n' "$*" >> "$calls_file"
      echo 'simulated copy failure' >&2
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "copy failure should fail installation"
    grep -Fq '[PREREQ:CODE:orbstack_copy_failed]' "$output_file" \
      || fail "expected typed copy failure"
    grep -Fq 'hdiutil detach' "$calls_file" \
      || fail "copy failure should detach the disk image"
    [ -z "$ORBSTACK_INSTALL_TMP_DIR" ] \
      || fail "copy failure should clear workspace state"
    [ ! -e "$ORBSTACK_USER_APP_PATH" ] \
      || fail "copy failure must not leave a destination app"
  )
}

test_verification_failure_detaches_and_cleans_workspace() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    codesign() {
      printf 'codesign %s\n' "$*" >> "$calls_file"
      echo 'simulated signature failure' >&2
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "verification failure should fail installation"
    grep -Fq '[PREREQ:CODE:orbstack_signature_invalid]' "$output_file" \
      || fail "expected typed signature failure"
    grep -Fq 'hdiutil detach' "$calls_file" \
      || fail "verification failure should detach the disk image"
    [ -z "$ORBSTACK_INSTALL_TMP_DIR" ] \
      || fail "verification failure should clear workspace state"
    [ ! -e "$ORBSTACK_USER_APP_PATH" ] \
      || fail "verification failure must not leave a destination app"
  )
}

test_quarantine_cleanup_failure_detaches_and_cleans_workspace() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    xattr() {
      printf 'xattr %s\n' "$*" >> "$calls_file"
      if [ "$1" = "-r" ]; then
        printf '%s: com.apple.quarantine\n' "$2"
        return 0
      fi
      echo 'simulated quarantine cleanup failure' >&2
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "quarantine cleanup failure should fail installation"
    grep -Fq '[PREREQ:CODE:orbstack_quarantine_cleanup_failed]' "$output_file" \
      || fail "expected typed quarantine cleanup failure"
    grep -Fq 'hdiutil detach' "$calls_file" \
      || fail "quarantine cleanup failure should detach the disk image"
    [ -z "$ORBSTACK_INSTALL_STAGING_PATH" ] \
      || fail "quarantine cleanup failure should clear staging state"
    [ ! -e "$ORBSTACK_USER_APP_PATH" ] \
      || fail "unsafe OrbStack copy must not reach the destination"
  )
}

test_mount_failure_cleans_workspace_without_detach() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    hdiutil() {
      printf 'hdiutil %s\n' "$*" >> "$calls_file"
      echo 'simulated mount failure' >&2
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "mount failure should fail installation"
    grep -Fq '[PREREQ:CODE:orbstack_mount_failed]' "$output_file" \
      || fail "expected typed mount failure"
    ! grep -Fq 'hdiutil detach' "$calls_file" \
      || fail "an unmounted disk image must not be detached"
    [ -z "$ORBSTACK_INSTALL_TMP_DIR" ] \
      || fail "mount failure should clear workspace state"
  )
}

test_atomic_move_failure_detaches_and_removes_staging() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    mv() {
      printf 'mv %s\n' "$*" >> "$calls_file"
      echo 'simulated atomic move failure' >&2
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "atomic move failure should fail installation"
    grep -Fq '[PREREQ:CODE:orbstack_copy_failed]' "$output_file" \
      || fail "expected typed copy failure for atomic move"
    grep -Fq 'mv -n ' "$calls_file" \
      || fail "expected a no-clobber atomic move"
    grep -Fq 'hdiutil detach' "$calls_file" \
      || fail "atomic move failure should detach the disk image"
    [ -z "$ORBSTACK_INSTALL_STAGING_PATH" ] \
      || fail "atomic move failure should clear staging state"
    [ ! -e "$ORBSTACK_USER_APP_PATH" ] \
      || fail "atomic move failure must not leave a destination app"
  )
}

test_existing_destination_is_never_overwritten() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    printf 'existing\n' > "$ORBSTACK_USER_APP_PATH/existing-marker"

    download_and_install_orbstack >/dev/null 2>&1 \
      || fail "existing destination should be accepted"
    [ -f "$ORBSTACK_USER_APP_PATH/existing-marker" ] \
      || fail "existing OrbStack app was replaced"
    ! grep -q '^ditto ' "$calls_file" \
      || fail "existing destination should not be copied over"
  )
}

test_first_launch_is_hidden_and_waits_for_process() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file pgrep_calls
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    pgrep_calls="$tmp_dir/pgrep-calls"
    : > "$calls_file"
    printf '0\n' > "$pgrep_calls"
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"

    defaults() {
      printf 'defaults %s\n' "$*" >> "$calls_file"
      if [ "$1" = "read" ]; then
        printf '0\n'
      fi
    }
    open() { printf 'open %s\n' "$*" >> "$calls_file"; }
    pgrep() {
      local count
      count="$(cat "$pgrep_calls")"
      count=$((count + 1))
      printf '%s\n' "$count" > "$pgrep_calls"
      if [ "$count" -ge 2 ]; then
        printf '123\n'
        return 0
      fi
      return 1
    }
    ps() { printf '%s\n' "$ORBSTACK_USER_APP_PATH/Contents/MacOS/OrbStack"; }
    sleep() { :; }
    run_orbctl() {
      fail "orbctl must not run during first-launch approval"
    }

    launch_new_orbstack_app >"$output_file" 2>&1 \
      || fail "hidden first launch should succeed after process appears"
    grep -Fq "open -gj $ORBSTACK_USER_APP_PATH" "$calls_file" \
      || fail "expected exact hidden/background app launch"
    grep -Fq 'defaults write dev.kdrag0n.MacVirt onboarding_showMoveToApplicationsPopup -bool false' "$calls_file" \
      || fail "expected OrbStack self-relocation prompt to be disabled before launch"
    grep -Fq '[PREREQ:PROGRESS:orbstack_launch_state:awaiting_approval]' "$output_file" \
      || fail "expected awaiting-approval progress state"
    grep -Fq '[PREREQ:PROGRESS:orbstack_launch_state:approved]' "$output_file" \
      || fail "expected approved progress state"
  )
}

test_first_launch_timeout_is_typed_and_nonterminal() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir output_file status
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/output"
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"
    ORBSTACK_FIRST_LAUNCH_TIMEOUT_SECONDS=4

    defaults() {
      if [ "$1" = "read" ]; then
        printf '0\n'
      fi
    }
    open() { :; }
    pgrep() { return 1; }
    sleep() { :; }

    set +e
    launch_new_orbstack_app >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "launch approval timeout should fail"
    grep -Fq '[PREREQ:CODE:orbstack_launch_approval_timeout]' "$output_file" \
      || fail "expected typed approval timeout"
    ! grep -Eqi 'terminal|xattr|spctl --add|codesign --force' "$output_file" \
      || fail "approval timeout must not recommend a security bypass"
  )
}

test_first_launch_requires_move_prompt_suppression() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir output_file open_calls status
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/output"
    open_calls="$tmp_dir/open-calls"
    : > "$open_calls"
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"

    defaults() {
      if [ "$1" = "read" ]; then
        printf '1\n'
      fi
    }
    open() { echo open >> "$open_calls"; }

    set +e
    launch_new_orbstack_app >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "unconfirmed move-prompt suppression should fail closed"
    grep -Fq '[PREREQ:CODE:orbstack_first_launch_preferences_failed]' "$output_file" \
      || fail "expected typed first-launch preference failure"
    [ ! -s "$open_calls" ] \
      || fail "OrbStack must not launch while its relocation prompt remains enabled"
  )
}

test_first_launch_rejects_app_translocation() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir output_file status
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/output"
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"

    defaults() {
      if [ "$1" = "read" ]; then
        printf '0\n'
      fi
    }
    open() { :; }
    pgrep() { printf '123\n'; }
    ps() {
      printf '/private/var/folders/test/AppTranslocation/UUID/d/OrbStack.app/Contents/MacOS/OrbStack\n'
    }

    set +e
    launch_new_orbstack_app >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "translocated first launch should fail closed"
    grep -Fq '[PREREQ:CODE:orbstack_translocated_launch]' "$output_file" \
      || fail "expected typed App Translocation failure"
  )
}

test_phase_fails_before_compose_when_any_running_orbstack_is_translocated() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir output_file status
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/output"
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    OSTYPE="darwin"

    check_virtualization_support() { return 0; }
    check_docker() { return 0; }
    resolve_orbstack_app_path() {
      set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"
      return 0
    }
    configure_orbstack_resources() { return 0; }
    ensure_docker_compose_frontend() {
      fail "compose readiness must not run after unsafe OrbStack detection"
    }
    defaults() {
      if [ "$1" = "read" ]; then
        printf '0\n'
      fi
    }
    pgrep() { printf '123\n456\n'; }
    ps() {
      local pid="$3"
      if [ "$pid" = "123" ]; then
        printf '%s\n' "$ORBSTACK_USER_APP_PATH/Contents/MacOS/OrbStack"
      else
        printf '/private/var/folders/test/AppTranslocation/UUID/d/OrbStack.app/Contents/MacOS/OrbStack\n'
      fi
    }

    set +e
    (main) >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "Phase 3 should fail for any translocated OrbStack process"
    grep -Fq '[PREREQ:CODE:orbstack_translocated_launch]' "$output_file" \
      || fail "expected typed App Translocation failure before image-pull readiness"
    grep -Fq '[PREREQ:STEP:orbstack:FAILED]' "$output_file" \
      || fail "expected OrbStack step to fail before Phase 3 succeeds"
  )
}

test_phase_rechecks_orbstack_location_after_compose_recovery() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir output_file status unsafe_process
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/output"
    unsafe_process=false
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    OSTYPE="darwin"

    check_virtualization_support() { return 0; }
    check_docker() { return 0; }
    resolve_orbstack_app_path() {
      set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"
      return 0
    }
    configure_orbstack_resources() { return 0; }
    ensure_docker_compose_frontend() {
      unsafe_process=true
      return 0
    }
    defaults() {
      if [ "$1" = "read" ]; then
        printf '0\n'
      fi
    }
    pgrep() { printf '123\n'; }
    ps() {
      if [ "$unsafe_process" = true ]; then
        printf '/private/var/folders/test/AppTranslocation/UUID/d/OrbStack.app/Contents/MacOS/OrbStack\n'
      else
        printf '%s\n' "$ORBSTACK_USER_APP_PATH/Contents/MacOS/OrbStack"
      fi
    }

    set +e
    (main) >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "Phase 3 should recheck OrbStack after Compose recovery"
    grep -Fq '[PREREQ:CODE:orbstack_translocated_launch]' "$output_file" \
      || fail "expected post-Compose App Translocation failure"
    grep -Fq 'OrbStack became unsafe while validating Docker Compose' "$output_file" \
      || fail "expected the post-Compose safety check to run"
  )
}

test_existing_system_install_skips_download() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_SYSTEM_APP_PATH"
    brew() { fail "existing system install should not call Homebrew"; }
    pgrep() { return 0; }
    finalize_orbstack_install() { return 0; }

    install_orbstack >/dev/null 2>&1 \
      || fail "existing system install should succeed"
    [ "$ORBSTACK_APP_PATH" = "$ORBSTACK_SYSTEM_APP_PATH" ] \
      || fail "existing system install should remain selected"
  )
}

test_existing_unopened_install_retries_first_launch_before_cli() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir launch_calls prepare_calls
    tmp_dir="$(mktemp -d)"
    launch_calls="$tmp_dir/launch-calls"
    prepare_calls="$tmp_dir/prepare-calls"
    : > "$launch_calls"
    : > "$prepare_calls"
    configure_temp_orbstack_paths "$tmp_dir"
    create_fake_orbstack_app "$ORBSTACK_USER_APP_PATH"
    brew() { fail "existing user install should not call Homebrew"; }
    pgrep() { return 1; }
    prepare_orbstack_app_for_first_launch() { echo prepare >> "$prepare_calls"; return 0; }
    launch_new_orbstack_app() { echo launch >> "$launch_calls"; return 0; }
    finalize_orbstack_install() { return 0; }

    install_orbstack >/dev/null 2>&1 \
      || fail "existing unopened install should retry first launch"
    [ "$(wc -l < "$prepare_calls" | tr -d ' ')" -eq 1 ] \
      || fail "expected existing app verification and quarantine preparation before launch"
    [ "$(wc -l < "$launch_calls" | tr -d ' ')" -eq 1 ] \
      || fail "expected first-launch retry before CLI finalization"
  )
}

test_old_homebrew_updates_once_after_fetch_failure_then_retries() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file brew_state parser_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    brew_state="$tmp_dir/brew-state"
    : > "$calls_file"
    printf 'stale\n' > "$brew_state"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    parser_error="Error: undefined method 'run' for an instance of Homebrew::Declarative::Steps"
    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      case "$1" in
        fetch)
          if [ "$(cat "$brew_state")" = "stale" ]; then
            printf '%s\n' "$parser_error" >&2
            return 1
          fi
          printf 'Downloaded and verified OrbStack\n'
          ;;
        --version)
          if [ "$(cat "$brew_state")" = "stale" ]; then
            printf 'Homebrew 6.0.12\n'
          else
            printf 'Homebrew 6.0.13\n'
          fi
          ;;
        update)
          printf 'updated\n' > "$brew_state"
          printf 'Updated Homebrew\n'
          ;;
        --cache)
          printf '%s\n' "$TEST_ORBSTACK_DMG_PATH"
          ;;
        *)
          return 1
          ;;
      esac
    }

    if ! download_and_install_orbstack >"$output_file" 2>&1; then
      cat "$output_file" >&2
      fail "stale Homebrew should recover by updating once and retrying the fetch"
    fi

    [ "$(grep -c '^brew fetch --cask --retry orbstack$' "$calls_file")" -eq 2 ] \
      || fail "expected one fetch retry after the Homebrew update"
    [ "$(grep -c '^brew update$' "$calls_file")" -eq 1 ] \
      || fail "expected exactly one Homebrew update"
    [ "$(sed -n '1p' "$calls_file")" = 'brew fetch --cask --retry orbstack' ] \
      && [ "$(sed -n '2p' "$calls_file")" = 'brew --version' ] \
      && [ "$(sed -n '3p' "$calls_file")" = 'brew update' ] \
      && [ "$(sed -n '4p' "$calls_file")" = 'brew fetch --cask --retry orbstack' ] \
      || fail "expected fetch, version check, update, fetch command order"
    grep -Fq 'Homebrew updated and can now download OrbStack' "$output_file" \
      || fail "expected successful recovery log"
    ! grep -Fq '[PREREQ:STEP:orbstack:FAILED]' "$output_file" \
      || fail "recovered installation must not emit an OrbStack failure marker"
    [ -d "$ORBSTACK_USER_APP_PATH" ] \
      || fail "recovered fetch should complete the verified user-local install"
  )
}

test_old_homebrew_retry_is_bounded_and_typed() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status parser_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    parser_error="Error: undefined method 'run' for an instance of Homebrew::Declarative::Steps"
    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      if [ "$1" = "fetch" ]; then
        printf '%s\n' "$parser_error" >&2
        return 1
      fi
      if [ "$1" = "--version" ]; then
        printf 'Homebrew 6.0.12\n'
        return 0
      fi
      if [ "$1" = "update" ]; then
        printf 'Already up-to-date.\n'
        return 0
      fi
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "an unhealed stale Homebrew should fail installation"
    [ "$(grep -c '^brew fetch --cask --retry orbstack$' "$calls_file")" -eq 2 ] \
      || fail "stale Homebrew recovery must stop after one fetch retry"
    [ "$(grep -c '^brew update$' "$calls_file")" -eq 1 ] \
      || fail "stale Homebrew recovery must run only one update"
    [ "$(grep -c '^brew --version$' "$calls_file")" -eq 2 ] \
      || fail "expected version checks before updating and after the failed retry"
    grep -Fq '[PREREQ:CODE:homebrew_outdated]' "$output_file" \
      || fail "expected typed homebrew_outdated failure after the bounded retry"
    grep -Fq '[PREREQ:STEP:orbstack:FAILED]' "$output_file" \
      || fail "expected OrbStack step failure marker after recovery is exhausted"
    ! grep -Fq '[PREREQ:CODE:orbstack_download_failed]' "$output_file" \
      || fail "an unhealed cask DSL failure must remain classified as outdated Homebrew"
  )
}

test_outdated_homebrew_fetch_failure_reports_homebrew_outdated() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status outdated_error
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    outdated_error='/usr/local/Homebrew/Library/Homebrew/macos_version.rb:53:in `initialize'\'': unknown or unsupported macOS version: "26.5" (MacOSVersion::Error)'
    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      if [ "$1" = "fetch" ]; then
        printf '%s\n' "$outdated_error" >&2
        return 1
      fi
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "outdated brew fetch failure should fail installation"
    grep -Fq '[PREREQ:CODE:homebrew_outdated]' "$output_file" \
      || fail "expected typed homebrew_outdated failure"
    ! grep -Fq '[PREREQ:CODE:orbstack_download_failed]' "$output_file" \
      || fail "outdated brew must not be misreported as a download failure"
    grep -Fq '[PREREQ:STEP:orbstack:FAILED]' "$output_file" \
      || fail "expected orbstack step failure marker"
    ! grep -Eqi 'terminal|xattr|spctl --add|codesign --force' "$output_file" \
      || fail "outdated brew failure must not recommend a security bypass"
    [ ! -e "$ORBSTACK_USER_APP_PATH" ] \
      || fail "a failed fetch must not leave a destination app"
  )
}

test_generic_fetch_failure_still_reports_download_failed() {
  (
    source_prereq_docker_setup_for_tests
    local tmp_dir calls_file output_file status
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls"
    output_file="$tmp_dir/output"
    : > "$calls_file"
    configure_temp_orbstack_paths "$tmp_dir"
    install_success_command_stubs "$tmp_dir" "$calls_file"
    brew() {
      printf 'brew %s\n' "$*" >> "$calls_file"
      if [ "$1" = "fetch" ]; then
        echo 'curl: (7) Failed to connect to raw.githubusercontent.com port 443' >&2
        return 1
      fi
      if [ "$1" = "--version" ]; then
        echo 'Homebrew 6.0.13'
        return 0
      fi
      return 1
    }

    set +e
    download_and_install_orbstack >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "generic fetch failure should fail installation"
    grep -Fq '[PREREQ:CODE:orbstack_download_failed]' "$output_file" \
      || fail "expected typed download failure for a network error"
    ! grep -Fq '[PREREQ:CODE:homebrew_outdated]' "$output_file" \
      || fail "a network error must not be reported as an outdated brew"
    ! grep -Fq 'brew update' "$calls_file" \
      || fail "a fetch failure at the minimum Homebrew version must not update Homebrew"
  )
}

test_source_does_not_execute_main
test_resolve_orbstack_app_path_prefers_system_then_user
test_verified_install_fetches_without_installing_cask
test_verify_rejects_signature_identity_and_gatekeeper_failures
test_copy_failure_detaches_and_cleans_workspace
test_verification_failure_detaches_and_cleans_workspace
test_quarantine_cleanup_failure_detaches_and_cleans_workspace
test_mount_failure_cleans_workspace_without_detach
test_atomic_move_failure_detaches_and_removes_staging
test_existing_destination_is_never_overwritten
test_first_launch_is_hidden_and_waits_for_process
test_first_launch_timeout_is_typed_and_nonterminal
test_first_launch_requires_move_prompt_suppression
test_first_launch_rejects_app_translocation
test_phase_fails_before_compose_when_any_running_orbstack_is_translocated
test_phase_rechecks_orbstack_location_after_compose_recovery
test_existing_system_install_skips_download
test_existing_unopened_install_retries_first_launch_before_cli
test_old_homebrew_updates_once_after_fetch_failure_then_retries
test_old_homebrew_retry_is_bounded_and_typed
test_outdated_homebrew_fetch_failure_reports_homebrew_outdated
test_generic_fetch_failure_still_reports_download_failed

echo "PASS: prereq-docker-setup shell tests"
