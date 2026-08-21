# H.3 — Token-based integrations (guided setup)

Four scenarios for the non-OAuth integration setup path: PAT entry, long install timeouts, env var presets, and cancel handling.

- Up: [`docs/testing/plan/auth/README.md`](README.md).

---

## Scenarios

### H-30 — GitLab guided setup: PAT entry → container healthy → tools work

**Coverage:** Auto — [`mcp-config-modal.test.js`](../../../../electron-app/src/services/mcp-config-modal.test.js)
**Type:** MCP / Auth
**Preconditions:** GitLab PAT with `read_api` scope.

**Steps:**
1. Settings → MCP → GitLab → guided setup.
2. Paste the PAT into the secure field.
3. Save & Test.
4. Send a chat message: `show my open merge requests`.

**Expected:**
- Container starts and reaches healthy.
- Tool call returns merge request data.
- Token never appears as a plaintext literal in `runtime-secrets.env`.

**Fail indicators:**
- Container fails to start.
- 401 from tool call.
- Plaintext token on disk.

<!-- @portico:test-status:begin id=H-30 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:04.098Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/mcp-config-modal.test.js -- 0s
<!-- @portico:test-status:end -->

---

### H-31 — First-run GitLab `npx`-based 120s install survives the 180s timeout

**Coverage:** Manual (regressions #14 / #44)
**Type:** MCP / Performance
**Preconditions:** First time enabling GitLab on a fresh machine (so npx will install the GitLab MCP package fresh).

**Steps:**
1. Note current time.
2. Toggle GitLab on (no PAT yet).
3. Wait for the npx install to complete and the container to become healthy.

**Expected:**
- Install completes within 180s.
- Container reaches healthy.
- No premature timeout.

**Fail indicators:**
- Container marked unhealthy at ~120s.
- Install times out before npx finishes.

<!-- @portico:test-status:begin id=H-31 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-06T08:23:29.104Z
- Build: pre-beta-fix-message-sending @ 7233568a
- Executor: odubo
- Notes: manual: GitLab npx install completed within 180s; container reached healthy without premature timeout
<!-- @portico:test-status:end -->

---

### H-32 — Guided setup writes preset env vars (e.g. `GITLAB_API_URL`) along with user fields

**Coverage:** Manual (regression #23)
**Type:** MCP / Auth
**Preconditions:** GitLab integration in guided setup.

**Steps:**
1. Open guided setup for GitLab.
2. Inspect the form — confirm `GITLAB_API_URL` is shown as a preset (read-only or default-filled) value.
3. Save & Test.
4. Inspect the resulting MCP config in `mcpo-configs-generated/`.

**Expected:**
- Generated config includes `GITLAB_API_URL` from the preset along with the user-entered PAT.
- Tool calls hit the right URL.

**Fail indicators:**
- `GITLAB_API_URL` missing from the generated config.
- Wrong URL leaks (e.g. `gitlab.com` instead of internal one).

<!-- @portico:test-status:begin id=H-32 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-06T08:27:34.992Z
- Build: pre-beta-fix-message-sending @ 7233568a-dirty
- Executor: odubo
- Notes: manual: GitLab guided setup (PAT entry) merged all 6 preset env vars into .env (GITLAB_API_URL=https://example.invalid/api/v4, GITLAB_IS_OLD=true, GITLAB_READ_ONLY_MODE=false, USE_GITLAB_WIKI=false, USE_MILESTONE=false, USE_PIPELINE=false) plus the user PAT; no gitlab.com leak
<!-- @portico:test-status:end -->

---

### H-33 — Cancel config modal mid-flow → AI sees `cancelled`, offers retry

**Coverage:** Manual (regression #37)
**Type:** MCP / Auth
**Preconditions:** A token-based integration's config modal is open mid-flow.

**Steps:**
1. Click Cancel (or close X) without saving.
2. Observe the assistant's next message.

**Expected:**
- Assistant acknowledges the cancellation.
- Offers a retry button or inline link.

**Fail indicators:**
- Assistant silently waits forever.
- No retry option.

<!-- @portico:test-status:begin id=H-33 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-06T08:23:29.251Z
- Build: pre-beta-fix-message-sending @ 7233568a-dirty
- Executor: odubo
- Notes: manual: cancelled GitLab config modal; assistant acknowledged 'cancelled' reason and offered retry
<!-- @portico:test-status:end -->
