#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY_SCRIPT="$PROJECT_ROOT/electron-app/src/scripts/apply-prepared-update.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

create_apply_fixture() {
  local tmp_dir="$1"
  local prepared_root="$tmp_dir/prepared-managed"
  local app_bundle="$tmp_dir/Portico.app"
  local resources_root="$app_bundle/Contents/Resources"

  mkdir -p \
    "$tmp_dir/managed/electron-app" \
    "$prepared_root/electron-app" \
    "$prepared_root/src/mcp-orc-rust/target/debug" \
    "$resources_root"
  printf '{"buildNumber":"old-build"}\n' > "$tmp_dir/managed/electron-app/build-info.json"
  printf '{"buildNumber":"new-build"}\n' > "$prepared_root/electron-app/build-info.json"
  printf '{"buildNumber":"new-build"}\n' > "$tmp_dir/prepared-build-info.json"
  cp "$tmp_dir/prepared-build-info.json" "$resources_root/build-info.json"
  cp /usr/bin/true "$prepared_root/src/mcp-orc-rust/target/debug/mcp-orc"
  chmod +x "$prepared_root/src/mcp-orc-rust/target/debug/mcp-orc"
  : > "$tmp_dir/prepared.dmg"
}

test_source_does_not_execute_main() {
  local output
  output="$(bash -c 'set -euo pipefail; source "$1"; echo sourced-ok' bash "$APPLY_SCRIPT")"
  [ "$output" = "sourced-ok" ] || fail "sourcing apply-prepared-update.sh executed main()"
}

test_install_prepared_backup_archive_prunes_before_link_and_retains_two() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir backup_dir prepared_backup output archive_count prune_line link_line
    tmp_dir="$(mktemp -d)"
    MANAGED_DIR="$tmp_dir/managed"
    backup_dir="$MANAGED_DIR/backup"
    mkdir -p "$backup_dir/manual-note-dir"

    printf 'keep note\n' > "$backup_dir/notes.txt"
    printf 'keep dir note\n' > "$backup_dir/manual-note-dir/keep.txt"

    local index=""
    for index in 004 005 006 007 008; do
      printf '%s\n' "$index" > "$backup_dir/portico_full_backup_${index}.zip"
    done

    prepared_backup="$tmp_dir/portico_full_backup_999.zip"
    printf 'prepared backup\n' > "$prepared_backup"

    output="$(install_prepared_backup_archive "$prepared_backup" 2>&1)"

    archive_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' | wc -l | tr -d '[:space:]')"
    [ "$archive_count" = "2" ] \
      || fail "expected prepared backup installation to retain two matching archives, saw $archive_count"
    [ -f "$backup_dir/portico_full_backup_999.zip" ] \
      || fail "expected the prepared backup archive to be retained in managed backup storage"
    [ -f "$backup_dir/portico_full_backup_008.zip" ] \
      || fail "expected the newest existing archive to be retained with the incoming backup"
    [ ! -e "$backup_dir/portico_full_backup_007.zip" ] \
      || fail "expected older matching archives to be pruned before placing the prepared backup"
    [ -f "$backup_dir/notes.txt" ] \
      || fail "prepared backup installation should not remove unrelated files"
    [ -f "$backup_dir/manual-note-dir/keep.txt" ] \
      || fail "prepared backup installation should not remove unrelated directories"
    case "$output" in
      *"Prepared backup linked to "*|*"Prepared backup copied to "* ) ;;
      * ) fail "expected prepared backup installation to log the placed archive path" ;;
    esac
    printf '%s' "$output" | grep -q 'Managed full backup retention: pruned 4 archive(s); kept 1 of 5' \
      || fail "expected prepared backup installation to reserve one retention slot before linking"
    prune_line="$(printf '%s\n' "$output" | grep -n 'Managed full backup retention' | cut -d: -f1)"
    link_line="$(printf '%s\n' "$output" | grep -n 'Prepared backup .* to ' | cut -d: -f1)"
    [ "$prune_line" -lt "$link_line" ] \
      || fail "expected retention pruning to happen before backup placement"
  )
}

