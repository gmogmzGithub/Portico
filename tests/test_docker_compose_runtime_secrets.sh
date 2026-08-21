#!/usr/bin/env bash
# Regression coverage for the Docker secrets runtime-secret ingress introduced
# as part of the security hardening pass. The goal is to assert, without
# touching Docker or macOS Keychain, that:
#   1. docker-compose.yml references /run/secrets/* paths rather than
#      plaintext env vars for the upstream and local Bifrost keys.
#   2. docker-compose.yml and docker-compose.advanced.yml do not reintroduce
#      retired OAuth token-store mounts or the historical OPENAI_API_KEY fallback.
#   3. Both compose files declare the top-level `secrets:` stanza defaulting to
#      `/dev/null` so read-only compose operations (`config`, `build`, `down`,
#      `pull`, `logs`) work without the ingress helper, and a stray
#      `docker compose up` still fails loudly at the application layer when
#      the container tries to read an empty secret.
#   4. `prepare_optional_file_secret_ingress` produces 0600-mode secret files
#      with 0700 directory permissions under a user-scoped cache dir
#      (`$HOME/Library/Caches/portico/runtime-secrets` on darwin, under
#      `$XDG_STATE_HOME` on linux), overridable via
#      `PORTICO_RUNTIME_SECRET_CACHE_DIR`, and keeps the files alive when the
#      invoking shell exits (containers bind-mount them for the stack's
#      lifetime). `cleanup_runtime_secret_tmpdir` must explicitly wipe the
#      directory when called, so the stop/down path can reclaim it.
#   5. `docker compose config` succeeds against the hardened compose files even
#      when the ingress helper has not been invoked (regression guard for the
#      clean_full.sh / install_v2.sh breakage caused by the earlier `:?`
#      default, which aborted build/down/config operations).
#   6. `docker-compose.sh stop_containers` invokes `cleanup_runtime_secret_tmpdir`
#      so that explicit teardown reclaims the cache dir (regression guard for
#      the "trap EXIT wipes bind-mount sources" bug that left restarted
#      containers with ENOENT on /run/secrets/*).
#   7. No container gets `env_file: .env` or a health-check bind mount of
#      `.env`, and generated per-server sensitive required env vars are wired
#      only through Docker secrets and *_FILE environment entries.
#   8. Startup detects the llm-gateway deleted bind-mount failure mode and
#      force-recreates only llm-gateway after re-preparing runtime secrets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=src/scripts/mcp-orc-generator-test-lib.sh
source "$PROJECT_ROOT/src/scripts/mcp-orc-generator-test-lib.sh"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

assert_file_contains() {
    local file="$1"
    local needle="$2"
    local message="$3"
    if ! grep -Fq -- "$needle" "$file"; then
        fail "$message (expected substring '$needle' in $file)"
    fi
}

refute_file_contains() {
    local file="$1"
    local needle="$2"
    local message="$3"
    if grep -Fq -- "$needle" "$file"; then
        fail "$message (unexpected substring '$needle' in $file)"
    fi
}

assert_text_contains() {
    local text="$1"
    local needle="$2"
    local message="$3"
    if ! grep -Fq -- "$needle" <<<"$text"; then
        fail "$message (expected substring '$needle')"
    fi
}

refute_text_contains() {
    local text="$1"
    local needle="$2"
    local message="$3"
    if grep -Fq -- "$needle" <<<"$text"; then
        fail "$message (unexpected substring '$needle')"
    fi
}

compose_service_block() {
    local file="$1"
    local service="$2"
    awk -v svc="  ${service}:" '
        $0 == svc { in_block = 1; print; next }
        in_block && /^  [A-Za-z0-9_.-]+:/ { exit }
        in_block { print }
    ' "$file"
}

test_base_compose_uses_docker_secrets_for_bifrost_gateway() {
    local file="$PROJECT_ROOT/docker-compose.yml"
    assert_file_contains "$file" \
        "PORTICO_LLM_API_KEY_FILE=/run/secrets/portico_llm_api_key" \
        "base compose must consume PORTICO_LLM_API_KEY via /run/secrets"
    assert_file_contains "$file" \
        "BIFROST_BRIDGE_LOCAL_API_KEY_FILE=/run/secrets/bifrost_bridge_local_api_key" \
        "base compose must consume BIFROST_BRIDGE_LOCAL_API_KEY via /run/secrets"
    assert_file_contains "$file" \
        "OWUI_AUTH_BRIDGE_SECRET_FILE=/run/secrets/owui_auth_bridge_secret" \
        "base compose must consume OWUI_AUTH_BRIDGE_SECRET via /run/secrets"
    assert_file_contains "$file" \
        "WEBUI_SECRET_KEY_FILE=/run/secrets/webui_secret_key" \
        "base compose must consume WEBUI_SECRET_KEY via /run/secrets"
    refute_file_contains "$file" \
        "PORTICO_LLM_API_KEY=\${PORTICO_LLM_API_KEY}" \
        "base compose must not export raw PORTICO_LLM_API_KEY into the container env"
    refute_file_contains "$file" \
        "BIFROST_BRIDGE_LOCAL_API_KEY=\${BIFROST_BRIDGE_LOCAL_API_KEY}" \
        "base compose must not export raw BIFROST_BRIDGE_LOCAL_API_KEY into the container env"
    refute_file_contains "$file" \
        "OWUI_AUTH_BRIDGE_SECRET=\${OWUI_AUTH_BRIDGE_SECRET}" \
        "base compose must not export raw OWUI_AUTH_BRIDGE_SECRET into the container env"
    refute_file_contains "$file" \
        "WEBUI_SECRET_KEY=\${WEBUI_SECRET_KEY}" \
        "base compose must not export raw WEBUI_SECRET_KEY into the container env"
    assert_file_contains "$file" \
        "\${PORTICO_LLM_API_KEY_FILE:-/dev/null}" \
        "base compose must default PORTICO_LLM_API_KEY_FILE to /dev/null so read-only compose ops work without ingress"
    assert_file_contains "$file" \
        "\${BIFROST_BRIDGE_LOCAL_API_KEY_FILE:-/dev/null}" \
        "base compose must default BIFROST_BRIDGE_LOCAL_API_KEY_FILE to /dev/null so read-only compose ops work without ingress"
    assert_file_contains "$file" \
        "\${OWUI_AUTH_BRIDGE_SECRET_FILE:-/dev/null}" \
        "base compose must default OWUI_AUTH_BRIDGE_SECRET_FILE to /dev/null so read-only compose ops work without ingress"
    assert_file_contains "$file" \
        "\${WEBUI_SECRET_KEY_FILE:-/dev/null}" \
        "base compose must default WEBUI_SECRET_KEY_FILE to /dev/null so read-only compose ops work without ingress"
    refute_file_contains "$file" \
        "\${PORTICO_LLM_API_KEY_FILE:?" \
        "base compose must not use a :? default (regresses clean_full.sh / install_v2.sh build step)"
    refute_file_contains "$file" \
        "\${BIFROST_BRIDGE_LOCAL_API_KEY_FILE:?" \
        "base compose must not use a :? default for BIFROST_BRIDGE_LOCAL_API_KEY_FILE"
    refute_file_contains "$file" \
        "\${OWUI_AUTH_BRIDGE_SECRET_FILE:?" \
        "base compose must not use a :? default for OWUI_AUTH_BRIDGE_SECRET_FILE"
    refute_file_contains "$file" \
        "\${WEBUI_SECRET_KEY_FILE:?" \
        "base compose must not use a :? default for WEBUI_SECRET_KEY_FILE"
}

test_base_compose_uses_docker_secrets_for_mcpo() {
    local file="$PROJECT_ROOT/docker-compose.yml"
    refute_file_contains "$file" \
        "mcpo-oauth-tokens" \
        "base compose must not mount the retired mcpo-oauth-tokens store"
    refute_file_contains "$file" \
        "mcpo-core-oauth-tokens" \
        "base compose must not mount the retired mcpo-core-oauth-tokens store"
    refute_file_contains "$file" \
        "/root/.mcpo" \
        "base compose must not mount retired .mcpo OAuth stores"
    assert_file_contains "$file" \
        "OPENAI_API_KEY_FILE=/run/secrets/bifrost_bridge_local_api_key" \
        "open-webui must consume the local gateway key via /run/secrets"
    awk '
        /^  open-webui:/ { in_open_webui=1; next }
        /^  [A-Za-z0-9_-]+:/ && in_open_webui { exit }
        in_open_webui && /^[[:space:]]+secrets:/ { saw_secrets=1; next }
        saw_secrets && /^[[:space:]]+- bifrost_bridge_local_api_key$/ { found=1; exit }
        END { exit found ? 0 : 1 }
    ' "$file" || fail "open-webui must mount the bifrost_bridge_local_api_key Docker secret"
}

test_open_webui_mounts_health_status_read_only_for_prompt_context() {
    local file="$PROJECT_ROOT/docker-compose.yml"
    local open_webui_block
    open_webui_block="$(compose_service_block "$file" "open-webui")"
    [ -n "$open_webui_block" ] || fail "open-webui service block not found"
    assert_text_contains "$open_webui_block" \
        "- ./health-status:/app/health-status:ro" \
        "open-webui must read the periodic health snapshot without prompt-path readiness HTTP calls"
}

test_docker_socket_proxy_is_internal_and_not_on_default_network() {
    local file="$PROJECT_ROOT/docker-compose.yml"
    local proxy_block
    proxy_block="$(compose_service_block "$file" "docker-socket-proxy")"
    [ -n "$proxy_block" ] || fail "docker-socket-proxy service block not found"
    assert_text_contains "$proxy_block" \
        "docker-proxy:" \
        "docker-socket-proxy must be attached only to the dedicated proxy network"
    refute_text_contains "$proxy_block" \
        "default:" \
        "docker-socket-proxy must not be reachable from the default MCP runtime network"
    assert_file_contains "$file" \
        "name: portico-docker-proxy-network" \
        "base compose must declare the dedicated Docker proxy network"
    assert_file_contains "$file" \
        "internal: true" \
        "Docker proxy network must be internal-only"
}

test_generated_core_group_uses_docker_proxy_without_raw_socket() {
    local fixture file routing_file
    local core_group_block
    local route_hosts
    local route_host
    fixture="$(mktemp -d -t compose-core-group.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$fixture'" RETURN

    mcp_orc_test_prepare_project_root "$PROJECT_ROOT" "$fixture"
    mcp_orc_test_copy_server_configs "$PROJECT_ROOT" "$fixture" \
        agent-vm \
        artifacts \
        mcp-assistant \
        scheduling \
        skills \
        subagents \
        web-tools \
        glean
    cat > "$fixture/mcp_toggles.json" <<'EOF'
{"agent-vm":true,"artifacts":true,"mcp-assistant":true,"scheduling":true,"skills":true,"subagents":true,"web-tools":true,"glean":true}
EOF
    MCP_ORC_MODE=rust-full LLM_GATEWAY_MODE=bifrost \
        mcp_orc_test_run_generator "$PROJECT_ROOT" "$fixture" generate-docker-compose-override --force >/dev/null \
        || fail "failed to generate core-group compose fixture"

    file="$fixture/docker-compose.override.yml"
    routing_file="$fixture/mcpo-configs-generated/server-routing.json"
    core_group_block="$(compose_service_block "$file" "mcpo-group-core")"
    [ -n "$core_group_block" ] || fail "mcpo-group-core service block not found"
    [ -f "$routing_file" ] || fail "server routing file not found: $routing_file"
    assert_text_contains "$core_group_block" \
        "DOCKER_HOST=tcp://docker-socket-proxy:2375" \
        "core group must use the Docker socket proxy explicitly"
    grep -F 'NO_PROXY=' <<<"$core_group_block" | grep -Fq 'mcpo-group-core' \
        || fail "core group NO_PROXY must include its generated runtime hostname"
    [ -f "$routing_file" ] || fail "generated server routing file not found"
    route_hosts="$(node - "$routing_file" <<'NODE'
const fs = require("fs");
const routes = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hosts = new Set(
  Object.values(routes)
    .map((route) => route && route.network_host)
    .filter((host) => typeof host === "string" && host.length > 0),
);
process.stdout.write([...hosts].sort().join("\n"));
NODE
    )" || fail "generated server routing file could not be parsed"
    [ -n "$route_hosts" ] || fail "generated server routing file contains no runtime hostnames"
    while IFS= read -r route_host; do
        grep -F 'NO_PROXY=' <<<"$core_group_block" | grep -Fq "$route_host" \
            || fail "core group NO_PROXY must include generated runtime hostname '$route_host'"
    done <<<"$route_hosts"
    assert_text_contains "$core_group_block" \
        "- docker-socket-proxy" \
        "core group must depend on the Docker socket proxy"
    assert_text_contains "$core_group_block" \
        "docker-proxy:" \
        "core group must join the dedicated Docker proxy network"
    refute_text_contains "$core_group_block" \
        "/var/run/docker.sock" \
        "core group must not mount the raw Docker socket"
}

