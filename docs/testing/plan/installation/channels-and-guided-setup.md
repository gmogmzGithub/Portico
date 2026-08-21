# A.3 — Release channels and first-run guided setup

Three scenarios covering the build-channel switcher (Stable/Beta/Development/Custom) and the 9-screen first-run wizard.

- Up: [`docs/testing/plan/installation/README.md`](README.md).
- Source: [`electron-app/src/services/screen-*.unit.test.js`](../../../../electron-app/src/services).

---

## Scenarios

### A-16 — Switch release channel via menu seeds `UPDATE_CHANNEL` and rebuilds the menu

**Coverage:** Partial — [`release-channel-state.unit.test.js`](../../../../electron-app/src/services/release-channel-state.unit.test.js), [`release-channel-menu-regressions.unit.test.js`](../../../../electron-app/src/services/release-channel-menu-regressions.unit.test.js), and [`updates-cloudsmith.test.js`](../../../../electron-app/tests/updates-cloudsmith.test.js)
**Type:** Setup / Update
**Preconditions:**
- Packaged build running (channel switcher only renders for packaged builds).

**Steps:**
1. Open `Portico → Switch Release Channel → Custom...`.
2. Enter `team-alpha` and confirm.
3. Verify the disabled menu item reads `Release Channel: team-alpha` and
   `Custom...` is checked.
4. Reopen `Custom...`, edit the value, then cancel; verify the prior selection
   and checkmark remain unchanged.
5. Restart the app and inspect
   `~/portico/portico-managed/UPDATE_CHANNEL`.
6. Switch through Stable, Beta, and Development.

**Expected:**
- Custom remains ticked and the disabled item shows the custom slug.
- `UPDATE_CHANNEL` contains `portico_team-alpha` and survives restart.
- Stable removes `UPDATE_CHANNEL`; Beta and Development retain their existing
  package names.
- Auto-update polls now target the chosen channel's Cloudsmith repo.

**Fail indicators:**
- Channel reverts after relaunch.
- Cancel changes the active custom channel.
- `UPDATE_CHANNEL` mismatch.
- Auto-update still polls old channel.

<!-- @portico:test-status:begin id=A-16 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:58.478Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/tests/updates-cloudsmith.test.js -- 0s
<!-- @portico:test-status:end -->

---

### A-17 — First-run guided setup walks all 9 screens

**Coverage:** Auto — multiple [`screen-*.unit.test.js`](../../../../electron-app/src/services) files
**Type:** Setup / UX
**Preconditions:**
- Fresh install (post-`clean_full.sh`) — wizard auto-opens on first launch.

**Steps (regression-investigation only):**
1. Launch the app.
2. Walk through each screen in order: welcome → user → prereqs → VPN → servers → oauth → config → finalize → success.
3. At each screen, confirm the back button works and that screen-specific validations behave (e.g. VPN screen detects on-VPN status).

**Expected:**
- All 9 screens render in order.
- Back navigation works at each step.
- Final success screen lands you on the main shell with one chat tab.

**Fail indicators:**
- A screen is skipped or shown out of order.
- A back navigation step throws an error.

<!-- @portico:test-status:begin id=A-17 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-18 — Finalize blocks then unblocks correctly when prereqs change underneath

**Coverage:** Auto — [`screen-finalize.unit.test.js`](../../../../electron-app/src/services/screen-finalize.unit.test.js) (regression #58)
**Type:** Setup / UX
**Preconditions:**
- On the **Finalize** screen of guided setup.
- One prereq currently failing (e.g. VPN check off).

**Steps (regression-investigation only):**
1. Observe the Finalize button is disabled with an inline reason.
2. Resolve the failing prereq (turn VPN on / fix the missing dep).
3. Wait a few seconds without touching Finalize.

**Expected:**
- Button auto-unblocks once all prereqs pass — no need to re-navigate.

**Fail indicators:**
- Button stays disabled after prereqs pass — user has to back-out and re-enter.

<!-- @portico:test-status:begin id=A-18 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:08.741Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/screen-finalize.unit.test.js -- 0s
<!-- @portico:test-status:end -->
