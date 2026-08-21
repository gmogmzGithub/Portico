#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

OUTPUT="$(bash "$SCRIPT_DIR/build-host-mcp-binaries.sh" --list-targets)"

for expected in \
  "aarch64-apple-darwin" \
  "x86_64-apple-darwin" \
  "x86_64-unknown-linux-gnu" \
  "aarch64-unknown-linux-gnu"
do
  if ! printf '%s\n' "$OUTPUT" | grep -q "$expected"; then
    echo "missing expected host MCP target in build matrix: $expected" >&2
    exit 1
  fi
done

if ! rg -q 'build-host-mcp-binaries' "$PROJECT_ROOT/install_v2.sh"; then
  echo "install_v2.sh does not invoke host MCP binary build step" >&2
  exit 1
fi

if ! rg -q 'build_host_mcp_binaries "host-only"' "$PROJECT_ROOT/install_v2.sh"; then
  echo "install_v2.sh does not bootstrap the current-host mcp-orc binary before config generation" >&2
  exit 1
fi

if ! rg -q 'bootstrap_mcp_orc_generator_binary' "$PROJECT_ROOT/src/scripts/mcp-orc-cli.sh" || \
   ! rg -q -- '--host-only' "$PROJECT_ROOT/src/scripts/mcp-orc-cli.sh"; then
  echo "mcp-orc CLI wrapper does not self-bootstrap the current-host binary" >&2
  exit 1
fi

if ! node -e "const p=require('./electron-app/package.json'); const ok=(p.build.extraResources||[]).some((r)=>r.from==='../host-mcp-binaries' && r.to==='host-mcp-binaries'); process.exit(ok?0:1)" \
  >/dev/null 2>&1; then
  echo "electron-app/package.json is not packaging host-mcp-binaries extraResources" >&2
  exit 1
fi

TEST_PROJECT_ROOT="$TEMP_DIR/project"
TEST_BIN_DIR="$TEMP_DIR/bin"
BUILD_LOG="$TEMP_DIR/build.log"
LOCK_ERROR_LOG="$TEMP_DIR/lock-error.log"
TEST_HOME="$TEMP_DIR/home"

mkdir -p \
  "$TEST_PROJECT_ROOT/src/scripts" \
  "$TEST_PROJECT_ROOT/src/mcp-orc-rust/crates/mcp-orc/src" \
  "$TEST_BIN_DIR" \
  "$TEST_HOME"

cp "$SCRIPT_DIR/build-host-mcp-binaries.sh" "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh"
cp "$SCRIPT_DIR/host-mcp-binary-policy.sh" "$TEST_PROJECT_ROOT/src/scripts/host-mcp-binary-policy.sh"

cat > "$TEST_PROJECT_ROOT/src/mcp-orc-rust/Cargo.toml" <<'EOF'
[workspace]
members = ["crates/mcp-orc"]
resolver = "2"
EOF

printf '%s\n' 'fn main() {}' > "$TEST_PROJECT_ROOT/src/mcp-orc-rust/crates/mcp-orc/src/main.rs"

cat > "$TEST_BIN_DIR/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  -m)
    printf '%s\n' "${FAKE_UNAME_M:-arm64}"
    ;;
  *)
    printf '%s\n' "${FAKE_UNAME_S:-Darwin}"
    ;;
esac
EOF

cat > "$TEST_BIN_DIR/rustup" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'rustup %s\n' "$*" >> "$BUILD_LOG"
case "${1:-}" in
  toolchain)
    exit 0
    ;;
  target)
    exit 0
    ;;
  run)
    shift 2
    exec "$@"
    ;;
  *)
    echo "unexpected rustup invocation: $*" >&2
    exit 1
    ;;
esac
EOF

cat > "$TEST_BIN_DIR/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cargo %s\n' "$*" >> "$BUILD_LOG"
if [ "${FAIL_LOCKFILE_CHECK:-false}" = "true" ] && [ "${1:-}" = "metadata" ]; then
  printf '%s\n' 'lock drift from test' >&2
  exit 1
fi

