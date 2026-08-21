# L.4 — Cert trust & cleanup

Three scenarios covering the self-signed-cert lifecycle (creation, trust, removal) and the post-uninstall Keychain audit.

- Up: [`docs/testing/plan/security/README.md`](README.md).
- Threats: N-008, N-011.

---

## Scenarios

### L-12 — Single-server SSL: cert in user cache, narrow EKU, loopback bind, idempotent re-trust (N-008)

**Coverage:** Partial — [`start-single-mcp-server.sh`](../../../../src/scripts/start-single-mcp-server.sh) (manual cert-trust verify)
**Type:** Security
**Preconditions:** A successful Slack OAuth (P0-04) which exercised the cert-trust path.

**Steps:**
1. Locate the cert: `ls ~/Library/Caches/portico/certs/` — confirm cert exists in user cache dir.
2. Inspect EKU: `openssl x509 -in <cert> -noout -text | grep -A2 "Extended Key Usage"` — confirm narrow EKU (e.g. `serverAuth` only).
3. Run a second OAuth flow on the same machine — confirm cert is re-used (no second cert added) — idempotent re-trust.
4. Confirm the local HTTPS callback binds to `127.0.0.1`: `lsof -iTCP -sTCP:LISTEN -P -n | grep <port>`.

**Expected:**
- Cert lives only in user cache dir (not system Keychain proper for ops).
- EKU narrow.
- Loopback bind only.
- Idempotent re-trust on subsequent flows.

**Fail indicators:**
- New cert added per flow.
- Bind on `0.0.0.0`.
- Wide EKU.

<!-- @portico:test-status:begin id=L-12 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:45:43.066Z
- Build: pre-beta-tmp @ dba0c0e9
- Executor: odubo
- Notes: Cert at ~/Library/Caches/portico/single-server-ssl/oauth.crt (user cache, 0644 file in 0700 dir). EKU narrow: 'TLS Web Server Authentication' only; KU: critical Digital Signature + Key Encipherment; SAN: localhost + 127.0.0.1; basicConstraints CA:FALSE. Idempotent re-trust verified: only one CN=localhost cert in login.keychain-db, SHA-1 8f3c8bd5e85096caf6cd51d961921d84fb62fa8b matches both .cert.sha1 and openssl fingerprint; ensure_single_server_https_cert sets need_generate=0 when cert exists, only re-runs add-trusted-cert (idempotent no-op). Loopback bind verified via start-single-mcp-server.sh: 127.0.0.1:3838:3838, 127.0.0.1:HOST_PORT:80, 127.0.0.1:CALLBACK_HOST_PORT:3834 (PORTICO-68 / F6 comments). add-trusted-cert uses -k login.keychain-db (user, never system) and -p ssl -p basic (TLS server only).
<!-- @portico:test-status:end -->

---

### L-15 — `clean_full.sh` sweeps Slack Keychain entries + orphan `CN=localhost` certs + token dirs + logs (N-011)

**Coverage:** Manual
**Type:** Security
**Preconditions:** A previous install that completed Slack OAuth (so Keychain entries, certs, token dirs, and logs all exist).

**Steps:**
1. Snapshot pre-clean state:
   - `security find-generic-password -s portico-slack-token` should return one entry.
   - `security find-certificate -a -c "localhost" ~/Library/Keychains/login.keychain-db | grep -c "localhost"` should be ≥1.
   - `find /tmp -maxdepth 2 -name 'portico-*'` should list one or more directories.
   - `ls ~/Library/Logs/portico/` should be non-empty.
2. Run `./clean_full.sh`.
3. Re-run all the above; each should be empty.

**Expected:**
- Post-clean snapshot is empty for every surface.

**Fail indicators:**
- Any leftover entry.

<!-- @portico:test-status:begin id=L-15 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:48:58.197Z
- Build: pre-beta-tmp @ 8741a351
- Executor: odubo
- Notes: Historical pre-PKCE run: Pre-clean snapshot (login.keychain-db): CN=localhost certs and app-managed Keychain entries present; runtime-secrets dir was 0700 with 0600 files. Ran ./clean_full.sh --yes. Post-clean: 0 CN=localhost certs in keychain, 0 /tmp/portico-* dirs, logs/cache/Application Support removed, and Slack token state absent. Current Slack OAuth no longer creates localhost certs or Slack client-secret Keychain entries; legacy Slack client credential accounts remain cleanup-only.
<!-- @portico:test-status:end -->

---

### L-17 — After uninstall: no Keychain entries owned by `portico-*` remain

**Coverage:** Manual
**Type:** Security
**Preconditions:** A fully completed install with at least one OAuth and one token-based integration; then `clean_full.sh` ran.

**Steps:**
1. Run `security dump-keychain ~/Library/Keychains/login.keychain-db | grep -c portico`.

**Expected:**
- Result is `0`.

**Fail indicators:**
- Result > 0 — list the entries via `security find-generic-password -s <service>` and clean up manually before next test pass.

<!-- @portico:test-status:begin id=L-17 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-07T08:52:42.503Z
- Build: pre-beta-tmp @ 8741a351-dirty
- Executor: odubo
- Notes: After patching clean_full.sh step 5 to also sweep 'portico Safe Storage' Keychain entries (Electron safeStorage encryption keys), security dump-keychain ~/Library/Keychains/login.keychain-db | grep -c portico now returns 0.
<!-- @portico:test-status:end -->
