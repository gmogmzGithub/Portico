# Install Issues Tracker

Track recurring installation issues to identify patterns and improve the installer.

## Issue Log

| Date | Symptom | Root Cause | Resolution | Patch Applied |
|------|---------|------------|------------|---------------|
| 2026-02-18 | OrbStack download failed at 99.8% (curl: Connection reset by peer) | Transient network / VPN instability | Restarted computer, re-ran installer | Added retry logic with exponential backoff |
| 2026-02-18 | Docker image pulls stuck for 30+ minutes | Slow/throttled connection to Harbor registry | Re-ran installer | Added retry loop for docker-compose pull |
| 2026-02-18 | Docker build failed: git clone TLS error in open-webui | GnuTLS recv error during git clone inside Dockerfile | Restarted computer, re-ran installer | Added retry logic to git clone in Dockerfile |
| 2026-02-18 | Log directory missing, couldn't share logs | bootstrap.sh didn't create log dir before install_v2.sh | Pointed user at path manually | bootstrap.sh now creates log directory early |
| 2026-02-16 | Persistent "Nexus update check failed: fetch failed" (13 occurrences over 3 days) | App cannot reach Nexus server — likely VPN / network config issue | Under investigation | None yet |
| 2026-02-16 | `rsync` error (code 13 + SIGUSR1) during update extraction | `electron-app/dist` directory locked by running app during in-app update | Update continued despite error | None yet — needs fix to stop app before rsync |
| 2026-02-16 | "no such service: mcpo-slack" after update | Docker compose config mismatch — app references service not in compose file | Service errors on first launch post-update | None yet |
| 2026-02-16 | MCP tools returning 502/404 (slack, datadog, atlassian, glean) after update | MCP containers not yet running or misconfigured after update | Resolved on subsequent restarts | None yet — may need startup ordering / health checks |
| 2026-02-16 | Webview `ERR_EMPTY_RESPONSE` on `localhost:3789` at startup | Open WebUI backend not ready when Electron webview loads | Resolved on retry | None yet — may need webview retry / wait logic |
| 2026-02-19 | "Failed to remove `electron-app/dist` — may be in use or locked" during update | dist directory locked while app is running | Bootstrap continued with warning | None yet — needs graceful app shutdown before update |
| 2026-02-19 | Bootstrap log truncated mid-pull | Logs collected while update still in progress, or update interrupted | Unknown — could not confirm | None yet |

## Common Patterns

### Network Instability (VPN/Corporate Proxy)
- **Symptoms**: Connection reset, TLS errors, downloads timing out, pulls stuck
- **Affected steps**: OrbStack install, Docker image pulls, git clone in Docker builds, Nexus downloads
- **Mitigations added**:
  - `retry_with_backoff` helper in install_v2.sh (3 attempts, exponential backoff)
  - Docker pull retry loop (3 attempts, 15s/30s/60s backoff)
  - git clone retry in Dockerfile.open-webui-patched (3 attempts, 10s/30s backoff)
  - Network connectivity pre-check at install start
  - Clear error messages with VPN troubleshooting hints
  - "Safe to re-run" messaging at all failure exit points

### File Locking During In-App Updates
- **Symptoms**: rsync error code 13 + SIGUSR1, "Failed to remove electron-app/dist - may be in use or locked"
- **Affected steps**: In-app update extraction (rsync), bootstrap cleanup of electron-app/dist
- **Root cause**: The Electron app is still running and holding locks on files in dist/ when the updater tries to overwrite them
- **Mitigations needed**:
  - Gracefully quit the app before starting update extraction
  - Or extract to a staging directory and swap on next launch
- **First seen:** February 2026.

### Nexus Update Check Failures (Persistent)
- **Symptoms**: "Nexus update check failed: fetch failed" / "TypeError: fetch failed" repeatedly over days
- **Affected steps**: Background update checker in the Electron app
- **Root cause**: App cannot reach the Nexus update server — possibly VPN routing, corporate proxy, or geo-specific connectivity.
- **Mitigations needed**:
  - Add retry logic to update checker
  - Show user-visible notification when update checks persistently fail
  - Consider adding a timeout / backoff to avoid spamming failed requests
- **First seen:** February 2026.

### MCP Service Startup Race Conditions
- **Symptoms**: 502 Bad Gateway, 404 Not Found on MCP tools, "no such service", ERR_EMPTY_RESPONSE on webview
- **Affected steps**: Post-update first launch, MCP tool calls, webview loading
- **Root cause**: Services not yet ready when app/webview/tools try to connect. Docker containers still starting up or not defined in compose config.
- **Mitigations needed**:
  - Health-check gating before marking services as ready
  - Webview retry/loading screen while backend starts
  - Validate compose config references before attempting service operations
- **First seen:** February 2026 post-update.

### Missing Logs
- **Symptom**: `~/Library/Application Support/portico/logs/` doesn't exist
- **Cause**: bootstrap.sh failed before install_v2.sh had a chance to create the log directory
- **Fix**: bootstrap.sh now creates the log directory early, before Step 1

## How to Add Entries

When a user reports an install issue:
1. Add a row to the Issue Log table with date, symptom, root cause, resolution, and whether a code patch was applied.
2. If it matches an existing pattern, note it under Common Patterns.
3. If it is a new pattern, create a new section under Common Patterns with symptoms, affected steps, and mitigations.