test_install_prepared_backup_archive_dedupes_same_inode_on_retry() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir backup_dir prepared_backup output archive_count source_identity installed_identity
    tmp_dir="$(mktemp -d)"
    MANAGED_DIR="$tmp_dir/managed"
    backup_dir="$MANAGED_DIR/backup"
    prepared_backup="$tmp_dir/portico_full_backup_999.zip"
    printf 'prepared backup\n' > "$prepared_backup"

    install_prepared_backup_archive "$prepared_backup" >/dev/null
    output="$(install_prepared_backup_archive "$prepared_backup" 2>&1)"

    archive_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' | wc -l | tr -d '[:space:]')"
    [ "$archive_count" = "1" ] \
      || fail "expected retry dedupe to avoid a second hardlink name, saw $archive_count archives"
    printf '%s' "$output" | grep -q 'Prepared backup already installed at ' \
      || fail "expected retry dedupe to log that the archive is already installed"
    source_identity="$(backup_archive_inode_identity "$prepared_backup")"
    installed_identity="$(backup_archive_inode_identity "$backup_dir/portico_full_backup_999.zip")"
    [ "$source_identity" = "$installed_identity" ] \
      || fail "expected installed prepared backup to retain the source inode"
  )
}

test_backup_inode_identity_ignores_failed_bsd_stat_output() {
  (
    source "$APPLY_SCRIPT"

    stat() {
      if [ "$1" = "-f" ]; then
        printf 'partial GNU filesystem output\n'
        return 1
      fi
      if [ "$1" = "-c" ]; then
        printf '42:99\n'
        return 0
      fi
      return 1
    }

    [ "$(backup_archive_inode_identity /fixture/archive.zip)" = "42:99" ] \
      || fail "inode identity should discard output from a failed BSD stat probe"
  )
}

# --- PORTICO-215 disk-space preflight tests ---
# Fixed stub sizes (KB): payload 1.0 GB, backup zip 0.5 GB, margin 1.0
# GB. The in-place filter reconcile therefore needs 2.5 GB and never walks
# preserved user-data paths.

preflight_stub_sizes() {
  update_apply_du_kb() {
    case "$1" in
      /payload) printf '1048576\n' ;;
      /backup.zip) printf '524288\n' ;;
      *) printf '0\n' ;;
    esac
  }
}

test_preflight_blocks_when_managed_volume_space_is_insufficient() {
  (
    source "$APPLY_SCRIPT"
    preflight_stub_sizes
    update_apply_df_free_kb() { printf '2097152\n'; }   # 2.0 GB free

    local rc=0 output=""
    output="$(preflight_disk_space_for_apply /managed /payload /backup.zip /tmpvol wsA wsB 2>&1)" || rc=$?
    [ "$rc" = "1" ] || fail "expected preflight to fail on insufficient managed-volume space, rc=$rc"
    case "$output" in
      *"Error: Not enough free disk space to install the update. About 2.5 GB is needed, but only 2.0 GB is free"*) ;;
      *) fail "expected shortfall message with modeled numbers, saw: $output" ;;
    esac
    case "$output" in
      *"free up at least 0.5 GB"*) ;;
      *) fail "expected shortfall arithmetic of 0.5 GB, saw: $output" ;;
    esac
    case "$output" in
      *"The update will resume automatically."*) ;;
      *) fail "expected recovery guidance in shortfall message, saw: $output" ;;
    esac
  )
}

