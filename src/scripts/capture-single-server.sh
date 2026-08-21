#!/bin/bash
# capture-single-server.sh
# Captures diagnostics for the ephemeral single-server stack
# (mcpo-single-nginx + mcpo-single-<server>) used by the Control Plane
# re-auth / guided-setup wizard and the "test this server" config flow.
#
# The stack only exists for the duration of a single session and is torn
# down when it ends (on failure the OAuth wizard gives up after ~45-55s,
# but successful or slower sessions can live longer). Once torn down, its
# logs never make it into a normal debug bundle. This script grabs
# everything (container logs, state, nginx upstream errors, the live
# /oauth/status response, and the generated compose file) into ONE
# timestamped file you can send to support.
#
# USAGE
#   Watch mode (recommended) - start this BEFORE clicking Re-auth:
#     bash src/scripts/capture-single-server.sh --watch
#   then click Re-auth in the app. It auto-captures the whole window and
#   stops when the stack disappears (or press Ctrl-C).
#
#   One-shot mode - run WHILE the wizard is on "Waiting for OAuth...":
#     bash src/scripts/capture-single-server.sh
#
# OPTIONS
#   --watch [SECONDS]   Poll every SECONDS (default 3) until the stack is gone.
#   --server ID         Single-server id (default: auto-detect, fallback google_workspace).
#   --out PATH          Output file (default: ~/Desktop/portico-single-capture-<UTC>.txt).
#   --help              Show this help.

set -uo pipefail

NGINX_CONTAINER="mcpo-single-nginx"
WATCH=false
INTERVAL=3
SERVER_ID=""
OUT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --watch)
            WATCH=true
            if [[ "${2:-}" =~ ^[0-9]+$ ]]; then INTERVAL="$2"; shift; fi
            ;;
        --server) SERVER_ID="${2:-}"; shift ;;
        --out) OUT="${2:-}"; shift ;;
        --help|-h)
            tail -n +2 "$0" | grep '^#' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found on PATH" >&2
    exit 1
fi

# Resolve output path
if [ -z "$OUT" ]; then
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    if [ -d "$HOME/Desktop" ]; then
        OUT="$HOME/Desktop/portico-single-capture-${ts}.txt"
    else
        OUT="$HOME/portico-single-capture-${ts}.txt"
    fi
fi

# Auto-detect the single-server backend container if not given.
detect_server_container() {
    docker ps -a --format '{{.Names}}' 2>/dev/null \
        | grep -E '^mcpo-single-' | grep -v "^${NGINX_CONTAINER}$" | head -1
}

# Detect the host port nginx is published on (dynamic: 8770-8774).
detect_host_port() {
    docker port "$NGINX_CONTAINER" 2>/dev/null \
        | sed -n 's#.*:\([0-9][0-9]*\)$#\1#p' | head -1
}

container_exists() {
    # Do not use `grep -q` here. When the match appears before the end of
    # `docker ps` output, grep exits early and can close the pipe while docker
    # is still writing. With pipefail enabled, that SIGPIPE makes this helper
    # intermittently report that an existing container is absent, causing the
    # following inspect/log sections to be skipped.
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^$1$" >/dev/null
}

snapshot() {
    local server_container="$1"
    echo "================================================================"
    echo "SNAPSHOT @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "================================================================"

    echo
    echo "### docker ps (single + group google_workspace)"
    docker ps -a 2>&1 | grep -Ei 'single|google_workspace' || echo "(no matching containers)"

    local host_port
    host_port="$(detect_host_port)"
    echo
    echo "### nginx host port = ${host_port:-unknown}"

    for c in "$NGINX_CONTAINER" "$server_container"; do
        [ -z "$c" ] && continue
        echo
        echo "### inspect .State: $c"
        if container_exists "$c"; then
            docker inspect "$c" --format '{{json .State}}' 2>&1
        else
            echo "(container not present)"
        fi
    done

    for c in "$server_container" "$NGINX_CONTAINER"; do
        [ -z "$c" ] && continue
        echo
        echo "### docker logs (tail 400): $c"
        if container_exists "$c"; then
            docker logs --timestamps --tail 400 "$c" 2>&1
        else
            echo "(container not present)"
        fi
    done

    if [ -n "$host_port" ]; then
        echo
        echo "### curl http://localhost:${host_port}/oauth/status"
        echo "HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${host_port}/oauth/status" 2>&1)"
        echo "--- body (first 800 bytes) ---"
        curl -s --max-time 5 "http://localhost:${host_port}/oauth/status" 2>&1 | head -c 800
        echo
        echo "### curl http://localhost:${host_port}/health"
        echo "HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${host_port}/health" 2>&1)"
    fi

    echo
    echo "### generated single-server compose (if found)"
    local found=false
    for f in \
        "$HOME/portico/portico-managed/docker-compose.single-server.yml" \
        "$HOME/Library/Application Support/portico/docker-compose.single-server.yml" \
        "./docker-compose.single-server.yml"; do
        if [ -f "$f" ]; then
            echo "--- $f ---"
            cat "$f" 2>&1
            found=true
            break
        fi
    done
    $found || echo "(compose file not found in known locations)"
    echo
}

echo "Writing capture to: $OUT"
{
    echo "Portico - single-server OAuth stack capture"
    echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
    echo "Mode: $([ "$WATCH" = true ] && echo "watch (every ${INTERVAL}s)" || echo one-shot)"
    echo "Host: $(uname -a 2>&1)"
    echo "Docker: $(docker version --format '{{.Server.Version}}' 2>&1)"
    echo
} > "$OUT"

if [ "$WATCH" = true ]; then
    echo "Watching for the single-server stack... start your Re-auth now. Ctrl-C to stop."
    seen=false
    captures=0
    # Wait up to 5 minutes for the stack to appear, then capture until it's gone.
    start=$(date +%s)
    while true; do
        sc="${SERVER_ID:+mcpo-single-$SERVER_ID}"
        [ -z "$sc" ] && sc="$(detect_server_container)"
        if [ -n "$sc" ] && container_exists "$sc"; then
            seen=true
            captures=$((captures + 1))
            echo "  [$(date -u +%H:%M:%SZ)] stack up - snapshot #$captures"
            snapshot "$sc" >> "$OUT" 2>&1
        else
            if [ "$seen" = true ]; then
                echo "  stack gone - final snapshot and exit."
                snapshot "$sc" >> "$OUT" 2>&1
                break
            fi
            # Not seen yet; give up after 5 min of waiting.
            if [ $(( $(date +%s) - start )) -gt 300 ]; then
                echo "  Timed out after 5 min waiting for the stack to appear." | tee -a "$OUT"
                break
            fi
        fi
        sleep "$INTERVAL"
    done
else
    sc="${SERVER_ID:+mcpo-single-$SERVER_ID}"
    [ -z "$sc" ] && sc="$(detect_server_container)"
    [ -z "$sc" ] && sc="mcpo-single-google_workspace"
    if ! container_exists "$sc" && ! container_exists "$NGINX_CONTAINER"; then
        echo "WARNING: no single-server containers found right now." | tee -a "$OUT"
        echo "Run this WHILE the wizard is on 'Waiting for OAuth...', or use --watch." | tee -a "$OUT"
    fi
    snapshot "$sc" >> "$OUT" 2>&1
fi

echo "Done. Send this file: $OUT"
