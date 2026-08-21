#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"
PROJECT_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ROOT_OVERRIDE="${PROJECT_ROOT_OVERRIDE:-}"
PROJECT_ROOT="$PROJECT_ROOT_DEFAULT"
if [ -n "$PROJECT_ROOT_OVERRIDE" ]; then
    PROJECT_ROOT="$PROJECT_ROOT_OVERRIDE"
fi
APP_LOGS_DIR_DEFAULT="${HOME}/Library/Application Support/portico/logs"
APP_LOGS_DIR_OVERRIDE="${DEBUG_APP_LOGS_DIR:-${APP_LOGS_DIR_OVERRIDE:-}}"
APP_LOGS_DIR="$APP_LOGS_DIR_DEFAULT"
if [ -n "$APP_LOGS_DIR_OVERRIDE" ]; then
    APP_LOGS_DIR="$APP_LOGS_DIR_OVERRIDE"
fi
DEBUG_OUTPUT_ROOT="${DEBUG_OUTPUT_ROOT_OVERRIDE:-$APP_LOGS_DIR}"
REDACTION_SED_FILE=""

# Configuration
COMPOSE_FILES="-f docker-compose.yml"
DEBUG_DOCKER_LOG_SINCE="${DEBUG_DOCKER_LOG_SINCE:-72h}"
DEBUG_LOG_MAX_AGE_HOURS="${DEBUG_LOG_MAX_AGE_HOURS:-168}"
DEBUG_LOG_MAX_AGE_MINUTES="$((DEBUG_LOG_MAX_AGE_HOURS * 60))"
DEBUG_LOG_MAX_BYTES="${DEBUG_LOG_MAX_BYTES:-104857600}"
DEBUG_LOG_MAX_BYTES_MB="$((DEBUG_LOG_MAX_BYTES / 1024 / 1024))"
# Redaction worker count: default to core count minus two (floor 5, the
# old fixed default) — redaction is CPU-bound and runs in the background,
# so leave a little headroom for the app.
DEBUG_REDACTION_DEFAULT_JOBS=5
if sysctl -n hw.ncpu >/dev/null 2>&1; then
    DEBUG_REDACTION_DEFAULT_JOBS=$(( $(sysctl -n hw.ncpu) - 2 ))
elif command -v nproc >/dev/null 2>&1; then
    DEBUG_REDACTION_DEFAULT_JOBS=$(( $(nproc) - 2 ))
fi
if [ "$DEBUG_REDACTION_DEFAULT_JOBS" -lt 5 ]; then
    DEBUG_REDACTION_DEFAULT_JOBS=5
fi
DEBUG_REDACTION_MAX_JOBS="${DEBUG_REDACTION_MAX_JOBS:-$DEBUG_REDACTION_DEFAULT_JOBS}"
LIVE_MODE=false
LIVE_DURATION=30
HAS_DOCKER=true
HAS_DOCKER_COMPOSE=true

# PORTICO-373: a container engine can accept connections and never answer them. Every
# Docker call in this script was previously gated only on the docker BINARY
# existing, so against a wedged engine the collector blocked on its first daemon
# call and produced no bundle at all -- exactly when a bundle was most needed.
#
# The caller performs a bounded engine probe and passes the verdict in. The status
# goes through an allowlist because it is written into the bundle and must never
# carry a raw error string.
DEBUG_SKIP_DOCKER="${DEBUG_SKIP_DOCKER:-0}"
DEBUG_DOCKER_PREFLIGHT_STATUS="${DEBUG_DOCKER_PREFLIGHT_STATUS:-unknown}"
case "$DEBUG_DOCKER_PREFLIGHT_STATUS" in
    ok|probe-timeout|probe-failed|unavailable) ;;
    *) DEBUG_DOCKER_PREFLIGHT_STATUS="unavailable" ;;
esac

docker_calls_are_skipped() {
    [ "$DEBUG_SKIP_DOCKER" = "1" ]
}

# PORTICO-373: make "no container-engine call runs in skip mode" true by construction
# rather than by auditing call sites. Shell functions take precedence over PATH, so
# these shadow the real binaries for this process and every subshell -- including
# helpers in the sourced backend library, which reach the engine through paths that
# do not look like engine calls at all (resolve_docker_compose_frontend runs
# `docker compose version` itself, and run_docker_compose fans out from there).
#
# Auditing was tried first and missed call sites twice. A guard that has to be
# re-derived every time someone adds a helper is a guard that will be wrong again.
install_skipped_container_engine_shims() {
    docker() {
        echo "docker skipped: container engine unresponsive (${DEBUG_DOCKER_PREFLIGHT_STATUS})" >&2
        return 125
    }
    docker-compose() {
        echo "docker-compose skipped: container engine unresponsive (${DEBUG_DOCKER_PREFLIGHT_STATUS})" >&2
        return 125
    }
    orbctl() {
        echo "orbctl skipped: container engine unresponsive (${DEBUG_DOCKER_PREFLIGHT_STATUS})" >&2
        return 125
    }
}

if [ ! -d "$PROJECT_ROOT" ]; then
    PROJECT_ROOT="$PROJECT_ROOT_DEFAULT"
fi
cd "$PROJECT_ROOT" || true

LLM_GATEWAY_CONTAINER_NAME="llm-gateway"
INTERNAL_NO_PROXY_REQUIRED=(
    "localhost"
    "127.0.0.1"
    "::1"
    "open-webui"
    "portico-open-webui"
    "llm-gateway"
    "mcpo"
    "mcpo-core"
    "redis"
    "portico-redis"
    "mongodb"
    "portico-mongodb"
    "chat-state-api"
    "open-webui-health-check"
    "host.docker.internal"
)

append_internal_no_proxy_required() {
    local entry="$1"
    [ -n "$entry" ] || return

    local existing
    for existing in "${INTERNAL_NO_PROXY_REQUIRED[@]}"; do
        [ "$existing" = "$entry" ] && return
    done

    INTERNAL_NO_PROXY_REQUIRED+=("$entry")
}

load_internal_no_proxy_required_from_routes() {
    local routes_file="${PROJECT_ROOT}/mcpo-configs-generated/server-routing.json"
    [ -f "$routes_file" ] || return
    command -v jq >/dev/null 2>&1 || return

    local route_entry
    while IFS= read -r route_entry; do
        append_internal_no_proxy_required "$route_entry"
    done < <(
        jq -r 'to_entries[] | .value.compose_service?, .value.container_name?, .value.network_host? | select(type == "string" and length > 0)' "$routes_file" 2>/dev/null || true
    )
}

# Function to print timestamped log messages
log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

# Function to print error messages
error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $1${NC}"
}

# Function to print warning messages
warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  $1${NC}"
}

# Function to print success messages
success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $1${NC}"
}

# Helper for cross-platform in-place sed with extended regex
sed_inplace() {
    local expr="$1"
    local file="$2"

    if sed -E -i '' "$expr" "$file" 2>/dev/null; then
        return
    fi
    sed -E -i "$expr" "$file" 2>/dev/null
}

escape_sed_pattern() {
    printf '%s\n' "$1" | sed -e 's/[][\\.^$*+?()|{}\/&]/\\&/g'
}