test_preflight_does_not_measure_preserved_paths_or_tmpdir() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir calls_file
    tmp_dir="$(mktemp -d)"
    calls_file="$tmp_dir/calls.log"
    update_apply_du_kb() {
      printf 'du:%s\n' "$1" >> "$calls_file"
      case "$1" in
        /payload) printf '1048576\n' ;;
        /backup.zip) printf '524288\n' ;;
        *) printf '999999999\n' ;;
      esac
    }
    update_apply_df_free_kb() {
      printf 'df:%s\n' "$1" >> "$calls_file"
      printf '8388608\n'
    }

    preflight_disk_space_for_apply /managed /payload /backup.zip /tmpvol open-webui-data workspaces >/dev/null \
      || fail "expected corrected in-place reconcile preflight to pass"
    grep -q '^du:/payload$' "$calls_file" || fail "expected payload size measurement"
    grep -q '^du:/backup.zip$' "$calls_file" || fail "expected backup size measurement"
    grep -q '^df:/managed$' "$calls_file" || fail "expected managed-volume free-space measurement"
    if grep -Eq '/managed/(open-webui-data|workspaces)|/tmpvol' "$calls_file"; then
      fail "corrected preflight must not walk preserved paths or model TMPDIR staging"
    fi
  )
}

test_preflight_passes_with_sufficient_space_and_reports_ok() {
  (
    source "$APPLY_SCRIPT"
    preflight_stub_sizes
    update_apply_df_free_kb() { printf '8388608\n'; }   # 8.0 GB free

    local output=""
    output="$(preflight_disk_space_for_apply /managed /payload /backup.zip /tmpvol wsA wsB 2>&1)" \
      || fail "expected preflight to pass with 8 GB free"
    case "$output" in
      *"Preflight: disk space OK (need ~2.5 GB, 8.0 GB free)"*) ;;
      *) fail "expected OK line with modeled numbers, saw: $output" ;;
    esac
  )
}

test_preflight_checks_only_the_managed_destination_volume() {
  (
    source "$APPLY_SCRIPT"
    preflight_stub_sizes
    update_apply_df_free_kb() {
      case "$1" in
        /managed) printf '3145728\n' ;;
        *) fail "preflight unexpectedly measured non-destination volume: $1" ;;
      esac
    }
    preflight_disk_space_for_apply /managed /payload /backup.zip /tmpvol wsA wsB >/dev/null 2>&1 \
      || fail "expected destination-only preflight to pass with 3 GB free"
  )
}

test_preflight_excludes_absent_backup_from_requirement() {
  (
    source "$APPLY_SCRIPT"
    preflight_stub_sizes
    # Without the backup zip: need = 1.0 payload + 1.0 margin = 2.0 GB.
    update_apply_df_free_kb() { printf '2097152\n'; }   # exactly 2.0 GB free

    local output=""
    output="$(preflight_disk_space_for_apply /managed /payload none /tmpvol wsA wsB 2>&1)" \
      || fail "expected preflight to pass when the backup term is excluded (backup=none)"
    case "$output" in
      *"Preflight: disk space OK (need ~2.0 GB, 2.0 GB free)"*) ;;
      *) fail "expected backup-free requirement of 2.0 GB, saw: $output" ;;
    esac
  )
}

test_preflight_fails_open_when_du_is_unavailable() {
  (
    source "$APPLY_SCRIPT"
    update_apply_du_kb() { :; }   # unmeasurable
    update_apply_df_free_kb() { printf '1\n'; }

    local output=""
    output="$(preflight_disk_space_for_apply /managed /payload /backup.zip /tmpvol wsA 2>&1)" \
      || fail "expected preflight to fail open when du is unavailable"
    case "$output" in
      *"Preflight: skipping free disk space check"*) ;;
      *) fail "expected skip line when du is unavailable, saw: $output" ;;
    esac
  )
}

test_preflight_fails_open_when_df_is_unavailable() {
  (
    source "$APPLY_SCRIPT"
    preflight_stub_sizes
    update_apply_df_free_kb() { :; }   # unmeasurable

    local output=""
    output="$(preflight_disk_space_for_apply /managed /payload /backup.zip /tmpvol wsA 2>&1)" \
      || fail "expected preflight to fail open when df is unavailable"
    case "$output" in
      *"Preflight: skipping free disk space check"*) ;;
      *) fail "expected skip line when df is unavailable, saw: $output" ;;
    esac
  )
}