case "${1:-}" in
  metadata)
    exit 0
    ;;
  build)
    target=""
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --target)
          target="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done

    if [ -n "$target" ]; then
      output_path="$TEST_PROJECT_ROOT/src/mcp-orc-rust/target/$target/release/mcp-orc"
    else
      output_path="$TEST_PROJECT_ROOT/src/mcp-orc-rust/target/release/mcp-orc"
    fi

    mkdir -p "$(dirname "$output_path")"
    printf '#!/bin/sh\nexit 0\n' > "$output_path"
    chmod +x "$output_path"
    exit 0
    ;;
  *)
    echo "unexpected cargo invocation: $*" >&2
    exit 1
    ;;
esac
EOF

cat > "$TEST_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >> "$BUILD_LOG"

if [ -n "${HOST_MCP_LINUX_SOURCE_IMAGE:-}" ]; then
  case "${1:-}" in
    pull)
      [ "${FAKE_DOCKER_PULL_FAILURE:-false}" != "true" ]
      exit $?
      ;;
    info)
      [ "${FAKE_DOCKER_INFO_FAILURE:-false}" != "true" ]
      exit $?
      ;;
    create)
      case "$*" in
        *linux/amd64*) printf '%s\n' 'extract-amd64' ;;
        *linux/arm64*) printf '%s\n' 'extract-arm64' ;;
        *) exit 1 ;;
      esac
      exit 0
      ;;
    inspect)
      printf '%s\n' "${FAKE_IMAGE_REVISION:-${EXPECTED_REVISION:-}}"
      exit 0
      ;;
    cp)
      if [ "${FAKE_MISSING_BINARY:-false}" = "true" ]; then
        exit 1
      fi
      if [ -n "${FAKE_CP_FAIL_ONCE_COUNT_FILE:-}" ]; then
        count=0
        if [ -f "$FAKE_CP_FAIL_ONCE_COUNT_FILE" ]; then
          count="$(cat "$FAKE_CP_FAIL_ONCE_COUNT_FILE")"
        fi
        count=$((count + 1))
        printf '%s\n' "$count" > "$FAKE_CP_FAIL_ONCE_COUNT_FILE"
        if [ "$count" -eq 1 ]; then
          exit 1
        fi
      fi
      destination="${3:-}"
      mkdir -p "$(dirname "$destination")"
      printf '#!/bin/sh\nexit 0\n' > "$destination"
      chmod +x "$destination"
      exit 0
      ;;
    rm)
      exit 0
      ;;
    *)
      echo "unexpected extraction docker invocation: $*" >&2
      exit 1
      ;;
  esac
fi

case "$*" in
  *'cargo build --release --bin mcp-orc --locked'*)
    ;;
  *)
    echo "docker build command is missing --locked" >&2
    exit 1
    ;;
esac

host_output=""
for arg in "$@"; do
  case "$arg" in
    HOST_MCP_OUTPUT=*)
      host_output="${arg#HOST_MCP_OUTPUT=/workspace/}"
      ;;
  esac
done

[ -n "$host_output" ] || {
  echo "docker invocation did not forward HOST_MCP_OUTPUT" >&2
  exit 1
}

output_path="$TEST_PROJECT_ROOT/$host_output"
mkdir -p "$(dirname "$output_path")"
printf '#!/bin/sh\nexit 0\n' > "$output_path"
chmod +x "$output_path"
EOF

cat > "$TEST_BIN_DIR/file" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${2:-}" in
  *x86_64-unknown-linux-gnu*)
    if [ "${FAKE_WRONG_ARCH:-false}" = "true" ]; then
      printf '%s\n' 'ELF 64-bit LSB executable, ARM aarch64'
    else
      printf '%s\n' 'ELF 64-bit LSB executable, x86-64'
    fi
    ;;
  *aarch64-unknown-linux-gnu*)
    printf '%s\n' 'ELF 64-bit LSB executable, ARM aarch64'
    ;;
  *)
    /usr/bin/file "$@"
    ;;
esac
EOF

cat > "$TEST_BIN_DIR/gtimeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gtimeout %s\n' "$*" >> "$BUILD_LOG"
if [ "${1:-}" = "--kill-after=5s" ]; then
  shift
fi
[ "$#" -gt 0 ] || exit 2
shift
if [ "${FAKE_TIMEOUT_DOCKER_CP:-false}" = "true" ] \
  && [ "${1:-}" = "docker" ] \
  && [ "${2:-}" = "cp" ]; then
  exit 124
