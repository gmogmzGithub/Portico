# PORTICO-250: Seismic user-installed non-DCR OAuth investigation

Status snapshot: 2026-07-16

## Decision

PORTICO-250 is a real Portico defect, not an unresolved Seismic tenant, account, redirect-URI, or MCP configuration problem.

Indie implemented the intended fix on two MR source branches, but both MRs were closed without merging and neither release branch contains the fix:

- [`beta-latest` MR !175](https://example.invalid/portico/portico/-/merge_requests/175)
- [`pre-beta-tmp` MR !176](https://example.invalid/portico/portico/-/merge_requests/176)

The corrected `pre-beta-tmp` port is now implemented locally on `workbench/portico-250-seismic-oauth`. It includes the Seismic fix from MR !176 and preserves the host-broker behavior that the closed MR accidentally made unreachable. The remaining work is Dionny's review/ownership decision, commit and publication through the normal workflow, merge/promotion, and a real Seismic field retest. Dionny Santiago is the project owner/main author and should retain the merge and release decision.

## Current failure

The July 15 reproduction ran beta build `07072026-4d073bb9` (`4d073bb9165d67faa62ecc0714fd2f76601acf09`), recorded in:

- `<DOWNLOADS>/debug_logs_1784147872/build-info.json:2`

The manual OAuth flow is visible in `<DOWNLOADS>/debug_logs_1784147872/all-app-logs/app-2026-07-15.log`:

- `347064`: manual OAuth starts for `seismic-mcp`.
- `347175`: the wizard clears the previous token/client state.
- `347184` and `347194`: it starts the single-server stack with callback port `3836`.
- `347385`: it opens the Seismic authorization page at `20:22:22.967Z`.
- `347403`, `347436`, `347438`, and `347443`: it polls for completion in two-second windows.
- `347539`-`347549`: at `20:22:31.171Z`, it fails with `OAuth token validation could not find usable persisted tokens`.
- `347817`-`347827`: it stops the single-server stack.

The companion OAuth log, `<DOWNLOADS>/debug_logs_1784147872/all-app-logs/oauth-2026-07-15.log`, supplies the decisive protocol detail:

- `112547`: the generated Seismic authorization URL asks for only `scope=seismic.mcp`; `offline_access` is absent.
- `112561`: post-authorization token validation reports that it cannot find usable persisted tokens.

The managed container then continues indefinitely in the missing/invalid-token preconnect state in `<DOWNLOADS>/debug_logs_1784147872/docker/mcpo-seismic-mcp.log`.

The debug bundle does **not** contain an explicit callback-receipt line. The stronger conclusion that the callback and authorization-code exchange completed comes from the subsequent code-path analysis: the internal engineering thread corrects the first timeout theory and notes that this validation error is emitted only after `handle_callback` succeeds, saves the exchanged token, and `reload_oauth_tokens` rejects it. This is also the final root-cause statement in Jira comment `17828133`.

## Root cause

The final diagnosis is:

1. Seismic advertises `offline_access`, but PORTICO's user-installed public non-DCR request asks only for `seismic.mcp`.
2. Seismic returns an access token whose JWT audience representation does not match PORTICO's canonical protected-resource URL.
3. Without a durable refresh token, strict fail-closed startup validation cannot recover the token and reports that no usable persisted token exists.
4. The wizard surfaces that validation failure and tears down the single-server stack.

The early statement that the callback listener merely timed out after roughly ten seconds was an interim diagnosis. It appears at `<HOME>/.workbench/attachments/a1df09f6-997d-4c3b-8cc1-8ddb98fa5b2f/pasted-text.txt:199`. The later and more specific diagnosis at line `201`, Jira comment `17828133`, and the internal engineering thread supersede it: the validation failure is post-callback, and the missing durable-refresh permission is the initiating defect.

## What is already ruled out

These were real historical blockers, but they are not the remaining PORTICO-250 defect:

- **Tenant/MCP enablement:** the email thread confirms the Seismic tenant and app path were enabled.
- **User entitlement:** `<DOWNLOADS>/image (3).png` shows the earlier Okta assignment failure; the email thread records that Zac was later added.
- **Redirect URI:** `<DOWNLOADS>/image (2).png` shows the earlier invalid redirect; both `http://localhost:3834/callback` and `http://localhost:3836/callback` were subsequently registered.
- **OAuth discovery/config:** RFC 9728 discovery succeeds, the public non-DCR client is recognized, and the browser opens. The effective configuration is in `<DOWNLOADS>/debug_logs_1784147872/mcp-configs-user/seismic-mcp/seismic-mcp.fragment` and `seismic-mcp.yaml`.
- **Seismic API/token acquisition:** Zac reports that a manually obtained authorization-code + PKCE token exposes all 20 tools. This appears in the attached conversation at line `3` and in the email PDF on pages 11-12.
- **PORTICO-202/PORTICO-247-era failures:** the June callback-stack and authorization-URL-probe failures occurred at earlier stages. The July reproduction gets past those stages and fails during token validation.

The screenshot `<DOWNLOADS>/image (4).png` corroborates the same user-visible terminal error after server startup, URL generation, and browser opening. The other images are earlier setup-state evidence or the Seismic integration logo.

## Implemented fix and review focus

MR !175 contains four commits on `beta-latest`:

- `2286040d` - request Seismic offline access
- `7b045368` - cover callback refresh persistence
- `3d18d037` - serialize OAuth token refresh
- `706eb464` - serialize unauthorized token refresh

Its change is limited to:

- `src/mcp-orc-rust/crates/mcp-orc/src/oauth/binding.rs`
- `src/mcp-orc-rust/crates/mcp-orc/src/oauth/binding_tests.rs`

The production change adds `offline_access` only when all of the following hold: non-DCR OAuth, a public client with no secret, exact HTTPS Seismic authorization/token endpoints, exact HTTPS Seismic transport/effective-resource hosts, and metadata that advertises `offline_access`. It leaves stored-token scope requirements and strict startup validation intact. It also serializes proactive and 401-driven refreshes and reloads persisted state under the same lock so rotating refresh tokens are not redeemed twice.

MR !176 was the `pre-beta-tmp` port plus a pre-beta test adaptation. The Jira final comment records focused Rust tests, the canonical `./run-tests.sh`, and both CI pipelines as green. The internal Glean-indexed engineering thread reports the same validation outcome. Because the MR is closed and not merged, its production and test changes have now been ported onto current `origin/pre-beta-tmp` in the local `workbench/portico-250-seismic-oauth` branch.

### Closed MR !176 regression corrected in this branch

The pre-beta port is not yet behaviorally equivalent to its target branch. At MR !176 head `003120e9`, `OAuthBinding::access_token()` performs an initial fast-path token lookup and immediately returns `Ok(None)` when no local token status exists (`binding.rs:786-791` at that revision). The existing `pre-beta-tmp` implementation instead calls `access_token_from_broker(false)` in that state when the host OAuth access-token broker is configured (`binding.rs:773-780` at local base `380d85ca`). MR !176 retains a broker fallback after acquiring `refresh_lock`, but the new early return makes that fallback unreachable for the missing-local-state case.

This can break broker-backed OAuth token vending after in-memory/local token state is absent or cleared. The fallback was intentionally added by Dionny in `d95e2daf` with the stated purpose of handling expired/missing local tokens. The new tests cover an expired broker-seeded token, but not a configured broker with no local token record, so the reported green suites do not disprove the regression.

The local implementation corrects this before handoff:

- The missing-local-token path reaches the broker fallback under the refresh lock and recheck discipline.
- `broker_vends_access_token_when_local_record_is_missing` verifies `broker configured + no local token -> broker is called with force_refresh=false and its token is returned/persisted`.
- The focused Rust tests, full `mcp-orc` library suite, and canonical `./run-tests.sh` pass after the correction.

MR !175 does not contain the pre-beta host-broker architecture, so this specific blocker does not apply to !175.

Review should therefore concentrate on these invariants:

- The Seismic exception remains narrowly pinned to HTTPS, exact provider hosts, a public non-DCR client, and advertised scope support.
- No audience-validation bypass or generalized token-acceptance weakening is introduced.
- Both refresh entry points share the lock and reload persisted state before redeeming a rotating token.
- Negative allowlist, callback persistence, and concurrent refresh cases remain covered.
- MR !176 preserves the target branch's missing-local-token broker fallback as well as the intended Seismic behavior.

## Required action

1. Guillermo shares `workbench/portico-250-seismic-oauth` and this analysis with Dionny for owner review. The two Indie MRs are useful provenance, but neither is an active merge vehicle.
2. Commit/push the corrected port and open or revive the normal review vehicle with Dionny's ownership preserved.
3. Dionny/the agreed release owner decides merge and promotion. The local canonical gate is green; CI must still run on the published review branch.
4. Once a build contains the fix, Zac retries **Control Plane -> Seismic -> Authenticate**.
5. Confirm in fresh logs that `offline_access` was requested, a durable refresh token was saved, startup validation succeeds, and the managed Seismic server exposes its tools after restart.
6. If the field retest passes, update/close [PORTICO-250](https://portico.atlassian.net/browse/PORTICO-250) and promote this draft to `docs/incidents/2026-07-seismic-mcp-oauth.md`. If it fails, attach a new debug bundle from the fixed build before changing the design.

There is no reliable workaround on the affected build. Pre-seeding access or refresh tokens in `credentials_source` is unsupported and should not be presented as a supported path.

## Coordination state

At the time of inspection, [PORTICO-250](https://portico.atlassian.net/browse/PORTICO-250) is still `Pending Triage`, unassigned, priority `Minor`, even though the final Jira comment says the fix is ready for review. Both referenced MRs are closed and unmerged. That workflow state should be reconciled when Dionny confirms the replacement review vehicle and ownership.

Remote Git evidence captured on 2026-07-16:

- `beta-latest`: `3ec3290e229306b8c25ff3ca470bfbb2d9fb378c`
- MR !175 head: `706eb4649e652732443b09d22938351ddc6d8e22`
- `pre-beta-tmp`: `02aa97ff11bd441f89be3a1bd070d55a092d9358`
- MR !176 head: `003120e9bda4f8c1ab430a321f11732b97fd77ce`
- `git merge-base --is-ancestor` returned false for each MR-head/release-branch pair.

## Sources and method

Primary sources:

- [PORTICO-250](https://portico.atlassian.net/browse/PORTICO-250), read with `acli jira workitem view PORTICO-250 --fields ... --json`; relevant comments are `17827301` and `17828133`.
- [Origin Slack thread](https://portico-pte.slack.com/archives/C097UGSK8JZ/p1781653019726829?thread_ts=1781653019.726829&cid=C097UGSK8JZ), also supplied as `<HOME>/.workbench/attachments/a1df09f6-997d-4c3b-8cc1-8ddb98fa5b2f/pasted-text.txt`.
- [Internal engineering thread](https://portico.enterprise.slack.com/archives/C0AR5NMQ659/p1784149010976849?thread_ts=1784149010.976849&cid=C0AR5NMQ659), found through Glean searches for `PORTICO-250` and `Seismic MCP OAuth`. Glean's document reader returned indexed snippets rather than a rich document, so claims from it are limited to the returned thread text.
- `<DOWNLOADS>/debug_logs_1784147872/`, inspected with targeted `rg -n` searches and direct JSON/config reads. Secrets were redacted and are not reproduced here.
- `<DOWNLOADS>/Portico Mail - Request to Enable MCP in Our Seismic Tenant.pdf`, extracted with the bundled `pdfplumber` runtime and visually checked after Poppler rendering on pages 1, 12, and 13.
- `<DOWNLOADS>/image.png` through `<DOWNLOADS>/image (4).png`, visually inspected.
- Git remote refs and the fetched MR objects, inspected with `git ls-remote`, `git merge-base --is-ancestor`, `git log`, and `git diff --stat` without changing tracked worktree files.

Evidence hierarchy used here:

1. Raw July debug logs and effective config
2. Current source/MR diffs and remote branch ancestry
3. Final Jira root-cause comment and internal engineering correction
4. Slack conversation, screenshots, and Seismic email history for chronology and corroboration
