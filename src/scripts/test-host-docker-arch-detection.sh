#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

extract_get_host_docker_arch() {
  local script_path="$1"

  awk '
    /^get_host_docker_arch\(\) \{/ {
      printing = 1
    }
    printing {
      print
      if ($0 == "}") {
        exit
      }
    }
  ' "$script_path"
}

run_arch_case() {
  local script_path="$1"
  local case_name="$2"
  local sysctl_arm64="$3"
  local uname_system="$4"
  local uname_machine="$5"
  local expected="$6"
  local tmp_dir output

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  cat > "$tmp_dir/sysctl" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-in" ] && [ "\${2:-}" = "hw.optional.arm64" ]; then
  printf '%s\n' "$sysctl_arm64"
  exit 0
fi
exit 1
EOF
  chmod +x "$tmp_dir/sysctl"

  cat > "$tmp_dir/uname" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  -s)
    printf '%s\n' "$uname_system"
    ;;
  -m)
    printf '%s\n' "$uname_machine"
    ;;
  *)
    exit 1
    ;;
esac
EOF
  chmod +x "$tmp_dir/uname"

  extract_get_host_docker_arch "$script_path" > "$tmp_dir/run.sh"
  printf '\nget_host_docker_arch\n' >> "$tmp_dir/run.sh"

  output="$(PATH="$tmp_dir:$PATH" bash "$tmp_dir/run.sh")"
  [ "$output" = "$expected" ] || fail "$case_name for $script_path expected $expected, got $output"

  rm -rf "$tmp_dir"
  trap - RETURN
}

for script_path in \
  "$PROJECT_ROOT/src/scripts/docker-compose.sh" \
  "$PROJECT_ROOT/install_v2.sh" \
  "$PROJECT_ROOT/src/scripts/start-single-mcp-server.sh"
do
  run_arch_case "$script_path" "Apple Silicon under Rosetta" "1" "Darwin" "x86_64" "arm64"
  run_arch_case "$script_path" "Intel macOS" "0" "Darwin" "x86_64" "amd64"
done

echo "host Docker architecture detection handles Rosetta and Intel macOS."