test_compose_env_sanitizer_preserves_release_operator_cloudsmith_key() {
    local fixture
    local clean_env_source
    fixture="$(mktemp -d)"
    printf '%s\n' \
        "CLOUDSMITH_API_KEY=protected-test-key" \
        "PORTICO_LLM_API_KEY=runtime-test-key" \
        "PORTICO_USER_ID=test-user" \
        > "$fixture/.env"

    clean_env_source="$(awk '
        /^clean_env_file\(\) \{/ { capture=1 }
        capture { print }
        capture && /^}$/ { exit }
    ' "$PROJECT_ROOT/src/scripts/docker-compose.sh")"
    [ -n "$clean_env_source" ] || fail "clean_env_file function not found"

    (
        eval "$clean_env_source"
        PROJECT_ROOT="$fixture"
        YELLOW=""
        GREEN=""
        NC=""
        discover_sensitive_required_env_vars() { return 0; }
        discover_sensitive_required_env_descriptors() { return 0; }
        discover_sensitive_runtime_file_descriptors() { return 0; }
        clean_env_file
    )

    assert_file_contains "$fixture/.env" \
        "CLOUDSMITH_API_KEY=protected-test-key" \
        "Compose env sanitization must preserve protected release-operator input"
    assert_file_contains "$fixture/.env" \
        "PORTICO_USER_ID=test-user" \
        "Compose env sanitization must preserve ordinary configuration"
    refute_file_contains "$fixture/.env" \
        "PORTICO_LLM_API_KEY=" \
        "Compose env sanitization must still remove runtime-delivered secrets"
    rm -rf "$fixture"
}

test_compose_never_delivers_project_env_file() {
    local files=(
        "$PROJECT_ROOT/docker-compose.yml"
        "$PROJECT_ROOT/docker-compose.advanced.yml"
    )
    local file
    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        files+=("$PROJECT_ROOT/docker-compose.override.yml")
    fi
    for file in "${files[@]}"; do
        if grep -nE "env_file:|^[[:space:]]*-[[:space:]]*\\.env([[:space:]]|$)" "$file" >/dev/null 2>&1; then
            fail "$file must not deliver project .env through env_file"
        fi
        refute_file_contains "$file" \
            "./.env:/app/user.env:ro" \
            "$file must not mount project .env into health-check or any other service"
    done
}

test_compose_no_longer_delivers_slack_oauth_client_secret() {
    local files=(
        "$PROJECT_ROOT/docker-compose.yml"
        "$PROJECT_ROOT/docker-compose.advanced.yml"
    )
    local file
    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        files+=("$PROJECT_ROOT/docker-compose.override.yml")
    fi
    for file in "${files[@]}"; do
        refute_file_contains "$file" \
            "slack_oauth_client_" \
            "$file must not declare or mount Slack OAuth client Docker secrets"
        refute_file_contains "$file" \
            "SLACK_OAUTH_CLIENT_ID" \
            "$file must not pass Slack OAuth client ID through container env"
        refute_file_contains "$file" \
            "SLACK_OAUTH_CLIENT_SECRET" \
            "$file must not pass Slack OAuth client secret through container env"
    done
}

test_slack_uses_oauth_file_ingress() {
    local file="$PROJECT_ROOT/mcp-configs/slack/slack.fragment"
    assert_file_contains "$file" \
        '"oauth":' \
        "Slack fragment must keep OAuth metadata for the PKCE flow"
    assert_file_contains "$file" \
        '"oauth_access_token_file_env": "SLACK_MCP_OAUTH_ACCESS_TOKEN_FILE"' \
        "Slack must receive OAuth tokens through file ingress"
    assert_file_contains "$file" \
        '"readiness_endpoint": "/health"' \
        "Slack must gate tool readiness on the provider cache state"
    refute_file_contains "$file" \
        "oauth_access_token_env" \
        "Slack must not use plaintext OAuth token env compatibility"
    refute_file_contains "$file" \
        "SLACK_MCP_XOXP_TOKEN" \
        "Slack fragment must not reference the legacy plaintext token env key"
}

test_slack_rebuild_is_explicit_and_public() {
    local rebuild="$PROJECT_ROOT/mcp-configs/slack/rebuild-slack-mcp-server.sh"

    assert_file_contains "$rebuild" \
        "SLACK_MCP_UPSTREAM_REPO" \
        "Slack binary rebuild script must require an explicit upstream repository"
    assert_file_contains "$rebuild" \
        "SLACK_MCP_UPSTREAM_REF" \
        "Slack binary rebuild script must support an explicit source ref"
    refute_file_contains "$rebuild" \
        "example.invalid" \
        "Slack rebuild script must not contain a private registry default"
    [ ! -e "$PROJECT_ROOT/mcp-configs/slack/patches" ] || \
        fail "mcp-configs/slack/patches/ must stay retired; land Go changes in the fork instead"
    assert_file_contains "$PROJECT_ROOT/docker-compose.yml" \
        "slack-mcp-cache:" \
        "base compose must declare the persistent Slack cache volume"
    refute_file_contains "$PROJECT_ROOT/src/scripts/start-single-mcp-server.sh" \
        "slack-mcp-cache" \
        "single-server setup must not share the managed Slack cache volume"

    local fragment="$PROJECT_ROOT/mcp-configs/slack/slack.fragment"
    assert_file_contains "$fragment" \
        "SLACK_MCP_STATE_DIR" \
        "Slack fragment must route sync stamps to the host-mounted state dir"
    assert_file_contains "$fragment" \
        "SLACK_MCP_USERS_SEED" \
        "Slack fragment must point at the configured users seed path"
    assert_file_contains "$fragment" \
        "SLACK_MCP_CHANNELS_SEED" \
        "Slack fragment must point at the configured channels seed path"
    # NOTE: the old "~215 channels in 3s / membership-scoped" claim was an
    # artifact of the pagination-truncation bug fixed in fork r3. The real
    # universe measured 19,779 (2026-08-04); the hint feeds honest ETAs on
    # seedless cold crawls.
    assert_file_contains "$fragment" \
        "\"SLACK_MCP_EXPECTED_CHANNELS_HINT\": \"19500\"" \
        "channels hint must carry the measured directory size"
    assert_file_contains "$PROJECT_ROOT/.gitignore" \
        "mcp-configs/slack/users_seed_v1.json.gz" \
        "the seed artifact is CI-built and must never be committed"
    assert_file_contains "$PROJECT_ROOT/.gitignore" \
        "mcp-configs/slack/channels_seed_v1.json.gz" \
        "the channels seed artifact is CI-built and must never be committed"
    if git -C "$PROJECT_ROOT" ls-files --error-unmatch mcp-configs/slack/users_seed_v1.json.gz >/dev/null 2>&1; then
        fail "users_seed_v1.json.gz must not be tracked in git"
    fi
    if git -C "$PROJECT_ROOT" ls-files --error-unmatch mcp-configs/slack/channels_seed_v1.json.gz >/dev/null 2>&1; then
        fail "channels_seed_v1.json.gz must not be tracked in git"
    fi

    # EVERY job that runs 'run_dev_release.sh package' repackages from a
    # fresh checkout and must pull the seed artifacts explicitly. A missing
    # needs edge ships tracked-files-only zips (beta-staging 08042026).
    local ci_file="$PROJECT_ROOT/.gitlab-ci.yml"
    local package_jobs
    package_jobs="$(grep -c 'run_dev_release.sh package ' "$ci_file" || true)"
    local seed_edges
    seed_edges="$(grep -c '    - job: slack-users-seed' "$ci_file" || true)"
    [ "$seed_edges" -ge "$package_jobs" ] ||         fail "every packaging job in .gitlab-ci.yml needs a slack-users-seed artifacts edge ($seed_edges edges for $package_jobs package invocations)"

    # Packaging must account for seed built_at (the 14-day fleet
    # freshness contract needs its build-time nudge).
    grep -q 'built_at' "$PROJECT_ROOT/package_for_release.sh" || \
        fail "package_for_release.sh must carry the seed built_at age accounting"

    [ ! -e "$PROJECT_ROOT/mcp-configs/slack/slack-mcp-server-linux-amd64" ] || \
        fail "public checkout must not carry a prebuilt Slack binary"
    [ ! -e "$PROJECT_ROOT/mcp-configs/slack/slack-mcp-server-linux-arm64" ] || \
        fail "public checkout must not carry a prebuilt Slack binary"
}

test_debug_monitor_uses_token_file_secret() {
    local file="$PROJECT_ROOT/dev/docker-compose.debug-monitor.yml"
    local block
    block="$(compose_service_block "$file" "llm-debug-monitor")"
    [ -n "$block" ] || fail "llm-debug-monitor service block not found"
    assert_text_contains "$block" \
        "DEBUG_MONITOR_TOKEN_FILE=/run/secrets/bifrost_bridge_local_api_key" \
        "debug monitor must consume auth through the Docker secret file"
    assert_text_contains "$block" \
        "http://localhost:3789" \
        "debug monitor must allow authenticated OWUI debug-mode calls from the local frontend"
    assert_text_contains "$block" \
        "- bifrost_bridge_local_api_key" \
        "debug monitor service must mount the local API key Docker secret"
    refute_text_contains "$block" \
        "DEBUG_MONITOR_TOKEN=\${LOCAL_STACK_API_KEY}" \
        "debug monitor must not receive the raw local API key as an env var"
}

resolve_mcp_orc_test_binary() {
    local candidate
    if command -v cargo >/dev/null 2>&1; then
        (cd "$PROJECT_ROOT" && cargo build --manifest-path src/mcp-orc-rust/Cargo.toml -p mcp-orc --bin mcp-orc >/dev/null) \
            || fail "failed to build mcp-orc generator binary for compose fixture test"
        candidate="$PROJECT_ROOT/src/mcp-orc-rust/target/debug/mcp-orc"
        [ -x "$candidate" ] || fail "cargo build completed but $candidate is missing"
        printf '%s\n' "$candidate"
        return 0
    fi

    for candidate in \
        "$PROJECT_ROOT/src/mcp-orc-rust/target/debug/mcp-orc" \
        "$PROJECT_ROOT/src/mcp-orc-rust/target/release/mcp-orc"; do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    fail "mcp-orc generator binary is unavailable and cargo is not on PATH"
}

