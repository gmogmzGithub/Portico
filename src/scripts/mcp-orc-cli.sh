#!/bin/bash

if [[ "${BASH_SOURCE[0]}" == */* ]]; then
  SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
else
  SCRIPT_DIR="$(pwd)"
fi
source "$SCRIPT_DIR/host-mcp-binary-policy.sh"

mcp_orc_cli_binary_is_current() {
  local project_root="$1"
  local binary_path="$2"

  host_mcp_binary_is_current "$project_root" "$binary_path"
}

bootstrap_mcp_orc_generator_binary() {
  local project_root="$1"
  local resources_root="${2:-${HOST_MCP_RESOURCES_ROOT:-}}"
  local build_script="$project_root/src/scripts/build-host-mcp-binaries.sh"

  if host_mcp_is_packaged_mac_resources_root "$resources_root"; then
    return 1
  fi

  if [ ! -x "$build_script" ]; then
    return 1
  fi

  echo "Bootstrapping current-host mcp-orc binary via $build_script --host-only" >&2
  bash "$build_script" --host-only >&2
}

resolve_mcp_orc_generator_binary() {
  local project_root="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
  local resources_root="${2:-${HOST_MCP_RESOURCES_ROOT:-}}"
  local target_triple
  target_triple="$(host_mcp_current_target_triple)"

  local candidate
  if host_mcp_is_packaged_mac_resources_root "$resources_root"; then
    candidate="$(host_mcp_artifact_binary_path "$resources_root/host-mcp-binaries" "$target_triple" 2>/dev/null || true)"
    if [ -n "$candidate" ] && mcp_orc_cli_binary_is_current "$project_root" "$candidate" && host_mcp_binary_is_host_compatible "$candidate"; then
      echo "$candidate"
      return 0
    fi

    echo "Error: packaged macOS app must run bundled signed mcp-orc from $resources_root/host-mcp-binaries/$target_triple/mcp-orc" >&2
    return 1
  fi

  for candidate in \
    "$project_root/src/mcp-orc-rust/target/debug/mcp-orc" \
    "$project_root/src/mcp-orc-rust/target/release/mcp-orc"; do
    if mcp_orc_cli_binary_is_current "$project_root" "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  candidate="$(host_mcp_artifact_binary_path "$project_root/host-mcp-binaries" "$target_triple" 2>/dev/null || true)"
  if [ -n "$candidate" ] && mcp_orc_cli_binary_is_current "$project_root" "$candidate" && host_mcp_binary_is_host_compatible "$candidate"; then
    echo "$candidate"
    return 0
  fi

  if [ -n "$resources_root" ]; then
    candidate="$(host_mcp_artifact_binary_path "$resources_root/host-mcp-binaries" "$target_triple" 2>/dev/null || true)"
    if [ -n "$candidate" ] && mcp_orc_cli_binary_is_current "$project_root" "$candidate" && host_mcp_binary_is_host_compatible "$candidate"; then
      echo "$candidate"
      return 0
    fi
  fi

  candidate="$(host_mcp_cached_binary_path)"
  if mcp_orc_cli_binary_is_current "$project_root" "$candidate" && host_mcp_binary_is_host_compatible "$candidate"; then
    echo "$candidate"
    return 0
  fi

  candidate="$(host_mcp_legacy_cached_binary_path)"
  if [ "$candidate" != "$(host_mcp_cached_binary_path)" ] && mcp_orc_cli_binary_is_current "$project_root" "$candidate" && host_mcp_binary_is_host_compatible "$candidate"; then
    echo "$candidate"
    return 0
  fi

  if command -v mcp-orc >/dev/null 2>&1; then
    candidate="$(command -v mcp-orc)"
    if mcp_orc_cli_binary_is_current "$project_root" "$candidate" && host_mcp_binary_is_host_compatible "$candidate"; then
      echo "$candidate"
      return 0
    fi
  fi

  return 1
}

run_mcp_orc_generator() {
  local project_root="$1"
  shift
  local subcommand="$1"
  shift

  local binary
  if ! binary="$(resolve_mcp_orc_generator_binary "$project_root")"; then
    if ! bootstrap_mcp_orc_generator_binary "$project_root"; then
      echo "Error: unable to resolve an up-to-date mcp-orc binary for generator subcommand '$subcommand'" >&2
      echo "Run: bash \"$project_root/src/scripts/build-host-mcp-binaries.sh\" --host-only" >&2
      return 127
    fi

    if ! binary="$(resolve_mcp_orc_generator_binary "$project_root")"; then
      echo "Error: bootstrapped current-host mcp-orc binary but still could not resolve generator subcommand '$subcommand'" >&2
      return 127
    fi
  fi

  "$binary" "$subcommand" "$@" --project-root "$project_root"
}

project_has_managed_node_package_recipes() {
  local project_root="$1"
  local config_dir fragment

  for config_dir in "$project_root/mcp-configs" "$project_root/mcp-configs-user"; do
    [ -d "$config_dir" ] || continue
    while IFS= read -r fragment; do
      if grep -Eq '"command"[[:space:]]*:[[:space:]]*"(npx|npm|pnpm|yarn|bunx|__portico_managed_node_package__)"|"managed_node_package"[[:space:]]*:' "$fragment"; then
        return 0
      fi
    done < <(find "$config_dir" -type f -name '*.fragment' 2>/dev/null | sort)
  done

  return 1
}

resolve_mcp_orc_docker_preparer_image() {
  local project_root="$1"
  local build_info_file="$project_root/electron-app/build-info.json"
  local image_tag=""
  local harbor_image=""

  if [ -n "${portico_MANAGED_NODE_PREPARER_IMAGE:-}" ]; then
    printf '%s\n' "$portico_MANAGED_NODE_PREPARER_IMAGE"
    return 0
  fi

  # PORTICO-371: the preparer image must use the tag the images were pushed under.
  # Beta builds tag == build number, but MR/broker builds tag mr-<iid>-<sha>
  # (recorded as dockerImageTag). Prefer dockerImageTag; fall back to buildNumber.
  if [ -f "$build_info_file" ]; then
    image_tag="$(grep -o '"dockerImageTag"[[:space:]]*:[[:space:]]*"[^"]*"' "$build_info_file" 2>/dev/null | sed 's/.*"\([^"]*\)".*/\1/' | head -n 1 || true)"
    if [ -z "$image_tag" ] || [ "$image_tag" = "dev-build" ]; then
      image_tag="$(grep -o '"buildNumber"[[:space:]]*:[[:space:]]*"[^"]*"' "$build_info_file" 2>/dev/null | sed 's/.*"\([^"]*\)".*/\1/' | head -n 1 || true)"
    fi
  fi
  if [ -n "$image_tag" ] && [ "$image_tag" != "dev-build" ] && declare -F mcp_orc_harbor_image_name >/dev/null 2>&1; then
    harbor_image="$(mcp_orc_harbor_image_name full "$image_tag" rust)"
    if [ -n "$harbor_image" ]; then
      printf '%s\n' "$harbor_image"
      return 0
    fi
  fi

  if declare -F mcp_orc_local_image_name >/dev/null 2>&1; then
    mcp_orc_local_image_name full rust
    return 0
  fi

  printf '%s\n' "portico-mcp-orc-rust:latest"
}