fi
exec "$@"
EOF

cat > "$TEST_BIN_DIR/df" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${FAKE_LOW_DISK:-false}" = "true" ]; then
  printf '%s\n' \
    'Filesystem 1024-blocks Used Available Capacity Mounted on' \
    '/dev/fake 104857600 104857599 1 100% /'
  exit 0
fi
exec /bin/df "$@"
EOF

chmod +x \
  "$TEST_BIN_DIR/uname" \
  "$TEST_BIN_DIR/rustup" \
  "$TEST_BIN_DIR/cargo" \
  "$TEST_BIN_DIR/docker" \
  "$TEST_BIN_DIR/gtimeout" \
  "$TEST_BIN_DIR/df" \
  "$TEST_BIN_DIR/file"

DARWIN_ONLY_ROOT="$TEST_PROJECT_ROOT/darwin-only-host-mcp"
DARWIN_ONLY_LOG="$TEMP_DIR/darwin-only.log"
: > "$DARWIN_ONLY_LOG"
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$DARWIN_ONLY_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
HOST_MCP_ARTIFACTS_ROOT="$DARWIN_ONLY_ROOT" \
HOST_MCP_RUST_TOOLCHAIN="test-toolchain" \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --darwin-only >/dev/null

for target in aarch64-apple-darwin x86_64-apple-darwin; do
  [ -x "$DARWIN_ONLY_ROOT/$target/mcp-orc" ] || {
    echo "--darwin-only did not build $target" >&2
    exit 1
  }
done
if find "$DARWIN_ONLY_ROOT" -mindepth 1 -maxdepth 1 -type d -name '*-linux-gnu' -print -quit | grep -q .; then
  echo "--darwin-only unexpectedly built a Linux target" >&2
  exit 1
fi
if rg -q '^docker ' "$DARWIN_ONLY_LOG"; then
  echo "--darwin-only unexpectedly invoked Docker" >&2
  exit 1
fi

LINUX_ARM_ROOT="$TEST_PROJECT_ROOT/linux-arm-host-only"
LINUX_ARM_LOG="$TEMP_DIR/linux-arm-host-only.log"
: > "$LINUX_ARM_LOG"
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$LINUX_ARM_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
FAKE_UNAME_S=Linux \
FAKE_UNAME_M=aarch64 \
HOST_MCP_ARTIFACTS_ROOT="$LINUX_ARM_ROOT" \
HOST_MCP_RUST_TOOLCHAIN="test-toolchain" \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --host-only >/dev/null

[ -x "$LINUX_ARM_ROOT/aarch64-unknown-linux-gnu/mcp-orc" ] || {
  echo "native arm64 Linux --host-only did not build the arm64 target" >&2
  exit 1
}
if rg -q '^docker ' "$LINUX_ARM_LOG"; then
  echo "native arm64 Linux --host-only incorrectly used Docker" >&2
  exit 1
fi
rg -q '^cargo build --release ' "$LINUX_ARM_LOG" || {
  echo "native arm64 Linux --host-only did not use Cargo" >&2
  exit 1
}

PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$BUILD_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
HOST_MCP_RUST_TOOLCHAIN="test-toolchain" \
HOST_MCP_RUST_DOCKER_IMAGE="test-image" \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null

if ! rg -q 'cargo metadata --locked' "$BUILD_LOG"; then
  echo "build-host-mcp-binaries.sh does not validate Cargo.lock with --locked before building" >&2
  exit 1
fi

if ! rg -q 'cargo build --release --manifest-path .* --bin mcp-orc --locked' "$BUILD_LOG"; then
  echo "build-host-mcp-binaries.sh does not pass --locked when building the host target" >&2
  exit 1
fi

if ! rg -q 'cargo build --release --manifest-path .* --bin mcp-orc --target x86_64-apple-darwin --locked' "$BUILD_LOG"; then
  echo "build-host-mcp-binaries.sh does not pass --locked when cross-building the secondary Darwin target" >&2
  exit 1
fi

if ! rg -q 'docker .*HOST_MCP_OUTPUT=/workspace/host-mcp-binaries/x86_64-unknown-linux-gnu/mcp-orc' "$BUILD_LOG"; then
  echo "build-host-mcp-binaries.sh did not exercise the docker Linux build path during regression coverage" >&2
  exit 1