build_redaction_sed_file() {
    if [ ! -f ".env" ]; then
        return
    fi

    local sed_file
    sed_file="$(mktemp)"

    while IFS='=' read -r key value; do
        # Skip empty lines and comments
        if [[ -z "$key" ]] || [[ "$key" =~ ^[[:space:]]*# ]]; then
            continue
        fi

        # Remove leading/trailing whitespace and quotes from value
        value=$(echo "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']*$//')

        # JSON primitives and numbers are too broad for global substring
        # replacement. Replacing values such as true or 1 with the bare
        # redaction marker corrupts every matching structured artifact.
        # Secret-labeled fields are still covered by redact_file's targeted
        # key/name patterns below.
        local lowercase_value
        lowercase_value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
        if [[ "$lowercase_value" =~ ^(true|false|null)$ ]] \
            || [[ "$value" =~ ^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$ ]]; then
            continue
        fi

        # Only redact non-empty values that aren't placeholders
        if [[ -n "$value" ]] && [[ "$value" != "placeholder" ]] && [[ ! "$value" =~ ^your[_-] ]]; then
            local escaped_value
            escaped_value=$(escape_sed_pattern "$value")
            printf 's|%s|<REDACTED>|g\n' "$escaped_value" >> "$sed_file"
        fi
    done < .env

    if [ -s "$sed_file" ]; then
        REDACTION_SED_FILE="$sed_file"
    else
        rm -f "$sed_file"
    fi
}

apply_sed_file() {
    local sed_file="$1"
    local file="$2"
    local temp_out="${file}.redacted"

    if sed -E -f "$sed_file" "$file" > "$temp_out" 2>/dev/null; then
        mv "$temp_out" "$file"
        return 0
    fi
    rm -f "$temp_out"
    return 1
}

# Generic redaction patterns applied to every captured file, in order.
# ORDER MATTERS: broad catch-alls (content=, response=) must stay after the
# more specific patterns, exactly as they ran when these were individual
# sed_inplace passes. This array is the single source of truth — it is
# compiled into one combined sed script (one pass per file instead of one
# full read/rewrite per pattern) and doubles as the per-pattern fallback
# when the combined file cannot be built.
GENERIC_REDACTION_PATTERNS=(
    's#(Authorization: Bearer )[A-Za-z0-9._=-]+#\1<REDACTED>#g'
    's#(Authorization: Basic )[A-Za-z0-9+/=]+#\1<REDACTED>#g'
    's#(Bearer )[A-Za-z0-9._=-]+#\1<REDACTED>#g'
    's#(\"access_token\"[[:space:]]*:[[:space:]]*\")[^\"]+#\1<REDACTED>#g'
    's#(\"refresh_token\"[[:space:]]*:[[:space:]]*\")[^\"]+#\1<REDACTED>#g'
    's#(\"id_token\"[[:space:]]*:[[:space:]]*\")[^\"]+#\1<REDACTED>#g'
    's#(\"client_secret\"[[:space:]]*:[[:space:]]*\")[^\"]+#\1<REDACTED>#g'
    's#(\"api_key\"[[:space:]]*:[[:space:]]*\")[^\"]+#\1<REDACTED>#g'
    's#(\"apiKey\"[[:space:]]*:[[:space:]]*\")[^\"]+#\1<REDACTED>#g'
    's#(\"token\"[[:space:]]*:[[:space:]]*\")[^\"]+#\1<REDACTED>#g'
    's#([A-Z0-9_]*(API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|AUTH)[A-Z0-9_]*)=[^[:space:]",]+#\1=<REDACTED>#g'
    's#(\[DEBUGGING_TOOLS\].* content=).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(\[DEBUGGING_TOOLS\].*Content preview: ).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(\[SYSTEM-PROMPT-DEBUG\].* preview=).*#\1<REDACTED_SYSTEM_PROMPT>#g'
    's#(\[FOLLOW-UP\].* content_preview=).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(\[Skills\].*Message preview: ).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(\[Skills\].*Message: ).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(^.*args_preview.*)$#<REDACTED_TOOL_CALL>#g'
    's#(^.*Original messages: ).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(^.*Transformed messages: ).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(^.*Parsed line data: ).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(\[ChatCapabilities\] Raw Redis values: ).*#\1<REDACTED_CAPABILITIES_STATE>#g'
    's#(\[ChatCapabilities\] Parsed: ).*#\1<REDACTED_CAPABILITIES_STATE>#g'
    's#(\[ChatCapabilities\] Full response: ).*#\1<REDACTED_CAPABILITIES_STATE>#g'
    's#(\[ChatCapabilities\] Emitting to room user:[^ ]+ with event: ).*#\1<REDACTED_CAPABILITIES_EVENT>#g'
    's#(^.*generate_chat_completion: ).*#\1<REDACTED_REQUEST_PAYLOAD>#g'
    's#(^.*form_data: ).*#\1<REDACTED_REQUEST_PAYLOAD>#g'
    's#(\[ChatCapabilities\] Received form_data: ).*#\1<REDACTED_CAPABILITIES_PAYLOAD>#g'
    's#(^.*response=).*#\1<REDACTED_RESPONSE_PAYLOAD>#g'
    's#(^.*content=).*#\1<REDACTED_CHAT_CONTENT>#g'
    's#(^.*tool_call=).*#\1<REDACTED_TOOL_CALL>#g'
)
GENERIC_REDACTION_SED_FILE=""

# Compile GENERIC_REDACTION_PATTERNS into one sed script so redact_file can
# apply all of them in a single pass. Verifies the compiled line count
# matches the pattern list; on any mismatch or failure leaves
# GENERIC_REDACTION_SED_FILE empty and redact_file falls back to the
# per-pattern path — patterns are never silently skipped.
build_generic_redaction_sed_file() {
    GENERIC_REDACTION_SED_FILE=""
    local sed_file
    sed_file="$(mktemp)" || return
    local pattern
    for pattern in "${GENERIC_REDACTION_PATTERNS[@]}"; do
        printf '%s\n' "$pattern" >> "$sed_file"
    done
    local compiled_count
    compiled_count=$(wc -l < "$sed_file" | tr -d ' ')
    if [ "$compiled_count" != "${#GENERIC_REDACTION_PATTERNS[@]}" ]; then
        rm -f "$sed_file"
        return
    fi
    GENERIC_REDACTION_SED_FILE="$sed_file"
}

PERL_REDACTION_SCRIPT=""

# Compile the .env patterns plus GENERIC_REDACTION_PATTERNS into one perl
# script. perl applies the identical substitutions ~10x faster than BSD
# sed (measured 0.6s vs 7.5s on a 23MB log), which is what makes bundle
# redaction fast. The only syntax delta from the sed expressions is
# ${1} instead of \1 in replacements (a mechanical rewrite below); output
# is verified byte-identical against the sed path by
# tests/manual/debug-redaction-equivalence.sh. On any failure the
# variable stays empty and redact_file uses the sed paths instead —
# redaction is never skipped.
build_perl_redaction_script() {
    PERL_REDACTION_SCRIPT=""
    command -v perl >/dev/null 2>&1 || return
    local perl_file
    perl_file="$(mktemp)" || return
    local expected_count="${#GENERIC_REDACTION_PATTERNS[@]}"
    {
        if [ -n "$REDACTION_SED_FILE" ] && [ -f "$REDACTION_SED_FILE" ]; then
            # .env expressions carry sed-escaped literals and no backrefs.
            # One perl-specific hazard remains: a bare @ inside the pattern
            # (e.g. an email value) is array interpolation in perl and would
            # silently erase part of the pattern — escape it. $ is already
            # escaped by escape_sed_pattern. Then terminate each statement.
            sed -e 's/@/\\@/g' -e 's/$/;/' "$REDACTION_SED_FILE"
        fi
        printf '%s\n' "${GENERIC_REDACTION_PATTERNS[@]}" \
            | sed -e 's/#\\1/#${1}/' -e 's/$/;/'
    } > "$perl_file" || {
        rm -f "$perl_file"
        return
    }
    if [ -n "$REDACTION_SED_FILE" ] && [ -f "$REDACTION_SED_FILE" ]; then
        expected_count=$((expected_count + $(wc -l < "$REDACTION_SED_FILE")))
    fi
    local compiled_count
    compiled_count=$(wc -l < "$perl_file" | tr -d ' ')
    if [ "$compiled_count" != "$expected_count" ]; then
        rm -f "$perl_file"
        return
    fi
    # Reject the script outright if perl cannot compile it — better to run
    # the slower sed path than to discover a bad script per file.
    if ! printf '' | perl -p "$perl_file" >/dev/null 2>&1; then
        rm -f "$perl_file"
        return
    fi
    PERL_REDACTION_SCRIPT="$perl_file"
}

file_mtime() {
    local file="$1"

    if stat -c "%Y" "$file" >/dev/null 2>&1; then
        stat -c "%Y" "$file"
        return
    fi

    if stat -f "%m" "$file" >/dev/null 2>&1; then
        stat -f "%m" "$file"
        return
    fi

    echo 0
}

file_size_bytes() {
    local file="$1"

    if stat -c "%s" "$file" >/dev/null 2>&1; then
        stat -c "%s" "$file"
        return
    fi

    if stat -f "%z" "$file" >/dev/null 2>&1; then
        stat -f "%z" "$file"
        return
    fi

    wc -c < "$file" 2>/dev/null | tr -d '[:space:]'
}

sanitize_home_in_text() {
    local text="${1:-}"
    if [ -n "${HOME:-}" ]; then
        local home_marker='~'
        text="${text//$HOME/$home_marker}"
    fi
    printf '%s\n' "$text"
}

capture_compose_cli_diagnostics() {
    local debug_dir="$1"
    local output_file="${debug_dir}/compose-cli-diagnostics.txt"

    {
        echo "=== Sanitized Paths ==="
        echo "HOME=<HOME>"
        echo "DOCKER_CONFIG=$(sanitize_home_in_text "${DOCKER_CONFIG:-${HOME}/.docker}")"
        echo

        for command_name in docker docker-compose; do
            echo "=== Command Resolution: ${command_name} ==="
            type -a "$command_name" 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
                || true
            local command_path=""
            # PORTICO-373: `type -P` searches PATH only. In skip mode a shell function
            # shadows these names, and `command -v` would report the function
            # instead of the binary -- destroying the very diagnostic that says
            # which docker the collector would have used, which is information a
            # reader of a degraded bundle actually wants.
            command_path="$(type -P "$command_name" 2>/dev/null || true)"
            if [ -n "$command_path" ]; then
                echo "resolved=$(sanitize_home_in_text "$command_path")"
                ls -ld "$command_path" 2>&1 | while IFS= read -r line; do sanitize_home_in_text "$line"; done
                echo "mtime_epoch=$(file_mtime "$command_path")"
                if [ -L "$command_path" ]; then
                    echo "symlink_target=$(sanitize_home_in_text "$(readlink "$command_path" 2>/dev/null || true)")"
                fi
            else
                echo "resolved=unavailable"
            fi
            echo
        done

        echo "=== Docker Compose Plugin Probe ==="
        # PORTICO-373: skipped wholesale when the engine is unresponsive. These probes
        # are client-side today, but keeping the rule "no container-engine command
        # runs in skip mode" makes the guarantee assertable instead of resting on
        # which subcommands happen not to contact the daemon this release.
        if [ "$HAS_DOCKER" != true ]; then
            echo "skipped (${DEBUG_DOCKER_PREFLIGHT_STATUS})"
            echo
            echo "=== Standalone Docker Compose Probe ==="
            echo "skipped (${DEBUG_DOCKER_PREFLIGHT_STATUS})"
        else
        docker compose version 2>&1 \
            | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
            || true
        echo
        echo "=== Standalone Docker Compose Probe ==="
        docker-compose version 2>&1 \
            | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
            || true
        echo
        fi

        # PORTICO-373: resolve_docker_compose_frontend runs `docker compose version`
        # itself, so it is a container-engine invocation even though nothing here
        # looks like one. This was the last call that escaped skip mode.
        echo "=== Selected Compose Frontend ==="
        if [ "$HAS_DOCKER" != true ]; then
            echo "skipped (${DEBUG_DOCKER_PREFLIGHT_STATUS})"
            echo "docker_plugin_probe=skipped"
            echo "standalone_v2_probe=skipped"
        else
            reset_docker_compose_frontend_cache
            if resolve_docker_compose_frontend; then
                echo "$DOCKER_COMPOSE_FRONTEND_RESOLVED"
            else
                echo "unavailable"
            fi
            echo "docker_plugin_probe=$(sanitize_home_in_text "$(sanitize_docker_compose_probe_output "$DOCKER_COMPOSE_PLUGIN_PROBE_OUTPUT")")"
            echo "standalone_v2_probe=$(sanitize_home_in_text "$(sanitize_docker_compose_probe_output "$DOCKER_COMPOSE_STANDALONE_PROBE_OUTPUT")")"
        fi
        echo

        echo "=== Docker Client Plugin Inventory ==="
        # PORTICO-373: `docker info` is a daemon round trip, unlike the version probes
        # above it, so it is the second call that could hang here.
        if [ "$HAS_DOCKER" = true ]; then
            docker info --format '{{json .ClientInfo.Plugins}}' 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
                || true
        else
            echo "skipped (${DEBUG_DOCKER_PREFLIGHT_STATUS})"
        fi
        echo
        echo "=== OrbStack Version ==="
        if [ "$HAS_DOCKER" = true ]; then
            orbctl version 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
                || true
        else
            echo "skipped (${DEBUG_DOCKER_PREFLIGHT_STATUS})"
        fi
        echo
        echo "=== OrbStack Status ==="
        # PORTICO-373: `orbctl status` queries the engine, so it is exactly the kind of
        # call that hangs when the engine has stopped answering.
        if [ "$HAS_DOCKER" = true ]; then
            orbctl status 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
                || true
        else
            echo "skipped (${DEBUG_DOCKER_PREFLIGHT_STATUS})"
        fi
    } > "$output_file"
}

is_recent_file() {
    local file="$1"
    local now
    local mtime
    local cutoff

    now=$(date +%s)
    mtime=$(file_mtime "$file")
    cutoff=$((now - (DEBUG_LOG_MAX_AGE_HOURS * 3600)))

    [ -n "$mtime" ] && [ "$mtime" -ge "$cutoff" ]
}

trim_large_log_file() {
    local file="$1"
    local size_bytes

    if [ ! -f "$file" ]; then
        return
    fi

    if stat -c "%s" "$file" >/dev/null 2>&1; then
        size_bytes=$(stat -c "%s" "$file")
    elif stat -f "%z" "$file" >/dev/null 2>&1; then
        size_bytes=$(stat -f "%z" "$file")
    else
        size_bytes=0
    fi

    if [ "$size_bytes" -le "$DEBUG_LOG_MAX_BYTES" ]; then
        return
    fi

    local temp_file="${file}.trimmed"
    local head_bytes=$((DEBUG_LOG_MAX_BYTES / 2))
    local tail_bytes=$((DEBUG_LOG_MAX_BYTES - head_bytes))
    if {
        head -c "$head_bytes" "$file" 2>/dev/null &&
        tail -c "$tail_bytes" "$file" 2>/dev/null
    } > "$temp_file"; then
        mv "$temp_file" "$file"
    else
        rm -f "$temp_file"
    fi
}

collect_update_pipeline_state() {
    local debug_dir="$1"
    local output_file="${debug_dir}/update-pipeline-state.txt"
    local managed_dir="$PROJECT_ROOT"
    local backup_dir="${managed_dir}/backup"
    local health_dir="${managed_dir}/health-status"
    local db_path="${managed_dir}/open-webui-data/webui.db"
    local tmp_root="${TMPDIR:-/tmp}"
    local now=""
    local strand=""
    local strand_count=0

    now="$(date +%s)"
    mkdir -p "$debug_dir"

    {
        echo "Update pipeline state"
        echo "====================="
        echo

        echo "=== Managed backup inode inventory ==="
        echo "path: $(sanitize_home_in_text "$backup_dir")"
        if [ -d "$backup_dir" ]; then
            ls -lisa "$backup_dir" 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done
            if [ -d "$backup_dir/db-snapshots" ]; then
                echo
                echo "db-snapshots:"
                ls -lisa "$backup_dir/db-snapshots" 2>&1 \
                    | while IFS= read -r line; do sanitize_home_in_text "$line"; done
            fi
        else
            echo "<missing>"
        fi
        echo

        echo "=== Filesystem capacity ==="
        echo "managed: $(sanitize_home_in_text "$managed_dir")"
        df -Pk "$managed_dir" 2>&1 \
            | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
            || true
        echo
        echo "tmpdir: $(sanitize_home_in_text "$tmp_root")"
        df -Pk "$tmp_root" 2>&1 \
            | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
            || true
        echo

        echo "=== Directory usage (KiB) ==="
        # Scoped to the update-relevant directories. Whole-tree du over the
        # managed checkout / $TMPDIR walks tens of GB (node_modules, build
        # targets, unrelated temp files) and cost ~14s of every collection;
        # overall disk fullness is already covered by the df section above,
        # and reconcile strands get per-strand du below.
        local usage_dir
        for usage_dir in "$backup_dir" \
            "${HOME}/Library/Application Support/portico/update-prep"; do
            if [ -e "$usage_dir" ]; then
                du -sk "$usage_dir" 2>&1 \
                    | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
                    || true
            else
                echo "<missing> $(sanitize_home_in_text "$usage_dir")"
            fi
        done
        echo

        echo "=== Reconcile strands ==="
        echo "tmpdir: $(sanitize_home_in_text "$tmp_root")"
        while IFS= read -r strand; do
            [ -n "$strand" ] || continue
            strand_count=$((strand_count + 1))
            local strand_mtime=""
            local strand_age_seconds=0
            local strand_age_hours=0
            strand_mtime="$(file_mtime "$strand")"
            case "$strand_mtime" in
                ''|*[!0-9]*) strand_mtime=0 ;;
            esac
            if [ "$strand_mtime" -gt 0 ] && [ "$now" -ge "$strand_mtime" ]; then
                strand_age_seconds=$((now - strand_mtime))
                strand_age_hours=$((strand_age_seconds / 3600))
            fi
            echo "strand: $(sanitize_home_in_text "$strand")"
            echo "age_seconds: ${strand_age_seconds}"
            echo "age_hours: ${strand_age_hours}"
            ls -ld "$strand" 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done
            du -sk "$strand" 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
                || true
            echo
        done < <(
            find "$tmp_root" -maxdepth 1 -type d \
                -name 'managed-runtime-reconcile.*' -print 2>/dev/null \
                | LC_ALL=C sort
        )
        if [ "$strand_count" -eq 0 ]; then
            echo "<none>"
        fi
        echo

        echo "=== Open WebUI database sentinel ==="
        if [ -f "$health_dir/owui-db-sentinel.json" ]; then
            cat "$health_dir/owui-db-sentinel.json"
        else
            echo "<missing>"
        fi
        echo

        echo "=== Open WebUI database corruption state ==="
        if [ -f "$health_dir/db_corruption_state.json" ]; then
            cat "$health_dir/db_corruption_state.json"
        else
            echo "<missing>"
        fi
        echo

        echo "=== Open WebUI database file ==="
        if [ -e "$db_path" ]; then
            ls -lisa "$db_path" 2>&1 \
                | while IFS= read -r line; do sanitize_home_in_text "$line"; done
            echo "size_bytes: $(file_size_bytes "$db_path")"
            echo "mtime_epoch: $(file_mtime "$db_path")"
        else
            echo "<missing>"
        fi
        echo

        echo "=== Docker containers ==="
        # PORTICO-373: was gated on the binary alone, which is true even when the
        # engine will never answer; this is one of the two daemon calls that ran
        # regardless of HAS_DOCKER.
        if [ "$HAS_DOCKER" = true ] && command -v docker >/dev/null 2>&1; then
            docker ps -a 2>&1 || true
        elif docker_calls_are_skipped; then
            echo "docker diagnostics skipped (${DEBUG_DOCKER_PREFLIGHT_STATUS})"
        else
            echo "docker unavailable"
        fi
    } > "$output_file"
}


# Metadata-only inventory of the three skill roots. Skill CONTENT is
# deliberately never bundled: user and marketplace skills can carry
# sensitive material (team context docs, restricted listings). Support
# still sees what is installed (names, file layout, sizes, mtimes);
# trigger/activation data for loaded skills already appears in the
# captured open-webui logs, and marketplace content is refetchable by id.
#
# Best-effort by design: every failure degrades to a note inside the
# manifest (or a skipped manifest) — it must never abort the wider
# debug collection.
capture_skills_manifest() {
    local debug_dir="$1"
    local manifest_file="${debug_dir}/skills-manifest.txt"
    local manifest_cap=2000
    local skills_root_label skills_root_name skills_root skills_stat_tmp
    local skills_file_count

    {
        echo "Skills manifest (content intentionally omitted from bundles)"
        echo "============================================================"
        for skills_root_label in "skills (system)" "skills-marketplace" "skills-user"; do
            skills_root_name="${skills_root_label%% *}"
            skills_root="${PROJECT_ROOT}/${skills_root_name}"
            echo
            echo "=== ${skills_root_label} ==="
            echo "root: $(sanitize_home_in_text "$skills_root")"
            if [ ! -d "$skills_root" ]; then
                echo "<missing>"
                continue
            fi
            skills_stat_tmp="$(mktemp 2>/dev/null)" || skills_stat_tmp=""
            if [ -z "$skills_stat_tmp" ]; then
                echo "<unavailable: could not create a temp file for the listing>"
                continue
            fi
            # Batched stat (one spawn per ~few hundred files); a per-file
            # command loop here costs tens of seconds on large skill trees.
            if stat -f "%z" "$skills_root" >/dev/null 2>&1; then
                find "$skills_root" -type f -exec stat -f "%z|%m|%N" {} + 2>/dev/null > "$skills_stat_tmp" || true
            else
                find "$skills_root" -type f -exec stat -c "%s|%Y|%n" {} + 2>/dev/null > "$skills_stat_tmp" || true
            fi
            skills_file_count="$(wc -l < "$skills_stat_tmp" 2>/dev/null | tr -d ' ')"
            skills_file_count="${skills_file_count:-0}"
            echo "files: ${skills_file_count}  total_bytes: $(awk -F'|' '{s+=$1} END {print s+0}' "$skills_stat_tmp" 2>/dev/null)"
            awk -F'|' -v prefix="${skills_root}/" '{
                path = $3;
                if (index(path, prefix) == 1) path = substr(path, length(prefix) + 1);
                printf "  %s  bytes=%s  mtime_epoch=%s\n", path, $1, $2;
            }' "$skills_stat_tmp" 2>/dev/null | LC_ALL=C sort | head -n "$manifest_cap"
            if [ "$skills_file_count" -gt "$manifest_cap" ] 2>/dev/null; then
                echo "  ... listing truncated at ${manifest_cap} of ${skills_file_count} files"
            fi
            rm -f "$skills_stat_tmp"
        done
    } > "$manifest_file" 2>&1
}

parse_args() {
    local duration_provided=false
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --advanced)
                COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
                echo -e "${YELLOW}🚀 Advanced mode enabled - will check for additional containers${NC}"
                ;;
            --live)
                LIVE_MODE=true
                ;;
            --duration)
                shift
                if [ "$#" -eq 0 ]; then
                    echo -e "${RED}--duration requires a whole number of seconds${NC}" >&2
                    return 1
                fi
                LIVE_DURATION="$1"
                duration_provided=true
                ;;
            --duration=*)
                LIVE_DURATION="${1#*=}"
                duration_provided=true
                ;;
            --help|-h)
                echo "Usage: $0 [--advanced] [--live [--duration SECONDS]] [--help]"
                echo "  --advanced : Include containers from docker-compose.advanced.yml"
                echo "  --live     : Sample database locks and the transaction ledger (default: 30s)"
                echo "  --duration : Live sampling duration from 1 to 120 seconds"
                echo "  --help     : Show this help message"
                return 2
                ;;
            *)
                echo -e "${RED}Unknown argument: $1${NC}" >&2
                return 1
                ;;
        esac
        shift
    done

    if ! [[ "$LIVE_DURATION" =~ ^[0-9]+$ ]] \
        || [ "$LIVE_DURATION" -lt 1 ] \
        || [ "$LIVE_DURATION" -gt 120 ]; then
        echo -e "${RED}Live duration must be a whole number from 1 to 120 seconds${NC}" >&2
        return 1
    fi
    if [ "$LIVE_MODE" != true ] && [ "$duration_provided" = true ]; then
        echo -e "${RED}--duration requires --live${NC}" >&2
        return 1
    fi
}