ensure_mcp_orc_docker_preparer_image() {
  local project_root="$1"
  local image="$2"

  if docker image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi

  case "$image" in
    harbor.example.invalid/*)
      docker pull "$image"
      ;;
    *)
      docker build -f "$project_root/Dockerfile.mcp-orc-rust" -t "$image" "$project_root"
      ;;
  esac
}

write_managed_node_preparer_npmrc() {
  local project_root="$1"
  local destination="$2"
  local source=""
  local primary_source=""
  local wrote_any=false
  local sources=()

  mkdir -p "$(dirname "$destination")"
  : >"$destination"
  chmod 600 "$destination" 2>/dev/null || true

  if [ -n "${portico_MANAGED_NODE_NPMRC:-}" ]; then
    sources=("$portico_MANAGED_NODE_NPMRC")
  else
    if [ -f "$project_root/.npmrc" ]; then
      primary_source="$project_root/.npmrc"
    elif [ -f "$project_root/electron-app/.npmrc" ]; then
      primary_source="$project_root/electron-app/.npmrc"
    fi
    if [ -n "$primary_source" ]; then
      sources=("$primary_source")
    else
      for source in "${NPM_CONFIG_GLOBALCONFIG:-}" "${npm_config_globalconfig:-}"; do
        [ -n "$source" ] || continue
        if [ "${sources[0]:-}" != "$source" ]; then
          sources+=("$source")
        fi
      done
    fi
  fi

  if [ "${#sources[@]}" -gt 0 ]; then
    for source in "${sources[@]}"; do
      [ -f "$source" ] || continue
      if [ "$wrote_any" = true ]; then
        printf '\n' >>"$destination"
      fi
      cat "$source" >>"$destination"
      if [ -s "$destination" ] && [ "$(tail -c 1 "$destination" 2>/dev/null || true)" != "" ]; then
        printf '\n' >>"$destination"
      fi
      wrote_any=true
    done
  fi

  if ! grep -Eq '^[[:space:]]*replace-registry-host[[:space:]]*=' "$destination" 2>/dev/null; then
    printf '%s\n' 'replace-registry-host=always' >>"$destination"
  fi
}

validate_managed_node_preparer_npmrc() {
  local npmrc_path="$1"
  local validation_status=0

  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    /^[[:space:]]*#/ { next }
    {
      separator = index($0, "=")
      if (separator == 0) next
      key = trim(substr($0, 1, separator - 1))
      if (key != "registry" && key !~ /^@[^:[:space:]]+:registry$/) next
      saw_registry = 1
      value = trim(substr($0, separator + 1))
      if (value !~ /^https:\/\/[^\/@[:space:]]+([\/:]|$)/ || value ~ /^https:\/\/[^\/]*@/) {
        invalid_registry = 1
      }
    }
    END {
      if (!saw_registry) exit 2
      if (invalid_registry) exit 3
    }
  ' "$npmrc_path" 2>/dev/null || validation_status=$?

  if [ "$validation_status" -eq 0 ]; then
    return 0
  fi

  if [ "$validation_status" -eq 2 ]; then
    printf '%s\n' \
      "package_prepare_failed: managed Node package preparation requires an npm registry; no registry was found in the packaged npm configuration" \
      >&2
  else
    printf '%s\n' \
      "package_prepare_failed: managed Node package preparation requires a valid HTTPS npm registry without embedded credentials" \
      >&2
  fi
  return 1
}

run_mcp_orc_docker_managed_node_preparer() {
  local project_root="$1"
  shift
  local image
  local store_dir="$project_root/open-webui-data/managed-node-mcp-packages"
  local acquisition_dir="$project_root/open-webui-data/managed-node-mcp-package-acquisition"
  local acquisition_work_dir="$acquisition_dir/work"
  local preparer_dir="$acquisition_dir/.docker-preparer"
  local health_status_dir="$project_root/health-status"
  local npmrc_path="$preparer_dir/managed-node-install.npmrc"
  local srt_wrapper="$preparer_dir/srt-direct"
  local docker_user_args=()
  local status=0

  if ! project_has_managed_node_package_recipes "$project_root"; then
    printf '%s\n' "No managed Node MCP package recipes found; skipping Docker package preparation" >&2
    return 0
  fi

  image="$(resolve_mcp_orc_docker_preparer_image "$project_root")"

  mkdir -p \
    "$project_root/mcp-configs" \
    "$project_root/mcp-configs-user" \
    "$store_dir" \
    "$acquisition_dir" \
    "$acquisition_work_dir" \
    "$preparer_dir" \
    "$health_status_dir"
  if [ ! -f "$project_root/mcp_toggles.json" ]; then
    # PORTICO-364: atomic create (tmp + mv) so an interrupted write can never leave
    # a 0-byte mcp_toggles.json that dead-ends every MCP toggle mutation.
    _mcp_toggles_tmp="$project_root/mcp_toggles.json.$$.$RANDOM.tmp"
    printf '{}\n' >"$_mcp_toggles_tmp"
    mv -f "$_mcp_toggles_tmp" "$project_root/mcp_toggles.json"
  fi

  write_managed_node_preparer_npmrc "$project_root" "$npmrc_path" || {
    status=$?
    rm -rf "$preparer_dir"
    return "$status"
  }
  if ! validate_managed_node_preparer_npmrc "$npmrc_path"; then
    rm -rf "$preparer_dir"
    return 1
  fi
  ensure_mcp_orc_docker_preparer_image "$project_root" "$image" || {
    status=$?
    rm -rf "$preparer_dir"
    return "$status"
  }

  cat >"$srt_wrapper" <<'SH'
#!/bin/sh
if [ "${1:-}" = "--settings" ]; then
  shift 2
fi
exec "$@"
SH
  chmod 700 "$srt_wrapper" 2>/dev/null || true

  if command -v id >/dev/null 2>&1; then
    docker_user_args=(--user "$(id -u):$(id -g)")
  fi

  if docker run --rm \
    "${docker_user_args[@]}" \
    -v "$project_root/mcp-configs:/work/mcp-configs:ro" \
    -v "$project_root/mcp-configs-user:/work/mcp-configs-user:rw" \
    -v "$project_root/mcp_toggles.json:/work/mcp_toggles.json:ro" \
    -v "$store_dir:/work/open-webui-data/managed-node-mcp-packages:rw" \
    -v "$acquisition_work_dir:/work/open-webui-data/managed-node-mcp-package-acquisition:rw" \
    -v "$health_status_dir:/work/health-status:rw" \
    -v "$npmrc_path:/run/managed-node-preparer/npmrc:ro" \
    -v "$srt_wrapper:/run/managed-node-preparer/srt-direct:ro" \
    -w /work \
    -e portico_MANAGED_NODE_MCP_PACKAGES_DIR=/work/open-webui-data/managed-node-mcp-packages \
    -e portico_MANAGED_NODE_MCP_ACQUISITION_DIR=/work/open-webui-data/managed-node-mcp-package-acquisition \
    -e portico_MANAGED_NODE_NPMRC=/run/managed-node-preparer/npmrc \
    -e portico_MANAGED_NODE_DIRECT_NPM=1 \
    -e HOST_NODE_PATH=/usr/local/bin/node \
    -e portico_MANAGED_NODE_NPM_BIN=/usr/local/bin/npm \
    -e portico_MANAGED_NODE_SRT_CLI=/run/managed-node-preparer/srt-direct \
    -e portico_MANAGED_NODE_ENABLE_FROM_OAUTH_TOKENS=0 \
    "$image" \
    mcp-orc prepare-managed-node-packages "$@" --project-root /work; then
    status=0
  else
    status=$?
  fi

  rm -rf "$preparer_dir"
  find "$acquisition_dir" -path '*/tmp/managed-node-install.npmrc' -type f -delete 2>/dev/null || true
  return "$status"
}

mcp_orc_cli_usage() {
  cat <<'EOF'
Usage: mcp-orc-cli.sh <generate-mcp-config|generate-docker-compose-override|prepare-managed-node-packages> [args...]

Resolves the preferred up-to-date mcp-orc binary, bootstraps the current-host
artifact when needed, and forwards generator invocations with --project-root
set to the repository containing this script.

prepare-managed-node-packages accepts --server-id <id> to scope package
preparation to one MCP server, --enabled-only to prepare only currently
enabled MCP servers, and --deployment-type docker|host to prepare one
deployment target.
EOF
}

mcp_orc_cli_main() {
  local project_root="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

  if [ "$#" -lt 1 ]; then
    mcp_orc_cli_usage >&2
    return 1
  fi

  run_mcp_orc_generator "$project_root" "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  mcp_orc_cli_main "$@"
fi