fi

EXTRACT_ROOT="$TEST_PROJECT_ROOT/extracted-host-mcp"
EXTRACT_LOG="$TEMP_DIR/extract.log"
EXPECTED_REVISION="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
: > "$EXTRACT_LOG"

PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$EXTRACT_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
HOST_MCP_ARTIFACTS_ROOT="$EXTRACT_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null

for target in \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu
do
  [ -x "$EXTRACT_ROOT/$target/mcp-orc" ] || {
    echo "missing revision-cached host MCP binary: $target" >&2
    exit 1
  }
  [ "$(cat "$EXTRACT_ROOT/$target/.source-revision")" = "$EXPECTED_REVISION" ] || {
    echo "missing source revision marker for host MCP binary: $target" >&2
    exit 1
  }
done

if rg -q 'docker run' "$EXTRACT_LOG"; then
  echo "release-image extraction should not compile Linux host MCP binaries with docker run" >&2
  exit 1
fi
rg -q 'docker pull --platform linux/amd64 harbor.example/mcp-orc-rust:test' "$EXTRACT_LOG" || {
  echo "release-image extraction did not pull the amd64 image" >&2
  exit 1
}
rg -q 'docker pull --platform linux/arm64 harbor.example/mcp-orc-rust:test' "$EXTRACT_LOG" || {
  echo "release-image extraction did not pull the arm64 image" >&2
  exit 1
}

LINUX_ONLY_ROOT="$TEST_PROJECT_ROOT/linux-only-extraction"
LINUX_ONLY_LOG="$TEMP_DIR/linux-only-extraction.log"
: > "$LINUX_ONLY_LOG"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  mkdir -p "$LINUX_ONLY_ROOT/$target"
  cp "$EXTRACT_ROOT/$target/mcp-orc" "$LINUX_ONLY_ROOT/$target/mcp-orc"
  printf '%s\n' "$EXPECTED_REVISION" > "$LINUX_ONLY_ROOT/$target/.source-revision"
done

PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$LINUX_ONLY_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
HOST_MCP_ARTIFACTS_ROOT="$LINUX_ONLY_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null

if rg -q '^(cargo|rustup) ' "$LINUX_ONLY_LOG"; then
  echo "exact-image-only Linux extraction unnecessarily initialized the Rust toolchain" >&2
  exit 1
fi
rg -q '^docker pull --platform linux/amd64 ' "$LINUX_ONLY_LOG" || {
  echo "Linux-only host MCP path did not extract the amd64 image binary" >&2
  exit 1
}
rg -q '^docker pull --platform linux/arm64 ' "$LINUX_ONLY_LOG" || {
  echo "Linux-only host MCP path did not extract the arm64 image binary" >&2
  exit 1
}

docker_calls_before="$(grep -c '^docker ' "$EXTRACT_LOG")"
second_output="$TEMP_DIR/second-extract.out"
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$EXTRACT_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
HOST_MCP_ARTIFACTS_ROOT="$EXTRACT_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported > "$second_output"

[ "$(grep -c '^docker ' "$EXTRACT_LOG")" = "$docker_calls_before" ] || {
  echo "same-revision host MCP cache unexpectedly called Docker again" >&2
  exit 1
}
[ "$(grep -c '^up-to-date ' "$second_output")" = "4" ] || {
  echo "same-revision host MCP cache did not reuse all four targets" >&2
  exit 1
}

NEW_REVISION="feedfacecafefeeddeadbeefcafefeeddeadbeef"
NEW_REVISION_LOG="$TEMP_DIR/new-revision.log"
: > "$NEW_REVISION_LOG"
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$NEW_REVISION_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$NEW_REVISION" \
HOST_MCP_ARTIFACTS_ROOT="$EXTRACT_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$NEW_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null

rg -q '^docker pull --platform linux/amd64 ' "$NEW_REVISION_LOG" || {
  echo "new source revision did not invalidate cached Linux host MCP binaries" >&2
  exit 1
}
for target in \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu
do
  [ "$(cat "$EXTRACT_ROOT/$target/.source-revision")" = "$NEW_REVISION" ] || {
    echo "new source revision was not persisted for host MCP target: $target" >&2
    exit 1
  }
done