find_running_open_webui_container() {
    [ "$HAS_DOCKER" = true ] || return 1
    local running container
    running="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
    for container in portico-open-webui open-webui; do
        if printf '%s\n' "$running" | grep -Fxq "$container"; then
            printf '%s\n' "$container"
            return 0
        fi
    done
    return 1
}

collect_database_diagnostics_snapshot() {
    local container="$1"
    local output_file="$2"
    local temp_file="${output_file}.tmp"

    if ! docker exec -i "$container" python - > "$temp_file" 2>/dev/null <<'PY'
import datetime
import json
import os
import pathlib
import urllib.error
import urllib.request

sampled_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

def emit(snapshot=None, reason=None, status=None, error_type=None):
    value = {"sampledAt": sampled_at, "available": snapshot is not None}
    if snapshot is not None:
        value["snapshot"] = snapshot
    if reason is not None:
        value["reason"] = reason
    if status is not None:
        value["httpStatus"] = status
    if error_type is not None:
        value["errorType"] = error_type
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))

secret = ""
secret_file = os.environ.get("OWUI_AUTH_BRIDGE_SECRET_FILE", "").strip()
if secret_file:
    try:
        secret = pathlib.Path(secret_file).read_text(encoding="utf-8").strip()
    except OSError:
        pass
if not secret:
    secret = os.environ.get("OWUI_AUTH_BRIDGE_SECRET", "").strip()
if not secret:
    emit(reason="bridge_secret_unavailable")
    raise SystemExit(0)

port = os.environ.get("PORT", "8080").strip() or "8080"
url = f"http://127.0.0.1:{port}/api/v1/portico/auth/diagnostics/database"
request = urllib.request.Request(
    url,
    headers={"Authorization": f"Bearer {secret}", "Accept": "application/json"},
)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    NoRedirect(),
)
try:
    with opener.open(request, timeout=1) as response:
        emit(snapshot=json.load(response))