test_preflight_counts_missing_preserved_paths_as_zero() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir=""
    tmp_dir="$(mktemp -d)"
    mkdir -p "$tmp_dir/payload" "$tmp_dir/managed"
    printf 'x\n' > "$tmp_dir/payload/file.txt"

    # Real du/df against a fixture where no preserved paths exist: the
    # requirement must degrade to payload + margin and still pass.
    local output=""
    output="$(preflight_disk_space_for_apply "$tmp_dir/managed" "$tmp_dir/payload" none "$tmp_dir" missing-a missing-b 2>&1)" \
      || fail "expected preflight with real du/df and empty preserved paths to pass, saw: $output"
    case "$output" in
      *"Preflight: disk space OK"*|*"Preflight: skipping free disk space check"*) ;;
      *) fail "expected OK or skip line, saw: $output" ;;
    esac
    rm -rf "$tmp_dir"
  )
}

test_cleanup_stale_reconcile_strands_removes_only_old_top_level_directories() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir old_strand new_strand nested_strand output
    tmp_dir="$(mktemp -d)"
    old_strand="$tmp_dir/managed-runtime-reconcile.old"
    new_strand="$tmp_dir/managed-runtime-reconcile.new"
    nested_strand="$tmp_dir/nested/managed-runtime-reconcile.old"
    mkdir -p "$old_strand" "$new_strand" "$nested_strand"
    printf 'not a directory\n' > "$tmp_dir/managed-runtime-reconcile.file"
    touch -t 202001010000 "$old_strand" "$nested_strand"

    output="$(cleanup_stale_reconcile_strands "$tmp_dir" 2>&1)"

    [ ! -e "$old_strand" ] || fail "expected stale top-level reconcile strand to be removed"
    [ -d "$new_strand" ] || fail "expected recent reconcile strand to remain"
    [ -d "$nested_strand" ] || fail "expected nested lookalike strand to remain"
    [ -f "$tmp_dir/managed-runtime-reconcile.file" ] || fail "expected matching regular file to remain"
    printf '%s' "$output" | grep -q 'Removed 1 stale managed-runtime reconcile strand(s)' \
      || fail "expected stale strand cleanup count in output"
  )
}

test_docker_daemon_unreachable_classifier_is_narrow() {
  (
    source "$APPLY_SCRIPT"

    update_apply_docker_daemon_unreachable \
      "failed to connect to the docker API at unix:///Users/test/.orbstack/run/docker.sock: dial unix /Users/test/.orbstack/run/docker.sock: connect: no such file or directory" \
      || fail "expected missing local OrbStack socket to prove the daemon is down"
    update_apply_docker_daemon_unreachable \
      "Cannot connect to the Docker daemon at unix:///Users/test/.orbstack/run/docker.sock. Is the docker daemon running?" \
      || fail "expected Docker's local Unix daemon-down diagnostic to be recognized"
    update_apply_docker_daemon_unreachable \
      "error during connect to unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: connection refused" \
      || fail "expected refused local Unix socket to prove the daemon is down"

    local error_text=""
    while IFS= read -r error_text; do
      if update_apply_docker_daemon_unreachable "$error_text"; then
        fail "container guard classifier accepted an unproven daemon failure: $error_text"
      fi
    done <<'EOF'
permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: permission denied
failed to connect to the docker API at tcp://remote.example:2376: connect: connection refused
failed to connect to the docker API at unix:///var/run/docker.sock: context deadline exceeded
TLS handshake failed for unix:///var/run/docker.sock: connect: connection refused
failed to connect to unix:///var/run/docker.sock: connect: connection refused after timeout
malformed Docker error
EOF

    if update_apply_docker_daemon_unreachable ""; then
      fail "container guard classifier accepted an empty Docker error"
    fi
  )
}

test_container_guard_allows_proven_daemon_down_before_reconcile() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir fake_bin order_log output ps_count
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/fake-bin"
    order_log="$tmp_dir/order.log"
    mkdir -p "$fake_bin"
    create_apply_fixture "$tmp_dir"

    cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