test_generated_compose_routes_sensitive_required_env_vars_as_secrets() {
    local fixture file binary
    fixture="$(mktemp -d -t compose-sensitive-env.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$fixture'" RETURN

    mkdir -p \
        "$fixture/mcp-configs" \
        "$fixture/mcp-configs-user" \
        "$fixture/mcpo-configs-generated" \
        "$fixture/src" \
        "$fixture/electron-app"
    cp -R \
        "$PROJECT_ROOT/mcp-configs/gitlab-mcp" \
        "$PROJECT_ROOT/mcp-configs/sourcegraph" \
        "$PROJECT_ROOT/mcp-configs/mcp-n8n" \
        "$PROJECT_ROOT/mcp-configs/n8n-community-mcp" \
        "$fixture/mcp-configs/"
    cat > "$fixture/mcp_toggles.json" <<'EOF'
{"gitlab-mcp":true,"sourcegraph":true,"mcp-n8n":true,"n8n-community-mcp":true}
EOF
    printf '{}\n' > "$fixture/mcp_tools_config.json"
    printf '{"buildNumber":"dev-build"}\n' > "$fixture/electron-app/build-info.json"
    : > "$fixture/HOST_MODE"
    : > "$fixture/.env"

    binary="$(resolve_mcp_orc_test_binary)"
    if ! GITLAB_PERSONAL_ACCESS_TOKEN="fake-gitlab-token" \
        SOURCEGRAPH_TOKEN="fake-sourcegraph-token" \
        N8N_API_KEY="fake-n8n-token" \
        "$binary" generate-docker-compose-override --project-root "$fixture" --force >/dev/null; then
        fail "failed to generate sensitive-env compose fixture"
    fi

    file="$fixture/docker-compose.override.yml"
    [ -f "$file" ] || fail "sensitive-env compose fixture did not produce docker-compose.override.yml"
    for key_secret_server in \
        "GITLAB_PERSONAL_ACCESS_TOKEN:gitlab_personal_access_token:gitlab-mcp" \
        "SOURCEGRAPH_TOKEN:sourcegraph_token:sourcegraph" \
        "N8N_API_KEY:n8n_api_key:n8n-community-mcp"; do
        local key_and_secret="${key_secret_server%:*}"
        local key="${key_and_secret%%:*}"
        local secret="${key_and_secret##*:}"
        local server="${key_secret_server##*:}"
        local token_env
        token_env="$(printf 'portico_STATIC_SECRET_TOKEN_%s_%s' \
            "$(printf '%s' "$server" | tr '[:lower:]-' '[:upper:]_')" \
            "$(printf '%s' "$secret" | tr '[:lower:]-' '[:upper:]_')")"
        assert_file_contains "$file" \
            "${key}_FILE=/dev/shm/portico-runtime-secrets/${secret}" \
            "generated compose must expose $key only as tmpfs ${key}_FILE"
        assert_file_contains "$file" \
            "${server}|${secret}|/dev/shm/portico-runtime-secrets/${secret}|${token_env}|" \
            "generated compose must declare scoped broker materialization for ${secret}"
        assert_file_contains "$file" \
            "${token_env}=\${${token_env}:-}" \
            "generated compose must pass only the scoped broker token for ${secret}"
        refute_file_contains "$file" \
            "      - ${secret}" \
            "generated compose must not attach Docker secret ${secret} to the owning service"
        refute_file_contains "$file" \
            "  ${secret}:" \
            "generated compose must not declare top-level Docker secret ${secret}"
        assert_file_contains "$file" \
            "/dev/shm/portico-runtime-secrets:mode=0700" \
            "generated compose must mount static secret tmpfs"
        if grep -nE "^[[:space:]]*-[[:space:]]*${key}=\\$\\{" "$file" >/dev/null 2>&1; then
            fail "generated compose must not render raw $key into any service environment block"
        fi
    done

    local sourcegraph_block n8n_block fork_block
    sourcegraph_block="$(compose_service_block "$file" "mcpo-sourcegraph")"
    [ -n "$sourcegraph_block" ] || fail "generated fixture did not include mcpo-sourcegraph"
    assert_text_contains "$sourcegraph_block" \
        "DOCKER_HOST=tcp://docker-socket-proxy:2375" \
        "Docker-command MCPs must use the socket proxy explicitly"
    assert_text_contains "$sourcegraph_block" \
        "- docker-socket-proxy" \
        "Docker-command MCPs must depend on the socket proxy"
    assert_text_contains "$sourcegraph_block" \
        "docker-proxy:" \
        "Docker-command MCPs must join the dedicated Docker proxy network"
    refute_text_contains "$sourcegraph_block" \
        "/var/run/docker.sock" \
        "Docker-command MCPs must not mount the raw Docker socket"

    n8n_block="$(compose_service_block "$file" "mcpo-mcp-n8n")"
    [ -n "$n8n_block" ] || fail "generated fixture did not include mcpo-mcp-n8n"
    assert_text_contains "$n8n_block" \
        "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=mcp-n8n" \
        "hosted n8n must receive OAuth tokens through the broker"
    refute_text_contains "$n8n_block" \
        "N8N_API_KEY_FILE" \
        "hosted n8n must not require the retired static API key"
    refute_text_contains "$n8n_block" \
        "portico_STATIC_SECRET_TARGETS" \
        "hosted n8n must not declare static-secret materialization"
    refute_text_contains "$n8n_block" \
        "DOCKER_HOST=tcp://docker-socket-proxy:2375" \
        "hosted n8n must not depend on nested Docker"
    refute_text_contains "$n8n_block" \
        "- docker-socket-proxy" \
        "hosted n8n must not depend on the socket proxy service"
    refute_text_contains "$n8n_block" \
        "docker-proxy:" \
        "hosted n8n must not join the Docker proxy network"
    refute_text_contains "$n8n_block" \
        "/var/run/docker.sock" \
        "hosted n8n must not mount the raw Docker socket"
    assert_file_contains "$fixture/mcpo-configs-generated/mcp-n8n.json" \
        '"url": "https://n8n.example.invalid/mcp-server/http"' \
        "hosted n8n must retain its streamable HTTP endpoint"

    fork_block="$(compose_service_block "$file" "mcpo-n8n-community-mcp")"
    [ -n "$fork_block" ] || fail "generated fixture did not include mcpo-n8n-community-mcp"
    assert_text_contains "$fork_block" \
        "N8N_API_KEY_FILE=/dev/shm/portico-runtime-secrets/n8n_api_key" \
        "community-fork n8n must receive its API key as a tmpfs _FILE secret"
    refute_text_contains "$fork_block" \
        "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=n8n-community-mcp" \
        "community-fork n8n must not receive broker OAuth tokens"
    assert_text_contains "$fork_block" \
        "DOCKER_HOST=tcp://docker-socket-proxy:2375" \
        "community-fork n8n runs docker-in-docker and must use the socket proxy"
    assert_text_contains "$fork_block" \
        "- docker-socket-proxy" \
        "community-fork n8n must depend on the socket proxy"
    assert_text_contains "$fork_block" \
        "docker-proxy:" \
        "community-fork n8n must join the dedicated Docker proxy network"
    refute_text_contains "$fork_block" \
        "/var/run/docker.sock" \
        "community-fork n8n must not mount the raw Docker socket"
    assert_file_contains "$fixture/mcpo-configs-generated/n8n-community-mcp.json" \
        "harbor.example.invalid/n8n/n8n-mcp:latest" \
        "community-fork n8n must keep its harbor docker-run image"
}

test_generated_compose_routes_sensitive_runtime_files_as_secrets() {
    local fixture file binary
    fixture="$(mktemp -d -t compose-sensitive-runtime-file.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$fixture'" RETURN

    mkdir -p \
        "$fixture/mcp-configs/snowflake" \
        "$fixture/mcp-configs-user" \
        "$fixture/mcpo-configs-generated" \
        "$fixture/src" \
        "$fixture/electron-app" \
        "$fixture/runtime"
    printf 'service: true\n' > "$fixture/runtime/mcp_config.yaml"
    printf 'token = "secret-token"\n' > "$fixture/runtime/connections.toml"
    cat > "$fixture/mcp-configs/snowflake/snowflake.yaml" <<'YAML'
name: Snowflake
id: snowflake
display_name: Snowflake
deployment_type: docker
description: Snowflake
is_core: false
required_env_vars: []
runtime_files:
  - source: ./runtime/mcp_config.yaml
    filename: mcp_config.yaml
  - source: ./runtime/connections.toml
    target: /root/.snowflake/connections.toml
    sensitive: true
user_installed: false
YAML
    cat > "$fixture/mcp-configs/snowflake/snowflake.fragment" <<'JSON'
{"command":"uvx","args":["snowflake-labs-mcp","--service-config-file","/app/runtime/mcp_config.yaml","--connection-name","default"]}
JSON
    cat > "$fixture/mcp_toggles.json" <<'EOF'
{"snowflake":true}
EOF
    printf '{}\n' > "$fixture/mcp_tools_config.json"
    printf '{"buildNumber":"dev-build"}\n' > "$fixture/electron-app/build-info.json"
    : > "$fixture/HOST_MODE"
    : > "$fixture/.env"

    binary="$(resolve_mcp_orc_test_binary)"
    if ! "$binary" generate-docker-compose-override --project-root "$fixture" --force >/dev/null; then
        fail "failed to generate sensitive runtime-file compose fixture"
    fi

    file="$fixture/docker-compose.override.yml"
    [ -f "$file" ] || fail "sensitive runtime-file fixture did not produce docker-compose.override.yml"
    local connections_source service_block secret_name env_name
    connections_source="$(realpath "$fixture/runtime/connections.toml")"
    service_block="$(compose_service_block "$file" "mcpo-snowflake")"
    [ -n "$service_block" ] || fail "generated fixture did not include mcpo-snowflake"

    refute_text_contains "$service_block" \
        "$connections_source:/root/.snowflake/connections.toml:ro" \
        "sensitive runtime file must not be bind-mounted from its source"
    assert_text_contains "$service_block" \
        "/dev/shm/portico-runtime-secrets:mode=0700" \
        "sensitive runtime file must use the static secret tmpfs"
    assert_text_contains "$service_block" \
        "portico_STATIC_SECRET_TARGETS=" \
        "sensitive runtime file must declare broker materialization targets"

    secret_name="$(grep -oE 'portico_runtime_file_snowflake_connections_toml_[a-f0-9]+' "$file" | head -n 1)"
    [ -n "$secret_name" ] || fail "sensitive runtime file secret name was not rendered"
    env_name="$(printf 'portico_STATIC_SECRET_TOKEN_SNOWFLAKE_%s' "$(printf '%s' "$secret_name" | tr '[:lower:]' '[:upper:]')")"
    assert_file_contains "$file" \
        "snowflake|${secret_name}|/dev/shm/portico-runtime-secrets/${secret_name}|${env_name}|/root/.snowflake/connections.toml" \
        "sensitive runtime file materialization must preserve the configured target via symlink"
    assert_file_contains "$file" \
        "${env_name}=\${${env_name}:-}" \
        "sensitive runtime file must use a scoped broker token"
    refute_file_contains "$file" \
        "  ${secret_name}:" \
        "sensitive runtime file must not declare a top-level Docker secret"
}

