#!/usr/bin/env bash

set -euo pipefail

# Build a compatible Slack MCP server from an explicitly selected upstream
# repository. The public project does not ship a prebuilt binary or assume
# ownership of a particular provider fork.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_REPO="${SLACK_MCP_UPSTREAM_REPO:?Set SLACK_MCP_UPSTREAM_REPO to a compatible Slack MCP server repository}"
UPSTREAM_REF="${SLACK_MCP_UPSTREAM_REF:-51eab7d360280636e084eb612a66aa6e3826c7ee}"
UPSTREAM_VERSION="${SLACK_MCP_UPSTREAM_VERSION:-v1.3.0}"
BUILD_TIME="${SLACK_MCP_BUILD_TIME:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
GO_MODULE_PROXY="${SLACK_MCP_GOPROXY:-https://proxy.golang.org,direct}"
GO_MODULE_SUMDB="${SLACK_MCP_GOSUMDB:-sum.golang.org}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "go is required" >&2
  exit 1
fi

workdir="${SLACK_MCP_BUILD_DIR:-$(mktemp -d)}"
cleanup_workdir=0
if [ -z "${SLACK_MCP_BUILD_DIR:-}" ]; then
  cleanup_workdir=1
fi

cleanup() {
  if [ "$cleanup_workdir" -eq 1 ]; then
    rm -rf "$workdir"
  fi
}
trap cleanup EXIT

rm -rf "$workdir/slack-mcp-server"
git clone "$UPSTREAM_REPO" "$workdir/slack-mcp-server"
git -C "$workdir/slack-mcp-server" checkout "$UPSTREAM_REF"

(
  cd "$workdir/slack-mcp-server"
  GOPROXY="$GO_MODULE_PROXY" GOSUMDB="$GO_MODULE_SUMDB" go test ./pkg/provider ./pkg/server
)

package="$(cd "$workdir/slack-mcp-server" && go list -m)"
ldflags="-s -w"
ldflags="$ldflags -X '$package/pkg/version.CommitHash=$UPSTREAM_REF'"
  ldflags="$ldflags -X '$package/pkg/version.Version=$UPSTREAM_VERSION'"
ldflags="$ldflags -X '$package/pkg/version.BuildTime=$BUILD_TIME'"
ldflags="$ldflags -X '$package/pkg/version.BinaryName=slack-mcp-server'"

for arch in amd64 arm64; do
  output="$SCRIPT_DIR/slack-mcp-server-linux-$arch"
  (
    cd "$workdir/slack-mcp-server"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" GOPROXY="$GO_MODULE_PROXY" GOSUMDB="$GO_MODULE_SUMDB" \
      go build -trimpath -ldflags "$ldflags" -o "$output" ./cmd/slack-mcp-server
  )
  chmod 0644 "$output"
  echo "rebuilt $output"
done
