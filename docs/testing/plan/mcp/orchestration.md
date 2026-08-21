# G.1 — Toggles & lifecycle

Seven scenarios for toggling MCP integrations on/off, parallel toggles, and the nginx-corruption guard.

- Up: [`docs/testing/plan/mcp/README.md`](README.md).

---

## Scenarios

### G-01 — Toggle one core integration (Slack) on → container healthy → tools usable

**Coverage:** Auto — [`mcp-toggle-persistence.test.js`](../../../../electron-app/src/services/mcp-toggle-persistence.test.js)
**Type:** MCP
**Preconditions:** Slack already authorized (P0-04).

**Steps:**
1. Open Settings → MCP integrations → Slack → toggle on.
2. Wait for container to reach healthy.
3. Send a chat message asking the agent to perform a Slack tool call.

**Expected:**
- Container shows healthy in the status badge within 30s.
- Agent successfully performs the tool call.

**Fail indicators:**
- Container stuck in `starting`.
- Tool call returns `tool not available`.

<!-- @portico:test-status:begin id=G-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:21.296Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-toggle-persistence.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-02 — Toggle off → tools removed from `<active>` context

**Coverage:** Auto — [`api-toggle-readiness-regressions.test.js`](../../../../electron-app/src/services/api-toggle-readiness-regressions.test.js)
**Type:** MCP
**Preconditions:** Slack toggled on (G-01) and a tool call has succeeded.

**Steps:**
1. Toggle Slack off.
2. Send a chat message asking the agent to perform a Slack tool call.

**Expected:**
- The model has no Slack tool in its context (won't attempt the call).
- The control plane lists Slack as off.

**Fail indicators:**
- Tool still callable.
- Off state not propagated to LLM context.

<!-- @portico:test-status:begin id=G-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:21.746Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/api-toggle-readiness-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-03 — Toggle returns `needs_oauth` (not `starting`) for OAuth servers

**Coverage:** Partial — manual + [`oauth-flow-lifecycle.test.js`](../../../../electron-app/src/services/oauth-flow-lifecycle.test.js) (regression #43)
**Type:** MCP / Auth
**Preconditions:** A clean install (no existing OAuth tokens for the target server, e.g. Google Workspace).

**Steps:**
1. Toggle on the OAuth server *without* completing OAuth first.
2. Observe the status badge state in the control plane.

**Expected:**
- Badge transitions to `needs_oauth` immediately.
- Does NOT spin in `starting` indefinitely.

**Fail indicators:**
- `starting` for >30s.
- Container ends in unhealthy.

<!-- @portico:test-status:begin id=G-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:02.430Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/oauth-flow-lifecycle.test.js -- 1s
<!-- @portico:test-status:end -->

---

### G-04 — Bulk disable clears startup failures unconditionally after `mutateMcpToggles`

**Coverage:** Auto — [`mcp-bulk-toggle-ipc-regressions.test.js`](../../../../electron-app/src/services/mcp-bulk-toggle-ipc-regressions.test.js)
**Type:** MCP
**Preconditions:** Several integrations enabled with at least one in startup-failure state.

**Steps:**
1. Bulk-disable all enabled integrations from the control plane.
2. Inspect startup-failure badges.

**Expected:**
- After `mutateMcpToggles` returns, all startup-failure badges are cleared.

**Fail indicators:**
- Stale failure badge remains.

<!-- @portico:test-status:begin id=G-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:22.261Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-bulk-toggle-ipc-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-05 — `restart_mcp_infrastructure` is serialized; nginx never corrupted

**Coverage:** Auto — [`mcp-infra-regeneration.test.js`](../../../../electron-app/src/services/mcp-infra-regeneration.test.js) (regressions #35–36, #41)
**Type:** MCP
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. From `electron-app/`, run `node --test src/services/mcp-infra-regeneration.test.js`.
2. Manually: rapidly toggle 3 servers on/off in succession; confirm nginx config remains valid (`docker exec mcpo-nginx nginx -t`).

**Expected:**
- Test passes.
- nginx config remains valid.

**Fail indicators:**
- `nginx -t` reports duplicate or malformed entries.

<!-- @portico:test-status:begin id=G-05 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:23.031Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-infra-regeneration.test.js -- 0s
<!-- @portico:test-status:end -->

---

### G-06 — Cross-validated status agrees with Electron API

**Coverage:** Manual (legacy untested item 21; regression #28)
**Type:** MCP
**Preconditions:** Several integrations toggled on; one disabled state forced (e.g. via Docker stop directly).

**Steps:**
1. Stop one MCP container manually: `docker stop <mcp-server>`.
2. Open the control plane and inspect the server's status badge.
3. Try to invoke a tool of that server through chat.

**Expected:**
- The badge reflects the disabled state.
- The LLM context does not list tools for the disabled server.

**Fail indicators:**
- UI claims `available` while the container is down.
- LLM still tries to call the tool and fails.

<!-- @portico:test-status:begin id=G-06 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### G-07 — Three integrations enabled in parallel reach `tool_ready` within 45s

**Coverage:** Manual (legacy item 43; regression #42)
**Type:** MCP / Performance
**Preconditions:** Three integrations available but currently disabled (e.g. Slack, GitLab, Glean).

**Steps:**
1. Note current time.
2. Bulk-enable the three integrations in one action.
3. Wait until all three badges show `tool_ready`.
4. Compute elapsed.

**Expected:**
- All three reach `tool_ready` within 45s.
- No overlapping nginx race or container failures.

**Fail indicators:**
- Any container stuck >45s.
- nginx error log shows port collisions.

<!-- @portico:test-status:begin id=G-07 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
