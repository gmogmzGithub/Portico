#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/host-mcp-binary-policy.sh"

MANIFEST_PATH="$PROJECT_ROOT/src/mcp-orc-rust/Cargo.toml"
ARTIFACTS_ROOT="${HOST_MCP_ARTIFACTS_ROOT:-$PROJECT_ROOT/host-mcp-binaries}"
BUILD_SCOPE="${BUILD_SCOPE:-host-only}"
HOST_MCP_RUST_TOOLCHAIN="${HOST_MCP_RUST_TOOLCHAIN:-1.88.0}"
HOST_MCP_RUST_DOCKER_IMAGE="${HOST_MCP_RUST_DOCKER_IMAGE:-rust:1.88-slim}"
HOST_MCP_LINUX_SOURCE_IMAGE="${HOST_MCP_LINUX_SOURCE_IMAGE:-}"
HOST_MCP_EXPECTED_SOURCE_REVISION="${HOST_MCP_EXPECTED_SOURCE_REVISION:-}"
HOST_MCP_EXPECTED_IMAGE_REVISION="${HOST_MCP_EXPECTED_IMAGE_REVISION:-$HOST_MCP_EXPECTED_SOURCE_REVISION}"
HOST_MCP_DOCKER_TIMEOUT_SECONDS="${HOST_MCP_DOCKER_TIMEOUT_SECONDS:-600}"
HOST_MCP_DOCKER_MAX_ATTEMPTS="${HOST_MCP_DOCKER_MAX_ATTEMPTS:-2}"
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS="${HOST_MCP_DOCKER_RETRY_DELAY_SECONDS:-10}"
HOST_MCP_MIN_FREE_GB="${HOST_MCP_MIN_FREE_GB:-10}"
LOCKED_MANIFEST_STATE_VERIFIED=false

if [[ -n "${CARGO_TARGET_DIR+x}" && -z "${CARGO_TARGET_DIR}" ]]; then
  unset CARGO_TARGET_DIR
fi

ensure_rust_tooling_path() {
  local path_prefixes=(
    "$HOME/.cargo/bin"
    "/opt/homebrew/bin"
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  )
  local prefix

  for prefix in "${path_prefixes[@]}"; do
    case ":$PATH:" in
      *":$prefix:"*) ;;
      *)
        if [ -d "$prefix" ]; then
          PATH="$prefix:$PATH"
        fi
        ;;
    esac
  done

  export PATH
}

print_usage() {
  cat <<'EOF'
Usage: build-host-mcp-binaries.sh [--host-only|--darwin-only|--all-supported|--list-targets]

Options:
  --host-only       Build only the current host platform binary (default)
  --darwin-only     Build both Darwin binaries (must run on macOS)
  --all-supported   Build all supported host binaries for the current build OS
  --list-targets    Print the supported target matrix and exit
EOF
}

current_host_target() {
  host_mcp_current_target_triple
}

manifest_dir() {
  printf '%s\n' "$PROJECT_ROOT/src/mcp-orc-rust"
}

