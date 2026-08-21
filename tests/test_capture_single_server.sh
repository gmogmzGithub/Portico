#!/usr/bin/env bash
# Regression coverage for src/scripts/capture-single-server.sh — the diagnostic
# capture used (directly and via start-single-mcp-server.sh teardown) to persist
# the short-lived single-server OAuth stack logs into a file that ships in the
# debug bundle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CAPTURE_SCRIPT="$PROJECT_ROOT/src/scripts/capture-single-server.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Build a fake `docker` on PATH that reports a present single-server stack and
# returns canned logs/state, so the capture has real content to record.
make_fake_docker() {
  local bin_dir="$1"
  cat > "$bin_dir/docker" <<'DOCKER'
#!/usr/bin/env bash
case "$1" in
  ps)
    # Both `docker ps -a --format '{{.Names}}'` and bare `docker ps -a`.
    if printf '%s ' "$@" | grep -q -- '--format'; then
      printf 'mcpo-single-google_workspace\nmcpo-single-nginx\n'
    else
      printf 'CID  img  "cmd"  1m  Up  ports  mcpo-single-google_workspace\n'
    fi
    ;;
  port)
    printf '80/tcp -> 0.0.0.0:8770\n'
    ;;
  inspect)
    printf '{"Status":"running","ExitCode":0}\n'
    ;;
  logs)
    # Last arg is the container name.
    eval "container=\${$#}"
    printf 'CANNED-LOG-FOR:%s\n' "$container"
    ;;
  version)
    printf '99.9.9\n'
    ;;
  *)
    exit 0
    ;;
esac
DOCKER
  chmod +x "$bin_dir/docker"

  cat > "$bin_dir/curl" <<'CURL'
#!/usr/bin/env bash
if printf '%s ' "$@" | grep -q -- '-w %{http_code}'; then
  printf '200'
else
  printf '{"status":"ok"}\n'
fi
CURL
  chmod +x "$bin_dir/curl"
}

test_capture_records_backend_and_nginx_logs() {
  local tmp_dir bin_dir out
  tmp_dir="$(mktemp -d)"
  bin_dir="$tmp_dir/bin"
  mkdir -p "$bin_dir"
  make_fake_docker "$bin_dir"
  out="$tmp_dir/capture.txt"

  PATH="$bin_dir:$PATH" bash "$CAPTURE_SCRIPT" --server google_workspace --out "$out" >/dev/null 2>&1 \
    || fail "capture script exited non-zero"

  [ -f "$out" ] || fail "capture did not write output file"
  grep -Fq 'CANNED-LOG-FOR:mcpo-single-google_workspace' "$out" \
    || fail "capture missing backend container logs"
  grep -Fq 'CANNED-LOG-FOR:mcpo-single-nginx' "$out" \
    || fail "capture missing nginx container logs"
  grep -Fq 'nginx host port = 8770' "$out" \
    || fail "capture did not detect the dynamic host port"
  grep -Fq 'inspect .State: mcpo-single-google_workspace' "$out" \
    || fail "capture missing backend .State section"
}

test_one_shot_warns_when_no_stack_present() {
  local tmp_dir bin_dir out
  tmp_dir="$(mktemp -d)"
  bin_dir="$tmp_dir/bin"
  mkdir -p "$bin_dir"
  # Fake docker that reports NO containers.
  cat > "$bin_dir/docker" <<'DOCKER'
#!/usr/bin/env bash
case "$1" in
  version) printf '99.9.9\n' ;;
  *) exit 0 ;;
esac
DOCKER
  chmod +x "$bin_dir/docker"
  out="$tmp_dir/capture.txt"

  local output
  output="$(PATH="$bin_dir:$PATH" bash "$CAPTURE_SCRIPT" --server google_workspace --out "$out" 2>&1)" \
    || fail "capture script exited non-zero with no stack"
  grep -Fq 'no single-server containers found' "$out" \
    || fail "expected a warning when no stack is present"
}

test_capture_records_backend_and_nginx_logs
test_one_shot_warns_when_no_stack_present

echo "PASS: single-server capture diagnostics"
