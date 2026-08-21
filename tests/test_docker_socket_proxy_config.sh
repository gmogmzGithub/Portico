#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

config_block() {
    local file="$1"
    local section="$2"
    awk -v section="$section" '
        $0 == section { in_block = 1; print; next }
        in_block && /^[A-Za-z0-9_.-]+([[:space:]]|$)/ { exit }
        in_block { print }
    ' "$file"
}

proxy_block="$(awk '
    $0 == "  docker-socket-proxy:" { in_block = 1; print; next }
    in_block && /^  [A-Za-z0-9_.-]+:/ { exit }
    in_block { print }
' "$COMPOSE_FILE")"

[ -n "$proxy_block" ] || fail "docker-socket-proxy service is missing"

template_mount="$(printf '%s\n' "$proxy_block" \
    | awk '$0 ~ /:\/usr\/local\/etc\/haproxy\/haproxy\.cfg\.template:ro$/ { sub(/^[[:space:]]*-[[:space:]]*/, ""); print; exit }')"
[ -n "$template_mount" ] || fail "docker-socket-proxy does not mount a read-only HAProxy template"

template_source="${template_mount%%:*}"
case "$template_source" in
    ./*) template_path="$PROJECT_ROOT/${template_source#./}" ;;
    *) fail "HAProxy template source must be a project-relative bind mount" ;;
esac
[ -f "$template_path" ] || fail "mounted HAProxy template does not exist: $template_path"

effective_config="$(mktemp -t portico-docker-proxy-haproxy.XXXXXX)"
trap 'rm -f "$effective_config"' EXIT

# Match the image entrypoint's supported template expansion to inspect the
# configuration HAProxy receives at runtime without contacting Docker.
sed 's|${BIND_CONFIG}|[::]:2375 v4v6|g' "$template_path" > "$effective_config"

defaults_block="$(config_block "$effective_config" defaults)"
wait_block="$(config_block "$effective_config" 'backend docker-wait')"
frontend_block="$(config_block "$effective_config" 'frontend dockerfrontend')"

grep -Fq 'bind [::]:2375 v4v6' <<<"$frontend_block" \
    || fail "runtime HAProxy config did not expand BIND_CONFIG"
grep -Eq '^[[:space:]]*timeout client 10m[[:space:]]*$' <<<"$defaults_block" \
    || fail "ordinary Docker requests must retain the upstream client idle timeout"
grep -Eq '^[[:space:]]*timeout server 10m[[:space:]]*$' <<<"$defaults_block" \
    || fail "ordinary Docker requests must retain the upstream server idle timeout"
grep -Eq '^[[:space:]]*timeout tunnel 24h[[:space:]]*$' <<<"$defaults_block" \
    || fail "upgraded Docker attach and exec streams must use the extended idle timeout"
grep -Eq '^[[:space:]]*timeout server 0[[:space:]]*$' <<<"$wait_block" \
    || fail "Docker wait requests must not have a backend idle timeout"
grep -Fq 'use_backend docker-wait if { path,url_dec -m reg -i ^(/v[\d\.]+)?/containers/[a-zA-Z0-9_.-]+/wait/?$ }' <<<"$frontend_block" \
    || fail "Docker wait requests must route to the no-timeout backend"

echo "Docker socket proxy runtime configuration scopes extended idle time to wait and tunnel streams."
