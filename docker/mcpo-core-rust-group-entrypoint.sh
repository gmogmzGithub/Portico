#!/bin/sh
set -eu

TARGETS_FILE="${MCPO_MULTI_TARGETS_FILE:-/app/mcpo-configs-generated/group-core-targets.json}"
SUPERVISOR_CONF="${MCPO_MULTI_SUPERVISOR_CONF:-/tmp/mcpo-core-rust-group.conf}"
HOME_ROOT="${MCPO_MULTI_HOME_ROOT:-/app/mcpo-runtime-homes/core}"

if [ ! -f "$TARGETS_FILE" ]; then
  echo "FATAL: core group targets file not found at $TARGETS_FILE" >&2
  exit 1
fi

mkdir -p "$HOME_ROOT"

supervisor_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

ensure_oauth_symlink() {
  home_dir="$1"
  oauth_storage_dir="$2"
  target="$home_dir/.mcpo"

  mkdir -p "$home_dir" "$oauth_storage_dir"

  if [ -L "$target" ]; then
    current_target="$(readlink "$target" || true)"
    if [ "$current_target" = "$oauth_storage_dir" ]; then
      return
    fi
    rm -f "$target"
  elif [ -d "$target" ]; then
    rm -rf "$target"
  elif [ -e "$target" ]; then
    rm -f "$target"
  fi

  ln -s "$oauth_storage_dir" "$target"
}

write_supervisor_header() {
  cat <<'EOF'
[unix_http_server]
file=/tmp/supervisor-mcpo-core-rust.sock
chmod=0700

[supervisord]
nodaemon=true
logfile=/dev/null
pidfile=/tmp/supervisord-mcpo-core-rust.pid
childlogdir=/tmp

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///tmp/supervisor-mcpo-core-rust.sock

EOF
}

render_programs() {
  index=0
  jq -r '.servers[] | [.id, (.port | tostring), .config_file, .oauth_storage_dir] | @tsv' "$TARGETS_FILE" \
  | while IFS="$(printf '\t')" read -r server_id port config_file oauth_storage_dir; do
      [ -n "$server_id" ] || continue

      home_dir="$HOME_ROOT/$server_id"
      ensure_oauth_symlink "$home_dir" "$oauth_storage_dir"

      case "$config_file" in
        /*) config_path="$config_file" ;;
        *) config_path="/app/$config_file" ;;
      esac

      escaped_home="$(supervisor_escape "$home_dir")"
      escaped_config="$(supervisor_escape "$config_path")"
      program_id="$(printf '%s' "$server_id" | tr '-' '_')"
      priority=$((10 + index))

      cat <<EOF
[program:mcpo_$program_id]
command=/usr/local/bin/mcpo --host 0.0.0.0 --port $port --config $escaped_config
directory=/app
autostart=true
autorestart=true
startsecs=2
startretries=10
stopsignal=TERM
stopasgroup=true
killasgroup=true
priority=$priority
environment=HOME="$escaped_home",MCP_ORC_BACKEND="rust",MCP_ORC_NATIVE_MODE="native"
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

EOF

      index=$((index + 1))
    done
}

render_scheduling_daemon() {
  if ! jq -e '.servers[] | select(.id == "scheduling")' "$TARGETS_FILE" >/dev/null 2>&1; then
    return
  fi

  cat <<'EOF'
[program:scheduling_daemon]
command=/usr/local/bin/scheduling-daemon
directory=/app
autostart=true
autorestart=true
startsecs=2
startretries=10
stopsignal=TERM
stopasgroup=true
killasgroup=true
priority=200
environment=HOME="/app",MCP_ORC_BACKEND="rust",MCP_ORC_NATIVE_MODE="native"
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

EOF
}

if ! jq -e '.servers | length > 0' "$TARGETS_FILE" >/dev/null 2>&1; then
  echo "FATAL: no grouped core MCP servers defined in $TARGETS_FILE" >&2
  exit 1
fi

{
  write_supervisor_header
  render_programs
  render_scheduling_daemon
} > "$SUPERVISOR_CONF"

exec supervisord -n -c "$SUPERVISOR_CONF"
