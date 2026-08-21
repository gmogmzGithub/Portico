#!/bin/sh
set -eu

TARGETS_FILE="${MCPO_MULTI_TARGETS_FILE:-/app/mcpo-configs-generated/multi-server-targets.json}"
SUPERVISOR_CONF="${MCPO_MULTI_SUPERVISOR_CONF:-/tmp/mcpo-multi-server.conf}"
HOME_ROOT="${MCPO_MULTI_HOME_ROOT:-/app/mcpo-runtime-homes}"

if [ ! -f "$TARGETS_FILE" ]; then
  echo "FATAL: multi-server targets file not found at $TARGETS_FILE" >&2
  exit 1
fi

python3 /app/render-mcpo-multi-supervisor.py \
  --targets "$TARGETS_FILE" \
  --output "$SUPERVISOR_CONF" \
  --home-root "$HOME_ROOT"

exec supervisord -n -c "$SUPERVISOR_CONF"