except urllib.error.HTTPError as error:
    emit(reason="endpoint_http_error", status=error.code)
except Exception as error:
    emit(reason="endpoint_unavailable", error_type=type(error).__name__)
PY
    then
        printf '%s\n' '{"available":false,"reason":"container_exec_failed"}' > "$temp_file"
    fi

    mv "$temp_file" "$output_file"
}

capture_container_database_runtime_state() {
    local container="$1"
    local output_file="$2"

    if ! docker exec -i "$container" bash -s > "$output_file" 2>&1 <<'SH'
set +e
echo "=== Capture time ==="
date -u +%Y-%m-%dT%H:%M:%S.%NZ
echo
echo "=== SQLite files ==="
for file in /app/backend/data/webui.db /app/backend/data/webui.db-wal /app/backend/data/webui.db-shm /app/backend/data/webui.db-journal; do
    if [ -e "$file" ]; then
        stat -Lc 'path=%n device=%d inode=%i size=%s mtime=%Y mode=%a' "$file"
    else
        echo "path=$file state=absent"
    fi
done
echo
echo "=== Kernel lock table ==="
cat /proc/locks 2>/dev/null || echo "unavailable"
echo
echo "=== Processes (name/state/wait channel only) ==="
for status_file in /proc/[0-9]*/status; do
    [ -r "$status_file" ] || continue
    pid="${status_file#/proc/}"
    pid="${pid%/status}"
    name="$(awk '/^Name:/{print $2; exit}' "$status_file" 2>/dev/null)"
    state="$(awk '/^State:/{print $2; exit}' "$status_file" 2>/dev/null)"
    wchan="$(cat "/proc/$pid/wchan" 2>/dev/null)"
    printf 'pid=%s name=%s state=%s wchan=%s\n' "$pid" "$name" "$state" "$wchan"
done
echo
echo "=== File descriptors targeting webui.db files ==="
for fd in /proc/[0-9]*/fd/*; do
    [ -L "$fd" ] || continue
    target="$(readlink "$fd" 2>/dev/null)"
    case "$target" in
        /app/backend/data/webui.db*) printf '%s -> %s\n' "$fd" "$target" ;;
    esac
done
SH
    then
        printf '%s\n' "container runtime state unavailable" > "$output_file"
    fi
}

capture_host_database_lsof() {
    local output_file="$1"
    local phase="${2:-snapshot}"
    {
        echo "=== Host database lsof: ${phase} ==="
        date -u +%Y-%m-%dT%H:%M:%SZ
        if ! command -v lsof >/dev/null 2>&1; then
            echo "lsof unavailable"
            return
        fi
        local files=()
        while IFS= read -r file; do files+=("$file"); done < <(
            find "${PROJECT_ROOT}/open-webui-data" -maxdepth 1 -type f -name 'webui.db*' 2>/dev/null || true
        )
        if [ "${#files[@]}" -eq 0 ]; then
            echo "no host database files found"
            return
        fi
        # Field output intentionally excludes lsof's USER/login column.
        lsof -Fpcftn -- "${files[@]}" 2>&1 \
            | while IFS= read -r line; do sanitize_home_in_text "$line"; done \
            || echo "no matching host processes or lsof failed"
    } >> "$output_file" 2>&1
}

capture_container_database_live_samples() {
    local container="$1"
    local duration="$2"
    local output_file="$3"

    if ! docker exec -i "$container" bash -s -- "$duration" > "$output_file" 2>&1 <<'SH'
set +e
duration="$1"
deadline=$(( $(date +%s) + duration ))
previous_locks=""
last_stack_at=0

capture_fds() {
    echo "fd_mapping_reason=$1"
    for fd in /proc/[0-9]*/fd/*; do
        [ -L "$fd" ] || continue
        target="$(readlink "$fd" 2>/dev/null)"
        case "$target" in
            /app/backend/data/webui.db*) printf '%s -> %s\n' "$fd" "$target" ;;
        esac
    done
}

capture_wait_stacks() {
    now="$(date +%s)"
    [ $((now - last_stack_at)) -ge 5 ] || return
    last_stack_at="$now"
    echo "--- database process kernel wait stacks ---"
    for fd in /proc/[0-9]*/fd/*; do
        [ -L "$fd" ] || continue
        target="$(readlink "$fd" 2>/dev/null)"
        case "$target" in
            /app/backend/data/webui.db*)
                pid="${fd#/proc/}"; pid="${pid%%/*}"
                echo "pid=$pid"
                cat "/proc/$pid/stack" 2>/dev/null || echo "stack unavailable"
                ;;
        esac
    done
}

capture_fds start
index=0
while [ "$(date +%s)" -lt "$deadline" ]; do
    index=$((index + 1))
    echo "=== lock sample $index ==="
    date -u +%Y-%m-%dT%H:%M:%S.%NZ
    locks="$(cat /proc/locks 2>/dev/null)"
    printf '%s\n' "${locks:-<empty>}"
    if [ "$locks" != "$previous_locks" ]; then
        capture_fds lock-table-transition
        [ -n "$locks" ] && capture_wait_stacks
        previous_locks="$locks"
    fi
    if [ $((index % 4)) -eq 1 ]; then
        echo "--- one-second process/file sample ---"
        for file in /app/backend/data/webui.db /app/backend/data/webui.db-wal /app/backend/data/webui.db-shm /app/backend/data/webui.db-journal; do
            [ -e "$file" ] && stat -Lc 'path=%n device=%d inode=%i size=%s mtime=%Y' "$file"
        done
        for status_file in /proc/[0-9]*/status; do
            [ -r "$status_file" ] || continue
            pid="${status_file#/proc/}"; pid="${pid%/status}"
            name="$(awk '/^Name:/{print $2; exit}' "$status_file" 2>/dev/null)"
            state="$(awk '/^State:/{print $2; exit}' "$status_file" 2>/dev/null)"
            wchan="$(cat "/proc/$pid/wchan" 2>/dev/null)"
            printf 'pid=%s name=%s state=%s wchan=%s\n' "$pid" "$name" "$state" "$wchan"
        done
    fi
    sleep 0.25
done
capture_fds end
SH
    then
        printf '%s\n' "live container sampling unavailable" > "$output_file"
    fi
}

capture_database_live_samples() (
    local debug_dir="$1"
    local container="$2"
    local duration="$3"
    local ledger_file="${debug_dir}/database-ledger-live.jsonl"
    local os_file="${debug_dir}/database-os-live.txt"
    local lsof_file="${debug_dir}/database-host-lsof.txt"
    local sample_file="${ledger_file}.sample"
    local os_sampler_pid=""

    cleanup_database_live_samples() {
        local cleanup_pid="$os_sampler_pid"
        os_sampler_pid=""
        if [ -n "$cleanup_pid" ]; then
            kill "$cleanup_pid" 2>/dev/null || true
            wait "$cleanup_pid" 2>/dev/null || true
        fi
        rm -f "$sample_file"
    }
    trap cleanup_database_live_samples EXIT
    trap 'exit 130' INT TERM HUP

    log "  • Sampling database diagnostics for ${duration}s..."
    : > "$ledger_file"
    : > "$lsof_file"
    capture_host_database_lsof "$lsof_file" start
    capture_container_database_live_samples "$container" "$duration" "$os_file" &
    os_sampler_pid=$!

    local end_time=$((SECONDS + duration))
    while [ "$SECONDS" -lt "$end_time" ]; do
        collect_database_diagnostics_snapshot "$container" "$sample_file"
        cat "$sample_file" >> "$ledger_file"
        rm -f "$sample_file"
        [ "$SECONDS" -lt "$end_time" ] && sleep 1
    done

    wait "$os_sampler_pid" || true
    os_sampler_pid=""
    capture_host_database_lsof "$lsof_file" end
)

resolve_app_logs_dir() {
    local fallback_dir="${HOME}/Library/Logs/Portico"

    if [ -d "$APP_LOGS_DIR" ]; then
        printf '%s\n' "$APP_LOGS_DIR"
        return
    fi

    if [ -z "$APP_LOGS_DIR_OVERRIDE" ] && [ -d "$fallback_dir" ]; then
        printf '%s\n' "$fallback_dir"
        return
    fi

    printf '%s\n' "$APP_LOGS_DIR"
}

is_debug_bundle_artifact() {
    local base_name
    base_name="$(basename "$1")"
    case "$base_name" in
        debug_logs_*.zip|debug-info-*.log)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Emit a machine-readable progress marker for the Electron progress pill.
# Plain stdout (no color/timestamp) so the main process can parse it:
#   [PROGRESS] <percent> <label>
# Percent checkpoints are hand-tuned to the measured phase time shares; the
# redaction loop interpolates its range by files completed.
progress_update() {
    echo "[PROGRESS] $1 $2"
}

archive_recent_app_support_logs() {
    local app_logs_dir="$1"
    local debug_dir="$2"
    local latest_app_log=""
    local latest_app_mtime=0
    local latest_error_log=""
    local latest_error_mtime=0
    local latest_init_log=""
    local latest_init_mtime=0
    local latest_update_log=""
    local latest_update_mtime=0
    local copied_count=0
    local prefixes=(
        "update-app-install-"
        "update-prep-"
        "install-"
        "prereq-"
        "update-"
        "init-"
        "health-sync-"
        "oauth-"
        "single-server-"
        "console-"
        "app-"
        "error-"
    )

    if [ ! -d "$app_logs_dir" ]; then
        log "  • No Portico application logs found at: $app_logs_dir"
        return 1
    fi

    progress_update 25 "Copying application logs"
    log "  • Capturing Portico application logs from: $app_logs_dir"
    mkdir -p "${debug_dir}/all-app-logs"

    local prefix
    for prefix in "${prefixes[@]}"; do
        local log_file
        for log_file in "${app_logs_dir}/${prefix}"*.log; do
            [ -f "$log_file" ] || continue
            is_debug_bundle_artifact "$log_file" && continue
            is_recent_file "$log_file" || continue

            local base_name
            local log_mtime
            base_name="$(basename "$log_file")"
            log_mtime=$(file_mtime "$log_file")

            case "$base_name" in
                app-*.log)
                    if [ "$log_mtime" -gt "$latest_app_mtime" ]; then
                        latest_app_mtime="$log_mtime"
                        latest_app_log="$log_file"
                    fi
                    ;;
                error-*.log)
                    if [ "$log_mtime" -gt "$latest_error_mtime" ]; then
                        latest_error_mtime="$log_mtime"
                        latest_error_log="$log_file"
                    fi
                    ;;
                init-*.log)
                    if [ "$log_mtime" -gt "$latest_init_mtime" ]; then
                        latest_init_mtime="$log_mtime"
                        latest_init_log="$log_file"
                    fi
                    ;;
                update-*.log|update-prep-*.log|update-app-install-*.log)
                    if [ "$log_mtime" -gt "$latest_update_mtime" ]; then
                        latest_update_mtime="$log_mtime"
                        latest_update_log="$log_file"
                    fi
                    ;;
            esac

            if [ ! -f "${debug_dir}/all-app-logs/${base_name}" ]; then
                cp "$log_file" "${debug_dir}/all-app-logs/${base_name}" 2>/dev/null
                copied_count=$((copied_count + 1))
            fi
        done
    done

    if [ -n "$latest_app_log" ]; then
        log "    • Copying app log: $(basename "$latest_app_log")"
        cp "$latest_app_log" "${debug_dir}/portico-app.log"
    else
        log "    • No recent app logs found within the last ${DEBUG_LOG_MAX_AGE_HOURS}h"
    fi

    if [ -n "$latest_error_log" ]; then
        log "    • Copying error log: $(basename "$latest_error_log")"
        cp "$latest_error_log" "${debug_dir}/portico-error.log"
    else
        log "    • No recent error logs found within the last ${DEBUG_LOG_MAX_AGE_HOURS}h"
    fi

    if [ -n "$latest_init_log" ]; then
        log "    • Copying initialization log: $(basename "$latest_init_log")"
        cp "$latest_init_log" "${debug_dir}/initialization.log"
    fi

    if [ -n "$latest_update_log" ]; then
        log "    • Copying latest update-family log: $(basename "$latest_update_log")"
        cp "$latest_update_log" "${debug_dir}/update-latest.log"
    fi

    if [ "$copied_count" -gt 0 ]; then
        log "    • Archived recent application logs (${copied_count} total)..."
    else
        log "    • No recent application logs matched the configured prefixes"
    fi

    return 0
}