PARTIAL_ROOT="$TEST_PROJECT_ROOT/partial-host-mcp"
PARTIAL_OUTPUT="$TEMP_DIR/partial.out"
mkdir -p "$PARTIAL_ROOT/aarch64-apple-darwin"
cp "$EXTRACT_ROOT/aarch64-apple-darwin/mcp-orc" "$PARTIAL_ROOT/aarch64-apple-darwin/mcp-orc"
printf '%s\n' "$NEW_REVISION" > "$PARTIAL_ROOT/aarch64-apple-darwin/.source-revision"

PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$NEW_REVISION_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$NEW_REVISION" \
HOST_MCP_ARTIFACTS_ROOT="$PARTIAL_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$NEW_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported > "$PARTIAL_OUTPUT"

grep -Fxq 'up-to-date aarch64-apple-darwin' "$PARTIAL_OUTPUT" || {
  echo "interrupted partial host MCP build did not retain its completed target" >&2
  exit 1
}
for target in \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu
do
  [ -x "$PARTIAL_ROOT/$target/mcp-orc" ] || {
    echo "partial host MCP build did not complete missing target: $target" >&2
    exit 1
  }
done

BAD_EXTRACT_ROOT="$TEST_PROJECT_ROOT/bad-extracted-host-mcp"
set +e
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$EXTRACT_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
FAKE_IMAGE_REVISION="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
HOST_MCP_ARTIFACTS_ROOT="$BAD_EXTRACT_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null 2>&1
bad_status=$?
set -e

[ "$bad_status" -ne 0 ] || {
  echo "host MCP extraction accepted a mismatched source revision" >&2
  exit 1
}
[ ! -e "$BAD_EXTRACT_ROOT/x86_64-unknown-linux-gnu/mcp-orc" ] || {
  echo "failed host MCP extraction left a mismatched Linux binary behind" >&2
  exit 1
}

RETRY_ROOT="$TEST_PROJECT_ROOT/retry-extracted-host-mcp"
RETRY_LOG="$TEMP_DIR/retry-extract.log"
RETRY_COUNT="$TEMP_DIR/retry-cp-count"
: > "$RETRY_LOG"
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$RETRY_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
FAKE_CP_FAIL_ONCE_COUNT_FILE="$RETRY_COUNT" \
HOST_MCP_ARTIFACTS_ROOT="$RETRY_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null

[ "$(cat "$RETRY_COUNT")" -ge 3 ] || {
  echo "healthy host MCP extraction did not retry the failed Docker copy" >&2
  exit 1
}
[ -x "$RETRY_ROOT/x86_64-unknown-linux-gnu/mcp-orc" ] || {
  echo "healthy host MCP extraction retry did not produce the amd64 binary" >&2
  exit 1
}
[ "$(grep -c '^docker pull --platform linux/amd64 ' "$RETRY_LOG")" = "2" ] || {
  echo "healthy host MCP extraction did not rerun the amd64 image operation once" >&2
  exit 1
}

WRONG_ARCH_ROOT="$TEST_PROJECT_ROOT/wrong-arch-host-mcp"
set +e
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$RETRY_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
FAKE_WRONG_ARCH=true \
HOST_MCP_ARTIFACTS_ROOT="$WRONG_ARCH_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_MAX_ATTEMPTS=1 \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null 2>&1
wrong_arch_status=$?
set -e
[ "$wrong_arch_status" -ne 0 ] || {
  echo "host MCP extraction accepted a wrong-architecture binary" >&2
  exit 1
}
[ ! -e "$WRONG_ARCH_ROOT/x86_64-unknown-linux-gnu/mcp-orc" ] || {
  echo "wrong-architecture extraction left a Linux binary behind" >&2
  exit 1
}

MISSING_ROOT="$TEST_PROJECT_ROOT/missing-binary-host-mcp"
set +e
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$RETRY_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
FAKE_MISSING_BINARY=true \
HOST_MCP_ARTIFACTS_ROOT="$MISSING_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_MAX_ATTEMPTS=1 \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null 2>&1
missing_status=$?
set -e
[ "$missing_status" -ne 0 ] || {
  echo "host MCP extraction accepted an image missing /usr/local/bin/mcp-orc" >&2
  exit 1
}
[ ! -e "$MISSING_ROOT/x86_64-unknown-linux-gnu/mcp-orc" ] || {
  echo "missing-binary extraction left a Linux output behind" >&2
  exit 1
}

