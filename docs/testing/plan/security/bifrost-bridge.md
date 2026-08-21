# L.2 — Bifrost bridge

Two scenarios for the LLM bridge bearer flow.

- Up: [`docs/testing/plan/security/README.md`](README.md).
- Threats: V-002, V-005.

---

## Scenarios

### L-02 — Bifrost bearer auth uses constant-time compare (V-002)

**Coverage:** Auto — Rust unit tests in [`src/bifrost-bridge-rust/`](../../../../src/bifrost-bridge-rust)
**Type:** Security
**Preconditions:** Rust toolchain installed.

**Steps (regression-investigation only):**
1. From `src/bifrost-bridge-rust/`, run `cargo test`.
2. Verify the bearer-compare tests reference `subtle::ConstantTimeEq`.

**Expected:**
- All Rust tests pass.
- No raw `==` comparison on the bearer slice in source.

**Fail indicators:**
- Tests fail.
- Source contains raw `==` on the bearer.

<!-- @portico:test-status:begin id=L-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.417Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: cargo test in src/bifrost-bridge-rust/ -- 106 passed; 0 failed; src/main.rs uses subtle::ConstantTimeEq for bearer compare
<!-- @portico:test-status:end -->

---

### L-05 — Bridge bearer key persisted in Keychain only (V-005)

**Coverage:** Auto — [`runtime-secrets-config.test.js`](../../../../electron-app/src/config/runtime-secrets-config.test.js)
**Type:** Security
**Preconditions:** Default install completed.

**Steps (regression-investigation only):**
1. Confirm one Keychain entry: `security find-generic-password -s portico-bridge-bearer`.
2. Confirm no plaintext bearer string in `~/Library/Application Support/portico/runtime-secrets.env`.
3. Confirm Docker compose mounts the `_FILE` pointer (Docker secret) for the bearer rather than embedding it as an env var.

**Expected:**
- Keychain entry exists.
- No plaintext on disk.
- Compose mount uses Docker secret.

**Fail indicators:**
- Plaintext bearer in any state file.
- Multiple Keychain entries.

<!-- @portico:test-status:begin id=L-05 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:13.338Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-config.test.js -- 1s
<!-- @portico:test-status:end -->
