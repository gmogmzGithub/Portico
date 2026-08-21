# L.1 — Runtime secrets registry

Four scenarios covering the runtime-secrets resolution chain, log scrubbing, and project-root plaintext-twin guard.

- Up: [`docs/testing/plan/security/README.md`](README.md).
- Threats: V-001, V-003, V-007, N-004 (see [`hardening-overview.md`](../../../security/hardening-overview.md)).

---

## Scenarios

### L-01 — `PORTICO_LLM_API_KEY` fetched from Vault when available; never plaintext on disk (V-001)

**Coverage:** Auto — [`vault-llm-key.test.js`](../../../../electron-app/src/services/vault-llm-key.test.js)
**Type:** Security
**Preconditions:** Default install on corporate network with Vault reachable.

**Steps (regression-investigation only):**
1. Inspect `~/Library/Application Support/portico/runtime-secrets.env` — should contain `_FILE` pointers, no plaintext literals.
2. `grep -r "PORTICO_LLM_API_KEY=[A-Za-z0-9]" ~/Library/Application\ Support/portico` — empty.
3. Test source: `node --test electron-app/src/services/vault-llm-key.test.js`.

**Expected:**
- No plaintext literal of the LLM API key on disk.
- Vault path used when available.

**Fail indicators:**
- Plaintext key detected in any state file.

<!-- @portico:test-status:begin id=L-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:00.442Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/vault-llm-key.test.js -- 0s
<!-- @portico:test-status:end -->

---

### L-03 — Runtime-secrets registry strips `_FILE` aliases from logs / .env (V-003)

**Coverage:** Auto — [`runtime-secrets-hardening.unit.test.js`](../../../../electron-app/src/config/runtime-secrets-hardening.unit.test.js)
**Type:** Security
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. From `electron-app/`, run `node --test src/config/runtime-secrets-hardening.unit.test.js`.
2. Manually: `tail ~/Library/Logs/portico/main.log` for `_FILE` lines.

**Expected:**
- Test passes.
- Log files contain no `_FILE=` alias entries (only the resolved values, which are themselves redacted in logs).

**Fail indicators:**
- `_FILE` aliases leak into logs.

<!-- @portico:test-status:begin id=L-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:12.536Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-hardening.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### L-06 — Portico LLM API key install-time embed (legacy fallback) (V-007)

**Coverage:** Auto — [`runtime-secrets-config.test.js`](../../../../electron-app/src/config/runtime-secrets-config.test.js)
**Type:** Security
**Preconditions:** Default install where Vault is unavailable.

**Steps (regression-investigation only):**
1. Force the V-007 chain to fall through to the install-time embed branch.
2. Inspect resulting on-disk state — should be `_FILE` pointer to a `0600` file in the runtime-secrets dir.
3. Confirm the embed gets auto-scrubbed once a Keychain copy is established.

**Expected:**
- Install-time embed becomes the V-007 fallback branch.
- Plaintext is scrubbed after Keychain population.

**Fail indicators:**
- Plaintext literal persists after Keychain step.

<!-- @portico:test-status:begin id=L-06 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:13.502Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-config.test.js -- 1s
<!-- @portico:test-status:end -->

---

### L-09 — Project-root plaintext twins of secrets are ignored at runtime (N-004)

**Coverage:** Auto — [`runtime-secrets-hardening.unit.test.js`](../../../../electron-app/src/config/runtime-secrets-hardening.unit.test.js)
**Type:** Security
**Preconditions:** A developer placed a `.env` file in the project root with literal secrets (simulating a leak).

**Steps (regression-investigation only):**
1. Touch `PORTICO_LLM_API_KEY=fakefakefake` into a project-root `.env`.
2. Re-launch via `npm start`.
3. Verify the running app does NOT use the project-root `.env` value.

**Expected:**
- Runtime registry ignores project-root plaintext twins.
- Vault / Keychain / install-time embed wins.

**Fail indicators:**
- App used the project-root `.env` value.

<!-- @portico:test-status:begin id=L-09 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:12.633Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-hardening.unit.test.js -- 0s
<!-- @portico:test-status:end -->