extract_health_sync_text_field() {
    local field="$1"
    case "$field" in
        event)
            awk -F'|' '{ value=$3; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print value; }' | tail -n 1
            ;;
        run_id)
            sed -n 's/.*|[[:space:]]*run=\([^|]*\).*/\1/p' | sed 's/[[:space:]]*$//' | tail -n 1
            ;;
        reason)
            sed -n 's/.*|[[:space:]]*reason=\([^|]*\).*/\1/p' | sed 's/[[:space:]]*$//' | tail -n 1
            ;;
        *)
            return 1
            ;;
    esac
}

write_health_sync_summary_section() {
    local title="$1"
    local pattern="$2"
    local log_file="$3"
    local output_file="$4"
    local line
    line="$(grep -E "$pattern" "$log_file" 2>/dev/null | tail -n 1 || true)"
    echo "${title}:" >> "$output_file"
    if [ -n "$line" ]; then
        printf '%s\n' "$line" >> "$output_file"
    else
        echo "  not found" >> "$output_file"
    fi
    echo >> "$output_file"
}

generate_health_sync_summary() {
    local debug_dir="$1"
    local logs_dir="${debug_dir}/all-app-logs"
    local output_file="${debug_dir}/health-sync-summary.txt"
    local latest_log

    {
        echo "Health sync summary"
        echo "==================="
        echo
    } > "$output_file"

    if [ ! -d "$logs_dir" ]; then
        echo "No all-app-logs directory was captured." >> "$output_file"
        return 0
    fi

    latest_log="$(ls -t "${logs_dir}"/health-sync-*.log 2>/dev/null | head -n 1 || true)"
    if [ -z "$latest_log" ] || [ ! -f "$latest_log" ]; then
        echo "No health-sync-*.log file was captured." >> "$output_file"
        return 0
    fi

    local latest_line latest_run_id latest_reason latest_event total_events
    latest_line="$(tail -n 1 "$latest_log" 2>/dev/null || true)"
    latest_run_id="$(printf '%s\n' "$latest_line" | extract_health_sync_text_field "run_id")"
    latest_reason="$(printf '%s\n' "$latest_line" | extract_health_sync_text_field "reason")"
    latest_event="$(printf '%s\n' "$latest_line" | extract_health_sync_text_field "event")"
    total_events="$(wc -l < "$latest_log" 2>/dev/null | tr -d '[:space:]')"

    {
        echo "latest_log: $(basename "$latest_log")"
        echo "total_events: ${total_events:-0}"
        echo "latest_run_id: ${latest_run_id:-unknown}"
        echo "latest_reason: ${latest_reason:-unknown}"
        echo "latest_event: ${latest_event:-unknown}"
        echo
    } >> "$output_file"

    write_health_sync_summary_section \
        "last_anomaly_or_failure" \
        '(health_sync_failure|health_sync_retry|owui_model_inventory_error|owui_json_parse_error|model_sync_marker_invalidated|health_sync_runner_timeout|health_sync_runner_stop_failed|health_sync_runner_failure)' \
        "$latest_log" \
        "$output_file"
    write_health_sync_summary_section \
        "last_marker_decision" \
        'model_sync_marker_decision' \
        "$latest_log" \
        "$output_file"
    write_health_sync_summary_section \
        "last_model_inventory" \
        'owui_model_inventory_loaded' \
        "$latest_log" \
        "$output_file"
    write_health_sync_summary_section \
        "last_runner_timeout" \
        'health_sync_runner_timeout' \
        "$latest_log" \
        "$output_file"
    write_health_sync_summary_section \
        "last_runner_queued_retry" \
        'health_sync_runner_queued_retry' \
        "$latest_log" \
        "$output_file"
}

no_proxy_contains_entry() {
    local no_proxy_value="$1"
    local required_entry="$2"
    local normalized
    normalized="$(printf '%s' "$no_proxy_value" | tr '[:upper:]' '[:lower:]' | tr ' ' ',')"
    required_entry="$(printf '%s' "$required_entry" | tr '[:upper:]' '[:lower:]')"

    case ",${normalized}," in
        *",${required_entry},"*) return 0 ;;
        *) return 1 ;;
    esac
}

write_proxy_diagnostic_for_container_env() {
    local container="$1"
    local env_lines="$2"
    local output_file="$3"
    load_internal_no_proxy_required_from_routes

    local has_proxy=false
    local no_proxy_value=""
    local line key value

    while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
            *=*) ;;
            *) continue ;;
        esac
        key="${line%%=*}"
        value="${line#*=}"
        case "$key" in
            HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)
                [ -n "$value" ] && has_proxy=true
                ;;
            NO_PROXY|no_proxy)
                if [ -n "$value" ]; then
                    if [ -n "$no_proxy_value" ]; then
                        no_proxy_value="${no_proxy_value},${value}"
                    else
                        no_proxy_value="$value"
                    fi
                fi
                ;;
        esac
    done <<< "$env_lines"

    local missing=()
    if [ "$has_proxy" = true ]; then
        local required
        for required in "${INTERNAL_NO_PROXY_REQUIRED[@]}"; do
            if ! no_proxy_contains_entry "$no_proxy_value" "$required"; then
                missing+=("$required")
            fi
        done
    fi

    {
        echo "container: ${container}"
        echo "proxy_env_present: ${has_proxy}"
        echo "no_proxy_present: $([ -n "$no_proxy_value" ] && echo true || echo false)"
        if [ "$has_proxy" = true ] && [ "${#missing[@]}" -gt 0 ]; then
            echo "status: missing_internal_no_proxy"
            printf 'missing_internal_no_proxy_entries:'
            local missing_entry
            for missing_entry in "${missing[@]}"; do
                printf ' %s' "$missing_entry"
            done
            echo
        elif [ "$has_proxy" = true ]; then
            echo "status: ok"
        else
            echo "status: no_proxy_env_detected"
        fi
        echo
    } >> "$output_file"
}

capture_proxy_diagnostics() {
    local debug_dir="$1"
    shift
    local output_file="${debug_dir}/proxy-diagnostics.txt"

    {
        echo "Internal proxy bypass diagnostics"
        echo "================================="
        echo "Proxy values are intentionally not recorded."
        echo
    } > "$output_file"

    if [ "$HAS_DOCKER" != true ]; then
        echo "Docker not available; proxy diagnostics skipped." >> "$output_file"
        return
    fi

    local container
    for container in "$@"; do
        if docker ps -a --format "{{.Names}}" | grep -q "^${container}$"; then
            local env_lines
            env_lines="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null || true)"
            write_proxy_diagnostic_for_container_env "$container" "$env_lines" "$output_file"
        else
            {
                echo "container: ${container}"
                echo "status: not_found"
                echo
            } >> "$output_file"
        fi
    done
}

# Function to redact sensitive values from a file
redact_file() {
    local file="$1"
    local temp_file="${file}.tmp"
    
    if [ ! -f "$file" ]; then
        return
    fi

    case "$(basename "$file")" in
        mcp_toggles.json|mcp_toggles_snapshot.json)
            # These files contain server ids and booleans only. Redacting their
            # values into placeholders makes the captured JSON unusable for
            # startup-health forensics.
            return 0
            ;;
    esac
    
    # Fast path: one perl invocation applies the .env patterns AND the
    # generic patterns together (byte-identical output to the sed paths,
    # ~10x faster).
    if [ -n "$PERL_REDACTION_SCRIPT" ] && [ -f "$PERL_REDACTION_SCRIPT" ]; then
        if perl -p "$PERL_REDACTION_SCRIPT" "$file" > "$temp_file" 2>/dev/null; then
            mv "$temp_file" "$file"
            return 0
        fi
        rm -f "$temp_file"
    fi

    # sed fallback path. Start with the original file.
    cp "$file" "$temp_file"

    # Redact .env values in a single pass (faster for large logs)
    if [ -n "$REDACTION_SED_FILE" ] && [ -f "$REDACTION_SED_FILE" ]; then
        apply_sed_file "$REDACTION_SED_FILE" "$temp_file"
    fi

    # Generic redactions for common secret patterns in logs: one combined
    # pass over the file. Fall back to per-pattern passes if the combined
    # script is unavailable or sed rejects it — never skip redaction.
    if [ -n "$GENERIC_REDACTION_SED_FILE" ] && [ -f "$GENERIC_REDACTION_SED_FILE" ] \
        && apply_sed_file "$GENERIC_REDACTION_SED_FILE" "$temp_file"; then
        :
    else
        local generic_pattern
        for generic_pattern in "${GENERIC_REDACTION_PATTERNS[@]}"; do
            sed_inplace "$generic_pattern" "$temp_file"
        done
    fi

    # Move the redacted file back
    mv "$temp_file" "$file"
}

capture_system_info() {
    local debug_dir="$1"

    # Capture Electron runtime launch diagnostics if available
    local runtime_diagnostics="${PROJECT_ROOT}/runtime_diagnostics_temp.txt"
    if [ -f "$runtime_diagnostics" ] && is_recent_file "$runtime_diagnostics"; then
        log "  • Capturing runtime diagnostics..."
        cp "$runtime_diagnostics" "${debug_dir}/runtime_diagnostics.txt"
    fi

    # Capture any stale guided-setup app build metadata that survived on disk
    if [ -d "${PROJECT_ROOT}/guided-setup" ]; then
        local stale_guided_setup_builds="${debug_dir}/stale-guided-setup-app-build-info.txt"
        find "${PROJECT_ROOT}/guided-setup" \
            -path "*/Portico.app/Contents/Resources/build-info.json" \
            -type f \
            -print 2>/dev/null | sort | while IFS= read -r build_info_path; do
                {
                    echo "=== ${build_info_path} ==="
                    cat "$build_info_path"
                    echo
                } >> "$stale_guided_setup_builds"
            done
        if [ -f "$stale_guided_setup_builds" ]; then
            log "  • Captured stale guided-setup app build metadata"
        fi
    fi
}

capture_runtime_launch_diagnostics() {
    capture_system_info "$1"
}