test_generated_compose_preserves_sensitive_non_sensitive_presets_and_fragment_precedence() {
    local fixture file binary
    fixture="$(mktemp -d -t compose-env-matrix.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$fixture'" RETURN

    mkdir -p \
        "$fixture/mcp-configs/matrix-single" \
        "$fixture/mcp-configs/matrix-group-a" \
        "$fixture/mcp-configs/matrix-group-b" \
        "$fixture/mcp-configs-user" \
        "$fixture/mcpo-configs-generated" \
        "$fixture/src" \
        "$fixture/electron-app"
    printf '{"buildNumber":"dev-build"}\n' > "$fixture/electron-app/build-info.json"
    printf '{"matrix-single":true,"matrix-group-a":true,"matrix-group-b":true}\n' > "$fixture/mcp_toggles.json"
    printf '{"groups":{"matrix":["matrix-group-a","matrix-group-b"]}}\n' > "$fixture/mcp-container-groups.json"
    printf '{}\n' > "$fixture/mcp_tools_config.json"
    : > "$fixture/HOST_MODE"
    : > "$fixture/.env"

    cat > "$fixture/mcp-configs/matrix-single/matrix-single.fragment" <<'JSON'
{"command":"python","args":["-m","matrix_single"],"env":{"MATRIX_PUBLIC":"fragment-public"}}
JSON
    cat > "$fixture/mcp-configs/matrix-single/matrix-single.yaml" <<'YAML'
name: Matrix Single
id: matrix-single
deployment_type: docker
required_env_vars:
  - name: MATRIX_SECRET
    sensitive: true
  - name: MATRIX_PUBLIC
    sensitive: false
  - name: MATRIX_DEFAULT
  - MATRIX_LEGACY
preset_env_vars:
  - name: MATRIX_PRESET
    value: "preset value"
  - name: MATRIX_PUBLIC
    value: preset-must-not-duplicate
YAML

    cat > "$fixture/mcp-configs/matrix-group-a/matrix-group-a.fragment" <<'JSON'
{"command":"python","args":["-m","matrix_group_a"],"env":{"MATRIX_GROUP_PUBLIC":"fragment-group-public"}}
JSON
    cat > "$fixture/mcp-configs/matrix-group-a/matrix-group-a.yaml" <<'YAML'
name: Matrix Group A
id: matrix-group-a
deployment_type: docker
required_env_vars:
  - name: MATRIX_GROUP_SECRET
    sensitive: true
  - name: MATRIX_GROUP_PUBLIC
    sensitive: false
preset_env_vars:
  - name: MATRIX_GROUP_PRESET
    value: "group preset"
YAML

    cat > "$fixture/mcp-configs/matrix-group-b/matrix-group-b.fragment" <<'JSON'
{"command":"python","args":["-m","matrix_group_b"]}
JSON
    cat > "$fixture/mcp-configs/matrix-group-b/matrix-group-b.yaml" <<'YAML'
name: Matrix Group B
id: matrix-group-b
deployment_type: docker
required_env_vars:
  - name: MATRIX_GROUP_SECOND_SECRET
    sensitive: true
  - MATRIX_GROUP_LEGACY
preset_env_vars:
  - name: MATRIX_GROUP_B_PRESET
    value: "group b preset"
YAML

    binary="$(resolve_mcp_orc_test_binary)"
    if ! MATRIX_SECRET="fake-matrix-secret" \
        MATRIX_GROUP_SECRET="fake-group-secret" \
        MATRIX_GROUP_SECOND_SECRET="fake-group-second-secret" \
        MATRIX_PUBLIC="public-for-status" \
        MATRIX_DEFAULT="default-public" \
        MATRIX_LEGACY="legacy-public" \
        MATRIX_GROUP_PUBLIC="group-public-for-status" \
        MATRIX_GROUP_LEGACY="group-legacy-public" \
        "$binary" generate-docker-compose-override --project-root "$fixture" --force >/dev/null; then
        fail "failed to generate env matrix compose fixture"
    fi

    file="$fixture/docker-compose.override.yml"
    [ -f "$file" ] || fail "env matrix compose fixture did not produce docker-compose.override.yml"

    assert_file_contains "$file" \
        "MATRIX_SECRET_FILE=/dev/shm/portico-runtime-secrets/matrix_secret" \
        "sensitive structured required env var must render only as tmpfs *_FILE"
    assert_file_contains "$file" \
        "matrix-single|matrix_secret|/dev/shm/portico-runtime-secrets/matrix_secret|portico_STATIC_SECRET_TOKEN_MATRIX_SINGLE_MATRIX_SECRET|" \
        "sensitive structured required env var must declare broker materialization"
    assert_file_contains "$file" \
        "portico_STATIC_SECRET_TOKEN_MATRIX_SINGLE_MATRIX_SECRET=\${portico_STATIC_SECRET_TOKEN_MATRIX_SINGLE_MATRIX_SECRET:-}" \
        "sensitive structured required env var must use a scoped broker token"
    refute_file_contains "$file" \
        "      - matrix_secret" \
        "sensitive structured required env var must not attach a Docker secret"
    refute_file_contains "$file" \
        "  matrix_secret:" \
        "sensitive structured required env var must not declare a top-level Docker secret"
    refute_file_contains "$file" \
        "MATRIX_SECRET=\${MATRIX_SECRET}" \
        "sensitive structured required env var must not render as plaintext environment"
    assert_file_contains "$file" \
        "MATRIX_PUBLIC=fragment-public" \
        "fragment env value must take precedence over required/preset env emission"
    local matrix_public_count
    matrix_public_count="$(grep -c "MATRIX_PUBLIC=" "$file" || true)"
    [ "$matrix_public_count" = "1" ] || fail "MATRIX_PUBLIC should appear once from the fragment, got $matrix_public_count"
    assert_file_contains "$file" \
        "MATRIX_DEFAULT=\${MATRIX_DEFAULT}" \
        "missing-sensitive structured required env var must be non-secret"
    assert_file_contains "$file" \
        "MATRIX_LEGACY=\${MATRIX_LEGACY}" \
        "legacy string required env var must be non-secret"
    assert_file_contains "$file" \
        "MATRIX_PRESET=preset value" \
        "preset env var values with spaces must be preserved"

    refute_file_contains "$file" \
        "mcpo-group-matrix:" \
        "secret-bearing group members must not share a grouped runtime"
    assert_file_contains "$file" \
        "mcpo-matrix-group-a:" \
        "first secret-bearing group member must be isolated"
    assert_file_contains "$file" \
        "mcpo-matrix-group-b:" \
        "second secret-bearing group member must be isolated"
    assert_file_contains "$file" \
        "MATRIX_GROUP_SECRET_FILE=/dev/shm/portico-runtime-secrets/matrix_group_secret" \
        "first isolated group member must receive sensitive env via tmpfs file"
    assert_file_contains "$file" \
        "matrix-group-a|matrix_group_secret|/dev/shm/portico-runtime-secrets/matrix_group_secret|portico_STATIC_SECRET_TOKEN_MATRIX_GROUP_A_MATRIX_GROUP_SECRET|" \
        "first isolated group member must declare scoped broker materialization"
    assert_file_contains "$file" \
        "portico_STATIC_SECRET_TOKEN_MATRIX_GROUP_A_MATRIX_GROUP_SECRET=\${portico_STATIC_SECRET_TOKEN_MATRIX_GROUP_A_MATRIX_GROUP_SECRET:-}" \
        "first isolated group member must use a scoped broker token"
    assert_file_contains "$file" \
        "MATRIX_GROUP_SECOND_SECRET_FILE=/dev/shm/portico-runtime-secrets/matrix_group_second_secret" \
        "second isolated group member must receive sensitive env via tmpfs file"
    assert_file_contains "$file" \
        "matrix-group-b|matrix_group_second_secret|/dev/shm/portico-runtime-secrets/matrix_group_second_secret|portico_STATIC_SECRET_TOKEN_MATRIX_GROUP_B_MATRIX_GROUP_SECOND_SECRET|" \
        "second isolated group member must declare scoped broker materialization"
    assert_file_contains "$file" \
        "portico_STATIC_SECRET_TOKEN_MATRIX_GROUP_B_MATRIX_GROUP_SECOND_SECRET=\${portico_STATIC_SECRET_TOKEN_MATRIX_GROUP_B_MATRIX_GROUP_SECOND_SECRET:-}" \
        "second isolated group member must use a scoped broker token"
    assert_file_contains "$file" \
        "MATRIX_GROUP_PUBLIC=fragment-group-public" \
        "isolated group member must preserve fragment env precedence"
    assert_file_contains "$file" \
        "MATRIX_GROUP_PRESET=group preset" \
        "isolated group member must include preset env vars"
    assert_file_contains "$file" \
        "MATRIX_GROUP_B_PRESET=group b preset" \
        "isolated group member must include its presets"
    refute_file_contains "$file" \
        "MATRIX_GROUP_SECRET=\${MATRIX_GROUP_SECRET}" \
        "isolated group member must not render first member sensitive env as plaintext"
    refute_file_contains "$file" \
        "MATRIX_GROUP_SECOND_SECRET=\${MATRIX_GROUP_SECOND_SECRET}" \
        "isolated group member must not render second member sensitive env as plaintext"

    local single_block group_a_block group_b_block
    single_block="$(compose_service_block "$file" "mcpo-matrix-single")"
    group_a_block="$(compose_service_block "$file" "mcpo-matrix-group-a")"
    group_b_block="$(compose_service_block "$file" "mcpo-matrix-group-b")"
    [ -n "$single_block" ] || fail "generated fixture did not include mcpo-matrix-single"
    [ -n "$group_a_block" ] || fail "generated fixture did not include mcpo-matrix-group-a"
    [ -n "$group_b_block" ] || fail "generated fixture did not include mcpo-matrix-group-b"
    for forbidden in \
        "DOCKER_HOST=tcp://docker-socket-proxy:2375" \
        "docker-socket-proxy" \
        "docker-proxy:" \
        "/var/run/docker.sock"; do
        refute_text_contains "$single_block" "$forbidden" \
            "non-Docker per-server MCP must not receive Docker proxy or raw socket access"
        refute_text_contains "$group_a_block" "$forbidden" \
            "isolated group member without Docker-needing config must not receive Docker proxy or raw socket access"
        refute_text_contains "$group_b_block" "$forbidden" \
            "isolated group member without Docker-needing config must not receive Docker proxy or raw socket access"
    done

    node - "$fixture" <<'NODE' || fail "generated config/status did not preserve sensitive env metadata"
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const singleConfig = JSON.parse(fs.readFileSync(path.join(root, "mcpo-configs-generated", "matrix-single.json"), "utf8"));
const single = singleConfig.mcpServers && singleConfig.mcpServers["matrix-single"];
if (!single) throw new Error("missing matrix-single config");
if (JSON.stringify(single.sensitive_env_vars) !== JSON.stringify(["MATRIX_SECRET"])) {
  throw new Error(`matrix-single sensitive_env_vars mismatch: ${JSON.stringify(single.sensitive_env_vars)}`);
}
if (single.env.MATRIX_SECRET !== undefined) throw new Error("matrix-single raw secret leaked into generated MCP config env");
if (single.env.MATRIX_SECRET_FILE !== undefined) throw new Error("matrix-single container-level secret file leaked into generated MCP config env");
if (single.env.MATRIX_PUBLIC !== "fragment-public") throw new Error("fragment env precedence not preserved in generated MCP config");

const groupAConfig = JSON.parse(fs.readFileSync(path.join(root, "mcpo-configs-generated", "matrix-group-a.json"), "utf8"));
const groupBConfig = JSON.parse(fs.readFileSync(path.join(root, "mcpo-configs-generated", "matrix-group-b.json"), "utf8"));
const groupA = groupAConfig.mcpServers && groupAConfig.mcpServers["matrix-group-a"];
const groupB = groupBConfig.mcpServers && groupBConfig.mcpServers["matrix-group-b"];
if (!groupA || !groupB) throw new Error("missing combined group target configs");
if (JSON.stringify(groupA.sensitive_env_vars) !== JSON.stringify(["MATRIX_GROUP_SECRET"])) {
  throw new Error(`matrix-group-a sensitive_env_vars mismatch: ${JSON.stringify(groupA.sensitive_env_vars)}`);
}
if (JSON.stringify(groupB.sensitive_env_vars) !== JSON.stringify(["MATRIX_GROUP_SECOND_SECRET"])) {
  throw new Error(`matrix-group-b sensitive_env_vars mismatch: ${JSON.stringify(groupB.sensitive_env_vars)}`);
}
const groupAEnv = groupA.env || {};
const groupBEnv = groupB.env || {};
if (groupAEnv.MATRIX_GROUP_SECRET !== undefined || groupBEnv.MATRIX_GROUP_SECOND_SECRET !== undefined) {
  throw new Error("group raw secret leaked into generated target env");
}
if (groupAEnv.MATRIX_GROUP_SECRET_FILE !== undefined) throw new Error("group-a container-level secret file leaked into generated target env");
if (groupBEnv.MATRIX_GROUP_SECOND_SECRET_FILE !== undefined) throw new Error("group-b container-level secret file leaked into generated target env");

const status = JSON.parse(fs.readFileSync(path.join(root, "mcpo-configs-generated", "server-config-status.json"), "utf8"));
for (const serverId of ["matrix-single", "matrix-group-a", "matrix-group-b"]) {
  if (!status.servers || !status.servers[serverId] || status.servers[serverId].configured !== true) {
    throw new Error(`${serverId} should be configured in status file`);
  }
}
NODE
}

test_generated_docker_node_mcp_uses_managed_store_without_package_manager_credentials() {
    local fixture file binary
    fixture="$(mktemp -d -t compose-managed-node.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$fixture'" RETURN

    mkdir -p \
        "$fixture/mcp-configs/docker-node" \
        "$fixture/mcp-configs-user" \
        "$fixture/mcpo-configs-generated" \
        "$fixture/src" \
        "$fixture/electron-app"
    printf '{"buildNumber":"dev-build"}\n' > "$fixture/electron-app/build-info.json"
    printf '{"docker-node":true}\n' > "$fixture/mcp_toggles.json"
    printf '{}\n' > "$fixture/mcp_tools_config.json"
    : > "$fixture/HOST_MODE"
    : > "$fixture/.env"

    cat > "$fixture/mcp-configs/docker-node/docker-node.fragment" <<'JSON'
{"command":"npx","args":["-y","@portico/docker-node-demo@1.2.3","--readonly"]}
JSON
    cat > "$fixture/mcp-configs/docker-node/docker-node.yaml" <<'YAML'
name: Docker Node
id: docker-node
deployment_type: docker
required_env_vars: []
YAML

    binary="$(resolve_mcp_orc_test_binary)"
    if ! "$binary" generate-docker-compose-override --project-root "$fixture" --force >/dev/null; then
        fail "failed to generate Docker managed-node compose fixture"
    fi

    file="$fixture/docker-compose.override.yml"
    assert_file_contains "$file" \
        "./open-webui-data/managed-node-mcp-packages:/app/open-webui-data/managed-node-mcp-packages:ro" \
        "Docker Node MCP runtime must receive only the prepared managed package store as a read-only mount"
    assert_file_contains "$file" \
        "portico_MANAGED_NODE_MCP_PACKAGES_DIR=/app/open-webui-data/managed-node-mcp-packages" \
        "Docker Node MCP runtime must resolve packages from the app-owned managed package store"
    refute_file_contains "$file" \
        "NPM_CONFIG_REGISTRY" \
        "Docker Node MCP runtime must not inject package-manager registry configuration"
    refute_file_contains "$file" \
        "managed-node-mcp-package-acquisition" \
        "Docker Node MCP runtime must not mount install-time npm acquisition scratch/cache"
    for forbidden in \
        "NPM_CONFIG_GLOBALCONFIG" \
        "npm_config_globalconfig" \
        "NPM_CONFIG_USERCONFIG" \
        "npm_config_userconfig" \
        "NODE_AUTH_TOKEN" \
        "NPM_AUTH_TOKEN" \
        "NPM_TOKEN" \
        "YARN_NPM_AUTH_TOKEN" \
        "YARN_NPM_AUTH_IDENT" \
        "COREPACK_NPM_TOKEN" \
        "COREPACK_NPM_USERNAME" \
        "COREPACK_NPM_PASSWORD" \
        "BUN_AUTH_TOKEN" \
        "BUN_CONFIG_REGISTRY" \
        "NVM_NODEJS_ORG_MIRROR" \
        ".npmrc" \
        "registry.npmjs.org"; do
        refute_file_contains "$file" "$forbidden" \
            "Docker Node MCP runtime compose must not expose package-manager credentials or public npm registry references"
    done

    node - "$fixture" <<'NODE' || fail "Docker managed-node generated MCP config did not use managed package metadata"
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(root, "mcpo-configs-generated", "docker-node.json"), "utf8"));
const server = config.mcpServers && config.mcpServers["docker-node"];
if (!server) throw new Error("missing docker-node config");
if (server.command !== "__portico_managed_node_package__") {
  throw new Error(`expected managed package sentinel, saw ${server.command}`);
}
if (Array.isArray(server.args) && server.args.length !== 0) {
  throw new Error(`managed package sentinel should not preserve package-manager args: ${JSON.stringify(server.args)}`);
}
if (!server.managed_node_package || server.managed_node_package.package_name !== "@portico/docker-node-demo") {
  throw new Error(`missing managed_node_package metadata: ${JSON.stringify(server.managed_node_package)}`);
}
const rendered = JSON.stringify(server);
for (const forbidden of ["registry.npmjs.org"]) {
  if (rendered.includes(forbidden)) {
    throw new Error(`generated MCP config retained forbidden public-registry text: ${forbidden}`);
  }
}
NODE
}

