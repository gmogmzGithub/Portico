# G.3 — Per-server & debug

Five scenarios for the per-server debug surfaces: log tailing, individual restart, deletion, fail-loud badges, and badge-tooltip focus.

- Up: [`docs/testing/plan/mcp/README.md`](README.md).

---

## Scenarios

### G-20 — Open MCP debug tab → tail logs for any running server

**Coverage:** Auto — [`mcp-server-logs.test.js`](../../../../electron-app/src/services/mcp-server-logs.test.js)
**Type:** MCP
**Preconditions:** At least one MCP server enabled and healthy.

**Steps:**
1. Open Settings → MCP → Debug → select a server.
2. Confirm logs are streaming.

**Expected:**
- Logs scroll in near-realtime as new lines arrive.
- Switching servers swaps the visible log without leaking the previous tail.

**Fail indicators:**
- Logs blank.
- Log of one server appears under another's name.

<!-- @portico:test-status:begin id=G-20 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:23.799Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-server-logs.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-21 — Restart an individual server from the debugger → no nginx race

**Coverage:** Auto — [`mcp-infra-regeneration.test.js`](../../../../electron-app/src/services/mcp-infra-regeneration.test.js)
**Type:** MCP
**Preconditions:** A server enabled and healthy.

**Steps:**
1. From the debug panel, click Restart on the server.
2. Within ~2s, also bulk-toggle another integration on/off (race).

**Expected:**
- Restart completes.
- nginx config regeneration is serialized; no port collision in the nginx error log.

**Fail indicators:**
- nginx error log shows duplicate upstream entries.
- Restart leaves the server unhealthy.

<!-- @portico:test-status:begin id=G-21 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:23.186Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-infra-regeneration.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-22 — Delete a custom MCP server → config + container removed cleanly

**Coverage:** Auto — [`mcp-server-delete.test.js`](../../../../electron-app/src/services/mcp-server-delete.test.js)
**Type:** MCP
**Preconditions:** A custom (non-OOTB) server is added and currently disabled.

**Steps:**
1. Settings → MCP → custom server → Delete.
2. Verify config: inspect `mcpo-configs-generated/` for the server's JSON file (should be gone).
3. Verify container: `docker ps -a | grep <server>` should be empty.

**Expected:**
- Config file removed.
- Container removed.
- Server no longer listed.

**Fail indicators:**
- Config file remains.
- Container in `Exited` state remains.

<!-- @portico:test-status:begin id=G-22 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:24.391Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-server-delete.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-23 — Startup failures display a fail-loud badge in the control plane

**Coverage:** Auto — [`mcp-startup-failures.test.js`](../../../../electron-app/src/services/mcp-startup-failures.test.js)
**Type:** MCP
**Preconditions:** Force a startup failure (e.g. break a server's config or its container image).

**Steps:**
1. Toggle the broken server on.
2. Wait ~30s.
3. Inspect the control plane status badge.

**Expected:**
- A clearly red/error fail-loud badge appears.
- Hover shows the failure reason.

**Fail indicators:**
- Badge silently sits in `starting`.
- Failure reason missing or generic.

<!-- @portico:test-status:begin id=G-23 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:24.895Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-startup-failures.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-24 — Tooltip on server status badge keeps focus during keyboard nav

**Coverage:** Auto — [`mcp-badge-tooltip-focus.test.js`](../../../../electron-app/src/services/mcp-badge-tooltip-focus.test.js)
**Type:** MCP / Accessibility
**Preconditions:** ≥2 server status badges visible.

**Steps:**
1. Tab onto the first badge using the keyboard.
2. Press Tab to move to the next badge.
3. Repeat backwards with Shift+Tab.

**Expected:**
- Focus ring follows the keyboard.
- Tooltip stays anchored to the focused badge (does not flash to the wrong one).

**Fail indicators:**
- Focus jumps somewhere else.
- Tooltip shows the wrong server's reason.

<!-- @portico:test-status:begin id=G-24 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:25.780Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-badge-tooltip-focus.test.js -- 0s
<!-- @portico:test-status:end -->