capture_runtime_fingerprint() {
    local debug_dir="$1"
    local output_file="${debug_dir}/runtime-fingerprint.txt"

    {
        echo "Runtime fingerprint"
        echo "==================="
        echo
        echo "project_root: ${PROJECT_ROOT}"
        echo "cwd: $(pwd)"
        echo "app_logs_dir: $(resolve_app_logs_dir)"
        echo "debug_output_root: ${DEBUG_OUTPUT_ROOT}"
        echo "project_root_override: ${PROJECT_ROOT_OVERRIDE:-<unset>}"
        echo "app_logs_dir_override: ${APP_LOGS_DIR_OVERRIDE:-<unset>}"
        echo

        echo "Git state"
        echo "---------"
        if command -v git >/dev/null 2>&1 && git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            local branch head upstream ahead behind
            branch="$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null || true)"
            head="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || true)"
            upstream="$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
            echo "current_branch: ${branch:-<detached>}"
            echo "head_sha: ${head:-unknown}"
            echo "upstream: ${upstream:-<none>}"
            if [ -n "$upstream" ]; then
                read -r ahead behind < <(git -C "$PROJECT_ROOT" rev-list --left-right --count "HEAD...${upstream}" 2>/dev/null || echo "unknown unknown")
                echo "ahead_count: ${ahead:-unknown}"
                echo "behind_count: ${behind:-unknown}"
            fi
            echo
            echo "git_status:"
            git -C "$PROJECT_ROOT" status --short --branch 2>/dev/null || true
            echo
            echo "git_last_commit:"
            git -C "$PROJECT_ROOT" log -1 --format='%H %D %s' 2>/dev/null || true
        else
            echo "git_state_unavailable: true"
        fi

        echo
        echo "Build info"
        echo "----------"
        if [ -f "${PROJECT_ROOT}/electron-app/build-info.json" ]; then
            echo "build_info_path: ${PROJECT_ROOT}/electron-app/build-info.json"
            sed -n '1,80p' "${PROJECT_ROOT}/electron-app/build-info.json"
        else
            echo "build_info_path: <missing>"
        fi

        echo
        echo "Runtime diagnostics"
        echo "-------------------"
        if [ -f "${PROJECT_ROOT}/runtime_diagnostics_temp.txt" ] && is_recent_file "${PROJECT_ROOT}/runtime_diagnostics_temp.txt"; then
            echo "runtime_diagnostics_temp: present"
            sed -n '1,120p' "${PROJECT_ROOT}/runtime_diagnostics_temp.txt"
        else
            echo "runtime_diagnostics_temp: <missing>"
        fi
    } > "$output_file" 2>&1
}