printf 'docker:%s\n' "$*" >> "$APPLY_TEST_ORDER_LOG"
case "${1:-}" in
  ps)
    printf 'failed to connect to the docker API at unix:///Users/test/.orbstack/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/test/.orbstack/run/docker.sock: connect: no such file or directory\n' >&2
    exit 1
    ;;
  *) exit 64 ;;
esac
SH
    chmod +x "$fake_bin/docker"
    PATH="$fake_bin:$PATH"
    APPLY_TEST_ORDER_LOG="$order_log"
    export PATH APPLY_TEST_ORDER_LOG

    managed_runtime_require_packaged_generator_binary() { :; }
    managed_runtime_remove_generated_compose_files() { :; }
    cleanup_stale_reconcile_strands() { :; }
    preflight_disk_space_for_apply() { :; }
    managed_runtime_reconcile_payload() {
      printf 'reconcile\n' >> "$APPLY_TEST_ORDER_LOG"
    }
    managed_runtime_regenerate_generated_compose() { :; }
    managed_runtime_validate_generated_compose() { :; }

    output="$(main \
      "$tmp_dir/managed" \
      "$tmp_dir/prepared-managed" \
      "$tmp_dir/Portico.app" \
      "$tmp_dir/prepared.dmg" \
      "$tmp_dir/prepared-build-info.json" \
      none \
      new-build 2>&1)"

    printf '%s' "$output" | grep -q 'Docker daemon is not running; continuing update apply' \
      || fail "expected proven daemon-down diagnostic, saw: $output"
    printf '%s' "$output" | grep -q 'READY_FOR_RESTART' \
      || fail "expected apply to finish when the local Docker daemon is proven down"
    grep -q '^reconcile$' "$order_log" \
      || fail "expected reconcile after the proven daemon-down guard"
    ps_count="$(grep -c '^docker:ps --format {{.Names}}$' "$order_log")"
    [ "$ps_count" = "1" ] \
      || fail "expected exactly one authorizing Docker probe, saw $ps_count"
    if grep -q '^docker:stop' "$order_log"; then
      fail "daemon-down path must not issue a Docker stop"
    fi
  )
}

test_container_guard_unknown_docker_failure_aborts_before_reconcile() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir fake_bin order_log output rc
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/fake-bin"
    order_log="$tmp_dir/order.log"
    mkdir -p "$fake_bin"
    create_apply_fixture "$tmp_dir"

    cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
printf 'docker:%s\n' "$*" >> "$APPLY_TEST_ORDER_LOG"
printf 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n' >&2
exit 1
SH
    chmod +x "$fake_bin/docker"
    PATH="$fake_bin:$PATH"
    APPLY_TEST_ORDER_LOG="$order_log"
    export PATH APPLY_TEST_ORDER_LOG

    managed_runtime_require_packaged_generator_binary() { :; }
    managed_runtime_remove_generated_compose_files() { :; }
    cleanup_stale_reconcile_strands() { :; }
    preflight_disk_space_for_apply() { :; }
    managed_runtime_reconcile_payload() {
      printf 'reconcile\n' >> "$APPLY_TEST_ORDER_LOG"
    }
    managed_runtime_regenerate_generated_compose() { :; }
    managed_runtime_validate_generated_compose() { :; }

    set +e
    output="$(
      set -e
      main \
      "$tmp_dir/managed" \
      "$tmp_dir/prepared-managed" \
      "$tmp_dir/Portico.app" \
      "$tmp_dir/prepared.dmg" \
      "$tmp_dir/prepared-build-info.json" \
      none \
      new-build 2>&1)"
    rc=$?
    set -e

    [ "$rc" -ne 0 ] || fail "expected unproven Docker failure to abort apply"
    printf '%s' "$output" | grep -q 'Make sure Docker is running and accessible, then retry the update' \
      || fail "expected actionable Docker-access guidance, saw: $output"
    printf '%s' "$output" | grep -q 'permission denied' \
      || fail "expected original Docker diagnostic to remain available"
    if grep -q '^reconcile$' "$order_log"; then
      fail "unproven Docker failure must abort before reconcile"
    fi
  )
}

