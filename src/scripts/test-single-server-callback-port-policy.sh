#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

set +e
output="$(bash "$PROJECT_ROOT/src/scripts/start-single-mcp-server.sh" mcp-atlassian --status --callback-port 3996 2>&1)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected unsupported callback port to be rejected"
  exit 1
fi

if ! grep -Fq -- "--callback-port must be 3834 or 3836" <<<"$output"; then
  echo "Expected explicit callback port policy error"
  echo "$output"
  exit 1
fi

echo "Single-server callback port policy rejects unsupported ports."