test_runtime_dockerfiles_do_not_bake_npm_registry_credentials() {
    local file forbidden
    for file in \
        "$PROJECT_ROOT/Dockerfile.mcp-orc-rust" \
        "$PROJECT_ROOT/Dockerfile.agent-vm"; do
        for forbidden in \
            "COPY .npmrc" \
            "NPM_CONFIG_GLOBALCONFIG=/etc/npmrc" \
            "NVM_NODEJS_ORG_MIRROR=https://token:" \
            "_authToken" \
            "/etc/npmrc"; do
            refute_file_contains "$file" "$forbidden" \
                "$file must not bake npm registry credentials into an MCP/runtime image"
        done
    done
}

test_compose_config_without_ingress_succeeds() {
    # Regression: the previous `:?` defaults caused `docker compose config`,
    # `build`, and `down` to abort whenever src/scripts/docker-compose.sh had
    # not been sourced. Verify the relaxed defaults no longer produce that
    # interpolation error when the _FILE env vars are unset.
    if ! command -v docker >/dev/null 2>&1; then
        echo "skip: docker binary unavailable for compose-config regression check" >&2
        return 0
    fi

    local out
    if ! out="$(cd "$PROJECT_ROOT" && \
        env -u PORTICO_LLM_API_KEY_FILE \
            -u BIFROST_BRIDGE_LOCAL_API_KEY_FILE \
            -u OWUI_AUTH_BRIDGE_SECRET_FILE \
            -u WEBUI_SECRET_KEY_FILE \
        docker compose \
            -f docker-compose.yml \
            config --services 2>&1)"; then
        echo "$out" >&2
        fail "docker compose config must succeed without prepare_optional_file_secret_ingress"
    fi

    case "$out" in
        *"error while interpolating secrets"*)
            echo "$out" >&2
            fail "docker compose config still reports a secrets interpolation error; :? default must not be re-introduced"
            ;;
    esac
}