TIMEOUT_ROOT="$TEST_PROJECT_ROOT/timeout-host-mcp"
TIMEOUT_LOG="$TEMP_DIR/timeout-extract.log"
: > "$TIMEOUT_LOG"
set +e
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$TIMEOUT_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
FAKE_TIMEOUT_DOCKER_CP=true \
HOST_MCP_ARTIFACTS_ROOT="$TIMEOUT_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_TIMEOUT_SECONDS=1 \
HOST_MCP_DOCKER_MAX_ATTEMPTS=1 \
HOST_MCP_DOCKER_RETRY_DELAY_SECONDS=0 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null 2>&1
timeout_status=$?
set -e
[ "$timeout_status" -ne 0 ] || {
  echo "host MCP extraction accepted a timed-out Docker copy" >&2
  exit 1
}
rg -q '^docker rm -f extract-amd64$' "$TIMEOUT_LOG" || {
  echo "timed-out host MCP extraction did not clean its deterministic container" >&2
  exit 1
}
[ ! -e "$TIMEOUT_ROOT/x86_64-unknown-linux-gnu/mcp-orc" ] || {
  echo "timed-out host MCP extraction left a Linux output behind" >&2
  exit 1
}

UNAVAILABLE_ROOT="$TEST_PROJECT_ROOT/unavailable-docker-host-mcp"
UNAVAILABLE_LOG="$TEMP_DIR/unavailable-extract.log"
: > "$UNAVAILABLE_LOG"
set +e
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$UNAVAILABLE_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
FAKE_DOCKER_INFO_FAILURE=true \
HOST_MCP_ARTIFACTS_ROOT="$UNAVAILABLE_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_MAX_ATTEMPTS=1 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null 2>&1
unavailable_status=$?
set -e
[ "$unavailable_status" -ne 0 ] || {
  echo "host MCP extraction continued with an unavailable Docker daemon" >&2
  exit 1
}
if rg -q '^docker pull ' "$UNAVAILABLE_LOG"; then
  echo "host MCP extraction pulled an image after Docker health check failed" >&2
  exit 1
fi

LOW_DISK_ROOT="$TEST_PROJECT_ROOT/low-disk-host-mcp"
LOW_DISK_LOG="$TEMP_DIR/low-disk-extract.log"
: > "$LOW_DISK_LOG"
set +e
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$LOW_DISK_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
FAKE_LOW_DISK=true \
HOST_MCP_ARTIFACTS_ROOT="$LOW_DISK_ROOT" \
HOST_MCP_EXPECTED_SOURCE_REVISION="$EXPECTED_REVISION" \
HOST_MCP_LINUX_SOURCE_IMAGE="harbor.example/mcp-orc-rust:test" \
HOST_MCP_DOCKER_MAX_ATTEMPTS=1 \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --all-supported >/dev/null 2>&1
low_disk_status=$?
set -e
[ "$low_disk_status" -ne 0 ] || {
  echo "host MCP extraction continued with insufficient local disk space" >&2
  exit 1
}
if rg -q '^docker (info|pull) ' "$LOW_DISK_LOG"; then
  echo "host MCP extraction contacted Docker after disk preflight failed" >&2
  exit 1
fi

rm -f "$TEST_PROJECT_ROOT/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
set +e
PATH="$TEST_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
BUILD_LOG="$BUILD_LOG" \
TEST_PROJECT_ROOT="$TEST_PROJECT_ROOT" \
HOME="$TEST_HOME" \
HOST_MCP_RUST_TOOLCHAIN="test-toolchain" \
FAIL_LOCKFILE_CHECK=true \
bash "$TEST_PROJECT_ROOT/src/scripts/build-host-mcp-binaries.sh" --host-only >"$LOCK_ERROR_LOG" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "build-host-mcp-binaries.sh accepted lock drift during metadata validation" >&2
  exit 1
fi

if ! rg -q 'Host MCP Rust lockfile is out of date' "$LOCK_ERROR_LOG"; then
  echo "build-host-mcp-binaries.sh did not emit the lock drift guidance" >&2
  exit 1
fi