test_container_guard_stops_running_open_webui_before_reconcile() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir fake_bin order_log output stop_line reconcile_line
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/fake-bin"
    order_log="$tmp_dir/order.log"
    mkdir -p "$fake_bin"
    create_apply_fixture "$tmp_dir"

    cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  ps)
    printf 'docker:ps\n' >> "$APPLY_TEST_ORDER_LOG"
    printf 'portico-open-webui\n'
    ;;
  stop)
    printf 'docker:stop:%s\n' "${4:-}" >> "$APPLY_TEST_ORDER_LOG"
    ;;
  *) exit 64 ;;
esac
SH
    chmod +x "$fake_bin/docker"
    PATH="$fake_bin:$PATH"
    APPLY_TEST_ORDER_LOG="$order_log"
    export PATH APPLY_TEST_ORDER_LOG

    managed_runtime_require_packaged_generator_binary() { :; }
    managed_runtime_remove_generated_compose_files() { :; }
    cleanup_stale_reconcile_strands() { :; }
    preflight_disk_space_for_apply() { :; }
    managed_runtime_reconcile_payload() {
      printf 'reconcile\n' >> "$APPLY_TEST_ORDER_LOG"
    }
    managed_runtime_regenerate_generated_compose() { :; }
    managed_runtime_validate_generated_compose() { :; }

    output="$(main \
      "$tmp_dir/managed" \
      "$tmp_dir/prepared-managed" \
      "$tmp_dir/Portico.app" \
      "$tmp_dir/prepared.dmg" \
      "$tmp_dir/prepared-build-info.json" \
      none \
      new-build)"

    printf '%s' "$output" | grep -q 'READY_FOR_RESTART' \
      || fail "expected guarded apply fixture to finish"
    stop_line="$(grep -n '^docker:stop:portico-open-webui$' "$order_log" | cut -d: -f1)"
    reconcile_line="$(grep -n '^reconcile$' "$order_log" | cut -d: -f1)"
    [ -n "$stop_line" ] || fail "expected running Open WebUI container to be stopped"
    [ -n "$reconcile_line" ] || fail "expected reconcile marker in apply fixture"
    [ "$stop_line" -lt "$reconcile_line" ] \
      || fail "expected Open WebUI stop to complete before managed-runtime reconcile"
  )
}

test_container_guard_failure_aborts_apply_before_backup_or_reconcile_and_records_result() {
  (
    local tmp_dir fake_bin output rc ledger
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/fake-bin"
    mkdir -p "$fake_bin"
    create_apply_fixture "$tmp_dir"

    cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  ps) printf 'portico-open-webui\n' ;;
  stop) exit 42 ;;
  *) exit 64 ;;
esac
SH
    chmod +x "$fake_bin/docker"

    set +e
    output="$(env \
      PATH="$fake_bin:$PATH" \
      HOST_MCP_IS_PACKAGED=0 \
      APPLY_PREFLIGHT_MARGIN_KB=0 \
      /bin/bash "$APPLY_SCRIPT" \
      "$tmp_dir/managed" \
      "$tmp_dir/prepared-managed" \
      "$tmp_dir/Portico.app" \
      "$tmp_dir/prepared.dmg" \
      "$tmp_dir/prepared-build-info.json" \
      none \
      new-build 2>&1)"
    rc=$?
    set -e

    [ "$rc" -ne 0 ] || fail "expected failed Docker stop to abort update apply"
    printf '%s' "$output" | grep -q "Failed to stop Open WebUI container 'portico-open-webui'" \
      || fail "expected actionable Docker stop failure message, saw: $output"
    if printf '%s' "$output" | grep -Eq '^Step [23]:'; then
      fail "container stop failure must abort before backup placement and reconcile"
    fi
    printf '%s' "$output" | grep -q '\[UPDATE_APPLY:RESULT:fail:container_guard\]' \
      || fail "expected failed apply result marker to identify the container guard"
    [ ! -e "$tmp_dir/managed/backup" ] \
      || fail "container stop failure must not create managed backup state"

    ledger="$tmp_dir/managed/health-status/update-history.jsonl"
    [ -f "$ledger" ] || fail "expected failed apply attempt to append the update ledger"
    grep -q '"from":"old-build"' "$ledger" || fail "expected ledger to record source build"
    grep -q '"to":"new-build"' "$ledger" || fail "expected ledger to record target build"
    grep -q '"step":"container_guard"' "$ledger" || fail "expected ledger to record failed step"
    grep -q '"result":"fail"' "$ledger" || fail "expected ledger to record failed result"
  )
}

