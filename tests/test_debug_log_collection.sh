#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEBUG_SCRIPT="$PROJECT_ROOT/src/scripts/debug.sh"
MIDDLEWARE_FILE="$PROJECT_ROOT/src/patches/backend/open_webui/utils/middleware.py"
OPENAI_FILE="$PROJECT_ROOT/src/patches/backend/open_webui/routers/openai.py"
CHATS_FILE="$PROJECT_ROOT/src/patches/backend/open_webui/routers/chats.py"
CHAT_UTILS_FILE="$PROJECT_ROOT/src/patches/backend/open_webui/utils/chat.py"
SKILL_MANAGER_FILE="$PROJECT_ROOT/src/managers/skill_manager.py"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in /usr/local/lib/nodejs/node-*/bin/node "$HOME/.nvm"/versions/node/*/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

test_source_does_not_execute_main() {
  local output
  output="$(bash -c 'set -euo pipefail; source "$1"; echo sourced-ok' bash "$DEBUG_SCRIPT")"
  [ "$output" = "sourced-ok" ] || fail "sourcing debug.sh executed main()"
}

test_live_sampling_arguments_are_validated() {
  local output
  output="$(bash -c 'source "$1"; parse_args --live --duration 60; printf "%s:%s\n" "$LIVE_MODE" "$LIVE_DURATION"' bash "$DEBUG_SCRIPT")"
  [ "$output" = "true:60" ] \
    || fail "expected --live --duration 60 to enable a 60-second sampler, saw: $output"

  output="$(bash -c 'source "$1"; parse_args --live --duration=120; printf "%s:%s\n" "$LIVE_MODE" "$LIVE_DURATION"' bash "$DEBUG_SCRIPT")"
  [ "$output" = "true:120" ] \
    || fail "expected --duration=120 to be accepted, saw: $output"

  ! bash -c 'source "$1"; parse_args --live --duration 0' bash "$DEBUG_SCRIPT" >/dev/null 2>&1 \
    || fail "zero-second live duration must be rejected"
  ! bash -c 'source "$1"; parse_args --live --duration 121' bash "$DEBUG_SCRIPT" >/dev/null 2>&1 \
    || fail "live duration over 120 seconds must be rejected"
  ! bash -c 'source "$1"; parse_args --duration 30' bash "$DEBUG_SCRIPT" >/dev/null 2>&1 \
    || fail "--duration without --live must be rejected"
}

test_database_snapshot_collection_is_secret_safe_and_graceful() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir fake_bin output_file docker_args
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    output_file="$tmp_dir/database-diagnostics.json"
    docker_args="$tmp_dir/docker-args.txt"
    mkdir -p "$fake_bin"

    cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$DOCKER_ARGS_FILE"
cat >/dev/null
printf '%s\n' '{"sampledAt":"2026-01-01T00:00:00Z","available":true,"snapshot":{"schemaVersion":1,"activeTransactions":[]}}'
SH
    chmod +x "$fake_bin/docker"
    PATH="$fake_bin:$PATH"
    DOCKER_ARGS_FILE="$docker_args"
    export PATH DOCKER_ARGS_FILE

    collect_database_diagnostics_snapshot "portico-open-webui" "$output_file"

    grep -Fq '"available":true' "$output_file" \
      || fail "expected successful database diagnostics snapshot"
    grep -Fq 'exec -i portico-open-webui python -' "$docker_args" \
      || fail "snapshot must execute the DB-independent endpoint client inside Open WebUI"
    ! grep -Eiq '(bearer|secret|authorization)' "$docker_args" \
      || fail "collector must never pass the bridge secret in docker argv"

    cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
exit 1
SH
    chmod +x "$fake_bin/docker"
    collect_database_diagnostics_snapshot "portico-open-webui" "$output_file"
    grep -Fq '"reason":"container_exec_failed"' "$output_file" \
      || fail "container exec failure should produce a graceful diagnostics marker"
  )
}

test_database_snapshot_client_refuses_proxies_and_redirects() {
  python3 - "$DEBUG_SCRIPT" <<'PY'
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


debug_script = sys.argv[1]
secret = "fixture-bridge-secret"


class QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


class OriginHandler(QuietHandler):
    hits = []
    redirect_url = None

    def do_GET(self):
        type(self).hits.append(self.headers.get("Authorization"))
        if type(self).redirect_url:
            self.send_response(302)
            self.send_header("Location", type(self).redirect_url)
            self.end_headers()
            return
        payload = json.dumps({"schemaVersion": 1, "activeTransactions": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ProxyHandler(QuietHandler):
    hits = []

    def do_GET(self):
        type(self).hits.append(self.headers.get("Authorization"))
        self.send_response(502)
        self.end_headers()


class RedirectTargetHandler(QuietHandler):
    hits = []

    def do_GET(self):
        type(self).hits.append(self.headers.get("Authorization"))
        self.send_response(200)
        self.end_headers()


def start_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


origin = start_server(OriginHandler)
proxy = start_server(ProxyHandler)
redirect_target = start_server(RedirectTargetHandler)
try:
    OriginHandler.redirect_url = (
        f"http://127.0.0.1:{redirect_target.server_port}/should-not-be-requested"
    )
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = pathlib.Path(temp_dir)
        fake_bin = temp_path / "bin"
        fake_bin.mkdir()
        docker = fake_bin / "docker"
        docker.write_text("#!/usr/bin/env bash\nexec python3 -\n", encoding="utf-8")
        docker.chmod(0o755)

        output = temp_path / "snapshot.json"
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                "OWUI_AUTH_BRIDGE_SECRET": secret,
                "OWUI_AUTH_BRIDGE_SECRET_FILE": "",
                "PORT": str(origin.server_port),
                "HTTP_PROXY": f"http://127.0.0.1:{proxy.server_port}",
                "http_proxy": f"http://127.0.0.1:{proxy.server_port}",
                "NO_PROXY": "",
                "no_proxy": "",
            }
        )
        command = (
            'source "$1"; '
            'collect_database_diagnostics_snapshot "portico-open-webui" "$2"'
        )

        OriginHandler.redirect_url = None
        subprocess.run(
            ["bash", "-c", command, "bash", debug_script, str(output)],
            check=True,
            env=env,
        )
        result = json.loads(output.read_text(encoding="utf-8"))
        assert result["available"] is True, result
        assert OriginHandler.hits == [f"Bearer {secret}"], OriginHandler.hits
        assert ProxyHandler.hits == [], ProxyHandler.hits

        OriginHandler.hits.clear()
        OriginHandler.redirect_url = (
            f"http://127.0.0.1:{redirect_target.server_port}/should-not-be-requested"
        )
        subprocess.run(
            ["bash", "-c", command, "bash", debug_script, str(output)],
            check=True,
            env=env,
        )
        result = json.loads(output.read_text(encoding="utf-8"))
        assert result["available"] is False, result
        assert result["reason"] == "endpoint_http_error", result
        assert result["httpStatus"] == 302, result
        assert RedirectTargetHandler.hits == [], RedirectTargetHandler.hits
        assert ProxyHandler.hits == [], ProxyHandler.hits
        assert secret not in output.read_text(encoding="utf-8")
finally:
    for server in (origin, proxy, redirect_target):
        server.shutdown()
        server.server_close()
PY
}

test_sensitive_log_statements_are_absent() {
  ! grep -Fq 'log.debug(f"{response=}")' "$MIDDLEWARE_FILE" \
    || fail "middleware.py still logs raw tool-calling responses"
  ! grep -Fq 'log.debug(f"{content=}")' "$MIDDLEWARE_FILE" \
    || fail "middleware.py still logs raw tool-calling content"
  ! grep -Fq 'log.debug(f"{tool_call=}")' "$MIDDLEWARE_FILE" \
    || fail "middleware.py still logs raw tool_call payloads"
  ! grep -Fq 'content_preview=' "$MIDDLEWARE_FILE" \
    || fail "middleware.py still logs content previews"
  ! grep -Fq 'Content preview:' "$MIDDLEWARE_FILE" \
    || fail "middleware.py still logs content preview lines"
  ! grep -Fq 'log.debug(f"form_data: {form_data}")' "$MIDDLEWARE_FILE" \
    || fail "middleware.py still logs raw form_data"
  ! grep -Fq 'preview=' "$OPENAI_FILE" \
    || fail "openai.py still logs system prompt previews"
  ! grep -Fq 'Message preview:' "$SKILL_MANAGER_FILE" \
    || fail "skill_manager.py still logs user message previews"
  ! grep -Fq 'Received form_data:' "$CHATS_FILE" \
    || fail "chats.py still logs raw capabilities payloads"
  ! grep -Fq 'Raw Redis values:' "$CHATS_FILE" \
    || fail "chats.py still logs raw Redis capability values"
  ! grep -Fq 'Full response:' "$CHATS_FILE" \
    || fail "chats.py still logs full capabilities responses"
  ! grep -Fq 'with event: {event_data}' "$CHATS_FILE" \
    || fail "chats.py still logs emitted event payloads"
  ! grep -Fq 'log.debug(f"generate_chat_completion: {form_data}")' "$CHAT_UTILS_FILE" \
    || fail "utils/chat.py still logs raw chat completion form_data"
}

test_archive_recent_app_support_logs_includes_expected_prefixes() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir app_logs_dir debug_dir
    tmp_dir="$(mktemp -d)"
    app_logs_dir="$tmp_dir/app-logs"
    debug_dir="$tmp_dir/debug"
    mkdir -p "$app_logs_dir" "$debug_dir"

    printf 'app\n' > "$app_logs_dir/app-2026-04-01.log"
    printf 'error\n' > "$app_logs_dir/error-2026-04-01.log"
    printf 'console\n' > "$app_logs_dir/console-2026-04-01.log"
    cat > "$app_logs_dir/health-sync-2026-04-01.log" <<'LOG'
2026-04-01T10:00:00Z | full | health_sync_runner_start | run=run-1 | reason=test | timeout_ms=180000 | mode=full reason=test
2026-04-01T10:00:01Z | full | model_sync_marker_decision | run=run-1 | reason=test | timeout_ms=180000 | marker_matches=true
2026-04-01T10:00:02Z | full | owui_model_inventory_loaded | run=run-1 | reason=test | timeout_ms=180000 | picker=0
2026-04-01T10:00:03Z | full | model_sync_marker_invalidated | run=run-1 | reason=test | timeout_ms=180000 | reason=empty_picker_inventory
2026-04-01T10:00:04Z | full | health_sync_runner_timeout | run=run-1 | reason=test | timeout_ms=180000 | elapsed_ms=180000
2026-04-01T10:00:05Z | full | health_sync_runner_queued_retry | run=run-1 | reason=test | timeout_ms=180000 | next_mode=light
LOG
    printf '{"stale":"old-format"}\n' > "$app_logs_dir/health-sync-2026-04-01.jsonl"
    printf 'init\n' > "$app_logs_dir/init-2026-04-01.log"
    printf 'install\n' > "$app_logs_dir/install-2026-04-01.log"
    printf 'oauth\n' > "$app_logs_dir/oauth-2026-04-01.log"
    printf 'prereq\n' > "$app_logs_dir/prereq-2026-04-01.log"
    printf 'update\n' > "$app_logs_dir/update-2026-04-01.log"
    printf 'update-prep\n' > "$app_logs_dir/update-prep-2026-04-01.log"
    printf 'update-app-install\n' > "$app_logs_dir/update-app-install-2026-04-01.log"
    printf 'single-server diag\n' > "$app_logs_dir/single-server-google_workspace-20260401T100000Z.log"
    printf 'ignore\n' > "$app_logs_dir/debug-info-2026-04-01.log"
    printf 'ignore-zip\n' > "$app_logs_dir/debug_logs_123.zip"

    archive_recent_app_support_logs "$app_logs_dir" "$debug_dir"
    generate_health_sync_summary "$debug_dir"

    local expected
    for expected in \
      app-2026-04-01.log \
      error-2026-04-01.log \
      console-2026-04-01.log \
      health-sync-2026-04-01.log \
      init-2026-04-01.log \
      install-2026-04-01.log \
      oauth-2026-04-01.log \
      prereq-2026-04-01.log \
      update-2026-04-01.log \
      update-prep-2026-04-01.log \
      update-app-install-2026-04-01.log \
      single-server-google_workspace-20260401T100000Z.log; do
      [ -f "$debug_dir/all-app-logs/$expected" ] \
        || fail "expected $expected to be archived into all-app-logs"
    done

    [ -f "$debug_dir/portico-app.log" ] \
      || fail "expected latest app log to be copied to top level"
    [ -f "$debug_dir/portico-error.log" ] \
      || fail "expected latest error log to be copied to top level"
    [ -f "$debug_dir/initialization.log" ] \
      || fail "expected latest init log to be copied to initialization.log"
    [ -f "$debug_dir/update-latest.log" ] \
      || fail "expected latest update-family log to be copied to update-latest.log"
    [ ! -e "$debug_dir/all-app-logs/debug-info-2026-04-01.log" ] \
      || fail "debug-info logs should not be rebundled"
    [ ! -e "$debug_dir/all-app-logs/health-sync-2026-04-01.jsonl" ] \
      || fail "health-sync jsonl logs should not be archived"
    [ -f "$debug_dir/health-sync-summary.txt" ] \
      || fail "expected health-sync-summary.txt to be generated"
    grep -Fq 'latest_log: health-sync-2026-04-01.log' "$debug_dir/health-sync-summary.txt" \
      || fail "expected health sync summary to use text log"
    grep -Fq 'latest_run_id: run-1' "$debug_dir/health-sync-summary.txt" \
      || fail "expected health sync summary to include latest run id"
    grep -Fq 'last_model_inventory:' "$debug_dir/health-sync-summary.txt" \
      || fail "expected health sync summary to include model inventory section"
    grep -Fq 'health_sync_runner_timeout' "$debug_dir/health-sync-summary.txt" \
      || fail "expected health sync summary to include runner timeout"
  )
}

test_proxy_diagnostics_flag_missing_internal_no_proxy_entries() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir diagnostic_file project_root
    tmp_dir="$(mktemp -d)"
    diagnostic_file="$tmp_dir/proxy-diagnostics.txt"
    project_root="$tmp_dir/project"
    mkdir -p "$project_root/mcpo-configs-generated"
    PROJECT_ROOT="$project_root"
    cat > "$project_root/mcpo-configs-generated/server-routing.json" <<'JSON'
{
  "agent-vm": {
    "compose_service": "mcpo-group-core",
    "container_name": "mcpo-group-core",
    "network_host": "mcpo-group-core"
  },
  "google_workspace": {
    "compose_service": "mcpo-google_workspace",
    "container_name": "mcpo-google_workspace",
    "network_host": "mcpo-google-workspace"
  }
}
JSON

    write_proxy_diagnostic_for_container_env \
      "portico-open-webui" \
      $'HTTP_PROXY=http://proxyproxy.orb.internal:8305\nNO_PROXY=localhost,127.0.0.1' \
      "$diagnostic_file"

    grep -Fq 'container: portico-open-webui' "$diagnostic_file" \
      || fail "expected proxy diagnostics to include container name"
    grep -Fq 'status: missing_internal_no_proxy' "$diagnostic_file" \
      || fail "expected missing internal NO_PROXY status"
    grep -Fq 'llm-gateway' "$diagnostic_file" \
      || fail "expected llm-gateway to be flagged as missing from NO_PROXY"
    grep -Fq 'open-webui' "$diagnostic_file" \
      || fail "expected open-webui to be flagged as missing from NO_PROXY"
    grep -Fq 'mcpo-group-core' "$diagnostic_file" \
      || fail "expected generated core group hostname to be flagged as missing from NO_PROXY"
    grep -Fq 'mcpo-google_workspace' "$diagnostic_file" \
      || fail "expected generated container hostname to be flagged as missing from NO_PROXY"
    grep -Fq 'mcpo-google-workspace' "$diagnostic_file" \
      || fail "expected generated network alias to be flagged as missing from NO_PROXY"

    : > "$diagnostic_file"
    write_proxy_diagnostic_for_container_env \
      "portico-open-webui" \
      $'HTTP_PROXY=http://proxyproxy.orb.internal:8305\nNO_PROXY=localhost,127.0.0.1,::1,open-webui,portico-open-webui,llm-gateway,mcpo,mcpo-core,redis,portico-redis,mongodb,portico-mongodb,chat-state-api,open-webui-health-check,host.docker.internal,mcpo-group-core,mcpo-google_workspace,mcpo-google-workspace' \
      "$diagnostic_file"

    grep -Fq 'status: ok' "$diagnostic_file" \
      || fail "expected complete internal NO_PROXY policy to pass diagnostics"
  )
}

test_redact_file_removes_chat_payload_previews() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir logfile
    tmp_dir="$(mktemp -d)"
    logfile="$tmp_dir/sensitive.log"

    cat > "$logfile" <<'EOF'
[DEBUGGING_TOOLS]    Message 0: role=user, has_contentBlocks=False, content=What scheduled tasks do I have tomorrow?...
[DEBUGGING_TOOLS]      Content preview: Bob has a 1:1 at 3pm
[SYSTEM-PROMPT-DEBUG]   System msg 0: len=128, has_portico_context=True, preview=# Portico instructions
[FOLLOW-UP] Message 4: role=user, content_preview=Use the Google Calendar tool with email=bob@example.com
[Skills]    Message: Short private message
[Skills]    Message preview: Search Slack for recent conversations in #ejs-dev and summarize the main themes.
[TOOL-CALL-DELTA] model=Claude Opus 4.6 count=1 tool_calls=[{'index': 0, 'id': None, 'name': None, 'args_len': 12, 'args_preview': 'santiago@ind'}]
Original messages: [{"role":"user","content":"private prompt"}]
Transformed messages: [{"role":"user","content":"private prompt"}]
Parsed line data: {"delta":{"text":"private response fragment"}}
[ChatCapabilities] Received form_data: tools=[{"server_id":"google_workspace"}], skills=[{"name":"meeting-scheduler"}]
generate_chat_completion: {"messages":[{"role":"user","content":"private prompt"}]}
form_data: {"messages":[{"role":"user","content":"private prompt"}]}
response='{"tool_calls":[{"name":"google_workspace_list_events","arguments":{"email":"bob@example.com"}}]}'
content='{"email":"bob@example.com"}'
tool_call={'name': 'google_workspace_list_events', 'parameters': {'email': 'bob@example.com'}}
EOF

    redact_file "$logfile"

    ! grep -Fq 'What scheduled tasks do I have tomorrow?' "$logfile" \
      || fail "chat content should be removed from debug bundle logs"
    ! grep -Fq 'Bob has a 1:1 at 3pm' "$logfile" \
      || fail "content preview should be removed from debug bundle logs"
    ! grep -Fq '# Portico instructions' "$logfile" \
      || fail "system prompt previews should be removed from debug bundle logs"
    ! grep -Fq 'Short private message' "$logfile" \
      || fail "skill manager message lines should be removed from debug bundle logs"
    ! grep -Fq 'Search Slack for recent conversations' "$logfile" \
      || fail "skill manager message previews should be removed from debug bundle logs"
    ! grep -Fq 'bob@example.com' "$logfile" \
      || fail "tool arguments should be removed from debug bundle logs"
    ! grep -Fq 'private response fragment' "$logfile" \
      || fail "parsed streaming payload content should be removed from debug bundle logs"
    grep -Fq '<REDACTED_CHAT_CONTENT>' "$logfile" \
      || fail "expected chat content placeholder after redaction"
    grep -Fq '<REDACTED_SYSTEM_PROMPT>' "$logfile" \
      || fail "expected system prompt placeholder after redaction"
    grep -Fq '<REDACTED_CAPABILITIES_PAYLOAD>' "$logfile" \
      || fail "expected capabilities placeholder after redaction"
    grep -Fq '<REDACTED_REQUEST_PAYLOAD>' "$logfile" \
      || fail "expected request payload placeholder after redaction"
    grep -Fq '<REDACTED_RESPONSE_PAYLOAD>' "$logfile" \
      || fail "expected response payload placeholder after redaction"
    grep -Fq '<REDACTED_TOOL_CALL>' "$logfile" \
      || fail "expected tool call placeholder after redaction"
  )
}

test_redact_file_preserves_toggle_json() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir toggles snapshot
    tmp_dir="$(mktemp -d)"
    toggles="$tmp_dir/mcp_toggles.json"
    snapshot="$tmp_dir/mcp_toggles_snapshot.json"
    printf '{"chrome-devtools":true,"slack":false}\n' > "$toggles"
    printf '{"schemaVersion":1,"revision":"sha256:test","toggles":{"chrome-devtools":true,"slack":false}}\n' > "$snapshot"

    redact_file "$toggles"
    redact_file "$snapshot"

    [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] \
      || fail "node is required to validate debug toggle JSON"
    "$NODE_BIN" -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (value["chrome-devtools"] !== true || value.slack !== false) process.exit(1)' "$toggles" \
      || fail "redaction should preserve valid boolean mcp_toggles.json"
    "$NODE_BIN" -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (value.toggles["chrome-devtools"] !== true || value.toggles.slack !== false) process.exit(1)' "$snapshot" \
      || fail "redaction should preserve valid boolean mcp_toggles_snapshot.json"
  )
}

test_env_redaction_preserves_structured_json_primitives() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir diagnostic
    tmp_dir="$(mktemp -d)"
    diagnostic="$tmp_dir/database-diagnostics.json"
    trap 'if [ -n "${REDACTION_SED_FILE:-}" ]; then rm -f "$REDACTION_SED_FILE"; fi; rm -rf "$tmp_dir"' EXIT

    cat > "$tmp_dir/.env" <<'EOF'
FEATURE_ENABLED=true
FEATURE_DISABLED=false
OPTIONAL_VALUE=null
REASONING_BUDGET=2048
FIXTURE_API_TOKEN=fixture-private-token-987
EOF
    printf '%s\n' '{"available":true,"installed":false,"optional":null,"limit":2048,"context":"fixture-private-token-987","env":["ENABLE_PASSWORD_AUTH=true","FIXTURE_API_TOKEN=fixture-private-token-987"]}' > "$diagnostic"

    cd "$tmp_dir"
    build_redaction_sed_file
    redact_file "$diagnostic"

    python3 - "$diagnostic" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert value["available"] is True
assert value["installed"] is False
assert value["optional"] is None
assert value["limit"] == 2048
assert value["context"] == "<REDACTED>"
assert value["env"] == [
    "ENABLE_PASSWORD_AUTH=<REDACTED>",
    "FIXTURE_API_TOKEN=<REDACTED>",
]
PY
    ! grep -Fq 'fixture-private-token-987' "$diagnostic" \
      || fail "env secret must not remain in structured debug output"
  )
}

test_debug_bundle_captures_runtime_and_stale_guided_setup_build_info() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir debug_dir stale_build_info
    tmp_dir="$(mktemp -d)"
    debug_dir="$tmp_dir/debug"
    stale_build_info="$tmp_dir/guided-setup/dist/mac-arm64/Portico.app/Contents/Resources/build-info.json"
    mkdir -p "$debug_dir" "$(dirname "$stale_build_info")" "$tmp_dir/electron-app"

    printf 'process.resourcesPath: /Applications/Portico.app/Contents/Resources\n' > "$tmp_dir/runtime_diagnostics_temp.txt"
    printf '{"buildNumber":"dev-build","fullSha":"abcdef"}\n' > "$tmp_dir/electron-app/build-info.json"
    printf '{"buildNumber":"11042025-224ca842"}\n' > "$stale_build_info"

    cd "$tmp_dir"
    git init -q
    git config user.email "debug-test@example.invalid"
    git config user.name "Debug Test"
    git add .
    git commit -qm "initial debug fixture"
    PROJECT_ROOT="$tmp_dir"
    capture_runtime_launch_diagnostics "$debug_dir"
    capture_runtime_fingerprint "$debug_dir"

    [ -f "$debug_dir/runtime_diagnostics.txt" ] \
      || fail "expected runtime diagnostics to be captured"
    grep -Fq 'process.resourcesPath' "$debug_dir/runtime_diagnostics.txt" \
      || fail "expected runtime diagnostics to include resourcesPath"
    [ -f "$debug_dir/stale-guided-setup-app-build-info.txt" ] \
      || fail "expected stale guided-setup build metadata to be captured"
    grep -Fq '11042025-224ca842' "$debug_dir/stale-guided-setup-app-build-info.txt" \
      || fail "expected stale guided-setup build number to be captured"
    [ -f "$debug_dir/runtime-fingerprint.txt" ] \
      || fail "expected runtime fingerprint to be captured"
    grep -Fq 'current_branch:' "$debug_dir/runtime-fingerprint.txt" \
      || fail "expected runtime fingerprint to include branch"
    grep -Fq 'head_sha:' "$debug_dir/runtime-fingerprint.txt" \
      || fail "expected runtime fingerprint to include HEAD"
    grep -Fq 'build_info_path:' "$debug_dir/runtime-fingerprint.txt" \
      || fail "expected runtime fingerprint to include build-info path"
    grep -Fq 'process.resourcesPath' "$debug_dir/runtime-fingerprint.txt" \
      || fail "expected runtime fingerprint to include runtime diagnostics"
  )
}

test_debug_container_inventory_includes_openwebui_aliases() {
  grep -Fq '"portico-open-webui" "open-webui"' "$DEBUG_SCRIPT" \
    || fail "debug collector should target both Open WebUI container aliases"
}

test_compose_cli_diagnostics_capture_split_frontends_and_sanitized_paths() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir fake_bin debug_dir
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    debug_dir="$tmp_dir/debug"
    mkdir -p "$fake_bin" "$debug_dir" "$tmp_dir/home/custom-docker"

    cat > "$fake_bin/docker-real" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  echo "docker: unknown command: docker compose" >&2
  exit 1
fi
if [[ "${1:-}" == "info" && "${2:-}" == "--format" ]]; then
  echo '[{"Name":"buildx","Path":"/tmp/docker-buildx"}]'
  exit 0
fi
echo "Docker version 28.0.0"
EOF
    chmod +x "$fake_bin/docker-real"
    ln -s "$fake_bin/docker-real" "$fake_bin/docker"

    cat > "$fake_bin/docker-compose" <<'EOF'
#!/usr/bin/env bash
echo "Docker Compose version v5.1.2"
EOF
    chmod +x "$fake_bin/docker-compose"

    cat > "$fake_bin/orbctl" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  version) echo "OrbStack 2.2.1" ;;
  status) echo "Running" ;;
esac
EOF
    chmod +x "$fake_bin/orbctl"

    PATH="$fake_bin:$PATH"
    HOME="$tmp_dir/home"
    DOCKER_CONFIG="$HOME/custom-docker"
    export PATH HOME DOCKER_CONFIG

    capture_compose_cli_diagnostics "$debug_dir"

    local diagnostics="$debug_dir/compose-cli-diagnostics.txt"
    grep -Fq 'HOME=<HOME>' "$diagnostics" \
      || fail "expected HOME to be sanitized"
    grep -Fq 'DOCKER_CONFIG=~/custom-docker' "$diagnostics" \
      || fail "expected DOCKER_CONFIG home prefix to be sanitized"
    ! grep -Fq "$HOME/custom-docker" "$diagnostics" \
      || fail "raw HOME path must not remain in compose diagnostics"
    grep -Fq 'symlink_target=' "$diagnostics" \
      || fail "expected Docker symlink target diagnostics"
    grep -Fq 'mtime_epoch=' "$diagnostics" \
      || fail "expected command timestamp diagnostics"
    grep -Fq 'docker: unknown command: docker compose' "$diagnostics" \
      || fail "expected Docker plugin probe output"
    grep -Fq 'Docker Compose version v5.1.2' "$diagnostics" \
      || fail "expected standalone Compose probe output"
    grep -Fq 'standalone-v2' "$diagnostics" \
      || fail "expected standalone frontend selection"
    grep -Fq '"Name":"buildx"' "$diagnostics" \
      || fail "expected Docker client plugin inventory"
    grep -Fq 'OrbStack 2.2.1' "$diagnostics" \
      || fail "expected OrbStack version"
    grep -Fq 'Running' "$diagnostics" \
      || fail "expected OrbStack status"
  )
}

test_debug_collection_uses_extended_update_incident_limits() {
  (
    unset DEBUG_DOCKER_LOG_SINCE DEBUG_LOG_MAX_AGE_HOURS DEBUG_LOG_MAX_BYTES
    source "$DEBUG_SCRIPT"

    [ "$DEBUG_DOCKER_LOG_SINCE" = "72h" ] \
      || fail "expected Docker log collection to default to 72h"
    [ "$DEBUG_LOG_MAX_AGE_HOURS" = "168" ] \
      || fail "expected application log collection to default to 168h"
    [ "$DEBUG_LOG_MAX_BYTES" = "104857600" ] \
      || fail "expected individual debug logs to default to a 100MB cap"
  )
}

test_trim_large_log_file_preserves_head_and_tail() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir logfile contents size_bytes
    tmp_dir="$(mktemp -d)"
    logfile="$tmp_dir/large.log"
    printf 'ABCDEFGHIJKLMNOPQRST' > "$logfile"
    DEBUG_LOG_MAX_BYTES=10

    trim_large_log_file "$logfile"

    contents="$(cat "$logfile")"
    size_bytes="$(wc -c < "$logfile" | tr -d '[:space:]')"
    [ "$contents" = "ABCDEPQRST" ] \
      || fail "head+tail trimming should retain the oldest and newest bytes, saw: $contents"
    [ "$size_bytes" = "10" ] \
      || fail "head+tail trimming should enforce the configured byte cap"
  )
}

test_collect_update_pipeline_state_captures_forensics() {
  (
    source "$DEBUG_SCRIPT"

    local tmp_dir managed_dir debug_dir tmp_root fake_bin output_file inode_one inode_two
    tmp_dir="$(mktemp -d)"
    managed_dir="$tmp_dir/managed"
    debug_dir="$tmp_dir/debug"
    tmp_root="$tmp_dir/tmp"
    fake_bin="$tmp_dir/bin"
    mkdir -p \
      "$managed_dir/backup/db-snapshots" \
      "$managed_dir/health-status" \
      "$managed_dir/open-webui-data" \
      "$tmp_root/managed-runtime-reconcile.old" \
      "$tmp_root/managed-runtime-reconcile.recent" \
      "$fake_bin" \
      "$debug_dir"

    printf 'archive bytes\n' > "$managed_dir/backup/portico_full_backup_1.zip"
    ln "$managed_dir/backup/portico_full_backup_1.zip" \
      "$managed_dir/backup/portico_full_backup_2.zip"
    printf 'snapshot\n' > "$managed_dir/backup/db-snapshots/webui.db.1"
    printf '{"sizeBytes":4096,"buildNumber":"test-build"}\n' \
      > "$managed_dir/health-status/owui-db-sentinel.json"
    printf '{"detected":true,"reason":"fixture"}\n' \
      > "$managed_dir/health-status/db_corruption_state.json"
    printf 'chat-db\n' > "$managed_dir/open-webui-data/webui.db"
    printf 'stranded bytes\n' > "$tmp_root/managed-runtime-reconcile.old/file.bin"
    touch -t 202001010000 "$tmp_root/managed-runtime-reconcile.old"

    cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "ps" ] && [ "${2:-}" = "-a" ]; then
  echo "CONTAINER ID   NAMES"
  echo "fixture-id    portico-open-webui"
  exit 0
fi
exit 1
SH
    chmod +x "$fake_bin/docker"

    PROJECT_ROOT="$managed_dir"
    TMPDIR="$tmp_root"
    PATH="$fake_bin:$PATH"
    export PROJECT_ROOT TMPDIR PATH
    collect_update_pipeline_state "$debug_dir"

    output_file="$debug_dir/update-pipeline-state.txt"
    [ -s "$output_file" ] || fail "expected update pipeline forensic state output"
    grep -Fq '=== Managed backup inode inventory ===' "$output_file" \
      || fail "expected managed backup inode inventory"
    grep -Fq 'portico_full_backup_1.zip' "$output_file" \
      || fail "expected first hardlinked backup in inode inventory"
    grep -Fq 'portico_full_backup_2.zip' "$output_file" \
      || fail "expected second hardlinked backup in inode inventory"
    inode_one="$(awk '/portico_full_backup_1[.]zip$/ { print $1; exit }' "$output_file")"
    inode_two="$(awk '/portico_full_backup_2[.]zip$/ { print $1; exit }' "$output_file")"
    [ -n "$inode_one" ] && [ "$inode_one" = "$inode_two" ] \
      || fail "expected inode inventory to expose hardlinked backup identity"
    grep -Fq '=== Filesystem capacity ===' "$output_file" \
      || fail "expected managed and TMPDIR filesystem capacity"
    grep -Fq '=== Directory usage (KiB) ===' "$output_file" \
      || fail "expected managed and TMPDIR directory usage"
    grep -Fq 'managed-runtime-reconcile.old' "$output_file" \
      || fail "expected reconcile strand inventory"
    grep -Eq '^age_hours: [1-9][0-9]*$' "$output_file" \
      || fail "expected reconcile strand ages"
    grep -Fq '"buildNumber":"test-build"' "$output_file" \
      || fail "expected Open WebUI database sentinel state"
    grep -Fq '"reason":"fixture"' "$output_file" \
      || fail "expected Open WebUI corruption state"
    grep -Fq 'size_bytes: 8' "$output_file" \
      || fail "expected webui.db byte size"
    grep -Eq '^mtime_epoch: [0-9]+$' "$output_file" \
      || fail "expected webui.db mtime"
    grep -Fq 'fixture-id    portico-open-webui' "$output_file" \
      || fail "expected docker ps -a inventory"
  )
}

test_docker_info_capture_scopes_image_inventory_to_app_images() {
  grep -Fq '=== Portico Images ===' "$DEBUG_SCRIPT" \
    || fail "debug.sh docker-info capture is missing the app image inventory section"
  grep -Fq 'docker images --filter "reference=harbor.example.invalid/portico/*"' "$DEBUG_SCRIPT" \
    || fail "debug.sh must capture the Harbor app image inventory"
  grep -Fq 'docker images --filter "reference=agent-vm"' "$DEBUG_SCRIPT" \
    || fail "debug.sh must capture the legacy agent-vm image inventory"
  ! grep -Eq '^[[:space:]]*docker images[[:space:]]*$' "$DEBUG_SCRIPT" \
    || fail "debug.sh must never capture the full unfiltered docker images table"
}

test_live_sampler_has_bounded_cleanup_and_private_lsof_fields() {
  grep -Fq "trap 'exit 130' INT TERM HUP" "$DEBUG_SCRIPT" \
    || fail "live sampler must exit through cleanup on interruption"
  grep -Fq 'trap cleanup_database_live_samples EXIT' "$DEBUG_SCRIPT" \
    || fail "live sampler must register temporary-file and child cleanup"
  grep -Fq 'lsof -Fpcftn --' "$DEBUG_SCRIPT" \
    || fail "database lsof must use field output that omits host usernames"
  ! grep -Eq '^[[:space:]]*lsof --' "$DEBUG_SCRIPT" \
    || fail "database diagnostics must not capture lsof's USER column"
}

# --- PORTICO-373: collection against an unresponsive container engine -------------
# A container engine (OrbStack) can accept connections and never answer them.
# Every Docker call in debug.sh used to be gated only on the docker BINARY
# existing, so a wedged engine blocked the collector on its first engine call and
# produced no bundle at all - exactly when a bundle was most needed. The caller
# now probes the engine and passes the verdict in through DEBUG_SKIP_DOCKER and
# DEBUG_DOCKER_PREFLIGHT_STATUS.
#
# These cases run debug.sh end to end in a throwaway fixture whose docker,
# docker-compose and orbctl shims record every invocation and then behave like the
# selected engine, so the suite can prove what the collector did and did not call.

build_collector_fixture() {
  # $1 = fixture directory (created here), $2 = engine mode: wedged | responsive
  local fixture="$1"
  local engine_mode="$2"

  mkdir -p \
    "$fixture/bin" \
    "$fixture/project/mcpo-configs-generated" \
    "$fixture/project/electron-app" \
    "$fixture/applogs" \
    "$fixture/out" \
    "$fixture/home"

  printf '%s\n' "$engine_mode" > "$fixture/engine-mode"
  : > "$fixture/calls.txt"

  printf 'FIXTURE_API_KEY=portico373-fixture-secret-value\nFIXTURE_PLAIN=plain-fixture-value\n' \
    > "$fixture/project/.env"
  printf '{"fixture":"mcp-config"}\n' > "$fixture/project/mcp_config.json"
  printf '{"fixture":"server-routing"}\n' \
    > "$fixture/project/mcpo-configs-generated/server-routing.json"
  printf '{"buildNumber":"portico373-fixture-build"}\n' \
    > "$fixture/project/electron-app/build-info.json"
  printf 'portico373-fixture-app-log-marker\n' > "$fixture/applogs/app-fixture.log"

  # One shim behind the docker, docker-compose and orbctl names: it records the
  # invocation, then behaves like the engine the fixture selected. In wedged mode
  # it accepts the call and never answers, so any container-engine command the
  # collector makes shows up both as a recorded call and as a blown deadline
  # instead of as a silently degraded bundle.
  cat > "$fixture/bin/engine-shim" <<'SH'
#!/usr/bin/env bash
invoked="$(basename "$0")"
printf '%s %s\n' "$invoked" "$*" >> "$portico373_FIXTURE/calls.txt"

if [ "$(cat "$portico373_FIXTURE/engine-mode" 2>/dev/null)" = "responsive" ]; then
  case "$invoked ${1:-}" in
    "docker compose"|"docker-compose version") echo "Docker Compose version v2.30.0" ;;
    "docker version") printf 'Client: fixture\nServer: fixture\n' ;;
    *" ps") echo "CONTAINER ID   NAMES" ;;
    *" network") echo "NETWORK ID   NAME" ;;
    *" images") echo "REPOSITORY   TAG" ;;
    *" info") echo "[]" ;;
    *" inspect") echo "{}" ;;
    *" logs") echo "fixture container log line" ;;
    *) echo "fixture $invoked ${1:-}" ;;
  esac
  exit 0
fi

waited=0
while [ ! -f "$portico373_FIXTURE/release" ] && [ "$waited" -lt 300 ]; do
  sleep 0.2
  waited=$((waited + 1))
done
echo "$invoked: engine accepted the connection and never answered" >&2
exit 1
SH
  chmod +x "$fixture/bin/engine-shim"
  ln -s engine-shim "$fixture/bin/docker"
  ln -s engine-shim "$fixture/bin/docker-compose"
  ln -s engine-shim "$fixture/bin/orbctl"

  # debug.sh reveals the finished zip in Finder; keep that off the test host.
  cat > "$fixture/bin/open" <<'SH'
#!/usr/bin/env bash
printf 'open %s\n' "$*" >> "$portico373_FIXTURE/calls.txt"
exit 0
SH

  chmod +x "$fixture/bin/open"
}

run_debug_collector_in_fixture() {
  # $1 = fixture, $2 = DEBUG_SKIP_DOCKER, $3 = DEBUG_DOCKER_PREFLIGHT_STATUS,
  # $4 = wall-clock deadline in seconds. Returns the collector's exit status, or
  # 124 when the deadline expired.
  local fixture="$1"
  local skip_docker="$2"
  local preflight_status="$3"
  local deadline_seconds="${4:-45}"
  local runner_pid waited limit collector_status

  rm -f "$fixture/release" "$fixture/collector-status"
  : > "$fixture/calls.txt"

  (
    env \
      PATH="$fixture/bin:$PATH" \
      HOME="$fixture/home" \
      portico373_FIXTURE="$fixture" \
      DEBUG_SKIP_DOCKER="$skip_docker" \
      DEBUG_DOCKER_PREFLIGHT_STATUS="$preflight_status" \
      PROJECT_ROOT_OVERRIDE="$fixture/project" \
      DEBUG_APP_LOGS_DIR="$fixture/applogs" \
      DEBUG_OUTPUT_ROOT_OVERRIDE="$fixture/out" \
      bash "$DEBUG_SCRIPT" > "$fixture/collector.log" 2>&1
    printf '%s\n' "$?" > "$fixture/collector-status"
  ) &
  runner_pid=$!

  waited=0
  limit=$((deadline_seconds * 10))
  while [ "$waited" -lt "$limit" ]; do
    kill -0 "$runner_pid" 2>/dev/null || break
    sleep 0.1
    waited=$((waited + 1))
  done

  if kill -0 "$runner_pid" 2>/dev/null; then
    # Release the wedged shims first so nothing is left blocked behind us.
    : > "$fixture/release"
    kill -9 "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
    return 124
  fi

  wait "$runner_pid" 2>/dev/null || true
  collector_status="$(cat "$fixture/collector-status" 2>/dev/null || true)"
  [ -n "$collector_status" ] || collector_status=1
  return "$collector_status"
}

recorded_container_engine_calls() {
  grep -E '^(docker|docker-compose|orbctl)( |$)' "$1/calls.txt" 2>/dev/null || true
}

extract_collected_debug_bundle() {
  # Echoes the extracted bundle directory, or nothing when no bundle was written.
  local fixture="$1"
  local zip_path="" candidate

  for candidate in "$fixture"/out/debug_logs_*.zip; do
    if [ -f "$candidate" ]; then
      zip_path="$candidate"
      break
    fi
  done
  [ -n "$zip_path" ] || return 1

  rm -rf "$fixture/extracted"
  mkdir -p "$fixture/extracted"
  unzip -o -q "$zip_path" -d "$fixture/extracted" >/dev/null 2>&1 || return 1

  for candidate in "$fixture/extracted"/debug_logs_*; do
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

test_wedged_engine_collection_never_calls_the_container_engine() {
  (
    local fixture bundle_dir collector_rc engine_calls
    fixture="$(mktemp -d)"
    build_collector_fixture "$fixture" wedged

    collector_rc=0
    run_debug_collector_in_fixture "$fixture" 1 probe-timeout 45 || collector_rc=$?
    [ "$collector_rc" -ne 124 ] || fail "collection blocked on the wedged engine instead of skipping it: $(recorded_container_engine_calls "$fixture")"
    [ "$collector_rc" -eq 0 ] || fail "collection against a wedged engine exited $collector_rc; log: $fixture/collector.log"

    engine_calls="$(recorded_container_engine_calls "$fixture")"
    [ -z "$engine_calls" ] \
      || fail "collector called the wedged container engine: $engine_calls"

    bundle_dir="$(extract_collected_debug_bundle "$fixture" || true)"
    [ -n "$bundle_dir" ] && [ -d "$bundle_dir" ] \
      || fail "a wedged engine must still produce a debug bundle"
    [ -s "$bundle_dir/summary.txt" ] || fail "expected a summary in the degraded bundle"
    grep -Fq 'Debug log collection complete!' "$fixture/collector.log" \
      || fail "collector did not report completion against a wedged engine"

    # The zero-call assertion above is only meaningful if the collector really
    # resolved the recording shim as its docker binary (the pre-fix trigger was
    # exactly "the binary exists"), and if that shim really records.
    grep -Fq "resolved=$fixture/bin/docker" "$bundle_dir/compose-cli-diagnostics.txt" \
      || fail "collector did not resolve the fixture docker shim; PATH interposition failed"
    : > "$fixture/release"
    portico373_FIXTURE="$fixture" "$fixture/bin/docker" ps -a >/dev/null 2>&1 || true
    grep -Fxq 'docker ps -a' "$fixture/calls.txt" \
      || fail "fixture docker shim does not record invocations; the zero-call assertion proves nothing"

    rm -rf "$fixture"
  )
}

test_skipped_docker_diagnostics_are_recorded_in_the_bundle() {
  (
    local fixture bundle_dir collector_rc
    fixture="$(mktemp -d)"
    build_collector_fixture "$fixture" wedged

    collector_rc=0
    run_debug_collector_in_fixture "$fixture" 1 probe-timeout 45 || collector_rc=$?
    [ "$collector_rc" -eq 0 ] || fail "skip-mode collection exited $collector_rc; log: $fixture/collector.log"

    bundle_dir="$(extract_collected_debug_bundle "$fixture" || true)"
    [ -n "$bundle_dir" ] && [ -d "$bundle_dir" ] || fail "expected a debug bundle in skip mode"

    [ -s "$bundle_dir/docker-diagnostics-skipped.txt" ] \
      || fail "expected docker-diagnostics-skipped.txt to explain the missing Docker evidence"
    grep -Fq 'reason: probe-timeout' "$bundle_dir/docker-diagnostics-skipped.txt" \
      || fail "expected the preflight verdict as the recorded skip reason"
    grep -Fq 'SKIPPED (probe-timeout)' "$bundle_dir/summary.txt" \
      || fail "expected the summary to note the skipped Docker diagnostics"
    grep -Fq 'docker-diagnostics-skipped.txt' "$bundle_dir/summary.txt" \
      || fail "expected the summary to point at the skip explanation file"
    grep -Fq 'skipped (probe-timeout)' "$bundle_dir/compose-cli-diagnostics.txt" \
      || fail "expected the compose diagnostics to record the skipped engine probes"
    grep -Fq 'docker diagnostics skipped (probe-timeout)' "$bundle_dir/update-pipeline-state.txt" \
      || fail "expected the update pipeline state to record the skipped container inventory"

    rm -rf "$fixture"
  )
}

test_docker_preflight_status_is_allowlisted_before_reaching_the_bundle() {
  (
    local fixture bundle_dir collector_rc leaked raw_status
    fixture="$(mktemp -d)"
    build_collector_fixture "$fixture" wedged

    # The status is written into a bundle users hand over, so an arbitrary error
    # string from the probe must never survive into it.
    raw_status='connect EACCES /Users/portico373-sentinel-user/.orbstack/run/docker.sock "wedged"'

    collector_rc=0
    run_debug_collector_in_fixture "$fixture" 1 "$raw_status" 45 || collector_rc=$?
    [ "$collector_rc" -eq 0 ] || fail "collection with an unrecognized preflight status exited $collector_rc"

    bundle_dir="$(extract_collected_debug_bundle "$fixture" || true)"
    [ -n "$bundle_dir" ] && [ -d "$bundle_dir" ] || fail "expected a debug bundle for the unrecognized status"

    leaked="$(grep -rlF 'portico373-sentinel-user' "$bundle_dir" 2>/dev/null || true)"
    [ -z "$leaked" ] || fail "raw preflight status leaked into the bundle: $leaked"
    leaked="$(grep -rlF '.orbstack/run/docker.sock' "$bundle_dir" 2>/dev/null || true)"
    [ -z "$leaked" ] || fail "raw preflight status path leaked into the bundle: $leaked"

    grep -Fq 'reason: unavailable' "$bundle_dir/docker-diagnostics-skipped.txt" \
      || fail "expected an unrecognized preflight status to normalize to 'unavailable'"
    grep -Fq 'SKIPPED (unavailable)' "$bundle_dir/summary.txt" \
      || fail "expected the summary to carry the normalized preflight status"

    rm -rf "$fixture"
  )
}

test_wedged_engine_collection_still_captures_non_docker_evidence() {
  (
    local fixture bundle_dir collector_rc leaked
    fixture="$(mktemp -d)"
    build_collector_fixture "$fixture" wedged

    collector_rc=0
    run_debug_collector_in_fixture "$fixture" 1 probe-failed 45 || collector_rc=$?
    [ "$collector_rc" -eq 0 ] || fail "skip-mode collection exited $collector_rc; log: $fixture/collector.log"

    bundle_dir="$(extract_collected_debug_bundle "$fixture" || true)"
    [ -n "$bundle_dir" ] && [ -d "$bundle_dir" ] || fail "expected a debug bundle in skip mode"

    grep -Fq 'portico373-fixture-build' "$bundle_dir/build-info.json" \
      || fail "expected build info in a Docker-skipped bundle"
    grep -Fq 'mcp-config' "$bundle_dir/mcp_config.json" \
      || fail "expected project configuration in a Docker-skipped bundle"
    [ -d "$bundle_dir/mcpo-configs-generated" ] \
      || fail "expected generated MCP configuration in a Docker-skipped bundle"
    grep -Fq 'portico373-fixture-app-log-marker' "$bundle_dir/portico-app.log" \
      || fail "expected application logs in a Docker-skipped bundle"
    grep -Fq 'FIXTURE_API_KEY=<REDACTED>' "$bundle_dir/env-sanitized.txt" \
      || fail "expected redacted environment capture in a Docker-skipped bundle"
    grep -Fq 'FIXTURE_PLAIN=' "$bundle_dir/env-sanitized.txt" \
      || fail "expected the environment capture to enumerate keys in a Docker-skipped bundle"
    # The redaction pass must still run when Docker diagnostics are skipped.
    leaked="$(grep -rlF 'portico373-fixture-secret-value' "$bundle_dir" 2>/dev/null || true)"
    [ -z "$leaked" ] || fail "secret survived redaction in a Docker-skipped bundle: $leaked"
    [ -s "$bundle_dir/runtime-fingerprint.txt" ] \
      || fail "expected a runtime fingerprint in a Docker-skipped bundle"
    [ -s "$bundle_dir/system-info.txt" ] \
      || fail "expected system info in a Docker-skipped bundle"

    rm -rf "$fixture"
  )
}

test_responsive_engine_collection_still_runs_docker_diagnostics() {
  (
    local fixture bundle_dir collector_rc
    fixture="$(mktemp -d)"
    build_collector_fixture "$fixture" responsive

    collector_rc=0
    run_debug_collector_in_fixture "$fixture" 0 ok 45 || collector_rc=$?
    [ "$collector_rc" -eq 0 ] || fail "collection against a responsive engine exited $collector_rc"

    grep -Fxq 'docker ps -a' "$fixture/calls.txt" \
      || fail "a responsive engine must still be inventoried: $(recorded_container_engine_calls "$fixture")"
    grep -Fxq 'docker version' "$fixture/calls.txt" \
      || fail "expected the docker version round trip against a responsive engine"
    grep -Fxq 'docker network ls' "$fixture/calls.txt" \
      || fail "expected docker network diagnostics against a responsive engine"

    bundle_dir="$(extract_collected_debug_bundle "$fixture" || true)"
    [ -n "$bundle_dir" ] && [ -d "$bundle_dir" ] || fail "expected a debug bundle for a responsive engine"

    [ ! -f "$bundle_dir/docker-diagnostics-skipped.txt" ] \
      || fail "a responsive engine must not be reported as skipped"
    ! grep -Fq 'docker diagnostics: SKIPPED' "$bundle_dir/summary.txt" \
      || fail "a responsive engine must not be summarized as skipped"
    ! grep -Fq 'Docker not available' "$bundle_dir/docker-info.txt" \
      || fail "a responsive engine must produce real container diagnostics"

    rm -rf "$fixture"
  )
}

test_source_does_not_execute_main
test_live_sampling_arguments_are_validated
test_database_snapshot_collection_is_secret_safe_and_graceful
test_database_snapshot_client_refuses_proxies_and_redirects
test_sensitive_log_statements_are_absent
test_archive_recent_app_support_logs_includes_expected_prefixes
test_proxy_diagnostics_flag_missing_internal_no_proxy_entries
test_redact_file_removes_chat_payload_previews
test_redact_file_preserves_toggle_json
test_env_redaction_preserves_structured_json_primitives
test_debug_bundle_captures_runtime_and_stale_guided_setup_build_info
test_debug_container_inventory_includes_openwebui_aliases
test_compose_cli_diagnostics_capture_split_frontends_and_sanitized_paths
test_debug_collection_uses_extended_update_incident_limits
test_trim_large_log_file_preserves_head_and_tail
test_collect_update_pipeline_state_captures_forensics
test_docker_info_capture_scopes_image_inventory_to_app_images
test_live_sampler_has_bounded_cleanup_and_private_lsof_fields
test_wedged_engine_collection_never_calls_the_container_engine
test_skipped_docker_diagnostics_are_recorded_in_the_bundle
test_docker_preflight_status_is_allowlisted_before_reaching_the_bundle
test_wedged_engine_collection_still_captures_non_docker_evidence
test_responsive_engine_collection_still_runs_docker_diagnostics

echo "PASS: debug log collection regressions"
