# L.3 — OAuth and tokens

Three scenarios for OAuth credential lifecycle: client-credential install-time embed, in-memory zeroize in Rust http_subprocess sessions, and loopback-only callback HTTPS bind.

- Up: [`docs/testing/plan/security/README.md`](README.md).
- Threats: N-007, N-009, N-010.

---

## Scenarios

### L-11 — Slack OAuth client credentials install-time embed; auto-scrub plaintext after Keychain (N-007)

**Coverage:** Auto — [`runtime-secrets-config.test.js`](../../../../electron-app/src/config/runtime-secrets-config.test.js)
**Type:** Security
**Preconditions:** Default install.

**Steps (regression-investigation only):**
1. Note that during install, Slack client credentials are temporarily embedded under runtime-secrets.
2. After Keychain is populated (post-OAuth), grep the runtime-secrets dir for plaintext `xoxb_`, `xoxp_`, or any literal Slack secret.
3. Run `node --test electron-app/src/config/runtime-secrets-config.test.js`.

**Expected:**
- Plaintext slack credentials are scrubbed once Keychain copies are established.
- Test passes.

**Fail indicators:**
- Plaintext literal persists post-Keychain.

<!-- @portico:test-status:begin id=L-11 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:13.420Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/runtime-secrets-config.test.js -- 1s
<!-- @portico:test-status:end -->

---

### L-13 — OAuth token file ingress + zeroize in Rust http_subprocess sessions (N-009)

**Coverage:** Auto — Rust `session_tests.rs` included as `session::tests` in `src/mcp-orc-rust/crates/mcp-orc/src/`
**Type:** Security
**Preconditions:** Rust toolchain installed.

**Steps (regression-investigation only):**
1. From `src/mcp-orc-rust/`, run `cargo test --package mcp-orc session::tests::` (or filter to the zeroize cases: `cargo test --package mcp-orc best_effort_zeroize_and_remove`).
2. Confirm tests assert that token bytes are zeroed before file removal (e.g. `best_effort_zeroize_and_remove_overwrites_before_unlink`).

**Expected:**
- Tests pass.
- Token bytes do not survive the session in process memory (drop impl uses `Zeroize`).

**Fail indicators:**
- Tests fail.
- Source uses plain `String` for tokens without `Zeroizing`.

<!-- @portico:test-status:begin id=L-13 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:38:17.460Z
- Build: pre-beta-tmp @ 2ea7155d-dirty
- Executor: odubo
- Notes: cargo test --package mcp-orc session::tests:: in src/mcp-orc-rust/ -- 25 passed; includes best_effort_zeroize_and_remove_overwrites_before_unlink
<!-- @portico:test-status:end -->

---

### L-14 — OAuth callback HTTPS server bound to `127.0.0.1` only (N-010)

**Coverage:** Auto — Rust OAuth and compose-generator tests in [`src/mcp-orc-rust/crates/mcp-orc`](../../../../src/mcp-orc-rust/crates/mcp-orc)
**Type:** Security
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `cargo test --manifest-path src/mcp-orc-rust/Cargo.toml --workspace`.
2. While an OAuth flow is running locally, run `lsof -iTCP -sTCP:LISTEN -P -n | grep <port>` and verify the bind address is `127.0.0.1`.

**Expected:**
- Test passes.
- Bind address is `127.0.0.1`, not `0.0.0.0`.

**Fail indicators:**
- Bind address `0.0.0.0` (LAN exposure).

<!-- @portico:test-status:begin id=L-14 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-15T00:00:00.000Z
- Build: legacy-stack-removal cleanup
- Executor: workbench
- Notes: Rust mcp-orc OAuth tests cover canonical callback ports, redirect URI sanitization, persisted client redirect cleanup, callback HTML rendering, and loopback-only generated compose bindings.
<!-- @portico:test-status:end -->