test_container_guard_allows_host_mode_when_docker_is_absent() {
  (
    source "$APPLY_SCRIPT"

    command() {
      if [ "${1:-}" = "-v" ] && [ "${2:-}" = "docker" ]; then
        return 1
      fi
      builtin command "$@"
    }

    local output
    output="$(ensure_open_webui_stopped 2>&1)" \
      || fail "expected Docker-absent host-mode guard to proceed"
    printf '%s' "$output" | grep -q 'Docker is not installed; continuing apply for host-mode runtime' \
      || fail "expected Docker-absent guard diagnostic"
  )
}

test_success_result_marker_caps_update_ledger_at_500_lines() {
  (
    source "$APPLY_SCRIPT"

    local tmp_dir ledger output line_count index
    tmp_dir="$(mktemp -d)"
    MANAGED_DIR="$tmp_dir/managed"
    mkdir -p "$MANAGED_DIR/health-status"
    ledger="$MANAGED_DIR/health-status/update-history.jsonl"
    for (( index=1; index<=510; index++ )); do
      printf '{"old":%s}\n' "$index" >> "$ledger"
    done
    APPLY_FROM_BUILD="old-build"
    APPLY_TO_BUILD="new-build"
    APPLY_CURRENT_STEP="complete"
    APPLY_RESULT="ok"
    UPDATE_KEY="test-update-key"

    output="$(update_apply_on_exit 0)"

    [ "$output" = '[UPDATE_APPLY:RESULT:ok:complete]' ] \
      || fail "expected successful apply result marker, saw: $output"
    line_count="$(wc -l < "$ledger" | tr -d '[:space:]')"
    [ "$line_count" = "500" ] || fail "expected update ledger cap of 500 lines, saw $line_count"
    tail -n 1 "$ledger" | grep -q '"result":"ok"' \
      || fail "expected capped ledger to end with successful apply record"
    tail -n 1 "$ledger" | grep -q '"source":"apply-prepared-update"' \
      || fail "expected successful apply record to identify its authoritative source"
    tail -n 1 "$ledger" | grep -q '"transitionId":"test-update-key"' \
      || fail "expected successful apply record to carry the exact transition identity"
  )
}

test_source_does_not_execute_main
test_install_prepared_backup_archive_prunes_before_link_and_retains_two
test_install_prepared_backup_archive_dedupes_same_inode_on_retry
test_backup_inode_identity_ignores_failed_bsd_stat_output
test_preflight_blocks_when_managed_volume_space_is_insufficient
test_preflight_does_not_measure_preserved_paths_or_tmpdir
test_preflight_passes_with_sufficient_space_and_reports_ok
test_preflight_checks_only_the_managed_destination_volume
test_preflight_excludes_absent_backup_from_requirement
test_preflight_fails_open_when_du_is_unavailable
test_preflight_fails_open_when_df_is_unavailable
test_preflight_counts_missing_preserved_paths_as_zero
test_cleanup_stale_reconcile_strands_removes_only_old_top_level_directories
test_docker_daemon_unreachable_classifier_is_narrow
test_container_guard_allows_proven_daemon_down_before_reconcile
test_container_guard_unknown_docker_failure_aborts_before_reconcile
test_container_guard_stops_running_open_webui_before_reconcile
test_container_guard_failure_aborts_apply_before_backup_or_reconcile_and_records_result
test_container_guard_allows_host_mode_when_docker_is_absent
test_success_result_marker_caps_update_ledger_at_500_lines

echo "PASS: apply-prepared-update shell tests"