resolve_native_target_dir() {
  local cargo_manifest_dir="$1"

  if [[ -z "${CARGO_TARGET_DIR:-}" ]]; then
    printf '%s\n' "$cargo_manifest_dir/target"
    return 0
  fi

  case "$CARGO_TARGET_DIR" in
    /*)
      printf '%s\n' "$CARGO_TARGET_DIR"
      ;;
    *)
      printf '%s\n' "$cargo_manifest_dir/$CARGO_TARGET_DIR"
      ;;
  esac
}

ensure_locked_manifest_state() {
  local cargo_runner=()
  local metadata_log=""
  local cargo_manifest_dir=""

  ensure_rust_tooling_path
  cargo_manifest_dir="$(manifest_dir)"

  if command -v rustup >/dev/null 2>&1; then
    rustup toolchain install "$HOST_MCP_RUST_TOOLCHAIN" --profile minimal >/dev/null
    cargo_runner=(rustup run "$HOST_MCP_RUST_TOOLCHAIN" cargo)
  elif command -v cargo >/dev/null 2>&1; then
    cargo_runner=(cargo)
  else
    return 0
  fi

  metadata_log="$(mktemp "${TMPDIR:-/tmp}/host-mcp-lock.XXXXXX")"
  if ! (
    cd "$cargo_manifest_dir"
    "${cargo_runner[@]}" metadata \
      --locked \
      --manifest-path "$MANIFEST_PATH" \
      --format-version 1 \
      >/dev/null 2>"$metadata_log"
  ); then
    echo "Host MCP Rust lockfile is out of date. Run: cargo generate-lockfile --manifest-path \"$MANIFEST_PATH\" and commit src/mcp-orc-rust/Cargo.lock before building host MCP binaries." >&2
    cat "$metadata_log" >&2
    rm -f "$metadata_log"
    return 1
  fi

  rm -f "$metadata_log"
}

ensure_locked_manifest_state_once() {
  if [ "$LOCKED_MANIFEST_STATE_VERIFIED" = true ]; then
    return 0
  fi

  ensure_locked_manifest_state
  LOCKED_MANIFEST_STATE_VERIFIED=true
}

supported_target_rows() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      cat <<'EOF'
aarch64-apple-darwin|native|
x86_64-apple-darwin|native|
x86_64-unknown-linux-gnu|docker|linux/amd64
aarch64-unknown-linux-gnu|docker|linux/arm64
EOF
      ;;
    Linux)
      case "$(uname -m 2>/dev/null || echo unknown)" in
        x86_64|amd64)
          cat <<'EOF'
x86_64-unknown-linux-gnu|native|
aarch64-unknown-linux-gnu|docker|linux/arm64
EOF
          ;;
        aarch64|arm64)
          cat <<'EOF'
x86_64-unknown-linux-gnu|docker|linux/amd64
aarch64-unknown-linux-gnu|native|
EOF
          ;;
        *)
          return 1
          ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
}

list_targets() {
  supported_target_rows | while IFS='|' read -r target method platform; do
    if [ "$method" = "docker" ]; then
      printf '%s\t%s\t%s\n' "$target" "$method" "$platform"
    else
      printf '%s\t%s\n' "$target" "$method"
    fi
  done
}

validate_positive_integer() {
  local name="$1"
  local value="$2"

  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ]; then
    echo "$name must be a positive integer (got: ${value:-empty})" >&2
    return 1
  fi
}

validate_nonnegative_integer() {
  local name="$1"
  local value="$2"

  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "$name must be a non-negative integer (got: ${value:-empty})" >&2
    return 1
  fi
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after=5s "${timeout_seconds}s" "$@"
    return
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=5s "${timeout_seconds}s" "$@"
    return
  fi
  if command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" "$@"
    return
  fi

  echo "A timeout-capable command (gtimeout, timeout, or perl) is required for Docker host MCP operations" >&2
  return 127
}

target_revision_marker() {
  local target="$1"
  printf '%s/.source-revision\n' "$(dirname "$(host_mcp_artifact_binary_path "$ARTIFACTS_ROOT" "$target")")"
}

target_is_current() {
  local target="$1"
  local output_path="$2"
  local marker=""

  if [ -n "$HOST_MCP_EXPECTED_SOURCE_REVISION" ]; then
    marker="$(target_revision_marker "$target")"
    [ -x "$output_path" ] && [ -f "$marker" ] \
      && [ "$(cat "$marker")" = "$HOST_MCP_EXPECTED_SOURCE_REVISION" ]
    return
  fi

  host_mcp_binary_is_current "$PROJECT_ROOT" "$output_path"
}

record_target_revision() {
  local target="$1"
  local marker=""
  local marker_tmp=""

  marker="$(target_revision_marker "$target")"
  if [ -z "$HOST_MCP_EXPECTED_SOURCE_REVISION" ]; then
    rm -f "$marker"
    return 0
  fi

  marker_tmp="${marker}.tmp.$$"
  printf '%s\n' "$HOST_MCP_EXPECTED_SOURCE_REVISION" > "$marker_tmp"
  mv "$marker_tmp" "$marker"
}

host_mcp_disk_is_healthy() {
  local available_kib=""
  local required_kib=$((HOST_MCP_MIN_FREE_GB * 1024 * 1024))
  local disk_path="$ARTIFACTS_ROOT"

  if [ ! -e "$disk_path" ]; then
    disk_path="$(dirname "$disk_path")"
  fi
  available_kib="$(df -Pk "$disk_path" 2>/dev/null | awk 'NR == 2 { print $4; exit }')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] && [ "$available_kib" -ge "$required_kib" ]
}

report_timed_docker_failure() {
  local operation="$1"
  local status="$2"

  case "$status" in
    124|137|142)
      echo "${operation} timed out after ${HOST_MCP_DOCKER_TIMEOUT_SECONDS}s" >&2
      ;;
    *)
      echo "${operation} failed (exit ${status})" >&2
      ;;
  esac
}

verify_linux_binary_architecture() {
  local target="$1"
  local binary_path="$2"
  local description=""

  command -v file >/dev/null 2>&1 || return 0
  description="$(file -b "$binary_path" 2>/dev/null || true)"
  case "$target" in
    x86_64-unknown-linux-gnu)
      [[ "$description" == *ELF* && "$description" == *x86-64* ]]
      ;;
    aarch64-unknown-linux-gnu)
      [[ "$description" == *ELF* && "$description" == *ARM\ aarch64* ]]
      ;;
    *)
      return 1
      ;;
  esac
}

remove_extraction_container() {
  local container_ref="$1"

  [ -n "$container_ref" ] || return 0
  run_with_timeout "$HOST_MCP_DOCKER_TIMEOUT_SECONDS" \
    docker rm -f "$container_ref" >/dev/null 2>&1
}

extract_linux_target_from_image_once() {
  local target="$1"
  local platform="$2"
  local output_path="$3"
  local attempt="$4"
  local container_name=""
  local container_id=""
  local image_revision=""
  local temp_output="${output_path}.tmp.$$"
  local status=0
  local command_status=0

  container_name="portico-host-mcp-extract-${target//_/-}-$$-${attempt}"
  rm -f "$temp_output"
  mkdir -p "$(dirname "$output_path")"

  echo "Pulling host MCP runtime image for ${target}: ${HOST_MCP_LINUX_SOURCE_IMAGE} (${platform})"
  if run_with_timeout "$HOST_MCP_DOCKER_TIMEOUT_SECONDS" \
    docker pull --platform "$platform" "$HOST_MCP_LINUX_SOURCE_IMAGE"; then
    :
  else
    command_status=$?
    report_timed_docker_failure "Docker pull for ${target}" "$command_status"
    return 1
  fi

  remove_extraction_container "$container_name" || true
  if ! container_id="$(run_with_timeout "$HOST_MCP_DOCKER_TIMEOUT_SECONDS" \
    docker create \
      --name "$container_name" \
      --platform "$platform" \
      "$HOST_MCP_LINUX_SOURCE_IMAGE" \
      true)"; then
    remove_extraction_container "$container_name" || true
    return 1
  fi

  if [ -n "$HOST_MCP_EXPECTED_IMAGE_REVISION" ]; then
    if ! image_revision="$(run_with_timeout "$HOST_MCP_DOCKER_TIMEOUT_SECONDS" \
      docker inspect \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
        "$container_id")"; then
      status=1
    elif [ "$image_revision" != "$HOST_MCP_EXPECTED_IMAGE_REVISION" ]; then
      echo "Host MCP source image revision mismatch for ${target}: expected ${HOST_MCP_EXPECTED_IMAGE_REVISION}, found ${image_revision:-missing}" >&2
      status=1
    fi
  fi

  if [ "$status" -eq 0 ] && ! run_with_timeout "$HOST_MCP_DOCKER_TIMEOUT_SECONDS" \
    docker cp "${container_id}:/usr/local/bin/mcp-orc" "$temp_output"; then
    echo "Exact-tag runtime image is missing /usr/local/bin/mcp-orc for ${target}" >&2
    status=1
  fi

  if [ "$status" -eq 0 ]; then
    chmod 0755 "$temp_output"
    if ! verify_linux_binary_architecture "$target" "$temp_output"; then
      echo "Extracted host MCP binary has the wrong architecture for ${target}: $(file -b "$temp_output" 2>/dev/null || echo unknown)" >&2
      status=1
    fi
  fi

  if ! remove_extraction_container "$container_id"; then
    echo "Failed to remove release-owned extraction container ${container_id}; refusing to continue" >&2
    status=1
  fi

  if [ "$status" -ne 0 ]; then
    rm -f "$temp_output"
    return 1
  fi

  mv "$temp_output" "$output_path"
  return 0
}

extract_linux_target_from_image() {
  local target="$1"
  local platform="$2"
  local output_path="$3"
  local attempt=1

  if ! host_mcp_disk_is_healthy; then
    echo "Host MCP extraction blocked by insufficient local disk space (minimum ${HOST_MCP_MIN_FREE_GB} GiB)" >&2
    return 1
  fi
  if ! run_with_timeout "$HOST_MCP_DOCKER_TIMEOUT_SECONDS" docker info >/dev/null 2>&1; then
    echo "Host MCP extraction blocked because Docker/OrbStack is unavailable" >&2
    return 1
  fi

  while [ "$attempt" -le "$HOST_MCP_DOCKER_MAX_ATTEMPTS" ]; do
    echo "Extracting ${target} from the exact release image (attempt ${attempt}/${HOST_MCP_DOCKER_MAX_ATTEMPTS})"
    if extract_linux_target_from_image_once "$target" "$platform" "$output_path" "$attempt"; then
      return 0
    fi

    if [ "$attempt" -ge "$HOST_MCP_DOCKER_MAX_ATTEMPTS" ]; then
      break
    fi
    if ! host_mcp_disk_is_healthy; then
      echo "Host MCP extraction retry blocked by insufficient local disk space (minimum ${HOST_MCP_MIN_FREE_GB} GiB)" >&2
      return 1
    fi
    if ! run_with_timeout "$HOST_MCP_DOCKER_TIMEOUT_SECONDS" docker info >/dev/null 2>&1; then
      echo "Host MCP extraction retry blocked because Docker/OrbStack is unavailable" >&2
      return 1
    fi

    echo "Host MCP extraction failed; retrying in ${HOST_MCP_DOCKER_RETRY_DELAY_SECONDS}s..." >&2
    sleep "$HOST_MCP_DOCKER_RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done

  return 1
}

build_native_target() {
  local target="$1"
  local output_path="$2"
  local host_target
  local cargo_manifest_dir
  local target_dir
  local artifact_path
  host_target="$(current_host_target)"
  cargo_manifest_dir="$(manifest_dir)"
  target_dir="$(resolve_native_target_dir "$cargo_manifest_dir")"
  ensure_rust_tooling_path

  if command -v rustup >/dev/null 2>&1; then
    rustup toolchain install "$HOST_MCP_RUST_TOOLCHAIN" --profile minimal >/dev/null
    if [ "$target" = "$host_target" ]; then
      (
        cd "$cargo_manifest_dir"
        rustup run "$HOST_MCP_RUST_TOOLCHAIN" cargo build \
          --release \
          --manifest-path "$MANIFEST_PATH" \
          --bin mcp-orc \
          --locked \
          >/dev/null
      )
      artifact_path="$target_dir/release/mcp-orc"
      mkdir -p "$(dirname "$output_path")"
      install -m 0755 "$artifact_path" "$output_path"
      return 0
    fi

    rustup target add --toolchain "$HOST_MCP_RUST_TOOLCHAIN" "$target" >/dev/null
    (
      cd "$cargo_manifest_dir"
      rustup run "$HOST_MCP_RUST_TOOLCHAIN" cargo build \
        --release \
        --manifest-path "$MANIFEST_PATH" \
        --bin mcp-orc \
        --target "$target" \
        --locked \
        >/dev/null
    )

    artifact_path="$target_dir/$target/release/mcp-orc"
    mkdir -p "$(dirname "$output_path")"
    install -m 0755 "$artifact_path" "$output_path"
    return 0
  fi

  if command -v cargo >/dev/null 2>&1 && [ "$target" = "$host_target" ]; then
    (
      cd "$cargo_manifest_dir"
      cargo build \
        --release \
        --manifest-path "$MANIFEST_PATH" \
        --bin mcp-orc \
        --locked \
        >/dev/null
    )
    artifact_path="$target_dir/release/mcp-orc"
    mkdir -p "$(dirname "$output_path")"
    install -m 0755 "$artifact_path" "$output_path"
    return 0
  fi

  if [ "$target" = "$host_target" ]; then
    echo "rustup or cargo is required to build the current host MCP binary ($target)" >&2
  else
    echo "rustup is required to cross-build host MCP binary target $target" >&2
  fi
  return 1
}

build_linux_target_via_docker() {
  local target="$1"
  local platform="$2"
  local output_path="$3"

  mkdir -p "$(dirname "$output_path")"

  docker run --rm \
    --platform "$platform" \
    -u "$(id -u):$(id -g)" \
    -e HOST_MCP_TARGET="$target" \
    -e HOST_MCP_OUTPUT="/workspace/host-mcp-binaries/$target/mcp-orc" \
    -v "$PROJECT_ROOT:/workspace" \
    "$HOST_MCP_RUST_DOCKER_IMAGE" \
    bash -c '
      set -euo pipefail
      export PATH="/usr/local/cargo/bin:/root/.cargo/bin:$PATH"
      cd /workspace/src/mcp-orc-rust
      export CARGO_TARGET_DIR=/tmp/mcp-orc-target
      cargo build --release --bin mcp-orc --locked >/dev/null
      mkdir -p "$(dirname "$HOST_MCP_OUTPUT")"
      install -m 0755 /tmp/mcp-orc-target/release/mcp-orc "$HOST_MCP_OUTPUT"
    ' >/dev/null
}

build_target_row() {
  local target="$1"
  local method="$2"
  local platform="$3"
  local output_path
  output_path="$(host_mcp_artifact_binary_path "$ARTIFACTS_ROOT" "$target")"

  if target_is_current "$target" "$output_path"; then
    echo "up-to-date $target"
    return 0
  fi

  echo "building $target ($method)"

  case "$method" in
    native)
      ensure_locked_manifest_state_once
      build_native_target "$target" "$output_path"
      ;;
    docker)
      if [ -n "$HOST_MCP_LINUX_SOURCE_IMAGE" ]; then
        extract_linux_target_from_image "$target" "$platform" "$output_path"
      else
        ensure_locked_manifest_state_once
        build_linux_target_via_docker "$target" "$platform" "$output_path"
      fi
      ;;
    *)
      echo "Unsupported build method for $target: $method" >&2
      return 1
      ;;
  esac

  record_target_revision "$target"
  echo "built $target"
}

select_target_rows() {
  case "$BUILD_SCOPE" in
    host-only)
      local host_target
      host_target="$(current_host_target)"
      supported_target_rows | while IFS='|' read -r target method platform; do
        if [ "$target" = "$host_target" ]; then
          printf '%s|%s|%s\n' "$target" "$method" "$platform"
        fi
      done
      ;;
    darwin-only)
      if [ "$(uname -s 2>/dev/null || echo unknown)" != "Darwin" ]; then
        echo "--darwin-only requires a Darwin build host" >&2
        return 1
      fi
      supported_target_rows | while IFS='|' read -r target method platform; do
        case "$target" in
          *-apple-darwin)
            printf '%s|%s|%s\n' "$target" "$method" "$platform"
            ;;
        esac
      done
      ;;
    all-supported)
      supported_target_rows
      ;;
    *)
      echo "Unsupported build scope: $BUILD_SCOPE" >&2
      return 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-only)
      BUILD_SCOPE="host-only"
      shift
      ;;
    --darwin-only)
      BUILD_SCOPE="darwin-only"
      shift
      ;;
    --all-supported)
      BUILD_SCOPE="all-supported"
      shift
      ;;
    --list-targets)
      list_targets
      exit 0
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

validate_positive_integer "HOST_MCP_DOCKER_TIMEOUT_SECONDS" "$HOST_MCP_DOCKER_TIMEOUT_SECONDS"
validate_positive_integer "HOST_MCP_DOCKER_MAX_ATTEMPTS" "$HOST_MCP_DOCKER_MAX_ATTEMPTS"
validate_nonnegative_integer "HOST_MCP_DOCKER_RETRY_DELAY_SECONDS" "$HOST_MCP_DOCKER_RETRY_DELAY_SECONDS"
validate_positive_integer "HOST_MCP_MIN_FREE_GB" "$HOST_MCP_MIN_FREE_GB"

mkdir -p "$ARTIFACTS_ROOT"
select_target_rows | while IFS='|' read -r target method platform; do
  [ -n "$target" ] || continue
  build_target_row "$target" "$method" "$platform"
done
