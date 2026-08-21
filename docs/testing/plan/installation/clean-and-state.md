# A.2 — `clean_full.sh` and clean-state checks

Four scenarios verifying that uninstall/clean removes every persistent artifact: Docker resources, app bundle, Application Support state, runtime-secrets, OAuth tokens, Keychain entries, and trusted certificates.

- Up: [`docs/testing/plan/installation/README.md`](README.md).
- Source: [`clean_full.sh`](../../../../clean_full.sh).
- Cross-references: N-011 in [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md).

---

## Scenarios

### A-12 — `clean_full.sh` removes Docker resources, app bundles, AS state, runtime-secrets, OAuth tokens, and Keychain entries

**Coverage:** Partial — [`tests/clean-full.unit.test.js`](../../../../tests/clean-full.unit.test.js)
**Type:** Setup / Security
**Preconditions:**
- A previous install with at least one OAuth integration enabled (Slack recommended) so Keychain entries and OAuth tokens exist.

**Steps:**
1. Run `./clean_full.sh` and accept any prompts.
2. After completion, verify each surface:
   - `docker ps -a | grep portico` — should be empty.
   - `docker volume ls | grep portico` — empty.
   - `ls /Applications | grep -i portico` — empty.
   - `ls ~/Library/Application\ Support/portico 2>/dev/null` — empty / no such directory.
   - `security find-generic-password -s portico-llm-key 2>&1 | grep -q "could not be found"` — true (Keychain entry removed).
   - `find /tmp -maxdepth 2 -name 'portico-*' 2>/dev/null` — empty (no orphan token directories).

**Expected:** Every surface listed is empty.

**Fail indicators:**
- Any leftover Docker resource, app bundle, AS state, runtime-secrets, OAuth token, or Keychain entry.

<!-- @portico:test-status:begin id=A-12 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-13 — `clean_full.sh` removes trusted self-signed certificates from the login Keychain

**Coverage:** Manual (regression N-011)
**Type:** Setup / Security
**Preconditions:**
- A previous install that completed Slack OAuth (so a `CN=localhost` cert was added).

**Steps:**
1. Before running `clean_full.sh`, run:
   ```bash
   security find-certificate -a -c "localhost" ~/Library/Keychains/login.keychain-db | grep -c "localhost"
   ```
   Note the count (should be ≥1).
2. Run `./clean_full.sh`.
3. Re-run the same `security find-certificate` command.

**Expected:**
- Post-clean count is `0`.

**Fail indicators:**
- Orphan `CN=localhost` certificates remain — manifests as the next install's Slack OAuth showing "Connection is not private".

<!-- @portico:test-status:begin id=A-13 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-14 — `clean_full.sh --dry-run` lists planned actions and changes nothing

**Coverage:** Manual
**Type:** Setup
**Preconditions:**
- A previous install (so there is something to enumerate).

**Steps:**
1. Take a snapshot of state surfaces:
   ```bash
   docker ps -a > /tmp/clean_dryrun_pre.txt
   ls ~/Library/Application\ Support/portico >> /tmp/clean_dryrun_pre.txt
   ```
2. Run `./clean_full.sh --dry-run`.
3. Take the same snapshot to `/tmp/clean_dryrun_post.txt`.
4. `diff /tmp/clean_dryrun_pre.txt /tmp/clean_dryrun_post.txt`.

**Expected:**
- Dry-run output enumerates planned actions (containers to stop, files to remove).
- The diff is empty.

**Fail indicators:**
- Diff shows changes — dry-run actually mutated state.

<!-- @portico:test-status:begin id=A-14 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-15 — `clean_full.sh` does not restart OrbStack when no Docker artefacts exist

**Coverage:** Manual
**Type:** Setup
**Preconditions:**
- No prior Portico install (or `clean_full.sh` already ran).
- OrbStack running.

**Steps:**
1. Note OrbStack PID: `pgrep -f OrbStack`.
2. Run `./clean_full.sh` on the clean state.
3. Re-check `pgrep -f OrbStack`.

**Expected:**
- OrbStack PID is unchanged (not restarted).

**Fail indicators:**
- OrbStack PID changed (script restarted it unnecessarily).

<!-- @portico:test-status:begin id=A-15 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
