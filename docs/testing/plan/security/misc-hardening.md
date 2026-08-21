# L.5 — Miscellaneous hardening

Five scenarios for outbound URL guard, FTS regex timeout, file-permissions on Docker secrets, Cloudsmith upload-token policy, and the post-install grep audit.

- Up: [`docs/testing/plan/security/README.md`](README.md).
- Threats: V-004, N-001, N-003, N-005.

---

## Scenarios

### L-04 — Outbound URL validation rejects javascript:/file:/data: schemes (V-004)

**Coverage:** Auto — [`shell-open.test.js`](../../../../electron-app/src/services/shell-open.test.js)
**Type:** Security
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/services/shell-open.test.js`.
2. Confirm the test asserts that `javascript:`, `file:`, and `data:` URLs are rejected before being passed to Electron's `shell.openExternal`.

**Expected:**
- Test passes.
- These three schemes throw or are silently dropped before reaching `shell.openExternal`.

**Fail indicators:**
- Test asserts allow path.
- Source code passes any of these schemes through untouched.

<!-- @portico:test-status:begin id=L-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:36.878Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/shell-open.test.js -- 0s
<!-- @portico:test-status:end -->

---

### L-07 — FTS regex query timeout (ReDoS mitigation) (N-001)

**Coverage:** Auto — [`tests/test_chat_search_security.py`](../../../../tests/test_chat_search_security.py)
**Type:** Security
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_chat_search_security.py`.

**Expected:**
- Test passes.
- ReDoS-style patterns time out within a bounded window (e.g. <500ms).

**Fail indicators:**
- Test fails.
- Pattern allowed to spin indefinitely.

<!-- @portico:test-status:begin id=L-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:35.102Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_chat_search_security.py -- 2s
<!-- @portico:test-status:end -->

---

### L-08 — Docker Compose secrets dirs `0700`, files `0600`; `/dev/null` fallback for read-only stacks (N-003)

**Coverage:** Auto — [`tests/test_docker_compose_runtime_secrets.sh`](../../../../tests/test_docker_compose_runtime_secrets.sh)
**Type:** Security
**Preconditions:** Default install completed.

**Steps (regression-investigation only):**
1. From repo root, run `bash tests/test_docker_compose_runtime_secrets.sh`.
2. Manually:
   - `stat -f "%A %N" ~/Library/Application\ Support/portico/runtime-secrets` → permissions `700`.
   - `stat -f "%A %N" ~/Library/Application\ Support/portico/runtime-secrets/*` → permissions `600` for files.

**Expected:**
- Test passes.
- Dir is `0700`; files inside are `0600`.

**Fail indicators:**
- World-readable / group-readable bits set.

<!-- @portico:test-status:begin id=L-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:42:38.638Z
- Build: pre-beta-tmp @ 5512efe2
- Executor: odubo
- Notes: bash tests/test_docker_compose_runtime_secrets.sh -- All docker-compose runtime-secret regressions passed. Manual: ~/Library/Caches/portico/runtime-secrets dir is 0700; infrastructure secret files are 0600; Slack OAuth client-secret files are no longer generated because Slack uses PKCE public-client OAuth.
<!-- @portico:test-status:end -->

---

### L-10 — Cloudsmith upload key not present in packaged builds (N-005)

**Coverage:** Auto — [`cloudsmith-config.test.js`](../../../../electron-app/src/config/cloudsmith-config.test.js)
**Type:** Security
**Preconditions:** A packaged build available.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/config/cloudsmith-config.test.js`.
2. Manually: extract the ASAR (`npx asar extract <path>/Portico\ AI\ Chat.app/Contents/Resources/app.asar /tmp/portico-asar`); grep for the upload-token literal.

**Expected:**
- Test passes.
- Upload-token literal not present anywhere in the unpacked ASAR.
- Read token (read-only scope) is present.

**Fail indicators:**
- Upload token leaked into the build.

<!-- @portico:test-status:begin id=L-10 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:38.641Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/cloudsmith-config.test.js -- 0s
<!-- @portico:test-status:end -->

---

### L-16 — After install: `runtime-secrets/` only `0600` files; no env file in project root has the literal LLM key

**Coverage:** Manual
**Type:** Security
**Preconditions:** Default install completed.

**Steps:**
1. `find ~/Library/Application\ Support/portico/runtime-secrets -type f -perm +066 2>/dev/null` — should be empty.
2. `grep -r "PORTICO_LLM_API_KEY=[A-Za-z0-9]" .` from the repo root — should be empty (i.e. no project-root `.env` containing the literal key).
3. Repeat the grep for sensitive MCP keys such as `GITLAB_PERSONAL_ACCESS_TOKEN=`, `SOURCEGRAPH_TOKEN=`, `N8N_API_KEY=`, and for legacy Slack client keys (`SLACK_OAUTH_CLIENT_ID=` / `SLACK_OAUTH_CLIENT_SECRET=`).

**Expected:**
- All grep results empty.
- Files in `runtime-secrets/` all `0600`.

**Fail indicators:**
- Any `runtime-secrets/` file with broader permissions.
- Plaintext literal in any project-root `.env`.

<!-- @portico:test-status:begin id=L-16 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:42:38.698Z
- Build: pre-beta-tmp @ 5512efe2
- Executor: odubo
- Notes: find ~/Library/Caches/portico/runtime-secrets -type f -perm +066 returns empty. grep for PORTICO_LLM_API_KEY=/SLACK_OAUTH_CLIENT_SECRET=/GITLAB_PERSONAL_ACCESS_TOKEN=/SOURCEGRAPH_TOKEN=/N8N_API_KEY= in project-root env files (.env, .env.runtime, cloudsmith.env) returns empty.
<!-- @portico:test-status:end -->
