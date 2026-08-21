# I — LLM routing

Eight scenarios for the LLM gateway, bearer auth, runtime-secret resolution, health checks, legacy stack, cost dashboard, and model list refresh.

- Up: [`docs/testing/plan/llm/README.md`](README.md).

---

## Scenarios

### I-01 — Bifrost is the active gateway by default

**Coverage:** Auto — [`docker-mcp-regressions.test.js`](../../../../electron-app/src/services/docker-mcp-regressions.test.js)
**Type:** LLM
**Preconditions:** Default install (`./install_v2.sh` with no `--legacy`).

**Steps (regression-investigation only):**
1. Run `docker ps --format '{{.Names}}'` and confirm Bifrost containers are running.
2. Confirm no Bifrost bridge containers are running.
3. Confirm `docker-compose.yml` is the active compose file (per install state).

**Expected:**
- Bifrost is up; Bifrost bridge is not.
- `docker-compose.yml` is active.

**Fail indicators:**
- Both stacks running simultaneously.
- Bifrost bridge running on a default install.

<!-- @portico:test-status:begin id=I-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:11.766Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/docker-mcp-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### I-02 — Bifrost bearer auth uses constant-time compare (V-002)

**Coverage:** Auto — Rust unit tests in [`src/bifrost-bridge-rust/`](../../../../src/bifrost-bridge-rust)
**Type:** LLM / Security
**Preconditions:** Repo cloned with Rust toolchain installed.

**Steps (regression-investigation only):**
1. From `src/bifrost-bridge-rust/`, run `cargo test` and confirm the bearer-compare tests reference `subtle::ConstantTimeEq`.

**Expected:**
- All tests pass.
- Bearer comparison goes through `subtle::ConstantTimeEq` (no early-return `==` path).

**Fail indicators:**
- Test asserts a non-constant-time path.
- A grep for raw `==` on the bearer slice in the source.

<!-- @portico:test-status:begin id=I-02 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### I-03 — Bridge bearer key is generated once, persisted to Keychain, mounted via Docker secret (V-005)

**Coverage:** Auto — [`runtime-secrets-hardening.unit.test.js`](../../../../electron-app/src/config/runtime-secrets-hardening.unit.test.js)
**Type:** LLM / Security
**Preconditions:** Default install completed.

**Steps (regression-investigation only):**
1. Confirm `security find-generic-password -s portico-bridge-bearer` returns one entry.
2. Confirm the Docker compose file mounts `BRIDGE_BEARER_FILE` as a Docker secret (path pointer), not as a literal env var.
3. Re-run the install — Keychain entry should still match the same key.

**Expected:**
- One Keychain entry exists.
- Compose mounts `_FILE` pointer.
- Key is stable across re-installs.

**Fail indicators:**
- Multiple Keychain entries.
- Plaintext bearer in `runtime-secrets.env`.
- Re-install rotates the key.

<!-- @portico:test-status:begin id=I-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:12.390Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-hardening.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### I-04 — `PORTICO_LLM_API_KEY` is sourced via the V-007 chain (env → Keychain → install-time embed)

**Coverage:** Auto — [`runtime-secrets-config.test.js`](../../../../electron-app/src/config/runtime-secrets-config.test.js)
**Type:** LLM / Security
**Preconditions:** Default install completed.

**Steps (regression-investigation only):**
1. Inspect the runtime-secrets registry — only `_FILE` pointers should appear, no plaintext literals.
2. Force each branch of the V-007 chain (env → Keychain → embed) and confirm priority order via the test.

**Expected:**
- No plaintext literal of the LLM API key on disk.
- Priority order: env > Keychain > install-time embed.

**Fail indicators:**
- Plaintext literal in any state file or config.
- Priority order broken.

<!-- @portico:test-status:begin id=I-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:13.258Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-config.test.js -- 1s
<!-- @portico:test-status:end -->

---

### I-05 — Health check polls Bifrost via local Node HTTP (regression #11)

**Coverage:** Partial — `cargo test --manifest-path src/mcp-orc-rust/Cargo.toml -p health-check`
**Type:** LLM / Performance
**Preconditions:** Default install completed.

**Steps (regression-investigation only):**
1. Tail `~/Library/Logs/portico/main.log` for health-check entries.
2. Confirm the health check uses local Node HTTP, not a Python subprocess.
3. Time the health check — should complete sub-second.

**Expected:**
- Health-check log entries reference Node HTTP.
- Each poll completes <1s.

**Fail indicators:**
- Slow Python poll detected in logs.
- Multi-second poll latency.

<!-- @portico:test-status:begin id=I-05 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### I-06 — Bifrost bridge legacy stack (`--legacy`) still launches and routes a chat

**Coverage:** Manual
**Type:** LLM
**Preconditions:** Repo cloned; ability to install with `--legacy`.

**Steps:**
1. Run `./install_v2.sh --legacy`.
2. Send a chat message.
3. Inspect `~/Library/Logs/portico/main.log` for `llm-gateway` references.

**Expected:**
- Install succeeds.
- Chat completes via Bifrost bridge gateway.

**Fail indicators:**
- Install fails.
- Chat routing dies.

<!-- @portico:test-status:begin id=I-06 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### I-07 — Cost-dashboard tracks token usage when enabled

**Coverage:** Auto — [`cost-dashboard.unit.test.js`](../../../../electron-app/src/services/cost-dashboard.unit.test.js)
**Type:** LLM / Observability
**Preconditions:** Cost dashboard feature enabled in settings.

**Steps:**
1. Send a chat message.
2. Open the cost dashboard.
3. Refresh and inspect the recorded token counts.

**Expected:**
- Token usage entry appears within seconds of the message completing.
- Per-model breakdown is recorded.

**Fail indicators:**
- Dashboard empty after chat.
- Token totals visibly wrong.

<!-- @portico:test-status:begin id=I-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:13.975Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/cost-dashboard.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### I-08 — OWUI model list refreshes after enabling a new model in Bifrost

**Coverage:** Auto — [`tests/llm-debug-monitor-cache-breakpoints.unit.test.js`](../../../../tests/llm-debug-monitor-cache-breakpoints.unit.test.js)
**Type:** LLM
**Preconditions:** Default install; ability to add a new model to Bifrost (e.g. via Vault).

**Steps:**
1. Add a new model to Bifrost.
2. Trigger a model-list refresh in OWUI (or wait for the polling cycle).
3. Open the model picker.

**Expected:**
- New model appears within ~30s.
- No restart required.

**Fail indicators:**
- New model only appears after restart.
- OWUI model list permanently stale.

<!-- @portico:test-status:begin id=I-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:14.502Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test tests/llm-debug-monitor-cache-breakpoints.unit.test.js -- 0s
<!-- @portico:test-status:end -->