# Function to capture debug logs
capture_debug_logs() {
    local timestamp=$(date +%s)
    local debug_dir_name="debug_logs_${timestamp}"
    local debug_dir="${DEBUG_OUTPUT_ROOT}/${debug_dir_name}"
    
    log "📁 Creating debug logs directory: ${debug_dir}"
    mkdir -p "${debug_dir}"

    # PORTICO-373: record WHY the bundle has no Docker diagnostics, so a partial
    # bundle reads as a deliberate degradation rather than as missing evidence.
    if docker_calls_are_skipped; then
        {
            echo "Docker diagnostics were skipped for this bundle."
            echo "reason: ${DEBUG_DOCKER_PREFLIGHT_STATUS}"
            echo
            echo "The container engine accepted connections but did not answer a"
            echo "bounded probe before collection started, so every Docker call was"
            echo "skipped rather than left to block. Everything not requiring the"
            echo "engine is present in this bundle."
        } > "${debug_dir}/docker-diagnostics-skipped.txt"
    fi

    # List of containers from docker-compose.yml
    local containers=("$LLM_GATEWAY_CONTAINER_NAME" "mcpo" "portico-open-webui" "open-webui" "open-webui-health-check" "chat-state-api")

    if [ "$HAS_DOCKER" = true ]; then
        local database_container=""
        database_container="$(find_running_open_webui_container || true)"
        if [ -n "$database_container" ]; then
            if [ "$LIVE_MODE" = true ]; then
                capture_database_live_samples "$debug_dir" "$database_container" "$LIVE_DURATION"
            fi
            progress_update 3 "Capturing database diagnostics"
    log "  • Capturing bounded database transaction diagnostics..."
            collect_database_diagnostics_snapshot \
                "$database_container" \
                "${debug_dir}/database-diagnostics.json"
            capture_container_database_runtime_state \
                "$database_container" \
                "${debug_dir}/database-runtime.txt"
            capture_host_database_lsof \
                "${debug_dir}/database-host-lsof.txt" \
                snapshot
        else
            printf '%s\n' '{"available":false,"reason":"open_webui_container_not_running"}' \
                > "${debug_dir}/database-diagnostics.json"
            printf '%s\n' "Open WebUI container is not running" \
                > "${debug_dir}/database-runtime.txt"
        fi

        progress_update 6 "Capturing container logs"
        log "📝 Capturing logs from all containers (since ${DEBUG_DOCKER_LOG_SINCE})..."

        # Containers are captured concurrently: this phase is dominated by
        # per-container docker CLI round-trips, not data volume.
        local all_container_names
        all_container_names=$(docker ps -a --format "{{.Names}}" 2>/dev/null)
        for container in "${containers[@]}"; do
            if printf '%s\n' "$all_container_names" | grep -q "^${container}$"; then
            (
                log "  • Capturing logs for ${container}..."
                docker logs --timestamps --since "${DEBUG_DOCKER_LOG_SINCE}" "${container}" &> "${debug_dir}/${container}.log" 2>&1

                # Capture container inspect data but redact sensitive environment variables.
                # FAIL-CLOSED: when jq is unavailable or the sanitization pipe fails, do
                # NOT fall back to raw `docker inspect` — its Env section carries real
                # secrets. The fallback is an allowlisted field subset selected via a Go
                # template, which cannot include Env by construction; if even that fails,
                # a note is written instead. Raw inspect output is never bundled.
                log "  • Capturing sanitized container config for ${container}..."
                if ! { command -v jq >/dev/null 2>&1 && docker inspect "${container}" 2>/dev/null | \
                    jq '.[0] |
                        if .Config.Env then
                            .Config.Env |= map(
                                if test("(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|AUTH|OPENAI|ANTHROPIC|GOOGLE|GLEAN|GITLAB|SLACK|JIRA|CONFLUENCE|PORTICO_LLM)")
                                then (split("=")[0] + "=<REDACTED>")
                                else .
                                end
                            )
                        else .
                        end |
                        if .Env then
                            .Env |= map(
                                if test("(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|AUTH|OPENAI|ANTHROPIC|GOOGLE|GLEAN|GITLAB|SLACK|JIRA|CONFLUENCE|PORTICO_LLM)")
                                then (split("=")[0] + "=<REDACTED>")
                                else .
                                end
                            )
                        else .
                        end' > "${debug_dir}/${container}_inspect.json" 2>/dev/null; }; then
                    docker inspect --format '{"note":"sanitized inspect unavailable (jq missing or failed); allowlisted fields only — container environment is never bundled unredacted","Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Config.Image}},"Created":{{json .Created}},"RestartCount":{{json .RestartCount}},"State":{{json .State}},"RestartPolicy":{{json .HostConfig.RestartPolicy}},"NetworkMode":{{json .HostConfig.NetworkMode}},"Mounts":{{json .Mounts}}}' \
                        "${container}" > "${debug_dir}/${container}_inspect.json" 2>/dev/null \
                        || printf '{"note":"container inspect omitted: sanitization and allowlisted fallback both failed"}\n' > "${debug_dir}/${container}_inspect.json"
                fi
            ) &
            else
                log "  • Container ${container} not found, skipping..."
            fi
        done
        wait
        capture_proxy_diagnostics "$debug_dir" "${containers[@]}"

        # Capture full logs for all running containers (concurrently — see above)
        progress_update 12 "Capturing container logs"
        log "  • Capturing full logs for all running containers (since ${DEBUG_DOCKER_LOG_SINCE})..."
        local docker_logs_dir="${debug_dir}/docker"
        mkdir -p "${docker_logs_dir}"
        local running_containers
        running_containers=$(docker ps --format "{{.Names}}")
        if [ -n "$running_containers" ]; then
            for container in $running_containers; do
                (
                    local safe_name
                    safe_name=$(echo "$container" | sed 's/[^A-Za-z0-9_.-]/_/g')
                    log "    • Capturing full logs for ${container}..."
                    docker logs --timestamps --since "${DEBUG_DOCKER_LOG_SINCE}" "${container}" &> "${docker_logs_dir}/${safe_name}.log" 2>&1
                ) &
            done
            wait
        else
            log "    • No running containers found"
        fi

    else
        warn "Docker not available - skipping container logs and Docker diagnostics"
    fi
    
    # Capture project configuration files and directories
    progress_update 18 "Copying configuration"
    log "  • Capturing project configuration files and directories..."
    local project_items=(
        "marketplaces.json"
        "mcp_config.json"
        "mcp_config_advanced.json"
        "mcp_config_host_sideload.json"
        "mcp_toggles.json"
        "mcp_tools_config.json"
        "docker-compose.override.yml"
        "docker-compose.harbor.yml"
        "mcp-configs"
        "mcpo-configs-generated"
        "health-status"
        "mcp-configs-user"
    )
    local missing_project_items=()

    for item in "${project_items[@]}"; do
        local src_path="${PROJECT_ROOT}/${item}"
        local dest_path="${debug_dir}/${item}"

        if [ -d "$src_path" ]; then
            log "    • Copying directory ${item}..."
            if ! cp -R "$src_path" "$dest_path" 2>/dev/null; then
                log "    ⚠️  Failed to copy directory ${item}"
                missing_project_items+=("$item")
            fi
        elif [ -f "$src_path" ]; then
            log "    • Copying file ${item}..."
            if ! cp "$src_path" "$dest_path" 2>/dev/null; then
                log "    ⚠️  Failed to copy file ${item}"
                missing_project_items+=("$item")
            fi
        else
            log "    • ${item} not found, skipping"
            missing_project_items+=("$item")
        fi
    done

    if [ "${#missing_project_items[@]}" -gt 0 ]; then
        {
            echo "Missing project items:"
            for item in "${missing_project_items[@]}"; do
                echo "  - ${item}"
            done
        } > "${debug_dir}/missing_project_items.txt"
    fi

    # Capture the scheduling daemon's task store (one JSON per task, with
    # embedded run history). This is the ground truth for diagnosing
    # scheduled-task failures — daemon logs do not survive container
    # re-creation, but these files do.
    #
    # PRIVACY: task files carry user content — the task prompt and per-run
    # response previews (which can be the assistant's entire final message).
    # We never copy the raw files. Each file is projected through a jq
    # ALLOWLIST that keeps only diagnostic fields (schedule, statuses,
    # timestamps, errors, ids) and replaces content fields with <REDACTED>;
    # unknown/future fields are dropped by construction. Without jq the
    # store is skipped entirely — fail closed, never ship raw content.
    progress_update 21 "Capturing scheduled tasks"
    log "  • Capturing scheduled task store (content redacted)..."
    local scheduled_task_sanitize_jq='
        def mark(v): if v == null then null else "<REDACTED>" end;
        {
            id, name, model_id, schedule, skill_ids, tool_server_ids, enabled,
            created_at, updated_at, next_run_at,
            last_run_at, last_run_status, last_run_chat_id, last_run_error,
            last_run_trigger, current_run,
            needs_attention, needs_attention_reason, needs_attention_since,
            prompt: mark(.prompt),
            last_run_response_preview: mark(.last_run_response_preview),
            runs: [ (.runs // [])[] | {
                run_id, chat_id, started_at, finished_at, status, trigger,
                error, needs_attention, needs_attention_reason,
                response_preview: mark(.response_preview)
            } ]
        }'
    local scheduled_tasks_candidates=()
    if [ -n "${PORTICO_APP_SUPPORT_DIR:-}" ]; then
        scheduled_tasks_candidates+=("${PORTICO_APP_SUPPORT_DIR}/scheduled_tasks")
    fi
    scheduled_tasks_candidates+=(
        "${HOME}/Library/Application Support/portico/scheduled_tasks"
        "${PROJECT_ROOT}/open-webui-data/app-support/scheduled_tasks"
    )
    # Inventory the skill roots WITHOUT shipping their content (skill
    # bodies are user/marketplace-authored and can carry sensitive
    # material). Best-effort: a manifest failure must never break the
    # rest of the collection.
    progress_update 23 "Writing skills manifest"
    log "  • Capturing skills manifest (metadata only, no content)..."
    if ! capture_skills_manifest "$debug_dir"; then
        log "    ⚠️  Skills manifest capture failed; continuing without it"
    fi

    if ! command -v jq &> /dev/null; then
        log "    ⚠️  jq unavailable - skipping scheduled task store (raw task files contain user content and are never copied unredacted)"
    else
        local scheduled_tasks_captured=false
        for scheduled_tasks_dir in "${scheduled_tasks_candidates[@]}"; do
            [ -d "$scheduled_tasks_dir" ] || continue
            log "    • Sanitizing scheduled task files from ${scheduled_tasks_dir}..."
            mkdir -p "${debug_dir}/scheduled-tasks"
            local task_file
            for task_file in "$scheduled_tasks_dir"/*.json; do
                [ -f "$task_file" ] || continue
                local task_base
                task_base=$(basename "$task_file")
                if jq "$scheduled_task_sanitize_jq" "$task_file" \
                    > "${debug_dir}/scheduled-tasks/${task_base}" 2>/dev/null; then
                    scheduled_tasks_captured=true
                else
                    rm -f "${debug_dir}/scheduled-tasks/${task_base}"
                    log "    ⚠️  Failed to sanitize ${task_base}; skipped (not copied raw)"
                fi
            done
            break
        done
        if [ "$scheduled_tasks_captured" = false ]; then
            log "    • No scheduled task store found, skipping"
        fi
    fi

    local app_logs_dir
    app_logs_dir="$(resolve_app_logs_dir)"
    archive_recent_app_support_logs "$app_logs_dir" "$debug_dir"
    generate_health_sync_summary "$debug_dir"

    # Capture initialization and update logs from legacy project locations only as fallback
    if [ -d "logs" ]; then
        if [ ! -f "${debug_dir}/initialization.log" ]; then
            local latest_init_log=""
            local latest_init_mtime=0
            local init_log
            for init_log in logs/init_*.log; do
                if [ -f "$init_log" ] && is_recent_file "$init_log"; then
                    local init_mtime
                    init_mtime=$(file_mtime "$init_log")
                    if [ "$init_mtime" -gt "$latest_init_mtime" ]; then
                        latest_init_mtime="$init_mtime"
                        latest_init_log="$init_log"
                    fi
                fi
            done

            if [ -n "$latest_init_log" ]; then
                log "  • Capturing legacy initialization logs from: $(basename "$latest_init_log")..."
                cp "$latest_init_log" "${debug_dir}/initialization.log"
            else
                log "  • No recent legacy initialization logs found in logs directory"
            fi
        else
            log "  • Initialization log already captured from Application Support logs"
        fi

        log "  • Checking for legacy update logs..."
        if [ ! -f "${debug_dir}/update-latest.log" ] && [ -f "logs/update-latest.log" ] && is_recent_file "logs/update-latest.log"; then
            log "    • Capturing legacy latest update log..."
            cp "logs/update-latest.log" "${debug_dir}/update-latest.log"
        fi

        if [ ! -f "${debug_dir}/update-latest.log" ]; then
            local update_logs=()
            while IFS= read -r update_log; do
                if [ -f "$update_log" ] && is_recent_file "$update_log"; then
                    update_logs+=("$update_log")
                    if [ "${#update_logs[@]}" -ge 5 ]; then
                        break
                    fi
                fi
            done < <(ls -t logs/update-*.log 2>/dev/null)

            if [ "${#update_logs[@]}" -gt 0 ]; then
                log "    • Capturing legacy recent update logs (last ${#update_logs[@]})..."
                mkdir -p "${debug_dir}/update_logs"
                local update_log
                for update_log in "${update_logs[@]}"; do
                    log "      • $(basename "$update_log")"
                    cp "$update_log" "${debug_dir}/update_logs/$(basename "$update_log")"
                done
            else
                log "    • No recent legacy update logs found"
            fi
        else
            log "    • Update-family logs already captured from Application Support logs"
        fi

        if [ -f "electron-app/update.log" ] && is_recent_file "electron-app/update.log"; then
            log "    • Capturing legacy update log from electron-app..."
            cp "electron-app/update.log" "${debug_dir}/update-legacy.log"
        fi
    fi
    
    # Also capture temporary init logs if they exist (for legacy support)
    if [ -f "init_logs_temp.txt" ] && is_recent_file "init_logs_temp.txt"; then
        log "  • Capturing temporary initialization logs..."
        cp "init_logs_temp.txt" "${debug_dir}/initialization_temp.log"
    fi
    
    # Capture control panel logs if available
    if [ -f "control_panel_logs_temp.txt" ] && is_recent_file "control_panel_logs_temp.txt"; then
        log "  • Capturing control panel logs..."
        cp "control_panel_logs_temp.txt" "${debug_dir}/control_panel.log"
    fi

    capture_system_info "$debug_dir"
    capture_compose_cli_diagnostics "$debug_dir"
    progress_update 40 "Capturing update state"
    log "  • Capturing update pipeline state..."
    collect_update_pipeline_state "$debug_dir"
    
    # Capture build info from electron-app folder
    if [ -f "electron-app/build-info.json" ]; then
        progress_update 43 "Capturing system info"
        log "  • Capturing build information..."
        cp "electron-app/build-info.json" "${debug_dir}/build-info.json"
    else
        log "  • No build-info.json found in electron-app directory"
    fi

    log "  • Capturing runtime fingerprint..."
    capture_runtime_fingerprint "$debug_dir"
    
    # Capture docker-compose status
    if [ "$HAS_DOCKER_COMPOSE" = true ]; then
        log "  • Capturing docker-compose status..."
        run_docker_compose ${COMPOSE_FILES} ps -a > "${debug_dir}/docker-compose-status.txt" 2>&1
    else
        log "  • Skipping docker-compose status (docker-compose not available)"
    fi
    
    # Capture environment configuration (with sensitive data redacted)
    log "  • Capturing environment configuration..."
    if [ -f ".env" ]; then
        {
            echo "=== Environment Configuration (Sanitized) ==="
            echo "File: .env"
            echo "---"
            while IFS='=' read -r key value; do
                # Skip empty lines and comments
                if [[ -z "$key" ]] || [[ "$key" =~ ^[[:space:]]*# ]]; then
                    continue
                fi
                # Redact sensitive values
                if [[ "$key" =~ (API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|AUTH|OPENAI|ANTHROPIC|GOOGLE|GLEAN|GITLAB|SLACK|JIRA|CONFLUENCE|PORTICO_LLM) ]]; then
                    echo "${key}=<REDACTED>"
                else
                    echo "${key}=${value}"
                fi
            done < .env
            echo
        } > "${debug_dir}/env-sanitized.txt" 2>&1
    else
        echo ".env file not found" > "${debug_dir}/env-sanitized.txt"
    fi
    
    # Capture system info
    log "  • Capturing system information..."
    {
        echo "=== Docker Version ==="
        if [ "$HAS_DOCKER" = true ]; then
            docker version
        else
            echo "Docker not available"
        fi
        echo
        echo "=== Docker Compose Version ==="
        if [ "$HAS_DOCKER_COMPOSE" = true ]; then
            echo "Selected frontend: $DOCKER_COMPOSE_FRONTEND_RESOLVED"
            run_docker_compose version
        else
            echo "docker-compose not available"
        fi
        echo
        echo "=== Docker Networks ==="
        if [ "$HAS_DOCKER" = true ]; then
            docker network ls
        else
            echo "Docker not available"
        fi
        echo
        echo "=== Date/Time ==="
        date
    } > "${debug_dir}/system-info.txt" 2>&1
    
    # Capture running processes (helpful for debugging)
    log "  • Capturing container processes..."
    {
        if [ "$HAS_DOCKER" = true ]; then
            echo "=== All Docker Containers ==="
            docker ps -a
            echo
            echo "=== Running Containers ==="
            docker ps
            echo
            echo "=== Docker Network Configuration ==="
            docker network inspect portico-network 2>/dev/null || echo "Network not found"
            echo
            # App-scoped image inventory only (PORTICO-231): never capture the
            # user's full image table.
            echo "=== Portico Images ==="
            docker images --filter "reference=harbor.example.invalid/portico/*"
            docker images --filter "reference=agent-vm"
            docker images --filter "reference=portico-*"
        else
            echo "Docker not available - container info skipped"
        fi
    } > "${debug_dir}/docker-info.txt" 2>&1

    # Trim large log files to keep collection fast
    progress_update 47 "Trimming oversized logs"
    log "  • Trimming log files larger than ${DEBUG_LOG_MAX_BYTES_MB}MB..."
    local trimmed_count=0
    local trimmed_total=0
    while IFS= read -r -d '' log_file; do
        trimmed_total=$((trimmed_total + 1))
        local size_bytes
        if stat -c "%s" "$log_file" >/dev/null 2>&1; then
            size_bytes=$(stat -c "%s" "$log_file")
        elif stat -f "%z" "$log_file" >/dev/null 2>&1; then
            size_bytes=$(stat -f "%z" "$log_file")
        else
            size_bytes=0
        fi

        if [ "$size_bytes" -gt "$DEBUG_LOG_MAX_BYTES" ]; then
            log "    • Trimming $(basename "$log_file")..."
            trim_large_log_file "$log_file"
            trimmed_count=$((trimmed_count + 1))
        fi
    done < <(find "${debug_dir}" -type f \( -name "*.log" -o -name "*.txt" \) -print0)
    log "  • Trimmed ${trimmed_count}/${trimmed_total} log file(s)"
    
    # Create a summary file
    progress_update 51 "Writing summary"
    log "  • Creating summary..."
    {
        echo "Debug Logs Captured: $(date)"
        echo "=============================="
        echo
        echo "Collection Settings:"
        echo "--------------------"
        echo "  • Docker logs since: ${DEBUG_DOCKER_LOG_SINCE}"
        echo "  • Log file age limit: ${DEBUG_LOG_MAX_AGE_HOURS}h"
        echo "  • Log file size cap: ${DEBUG_LOG_MAX_BYTES_MB}MB (oldest and newest halves kept)"
        echo "  • Redaction concurrency: ${DEBUG_REDACTION_MAX_JOBS}"
        echo "  • Database live sampling: ${LIVE_MODE}"
        if [ "$LIVE_MODE" = true ]; then
            echo "  • Database live sampling duration: ${LIVE_DURATION}s"
        fi
        echo
        echo "Container Status:"
        echo "-----------------"
        if [ "$HAS_DOCKER" = true ]; then
            for container in "${containers[@]}"; do
                if docker ps -a --format "{{.Names}}" | grep -q "^${container}$"; then
                    status=$(docker inspect "${container}" --format='{{.State.Status}}' 2>/dev/null || echo "unknown")
                    exit_code=$(docker inspect "${container}" --format='{{.State.ExitCode}}' 2>/dev/null || echo "N/A")
                    echo "  • ${container}: Status=${status}, ExitCode=${exit_code}"
                else
                    echo "  • ${container}: Not found"
                fi
            done
        else
            echo "  • Docker not available"
        fi
        echo
        echo "Special Log Files:"
        echo "------------------"
        echo "  • LLM gateway logs: captured through docker logs when available"
        if [ -f "${debug_dir}/mcp_config_advanced.json" ]; then
            local log_size=$(ls -lh "${debug_dir}/mcp_config_advanced.json" | awk '{print $5}')
            echo "  • mcp_config_advanced.json: Size=${log_size}"
        else
            echo "  • mcp_config_advanced.json: Not captured"
        fi
        if [ -f "${debug_dir}/initialization.log" ]; then
            local log_size=$(ls -lh "${debug_dir}/initialization.log" | awk '{print $5}')
            echo "  • initialization.log: Size=${log_size}"
        fi
        if [ -f "${debug_dir}/control_panel.log" ]; then
            local log_size=$(ls -lh "${debug_dir}/control_panel.log" | awk '{print $5}')
            echo "  • control_panel.log: Size=${log_size}"
        fi
        if [ -f "${debug_dir}/build-info.json" ]; then
            local log_size=$(ls -lh "${debug_dir}/build-info.json" | awk '{print $5}')
            echo "  • build-info.json: Size=${log_size}"
        else
            echo "  • build-info.json: Not captured"
        fi
        if [ -f "${debug_dir}/runtime-fingerprint.txt" ]; then
            local fingerprint_size=$(ls -lh "${debug_dir}/runtime-fingerprint.txt" | awk '{print $5}')
            echo "  • runtime-fingerprint.txt: Size=${fingerprint_size}"
        else
            echo "  • runtime-fingerprint.txt: Not captured"
        fi
        echo
        echo "Project Items:"
        echo "--------------"
        if [ -f "${debug_dir}/missing_project_items.txt" ]; then
            cat "${debug_dir}/missing_project_items.txt"
        else
            echo "All requested project items captured"
        fi
        echo
        echo "Application Logs:"
        echo "-----------------"
        if [ -f "${debug_dir}/portico-app.log" ]; then
            local log_size=$(ls -lh "${debug_dir}/portico-app.log" | awk '{print $5}')
            echo "  • portico-app.log: Size=${log_size}"
        else
            echo "  • portico-app.log: Not captured"
        fi
        if [ -f "${debug_dir}/portico-error.log" ]; then
            local log_size=$(ls -lh "${debug_dir}/portico-error.log" | awk '{print $5}')
            echo "  • portico-error.log: Size=${log_size}"
        else
            echo "  • portico-error.log: Not captured"
        fi
        if [ -d "${debug_dir}/all-app-logs" ]; then
            local app_log_count=$(ls "${debug_dir}/all-app-logs"/*.log 2>/dev/null | wc -l | tr -d ' ')
            echo "  • all-app-logs/: ${app_log_count} logs archived"
        fi
        if [ -d "${debug_dir}/docker" ]; then
            local docker_log_count=$(ls "${debug_dir}/docker"/*.log 2>/dev/null | wc -l | tr -d ' ')
            echo "  • docker/: ${docker_log_count} container logs archived"
        fi
        # PORTICO-373: make the degradation visible in the first file a reader opens.
        if docker_calls_are_skipped; then
            echo "  • docker diagnostics: SKIPPED (${DEBUG_DOCKER_PREFLIGHT_STATUS}) - see docker-diagnostics-skipped.txt"
        fi
        echo
        echo "Files in this directory:"
        echo "------------------------"
        ls -la "${debug_dir}/"
    } > "${debug_dir}/summary.txt"
    
    progress_update 53 "Redacting sensitive information"
    log "🔒 Redacting sensitive information from log files..."
    
    build_redaction_sed_file
    if [ -n "$REDACTION_SED_FILE" ] && [ -f "$REDACTION_SED_FILE" ]; then
        local redaction_pattern_count
        redaction_pattern_count=$(wc -l < "$REDACTION_SED_FILE" | tr -d ' ')
        log "  • Loaded ${redaction_pattern_count} redaction pattern(s) from .env"
    else
        log "  • No .env redaction patterns loaded"
    fi
    build_generic_redaction_sed_file
    if [ -n "$GENERIC_REDACTION_SED_FILE" ]; then
        log "  • Compiled ${#GENERIC_REDACTION_PATTERNS[@]} generic redaction pattern(s) into a single pass"
    else
        log "  ⚠️  Could not compile combined redaction script; using per-pattern fallback"
    fi
    build_perl_redaction_script
    if [ -n "$PERL_REDACTION_SCRIPT" ]; then
        log "  • Using perl redaction engine (single pass, all patterns)"
    else
        log "  • perl unavailable or rejected the script; using sed redaction"
    fi

    local redaction_files=()
    while IFS= read -r -d '' logfile; do
        redaction_files+=("$logfile")
    done < <(find "${debug_dir}" -type f \( -name "*.log" -o -name "*.txt" -o -name "*.json" -o -name "*.yml" -o -name "*.yaml" -o -name "*.fragment" \) -print0)

    local redaction_total="${#redaction_files[@]}"
    if [ "${redaction_total}" -eq 0 ]; then
        log "  • No log files found for redaction"
    else
        log "  • Redacting ${redaction_total} file(s) with up to ${DEBUG_REDACTION_MAX_JOBS} concurrent job(s)..."
    fi

    # Strided chunk workers: each of the N workers processes every Nth file
    # sequentially. This replaces the per-file job spawner, whose
    # wait-for-a-slot polling (sleep 0.2 between each of hundreds of job
    # launches) cost more wall time than the redaction itself.
    local redaction_workers="$DEBUG_REDACTION_MAX_JOBS"
    if [ "$redaction_workers" -lt 1 ] 2>/dev/null; then
        redaction_workers=1
    fi
    local worker_id
    for worker_id in $(seq 0 $((redaction_workers - 1))); do
        (
            local file_index
            for ((file_index = worker_id; file_index < redaction_total; file_index += redaction_workers)); do
                local logfile="${redaction_files[$file_index]}"
                local start_time=$SECONDS
                log "    • Redacting $((file_index + 1))/${redaction_total}: ${logfile}"
                if redact_file "$logfile"; then
                    log "      ✓ Redacted in $((SECONDS - start_time))s"
                else
                    log "      ⚠️  Redaction failed for ${logfile}"
                fi
                if [ $(( (file_index + 1) % 10 )) -eq 0 ] || [ $((file_index + 1)) -eq "$redaction_total" ]; then
                    progress_update $(( 53 + ( (file_index + 1) * 38 ) / redaction_total )) "Redacting files ($((file_index + 1))/${redaction_total})"
                fi
            done
        ) &
    done

    wait

    if [ -n "$REDACTION_SED_FILE" ]; then
        rm -f "$REDACTION_SED_FILE"
        REDACTION_SED_FILE=""
    fi
    if [ -n "$GENERIC_REDACTION_SED_FILE" ]; then
        rm -f "$GENERIC_REDACTION_SED_FILE"
        GENERIC_REDACTION_SED_FILE=""
    fi
    if [ -n "$PERL_REDACTION_SCRIPT" ]; then
        rm -f "$PERL_REDACTION_SCRIPT"
        PERL_REDACTION_SCRIPT=""
    fi
    
    progress_update 92 "Compressing bundle"
    log "📦 Creating zip archive..."
    
    # Create zip file
    local zip_file="debug_logs_${timestamp}.zip"
    (cd "${DEBUG_OUTPUT_ROOT}" && zip -r "${zip_file}" "${debug_dir_name}" -q)
    
    if [ $? -eq 0 ]; then
        # Remove the unzipped directory
        rm -rf "${debug_dir}"
        
        progress_update 100 "Done"
        success "Debug logs captured and zipped: ${zip_file}"
        echo
        
        # Get absolute path for the zip file
        local abs_zip_path="${DEBUG_OUTPUT_ROOT}/${zip_file}"
        
        # Open Finder window to show the zip file (macOS)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            log "📂 Opening Finder to show the zip file..."
            open -R "${abs_zip_path}"
        fi
        
        echo -e "${GREEN}Debug information saved to: ${abs_zip_path}${NC}"
        echo
        log "💡 You can share this zip file for debugging purposes."
        log "   All sensitive information has been redacted."
    else
        error "Failed to create zip file"
        success "Debug logs captured in directory: ${debug_dir}"
        echo
        log "📋 You can examine the logs with:"
        echo -e "${YELLOW}    cd ${debug_dir}${NC}"
        echo -e "${YELLOW}    ls -la${NC}"
    fi
    echo
}

# Main execution
main() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Portico Debug Log Collector${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo
    
    # PORTICO-373: honour the caller's engine verdict BEFORE any discovery, so nothing
    # below can execute a daemon call that would hang. Presence of the binary is
    # not evidence the engine will answer.
    if docker_calls_are_skipped; then
        warn "Container engine is not responding (${DEBUG_DOCKER_PREFLIGHT_STATUS}) - collecting everything except Docker diagnostics"
        HAS_DOCKER=false
        HAS_DOCKER_COMPOSE=false
        install_skipped_container_engine_shims
    fi

    # Check if Docker is available
    if [ "$HAS_DOCKER" = true ] && ! command -v docker &> /dev/null; then
        warn "Docker is not installed or not in PATH - skipping Docker logs"
        HAS_DOCKER=false
        HAS_DOCKER_COMPOSE=false
    fi

    # Check whether either Docker Compose v2 frontend is available.
    if [ "$HAS_DOCKER" = true ]; then
        reset_docker_compose_frontend_cache
        if ! resolve_docker_compose_frontend; then
            warn "No usable Docker Compose v2 frontend is available - collecting probe diagnostics only"
            HAS_DOCKER_COMPOSE=false
        fi
    fi
    
    # Check if jq is available for JSON processing
    if ! command -v jq &> /dev/null; then
        log "⚠️  jq is not installed - sensitive data will NOT be redacted from debug logs"
        log "    Consider installing jq for better security: brew install jq (macOS) or apt-get install jq (Linux)"
    fi
    
    # Capture debug logs
    capture_debug_logs
    
    success "Debug log collection complete!"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    parse_args "$@"
    parse_status=$?
    if [ "$parse_status" -eq 2 ]; then
        exit 0
    fi
    if [ "$parse_status" -ne 0 ]; then
        exit "$parse_status"
    fi
    main
fi