test_prepare_optional_file_secret_ingress_tmpdir_lifecycle() {
    local harness helper_frag cache_override
    harness="$(mktemp -t compose-secrets-test.XXXXXX)"
    helper_frag="$(mktemp -t compose-secrets-helper.XXXXXX)"
    cache_override="$(mktemp -d -t compose-secrets-cache.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -f '$harness' '$helper_frag'; rm -rf '$cache_override'" RETURN

    cat <<'EOF' > "$harness"
#!/usr/bin/env bash
set -euo pipefail
export PORTICO_LLM_API_KEY="portico-live-token-1234567890abcd"
export BIFROST_BRIDGE_LOCAL_API_KEY="sk-bifrost-local-abcd"
export OWUI_AUTH_BRIDGE_SECRET="owui-bridge-abcd"
export WEBUI_SECRET_KEY="webui-secret-abcd"
export PORTICO_RUNTIME_DISABLE_KEYCHAIN="1"
export PORTICO_RUNTIME_SECRET_CACHE_DIR="$2"
mode_of() {
    if stat -c '%a' "$1" >/dev/null 2>&1; then
        stat -c '%a' "$1"
    else
        stat -f '%Mp%Lp' "$1"
    fi
}
# shellcheck disable=SC1091
source "$1"
prepare_optional_file_secret_ingress
printf 'TMPDIR=%s\n' "$PORTICO_RUNTIME_SECRET_TMPDIR"
printf 'PORTICO_LLM_API_KEY_FILE=%s\n' "$PORTICO_LLM_API_KEY_FILE"
printf 'BIFROST_BRIDGE_LOCAL_API_KEY_FILE=%s\n' "$BIFROST_BRIDGE_LOCAL_API_KEY_FILE"
printf 'OWUI_AUTH_BRIDGE_SECRET_FILE=%s\n' "$OWUI_AUTH_BRIDGE_SECRET_FILE"
printf 'WEBUI_SECRET_KEY_FILE=%s\n' "$WEBUI_SECRET_KEY_FILE"
printf 'DIR_MODE=%s\n' "$(mode_of "$PORTICO_RUNTIME_SECRET_TMPDIR")"
printf 'PORTICO_MODE=%s\n' "$(mode_of "$PORTICO_LLM_API_KEY_FILE")"
printf 'BIFROST_MODE=%s\n' "$(mode_of "$BIFROST_BRIDGE_LOCAL_API_KEY_FILE")"
printf 'OWUI_BRIDGE_MODE=%s\n' "$(mode_of "$OWUI_AUTH_BRIDGE_SECRET_FILE")"
printf 'WEBUI_SECRET_MODE=%s\n' "$(mode_of "$WEBUI_SECRET_KEY_FILE")"
printf 'PORTICO_CONTENT=%s\n' "$(cat "$PORTICO_LLM_API_KEY_FILE")"
EOF
    chmod +x "$harness"

    # Extract just the helper fragment rather than sourcing docker-compose.sh
    # wholesale (which would pull in the rest of the MCP orchestrator stack).
    # Capture the cache-dir resolver, ingress helper and the cleanup function
    # into a small standalone file that the harness can source.
    {
        printf 'PROJECT_ROOT=%q\n' "$PROJECT_ROOT"
        printf 'YELLOW=""\nRED=""\nNC=""\n'
        cat "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
        printf 'discover_sensitive_runtime_file_descriptors() {\n    discover_sensitive_runtime_files\n}\n'
        awk '
            /^discover_sensitive_required_env_vars\(\)/ { capture_discovery=1 }
            capture_discovery { print }
            /^}$/ && capture_discovery { capture_discovery=0; print ""; next }
            /^PORTICO_RUNTIME_SECRET_TMPDIR=""/ { capture=1 }
            capture { print }
            /^}$/ && capture && past_prepare { capture=0 }
            /^prepare_optional_file_secret_ingress\(\)/ { past_prepare=1 }
        ' "$PROJECT_ROOT/src/scripts/docker-compose.sh"
    } > "$helper_frag"

    if ! grep -q "prepare_optional_file_secret_ingress" "$helper_frag"; then
        fail "failed to extract prepare_optional_file_secret_ingress from docker-compose.sh"
    fi
    if ! grep -q "discover_sensitive_required_env_vars" "$helper_frag"; then
        fail "helper fragment missing discover_sensitive_required_env_vars"
    fi
    if ! grep -q "discover_sensitive_runtime_files" "$helper_frag"; then
        fail "helper fragment missing discover_sensitive_runtime_files"
    fi
    if ! grep -q "_default_runtime_secret_cache_dir" "$helper_frag"; then
        fail "helper fragment missing _default_runtime_secret_cache_dir resolver"
    fi
    # Regression guard: the old EXIT trap MUST NOT be re-introduced — it would
    # wipe the bind-mount sources while containers still hold them open.
    if grep -q "trap cleanup_runtime_secret_tmpdir EXIT" "$PROJECT_ROOT/src/scripts/docker-compose.sh"; then
        fail "docker-compose.sh still installs an EXIT trap that wipes the runtime secret cache dir"
    fi

    local output
    output="$(bash "$harness" "$helper_frag" "$cache_override")"

    local tmpdir
    tmpdir="$(awk -F= '/^TMPDIR=/{print $2}' <<<"$output")"
    [ -n "$tmpdir" ] || fail "prepare_optional_file_secret_ingress did not export PORTICO_RUNTIME_SECRET_TMPDIR"
    [ "$tmpdir" = "$cache_override" ] || fail "ingress did not honor PORTICO_RUNTIME_SECRET_CACHE_DIR (expected '$cache_override', got '$tmpdir')"

    # The tmpdir MUST survive the harness shell's exit — containers bind-mount
    # the files inside it for the lifetime of the compose stack.
    if [ ! -d "$tmpdir" ]; then
        fail "runtime secret cache dir was removed after the helper shell exited — containers would ENOENT on /run/secrets/*"
    fi

    local portico_file bifrost_file owui_bridge_file webui_secret_file
    portico_file="$(awk -F= '/^PORTICO_LLM_API_KEY_FILE=/{print $2}' <<<"$output")"
    bifrost_file="$(awk -F= '/^BIFROST_BRIDGE_LOCAL_API_KEY_FILE=/{print $2}' <<<"$output")"
    owui_bridge_file="$(awk -F= '/^OWUI_AUTH_BRIDGE_SECRET_FILE=/{print $2}' <<<"$output")"
    webui_secret_file="$(awk -F= '/^WEBUI_SECRET_KEY_FILE=/{print $2}' <<<"$output")"
    case "$portico_file" in "$tmpdir"/*) ;; *) fail "PORTICO_LLM_API_KEY_FILE '$portico_file' not under tmpdir $tmpdir" ;; esac
    case "$bifrost_file" in "$tmpdir"/*) ;; *) fail "BIFROST_BRIDGE_LOCAL_API_KEY_FILE '$bifrost_file' not under tmpdir $tmpdir" ;; esac
    case "$owui_bridge_file" in "$tmpdir"/*) ;; *) fail "OWUI_AUTH_BRIDGE_SECRET_FILE '$owui_bridge_file' not under tmpdir $tmpdir" ;; esac
    case "$webui_secret_file" in "$tmpdir"/*) ;; *) fail "WEBUI_SECRET_KEY_FILE '$webui_secret_file' not under tmpdir $tmpdir" ;; esac

    local dir_mode
    dir_mode="$(awk -F= '/^DIR_MODE=/{print $2}' <<<"$output")"
    case "$dir_mode" in
        700|0700) ;;
        *) fail "runtime secret cache dir should be 0700, got $dir_mode" ;;
    esac

    for label in PORTICO BIFROST OWUI_BRIDGE WEBUI_SECRET; do
        local mode
        mode="$(awk -F= -v key="${label}_MODE" '$1 == key{print $2}' <<<"$output")"
        case "$mode" in
            600|0600) ;;
            *) fail "${label} secret file should be 0600, got $mode" ;;
        esac
    done

    local content
    content="$(awk -F= '/^PORTICO_CONTENT=/{print $2}' <<<"$output")"
    [ "$content" = "portico-live-token-1234567890abcd" ] || fail "secret file content did not match PORTICO_LLM_API_KEY (got '$content')"

    # Explicit cleanup should wipe the directory (simulates stop/down path).
    bash -c '
        set -euo pipefail
        export PORTICO_RUNTIME_SECRET_CACHE_DIR="'"$cache_override"'"
        export PORTICO_LLM_API_KEY="portico-live-token-1234567890abcd"
        export BIFROST_BRIDGE_LOCAL_API_KEY="sk-bifrost-local-abcd"
        export OWUI_AUTH_BRIDGE_SECRET="owui-bridge-abcd"
        export WEBUI_SECRET_KEY="webui-secret-abcd"
        export OPENAI_API_KEY="sk-local-openai-abcd"
        export PORTICO_RUNTIME_DISABLE_KEYCHAIN="1"
        source "'"$helper_frag"'"
        prepare_optional_file_secret_ingress >/dev/null
        cleanup_runtime_secret_tmpdir
        [ ! -d "'"$cache_override"'" ] || exit 42
    ' || fail "cleanup_runtime_secret_tmpdir did not remove the cache dir when called explicitly"
}

test_prepare_optional_file_secret_ingress_imports_sensitive_runtime_files_without_host_cache() {
    local fixture helper_frag harness cache persisted output output_second output_third
    fixture="$(mktemp -d -t compose-runtime-file-ingress.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$fixture'" RETURN

    mkdir -p "$fixture/mcp-configs/snowflake" "$fixture/runtime" "$fixture/cache"
    printf 'token = "secret-token"\n' > "$fixture/runtime/connections.toml"
    cat > "$fixture/mcp-configs/snowflake/snowflake.yaml" <<'YAML'
name: Snowflake
id: snowflake
deployment_type: docker
runtime_files:
  - source: ./runtime/connections.toml
    target: /root/.snowflake/connections.toml
    sensitive: true
YAML

    helper_frag="$fixture/helper.sh"
    harness="$fixture/harness.sh"
    cache="$fixture/cache"
    persisted="$fixture/persisted-keychain"
    : > "$persisted"
    {
        printf 'PROJECT_ROOT=%q\n' "$fixture"
        printf 'YELLOW=""\nRED=""\nNC=""\n'
        cat "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
        printf 'discover_sensitive_runtime_file_descriptors() {\n    discover_sensitive_runtime_files\n}\n'
        awk '
            /^discover_sensitive_required_env_vars\(\)/ { capture_discovery=1 }
            capture_discovery { print }
            /^}$/ && capture_discovery { capture_discovery=0; print ""; next }
            /^PORTICO_RUNTIME_SECRET_TMPDIR=""/ { capture=1 }
            capture { print }
            /^}$/ && capture && past_prepare { capture=0 }
            /^prepare_optional_file_secret_ingress\(\)/ { past_prepare=1 }
        ' "$PROJECT_ROOT/src/scripts/docker-compose.sh"
    } > "$helper_frag"

    cat > "$harness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export PORTICO_RUNTIME_SECRET_CACHE_DIR="$2"
export PERSISTED_FILE="$3"
export PORTICO_LLM_API_KEY="portico-live-token-1234567890abcd"
export BIFROST_BRIDGE_LOCAL_API_KEY="sk-bifrost-local-abcd"
export OWUI_AUTH_BRIDGE_SECRET="owui-bridge-abcd"
export WEBUI_SECRET_KEY="webui-secret-abcd"
export OPENAI_API_KEY="sk-local-openai-abcd"
mode_of() {
    if stat -c '%a' "$1" >/dev/null 2>&1; then
        stat -c '%a' "$1"
    else
        stat -f '%Mp%Lp' "$1"
    fi
}
# shellcheck disable=SC1091
source "$1"
is_keychain_supported() { return 0; }
is_keychain_disabled() { return 1; }
is_keychain_only_mode() { return 0; }
upsert_secret_in_keychain() {
    printf '%s=%s\n' "$1" "$2" >> "$PERSISTED_FILE"
    return 0
}
read_secret_from_keychain() {
    awk -F= -v account="$1" '$1 == account { value = substr($0, index($0, "=") + 1) } END { if (value != "") print value; else exit 1 }' "$PERSISTED_FILE"
}
prepare_optional_file_secret_ingress
env | sort | awk -F= '/^portico_RUNTIME_FILE_SNOWFLAKE_CONNECTIONS_TOML_/ {
    print "RUNTIME_FILE_ENV="$1
    print "RUNTIME_FILE_PATH="$2
}'
env | sort | awk -F= '/^portico_STATIC_SECRET_AVAILABLE_SNOWFLAKE_/ {
    print "RUNTIME_FILE_AVAILABLE_ENV="$1
    print "RUNTIME_FILE_AVAILABLE_VALUE="$2
}'
sed 's/^/PERSISTED=/' "$PERSISTED_FILE"
EOF
    chmod +x "$harness"

    local expected_encoded
    expected_encoded="$(base64 < "$fixture/runtime/connections.toml" | tr -d '\r\n')"
    output="$(bash "$harness" "$helper_frag" "$cache" "$persisted")"

    local runtime_file_env runtime_file_path runtime_file_available_env runtime_file_available_value source_content
    runtime_file_env="$(awk -F= '/^RUNTIME_FILE_ENV=/{print $2}' <<<"$output")"
    runtime_file_path="$(awk -F= '/^RUNTIME_FILE_PATH=/{print $2}' <<<"$output")"
    runtime_file_available_env="$(awk -F= '/^RUNTIME_FILE_AVAILABLE_ENV=/{print $2}' <<<"$output")"
    runtime_file_available_value="$(awk -F= '/^RUNTIME_FILE_AVAILABLE_VALUE=/{print $2}' <<<"$output")"
    [ -z "$runtime_file_env" ] || fail "sensitive runtime-file ingress must not export a generated *_FILE env key"
    [ -z "$runtime_file_path" ] || fail "sensitive runtime-file ingress must not export a generated host secret file path"
    [[ "$runtime_file_available_env" == portico_STATIC_SECRET_AVAILABLE_SNOWFLAKE_* ]] \
        || fail "sensitive runtime-file ingress must export a scoped availability signal"
    [ "$runtime_file_available_value" = "1" ] \
        || fail "sensitive runtime-file availability signal must be set to 1"
    if find "$cache" -type f -name 'portico_runtime_file_snowflake_connections_toml_*' | grep -q .; then
        fail "sensitive runtime-file ingress must not materialize a durable host-cache file"
    fi
    assert_text_contains "$output" \
        "PERSISTED=MCP_RUNTIME_FILE::snowflake::" \
        "sensitive runtime-file ingress must persist source bytes to its Keychain account"
    assert_text_contains "$output" \
        "=$expected_encoded" \
        "sensitive runtime-file Keychain value must be base64-encoded source bytes"
    source_content="$(cat "$fixture/runtime/connections.toml")"
    assert_text_contains "$source_content" \
        "secret-token" \
        "the user-owned sensitive runtime-file source must stay untouched after import"
    refute_text_contains "$source_content" \
        "# Portico imported this sensitive runtime file into secure storage." \
        "sensitive runtime-file source must not be replaced with the secure-import stub"

    output_second="$(bash "$harness" "$helper_frag" "$cache" "$persisted")"
    runtime_file_env="$(awk -F= '/^RUNTIME_FILE_ENV=/{print $2}' <<<"$output_second")"
    runtime_file_path="$(awk -F= '/^RUNTIME_FILE_PATH=/{print $2}' <<<"$output_second")"
    runtime_file_available_value="$(awk -F= '/^RUNTIME_FILE_AVAILABLE_VALUE=/{print $2}' <<<"$output_second")"
    [ -z "$runtime_file_env" ] || fail "unchanged sensitive runtime-file source must not export a generated *_FILE env key"
    [ -z "$runtime_file_path" ] || fail "unchanged sensitive runtime-file source must not export a generated host secret file path"
    [ "$runtime_file_available_value" = "1" ] \
        || fail "persisted sensitive runtime-file availability must survive restart"
    if find "$cache" -type f -name 'portico_runtime_file_snowflake_connections_toml_*' | grep -q .; then
        fail "unchanged sensitive runtime-file source must not recreate a durable host-cache file"
    fi
    [ "$(grep -c '^MCP_RUNTIME_FILE::snowflake::' "$persisted")" -eq 1 ] \
        || fail "an unchanged sensitive runtime-file source must not be re-persisted as a secret"

    printf 'token = "rotated-token"\n' > "$fixture/runtime/connections.toml"
    local rotated_encoded
    rotated_encoded="$(base64 < "$fixture/runtime/connections.toml" | tr -d '\r\n')"
    output_third="$(bash "$harness" "$helper_frag" "$cache" "$persisted")"
    runtime_file_available_value="$(awk -F= '/^RUNTIME_FILE_AVAILABLE_VALUE=/{print $2}' <<<"$output_third")"
    [ "$runtime_file_available_value" = "1" ] \
        || fail "rotated sensitive runtime-file availability must be set to 1"
    [ "$(grep -c '^MCP_RUNTIME_FILE::snowflake::' "$persisted")" -eq 2 ] \
        || fail "a changed sensitive runtime-file source must refresh the persisted secret"
    assert_text_contains "$(cat "$persisted")" \
        "=$rotated_encoded" \
        "the refreshed Keychain value must be the rotated source bytes"
    assert_text_contains "$(cat "$fixture/runtime/connections.toml")" \
        "rotated-token" \
        "rotation must leave the user-owned source file in place"
}

test_stop_containers_invokes_cleanup() {
    # Regression guard: ensure the stop path actually calls
    # cleanup_runtime_secret_tmpdir after the Compose down, otherwise a later
    # start would inherit a stale cache dir owned by a now-gone container set.
    local source_file="$PROJECT_ROOT/src/scripts/docker-compose.sh"
    # The call must appear inside stop_containers(), after at least one
    # shared Compose wrapper invocation.
    awk '
        /^stop_containers\(\)/ { in_fn = 1 }
        in_fn && /^\}$/ { in_fn = 0 }
        in_fn && /run_docker_compose .* down/ { saw_down = 1 }
        in_fn && /cleanup_runtime_secret_tmpdir/ && saw_down { print "OK"; exit 0 }
        END { if (!saw_down) print "NO_DOWN"; else print "NO_CLEANUP" }
    ' "$source_file" | grep -q '^OK$' \
	    || fail "stop_containers() must call cleanup_runtime_secret_tmpdir after the Compose wrapper down"
}

test_llm_gateway_secret_mount_guard_recreates_deleted_mounts() {
    local tmp_dir helper_frag harness docker_log exec_count_file
    tmp_dir="$(mktemp -d)"
    helper_frag="$tmp_dir/helper.sh"
    harness="$tmp_dir/harness.sh"
    docker_log="$tmp_dir/docker.log"
    exec_count_file="$tmp_dir/exec-count"

    {
        printf 'YELLOW=""\nRED=""\nGREEN=""\nNC=""\n'
        awk '
            /^check_llm_gateway_runtime_secret_mounts\(\)/ { capture=1 }
            capture { print }
            /^ensure_llm_gateway_runtime_secret_mounts\(\)/ { in_ensure=1 }
            capture && in_ensure && /^}$/ { exit }
        ' "$PROJECT_ROOT/src/scripts/docker-compose.sh"
    } > "$helper_frag"

    grep -q "check_llm_gateway_runtime_secret_mounts" "$helper_frag" \
        || fail "failed to extract llm-gateway secret mount check"
    grep -q "ensure_llm_gateway_runtime_secret_mounts" "$helper_frag" \
        || fail "failed to extract llm-gateway secret mount recovery"

    cat > "$harness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$1"

prepare_compose_runtime_env() {
    printf 'prepare_compose_runtime_env\n' >> "$DOCKER_LOG"
}

run_docker_compose() {
    docker compose "$@"
}

docker() {
    printf '%s\n' "$*" >> "$DOCKER_LOG"
    case "${1:-}" in
        inspect)
            printf 'running\n'
            return 0
            ;;
        exec)
            local count
            count="$(cat "$EXEC_COUNT_FILE" 2>/dev/null || printf '0')"
            count=$((count + 1))
            printf '%s\n' "$count" > "$EXEC_COUNT_FILE"
            if [ "$count" -eq 1 ]; then
                printf 'deleted_mount:/run/secrets/portico_llm_api_key\n'
                return 1
            fi
            return 0
            ;;
        compose)
            case "$*" in
                *" config --services"*)
                    printf 'llm-gateway\n'
                    return 0
                    ;;
            esac
            return 0
            ;;
    esac
    return 0
}

ensure_llm_gateway_runtime_secret_mounts "-f docker-compose.yml"
EOF
    chmod +x "$harness"

    DOCKER_LOG="$docker_log" EXEC_COUNT_FILE="$exec_count_file" \
        bash "$harness" "$helper_frag" >/dev/null 2>&1 \
        || fail "llm-gateway secret mount guard should recover after force-recreate"

    grep -Fq "prepare_compose_runtime_env" "$docker_log" \
        || fail "expected guard to re-prepare runtime secrets before recreating llm-gateway"
    grep -Fq "compose -f docker-compose.yml up -d --force-recreate --no-deps llm-gateway" "$docker_log" \
        || fail "expected guard to force-recreate only llm-gateway"
    [ "$(cat "$exec_count_file")" = "2" ] \
        || fail "expected guard to re-check llm-gateway secret mounts after recreate"
}

test_core_secret_mount_guard_recreates_affected_services_sequentially() {
    local tmp_dir helper_frag harness docker_log exec_count_dir
    tmp_dir="$(mktemp -d)"
    helper_frag="$tmp_dir/helper.sh"
    harness="$tmp_dir/harness.sh"
    docker_log="$tmp_dir/docker.log"
    exec_count_dir="$tmp_dir/exec-counts"
    mkdir -p "$exec_count_dir"

    {
        printf 'YELLOW=""\nRED=""\nGREEN=""\nNC=""\n'
        awk '
            /^check_container_runtime_secret_mounts\(\)/ { capture=1 }
            capture { print }
            /^ensure_core_runtime_secret_mounts\(\)/ { in_ensure=1 }
            capture && in_ensure && /^}$/ { exit }
        ' "$PROJECT_ROOT/src/scripts/docker-compose.sh"
    } > "$helper_frag"

    grep -q "check_container_runtime_secret_mounts" "$helper_frag" \
        || fail "failed to extract generic runtime secret mount check"
    grep -q "ensure_core_runtime_secret_mounts" "$helper_frag" \
        || fail "failed to extract core runtime secret mount recovery"

    cat > "$harness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$1"

prepare_compose_runtime_env() {
    printf 'prepare_compose_runtime_env\n' >> "$DOCKER_LOG"
}

run_docker_compose() {
    docker compose "$@"
}

docker() {
    printf '%s\n' "$*" >> "$DOCKER_LOG"
    case "${1:-}" in
        inspect)
            printf 'running\n'
            return 0
            ;;
        exec)
            local container_name count count_file
            container_name="${4:-unknown}"
            count_file="$EXEC_COUNT_DIR/$container_name"
            count="$(cat "$count_file" 2>/dev/null || printf '0')"
            count=$((count + 1))
            printf '%s\n' "$count" > "$count_file"
            if [ "$count" -eq 1 ]; then
                printf 'missing_or_empty:/run/secrets/owui_auth_bridge_secret\n'
                return 1
            fi
            return 0
            ;;
        compose)
            case "$*" in
                *" config --services"*)
                    printf 'open-webui\nmcpo-core\nmcpo-group-core\n'
                    return 0
                    ;;
            esac
            return 0
            ;;
    esac
    return 0
}

ensure_core_runtime_secret_mounts "-f docker-compose.yml"
EOF
    chmod +x "$harness"

    DOCKER_LOG="$docker_log" EXEC_COUNT_DIR="$exec_count_dir" \
        bash "$harness" "$helper_frag" >/dev/null 2>&1 \
        || fail "core secret mount guard should recover each affected service"

    [ "$(grep -Fc 'prepare_compose_runtime_env' "$docker_log")" -eq 3 ] \
        || fail "expected runtime secrets to be prepared before each sequential recreation"
    grep -Fq "compose -f docker-compose.yml up -d --force-recreate --no-deps open-webui" "$docker_log" \
        || fail "expected guard to recreate only open-webui"
    grep -Fq "compose -f docker-compose.yml up -d --force-recreate --no-deps mcpo-core" "$docker_log" \
        || fail "expected guard to recreate only mcpo-core"
    grep -Fq "compose -f docker-compose.yml up -d --force-recreate --no-deps mcpo-group-core" "$docker_log" \
        || fail "expected guard to recreate only mcpo-group-core"
    [ "$(cat "$exec_count_dir/portico-open-webui")" = "2" ] \
        || fail "expected guard to re-check open-webui secret mounts"
    [ "$(cat "$exec_count_dir/mcpo-core")" = "2" ] \
        || fail "expected guard to re-check mcpo-core secret mounts"
    [ "$(cat "$exec_count_dir/mcpo-group-core")" = "2" ] \
        || fail "expected guard to re-check mcpo-group-core secret mounts"
}

test_retired_oauth_secret_mount_guard_helpers_do_not_exist() {
    refute_file_contains "$PROJECT_ROOT/src/scripts/docker-compose.sh" \
        "list_oauth_secret_consumer_services()" \
        "retired OAuth secret consumer discovery helper must not return"
    refute_file_contains "$PROJECT_ROOT/src/scripts/docker-compose.sh" \
        "ensure_oauth_secret_consumer_mounts()" \
        "retired OAuth secret mount guard must not return"
}

test_start_mcpo_materializes_static_secret_broker_targets() {
    local tmp_dir fake_bin broker_port_file broker_request_file broker_pid output status
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    broker_port_file="$tmp_dir/broker-port"
    broker_request_file="$tmp_dir/broker-request"
    mkdir -p "$fake_bin" "$tmp_dir/app" "$tmp_dir/tmpfs" "$tmp_dir/link-target"
    cat > "$fake_bin/mcpo" <<'EOF'
#!/bin/sh
exit 0
EOF
    cat > "$fake_bin/envsubst" <<'EOF'
#!/bin/sh
cat
EOF
    chmod +x "$fake_bin/mcpo" "$fake_bin/envsubst"
    printf '%s\n' '{"mcpServers":{}}' > "$tmp_dir/app/mcp_config.json"

    python3 - "$broker_port_file" "$broker_request_file" <<'PY' &
import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port_file, request_file = sys.argv[1:3]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length)
        with open(request_file, "w", encoding="utf-8") as handle:
            handle.write(self.headers.get("Authorization", ""))
            handle.write("\n")
            handle.write(body.decode("utf-8"))
        payload = json.loads(body.decode("utf-8"))
        if (
            self.path != "/secrets/static-secret"
            or self.headers.get("Authorization") != "Bearer scoped-static-token"
            or payload.get("server_id") != "snowflake"
            or payload.get("secret_name") != "snowflake_key"
        ):
            self.send_response(403)
            self.end_headers()
            return
        response = json.dumps({
            "server_id": "snowflake",
            "secret_name": "snowflake_key",
            "value_base64": base64.b64encode(b"token = \"broker-secret\"").decode("ascii"),
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

server = HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_port))
server.handle_request()
PY
    broker_pid=$!
    trap "kill '$broker_pid' 2>/dev/null || true; rm -rf '$tmp_dir'" RETURN
    for _attempt in $(seq 1 50); do
        [ -s "$broker_port_file" ] && break
        sleep 0.1
    done
    [ -s "$broker_port_file" ] || fail "static secret broker fixture did not start"

    local broker_port secret_path link_path secret_mode link_target
    broker_port="$(cat "$broker_port_file")"
    secret_path="$tmp_dir/tmpfs/snowflake_key"
    link_path="$tmp_dir/link-target/connections.toml"

    set +e
    output="$(
        env \
            PATH="$fake_bin:/usr/bin:/bin" \
            MCPO_PRESYNC_MODE=none \
            MCPO_TEMP_DIR="$tmp_dir/tmp" \
            MCPO_APP_ROOT="$tmp_dir/app" \
            CONFIG_FILE=mcp_config.json \
            portico_STATIC_SECRET_BROKER_URL="http://127.0.0.1:${broker_port}/secrets/static-secret" \
            portico_STATIC_SECRET_TARGETS="snowflake|snowflake_key|${secret_path}|portico_STATIC_SECRET_TOKEN_SNOWFLAKE_SNOWFLAKE_KEY|${link_path}" \
            portico_STATIC_SECRET_TOKEN_SNOWFLAKE_SNOWFLAKE_KEY="scoped-static-token" \
            bash "$PROJECT_ROOT/src/scripts/start-mcpo.sh" 2>&1
    )"
    status=$?
    set -e
    wait "$broker_pid" || fail "static secret broker fixture failed"

    [ "$status" -eq 0 ] || fail "start-mcpo.sh should materialize static broker targets, got $status: $output"
    [ -f "$secret_path" ] || fail "static secret materializer did not create target file"
    [ "$(cat "$secret_path")" = 'token = "broker-secret"' ] \
        || fail "static secret materializer wrote unexpected payload"
    secret_mode="$(stat -c '%a' "$secret_path" 2>/dev/null || stat -f '%Mp%Lp' "$secret_path")"
    case "$secret_mode" in
        600|0600) ;;
        *) fail "static secret materialized file should be 0600, got $secret_mode" ;;
    esac
    [ -L "$link_path" ] || fail "static secret runtime-file target should be a symlink into tmpfs"
    link_target="$(readlink "$link_path")"
    [ "$link_target" = "$secret_path" ] || fail "static secret symlink points to '$link_target', expected '$secret_path'"
    assert_text_contains "$(cat "$broker_request_file")" \
        '"server_id": "snowflake"' \
        "static secret materializer must request only its configured server"
    refute_text_contains "$output" \
        "broker-secret" \
        "start-mcpo.sh must not print materialized static secret values"
    refute_text_contains "$output" \
        "scoped-static-token" \
        "start-mcpo.sh must not print scoped static-secret broker tokens"
}

test_runtime_secrets_migrates_sensitive_mcp_plaintext_once() {
    local fixture
    fixture="$(mktemp -d)"
    local managed_root="$fixture/managed"
    local project_root="$fixture/project"
    mkdir -p "$managed_root" "$project_root/mcp-configs/matrix"
    cat > "$project_root/mcp-configs/matrix/matrix.yaml" <<'YAML'
name: Matrix
required_env_vars:
  - name: MATRIX_SECRET_TOKEN
    sensitive: true
YAML
    printf "MATRIX_SECRET_TOKEN='project-env-secret'\n" > "$project_root/.env"
    printf 'MATRIX_SECRET_TOKEN=project-runtime-secret\n' > "$project_root/.env.runtime"
    printf 'MATRIX_SECRET_TOKEN=managed-runtime-secret\n' > "$managed_root/runtime-secrets.env"

    local harness="$fixture/harness.sh"
    cat > "$harness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
read_secret_from_keychain() {
    local key="$1" line
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "$key="*)
                printf '%s\n' "${line#*=}"
                return 0
                ;;
        esac
    done < "$PERSISTED_FILE"
    return 1
}
upsert_secret_in_keychain() {
    local key="$1" value="$2" temp
    temp="$(mktemp)"
    grep -v "^${key}=" "$PERSISTED_FILE" > "$temp" || true
    printf '%s=%s\n' "$key" "$value" >> "$temp"
    mv "$temp" "$PERSISTED_FILE"
    return 0
}

unset MATRIX_SECRET_TOKEN
ensure_mcp_sensitive_env_secret_presence
printf 'AVAILABLE=%s\n' "${portico_STATIC_SECRET_AVAILABLE_MATRIX_MATRIX_SECRET_TOKEN:-}"
printf 'RAW_PRESENT=%s\n' "${MATRIX_SECRET_TOKEN+x}"
printf 'PERSISTED=%s\n' "$(cat "$PERSISTED_FILE")"
printf 'MARKER=%s\n' "$(test -f "$PROJECT_ROOT/open-webui-data/runtime-migrations/mcp-sensitive-env-keychain-v1" && echo yes || echo no)"
printf 'ENV=%s\n' "$(cat "$PROJECT_ROOT/.env")"
printf 'ENV_RUNTIME=%s\n' "$(cat "$PROJECT_ROOT/.env.runtime")"

unset portico_STATIC_SECRET_AVAILABLE_MATRIX_MATRIX_SECRET_TOKEN
ensure_mcp_sensitive_env_secret_presence
printf 'RESTART_AVAILABLE=%s\n' "${portico_STATIC_SECRET_AVAILABLE_MATRIX_MATRIX_SECRET_TOKEN:-}"
EOF
    chmod +x "$harness"

    local persisted="$fixture/persisted"
    : > "$persisted"
    local output
    output="$(
        PROJECT_ROOT="$project_root" \
        PORTICO_MANAGED_ROOT="$managed_root" \
        PERSISTED_FILE="$persisted" \
        bash "$harness" "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
    )"

    assert_text_contains "$output" \
        "AVAILABLE=1" \
        "runtime-secrets helper must emit a scoped availability signal after verified migration"
    assert_text_contains "$output" \
        "RAW_PRESENT=" \
        "runtime-secrets helper must remove raw sensitive MCP values from the child environment"
    assert_text_contains "$output" \
        "PERSISTED=MATRIX_SECRET_TOKEN=project-env-secret" \
        "runtime-secrets helper must prefer and persist the beta-style project .env value"
    assert_text_contains "$output" \
        "MARKER=yes" \
        "runtime-secrets helper must complete the one-time migration marker"
    assert_text_contains "$output" \
        "RESTART_AVAILABLE=1" \
        "runtime-secrets helper must survive restart using Keychain only"
    refute_text_contains "$output" \
        "project-runtime-secret" \
        "runtime-secrets helper must prefer .env over .env.runtime"
    refute_text_contains "$output" \
        "managed-runtime-secret" \
        "runtime-secrets helper must not read managed plaintext mirrors for sensitive MCP secrets"
    refute_text_contains "$output" \
        "ENV=MATRIX_SECRET_TOKEN" \
        "runtime-secrets helper must scrub the migrated project .env value"
    refute_text_contains "$output" \
        "ENV_RUNTIME=MATRIX_SECRET_TOKEN" \
        "runtime-secrets helper must scrub the migrated project .env.runtime value"

    rm -rf "$fixture"
}

test_runtime_secrets_sensitive_mcp_migration_fails_closed() {
    local fixture
    fixture="$(mktemp -d)"
    local project_root="$fixture/project"
    mkdir -p "$project_root/mcp-configs/matrix"
    cat > "$project_root/mcp-configs/matrix/matrix.yaml" <<'YAML'
name: Matrix
required_env_vars:
  - name: MATRIX_SECRET_TOKEN
    sensitive: true
YAML
    printf 'MATRIX_SECRET_TOKEN=must-remain\n' > "$project_root/.env"

    local harness="$fixture/harness.sh"
    cat > "$harness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
upsert_secret_in_keychain() { return 0; }
read_secret_from_keychain() { return 1; }

if ensure_mcp_sensitive_env_secret_presence 2>/dev/null; then
    echo "UNEXPECTED_SUCCESS"
    exit 10
fi
printf 'SOURCE=%s\n' "$(cat "$PROJECT_ROOT/.env")"
printf 'MARKER=%s\n' "$(test -f "$PROJECT_ROOT/open-webui-data/runtime-migrations/mcp-sensitive-env-keychain-v1" && echo yes || echo no)"
printf 'AVAILABLE=%s\n' "${portico_STATIC_SECRET_AVAILABLE_MATRIX_MATRIX_SECRET_TOKEN:-}"
EOF
    chmod +x "$harness"

    local output
    output="$(
        PROJECT_ROOT="$project_root" \
        bash "$harness" "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
    )"

    assert_text_contains "$output" \
        "SOURCE=MATRIX_SECRET_TOKEN=must-remain" \
        "failed Keychain readback must preserve the beta plaintext source"
    assert_text_contains "$output" \
        "MARKER=no" \
        "failed Keychain readback must not complete the migration marker"
    assert_text_contains "$output" \
        "AVAILABLE=" \
        "failed Keychain readback must not emit an availability signal"

    rm -rf "$fixture"
}

test_runtime_secrets_prunes_empty_legacy_slack_oauth_dirs() {
    local fixture project_root output
    fixture="$(mktemp -d -t runtime-secrets-legacy-oauth.XXXXXX)"
    project_root="$fixture/project"
    mkdir -p \
        "$project_root/mcpo-oauth-tokens/slack/tokens" \
        "$project_root/mcpo-core-oauth-tokens/slack/tokens" \
        "$project_root/open-webui-data/runtime-migrations"
    printf '%s\n' '{"migration":"slack-pkce-public-client-artifacts-cleared","marker_version":2}' \
        > "$project_root/open-webui-data/runtime-migrations/slack-pkce-public-client-artifacts-cleared-v2"

    local harness="$fixture/harness.sh"
    cat > "$harness" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
clear_legacy_slack_pkce_oauth_artifacts_once
for path in \
    "$PROJECT_ROOT/mcpo-oauth-tokens" \
    "$PROJECT_ROOT/mcpo-core-oauth-tokens"; do
    if [ -e "$path" ]; then
        printf 'PRESENT=%s\n' "$path"
    fi
done
EOF
    chmod +x "$harness"

    output="$(
        PROJECT_ROOT="$project_root" \
        bash "$harness" "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
    )"
    [ -z "$output" ] || fail "runtime-secrets helper must prune empty legacy OAuth roots, got: $output"

    rm -rf "$fixture"
}

test_runtime_secrets_does_not_ship_legacy_shared_key_fallback() {
    if bash -c '
        source "$1"
        declare -F resolve_legacy_derived_portico_llm_api_key >/dev/null
    ' bash "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"; then
        fail "runtime-secrets helper must not expose a bundled derived provider key fallback"
    fi
}

test_runtime_secrets_rejects_short_upstream_keys() {
    bash -c '
        source "$1"
        is_malformed_upstream_key "ab"
    ' bash "$PROJECT_ROOT/src/scripts/runtime-secrets.sh" || fail "runtime-secrets helper must reject very short upstream keys"

    bash -c '
        source "$1"
        ! is_malformed_upstream_key "from-env"
    ' bash "$PROJECT_ROOT/src/scripts/runtime-secrets.sh" || fail "runtime-secrets helper must keep existing dev-length upstream fixtures valid"
}

test_packaged_cloudsmith_entitlement_resolution_precedence() {
    (
        source "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"

        local fixture source_env actual
        fixture="$(mktemp -d -t packaged-cloudsmith-token.XXXXXX)"
        source_env="$fixture/cloudsmith.env"
        printf '%s\n' 'CLOUDSMITH_ENTITLEMENT_TOKEN="source-file-token"' > "$source_env"

        read_packaged_cloudsmith_entitlement_from_keychain() {
            fail "Keychain must not be read when an earlier packaged-build source is configured"
        }

        export CLOUDSMITH_ENTITLEMENT_TOKEN=" environment-token "
        actual="$(resolve_packaged_cloudsmith_entitlement_token "$source_env")"
        [ "$actual" = "environment-token" ] \
            || fail "packaged Cloudsmith resolver must prefer the environment"

        unset CLOUDSMITH_ENTITLEMENT_TOKEN
        actual="$(resolve_packaged_cloudsmith_entitlement_token "$source_env")"
        [ "$actual" = "source-file-token" ] \
            || fail "packaged Cloudsmith resolver must use the source file before Keychain"

        printf '%s\n' 'CLOUDSMITH_OWNER="portico"' > "$source_env"
        read_packaged_cloudsmith_entitlement_from_keychain() {
            printf '%s\n' 'keychain-token'
        }
        actual="$(resolve_packaged_cloudsmith_entitlement_token "$source_env")"
        [ "$actual" = "keychain-token" ] \
            || fail "packaged Cloudsmith resolver must fall back to Keychain"

        read_packaged_cloudsmith_entitlement_from_keychain() { return 1; }
        if resolve_packaged_cloudsmith_entitlement_token "$source_env" >/dev/null 2>&1; then
            fail "packaged Cloudsmith resolver must fail closed when every source is absent"
        fi

        rm -rf "$fixture"
    )
}

test_packaged_cloudsmith_keychain_reader_contract() {
    (
        source "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"

        local fixture calls_file error_file actual status
        fixture="$(mktemp -d -t packaged-cloudsmith-keychain.XXXXXX)"
        calls_file="$fixture/security-calls"
        error_file="$fixture/error.log"
        unset PORTICO_RUNTIME_DISABLE_KEYCHAIN

        is_keychain_supported() { return 0; }
        is_keychain_disabled() { return 1; }
        security() {
            printf '%s\n' "$*" > "$calls_file"
            printf '%s\n' ' keychain-token '
        }

        PORTICO_LLM_KEYCHAIN_SERVICE="custom-service"
        CLOUDSMITH_ENTITLEMENT_KEYCHAIN_ACCOUNT="custom-account"
        actual="$(read_packaged_cloudsmith_entitlement_from_keychain)"
        [ "$actual" = "keychain-token" ] \
            || fail "packaged Cloudsmith Keychain reader must trim the resolved token"
        assert_file_contains "$calls_file" \
            "find-generic-password -s custom-service -a custom-account -w" \
            "packaged Cloudsmith Keychain reader must honor custom coordinates"

        security() { return 44; }
        set +e
        read_packaged_cloudsmith_entitlement_from_keychain >/dev/null 2> "$error_file"
        status=$?
        set -e
        [ "$status" -eq 1 ] || fail "missing Keychain items must be treated as an absent source"
        [ ! -s "$error_file" ] || fail "missing Keychain items must not emit an error diagnostic"

        security() { return 17; }
        set +e
        read_packaged_cloudsmith_entitlement_from_keychain >/dev/null 2> "$error_file"
        status=$?
        set -e
        [ "$status" -eq 2 ] || fail "unexpected Keychain read failures must remain distinguishable"
        assert_file_contains "$error_file" \
            "Failed to read CLOUDSMITH_ENTITLEMENT_TOKEN from macOS Keychain" \
            "unexpected Keychain failures must emit an actionable diagnostic"

        is_keychain_supported() { return 1; }
        security() { fail "security must not run when macOS Keychain is unavailable"; }
        set +e
        read_packaged_cloudsmith_entitlement_from_keychain >/dev/null 2> "$error_file"
        status=$?
        set -e
        [ "$status" -eq 1 ] || fail "non-Darwin hosts must report Keychain as unavailable"

        rm -rf "$fixture"
    )
}

test_ultra_signing_secret_rejects_late_resolved_peer_collisions() {
    local signing_secret
    signing_secret="ultra-sign-v1-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

    if (
        source "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
        unset LOCAL_STACK_API_KEY INTERNAL_OPENAI_API_KEY OPENAI_API_KEY
        unset BIFROST_BRIDGE_LOCAL_API_KEY OWUI_AUTH_BRIDGE_SECRET WEBUI_SECRET_KEY
        unset PORTICO_LLM_API_KEY CLOUDSMITH_ENTITLEMENT_TOKEN
        export ULTRA_MULTI_AGENT_SIGNING_SECRET="$signing_secret"

        resolve_local_stack_api_key() { printf '%s\n' 'local-stack-secret'; }
        resolve_bifrost_local_api_key() { printf '%s\n' 'bifrost-secret'; }
        resolve_owui_auth_bridge_secret() { printf '%s\n' "$signing_secret"; }
        resolve_webui_secret_key() { printf '%s\n' 'webui-secret'; }
        resolve_portico_llm_api_key() { printf '%s\n' 'upstream-secret'; }
        resolve_cloudsmith_entitlement_token() { return 1; }
        cleanup_legacy_bundled_slack_keychain_credentials() { :; }
        clear_legacy_slack_pkce_oauth_artifacts_once() { :; }
        ensure_mcp_sensitive_env_secret_presence() { :; }

        ensure_runtime_secret_env >/dev/null 2>&1
    ); then
        fail "Ultra signing secret must be rejected when a later-resolved OWUI secret is equal"
    fi

    if (
        source "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
        unset LOCAL_STACK_API_KEY INTERNAL_OPENAI_API_KEY OPENAI_API_KEY
        unset BIFROST_BRIDGE_LOCAL_API_KEY OWUI_AUTH_BRIDGE_SECRET WEBUI_SECRET_KEY
        unset PORTICO_LLM_API_KEY CLOUDSMITH_ENTITLEMENT_TOKEN
        export ULTRA_MULTI_AGENT_SIGNING_SECRET="$signing_secret"

        resolve_local_stack_api_key() { printf '%s\n' 'local-stack-secret'; }
        resolve_bifrost_local_api_key() { printf '%s\n' 'bifrost-secret'; }
        resolve_owui_auth_bridge_secret() { printf '%s\n' 'owui-secret'; }
        resolve_webui_secret_key() { printf '%s\n' 'webui-secret'; }
        resolve_portico_llm_api_key() { printf '%s\n' "$signing_secret"; }
        resolve_cloudsmith_entitlement_token() { return 1; }
        cleanup_legacy_bundled_slack_keychain_credentials() { :; }
        clear_legacy_slack_pkce_oauth_artifacts_once() { :; }
        ensure_mcp_sensitive_env_secret_presence() { :; }

        ensure_runtime_secret_env >/dev/null 2>&1
    ); then
        fail "Ultra signing secret must be rejected when a later-resolved upstream key is equal"
    fi

    (
        source "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"
        unset LOCAL_STACK_API_KEY INTERNAL_OPENAI_API_KEY OPENAI_API_KEY
        unset BIFROST_BRIDGE_LOCAL_API_KEY OWUI_AUTH_BRIDGE_SECRET WEBUI_SECRET_KEY
        unset PORTICO_LLM_API_KEY CLOUDSMITH_ENTITLEMENT_TOKEN
        export ULTRA_MULTI_AGENT_SIGNING_SECRET="$signing_secret"

        resolve_local_stack_api_key() { printf '%s\n' 'local-stack-secret'; }
        resolve_bifrost_local_api_key() { printf '%s\n' 'bifrost-secret'; }
        resolve_owui_auth_bridge_secret() { printf '%s\n' 'owui-secret'; }
        resolve_webui_secret_key() { printf '%s\n' 'webui-secret'; }
        resolve_portico_llm_api_key() { printf '%s\n' 'upstream-secret'; }
        resolve_cloudsmith_entitlement_token() { return 1; }
        cleanup_legacy_bundled_slack_keychain_credentials() { :; }
        clear_legacy_slack_pkce_oauth_artifacts_once() { :; }
        ensure_mcp_sensitive_env_secret_presence() { :; }

        ensure_runtime_secret_env >/dev/null
        [ "$ULTRA_MULTI_AGENT_SIGNING_SECRET" = "$signing_secret" ]
    ) || fail "Ultra signing secret must remain valid when every peer secret is distinct"
}

test_base_compose_uses_docker_secrets_for_bifrost_gateway
test_base_compose_uses_docker_secrets_for_mcpo
test_open_webui_mounts_health_status_read_only_for_prompt_context
test_docker_socket_proxy_is_internal_and_not_on_default_network
test_generated_core_group_uses_docker_proxy_without_raw_socket
test_compose_env_sanitizer_preserves_release_operator_cloudsmith_key
test_compose_never_delivers_project_env_file
test_compose_no_longer_delivers_slack_oauth_client_secret
test_slack_uses_oauth_file_ingress
test_slack_rebuild_is_explicit_and_public
test_debug_monitor_uses_token_file_secret
test_generated_compose_routes_sensitive_required_env_vars_as_secrets
test_generated_compose_routes_sensitive_runtime_files_as_secrets
test_generated_compose_preserves_sensitive_non_sensitive_presets_and_fragment_precedence
test_generated_docker_node_mcp_uses_managed_store_without_package_manager_credentials
test_runtime_dockerfiles_do_not_bake_npm_registry_credentials
test_compose_config_without_ingress_succeeds
test_prepare_optional_file_secret_ingress_tmpdir_lifecycle
test_prepare_optional_file_secret_ingress_imports_sensitive_runtime_files_without_host_cache
test_stop_containers_invokes_cleanup
test_llm_gateway_secret_mount_guard_recreates_deleted_mounts
test_core_secret_mount_guard_recreates_affected_services_sequentially
test_retired_oauth_secret_mount_guard_helpers_do_not_exist
test_start_mcpo_materializes_static_secret_broker_targets
test_runtime_secrets_migrates_sensitive_mcp_plaintext_once
test_runtime_secrets_sensitive_mcp_migration_fails_closed
test_runtime_secrets_prunes_empty_legacy_slack_oauth_dirs
test_runtime_secrets_does_not_ship_legacy_shared_key_fallback
test_runtime_secrets_rejects_short_upstream_keys
test_ultra_signing_secret_rejects_late_resolved_peer_collisions
test_packaged_cloudsmith_entitlement_resolution_precedence
test_packaged_cloudsmith_keychain_reader_contract

echo "All docker-compose runtime-secret regressions passed."
