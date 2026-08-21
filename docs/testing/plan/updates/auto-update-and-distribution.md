# K — Auto-update & distribution

Ten scenarios for auto-update polling, manual install flows, prep-script behavior, error surfacing, channel switching, DMG/Gatekeeper, and Cloudsmith token policy.

- Up: [`docs/testing/plan/updates/README.md`](README.md).

---

## Scenarios

### K-01 — Auto-update poll detects a newer Cloudsmith build on the active channel

**Coverage:** Auto — [`updates-cloudsmith.test.js`](../../../../electron-app/tests/updates-cloudsmith.test.js)
**Type:** Update
**Preconditions:** Packaged build running an older version than the latest Cloudsmith build on the active channel.

**Steps:**
1. Launch the app and let the auto-update poll run.
2. Wait for the update banner to appear.

**Expected:**
- Within the configured polling cycle, an update banner appears.
- Banner shows the new version number and channel.

**Fail indicators:**
- No banner.
- Banner refers to wrong channel.

<!-- @portico:test-status:begin id=K-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:58.551Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/tests/updates-cloudsmith.test.js -- 0s
<!-- @portico:test-status:end -->

---

### K-02 — Manual "Check for Updates…" forces a poll

**Coverage:** Auto — [`updates-cloudsmith.test.js`](../../../../electron-app/tests/updates-cloudsmith.test.js)
**Type:** Update
**Preconditions:** Packaged build.

**Steps:**
1. Click `Help → Check for Updates…`.

**Expected:**
- A poll runs immediately.
- A "checking..." indicator briefly appears.
- Either an update banner or "you're up to date" message.

**Fail indicators:**
- Click does nothing.
- Indicator never resolves.

<!-- @portico:test-status:begin id=K-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:58.624Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/tests/updates-cloudsmith.test.js -- 0s
<!-- @portico:test-status:end -->

---

### K-03 — "Reinstall Latest Build…" downloads + applies the latest build

**Coverage:** Auto — [`update-preparation.test.js`](../../../../electron-app/src/services/update-preparation.test.js)
**Type:** Update
**Preconditions:** Packaged build; you can tolerate a reinstall.

**Steps:**
1. Click `Help → Reinstall Latest Build…`.
2. Confirm prompt.
3. Wait for the app to relaunch.

**Expected:**
- App downloads the latest build for the current channel.
- App relaunches.
- Tabs/state preserved.

**Fail indicators:**
- Download fails silently.
- Relaunched into the previous version (silent failure).

<!-- @portico:test-status:begin id=K-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:59.506Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/update-preparation.test.js -- 1s
<!-- @portico:test-status:end -->

---

### K-04 — "Install Specific Build…" lets the user pick a build by hash and applies it

**Coverage:** Auto — [`update-preparation.test.js`](../../../../electron-app/src/services/update-preparation.test.js)
**Type:** Update
**Preconditions:** Packaged build; a known-good prior build hash or version available on Cloudsmith.

**Steps:**
1. Click `Help → Install Specific Build…`.
2. Paste/select a known build identifier.
3. Confirm.

**Expected:**
- Specific build is fetched and applied.
- App relaunches into that build.

**Fail indicators:**
- Picker accepts an invalid hash and falls through silently.

<!-- @portico:test-status:begin id=K-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:59.581Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/update-preparation.test.js -- 1s
<!-- @portico:test-status:end -->

---

### K-05 — Prepare-update script refuses staging inside the managed app directory

**Coverage:** Auto — [`update-preparation.test.js`](../../../../electron-app/src/services/update-preparation.test.js)
**Type:** Update / Security
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `node --test electron-app/src/services/update-preparation.test.js`.
2. Inspect the test for the assertion that prep refuses to stage inside `/Applications/Portico.app`.

**Expected:**
- Test passes.
- Staging path is forced to a tmp dir.

**Fail indicators:**
- Staging path inside the managed app directory.

<!-- @portico:test-status:begin id=K-05 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:59.664Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/update-preparation.test.js -- 1s
<!-- @portico:test-status:end -->

---

### K-06 — Update progress shows machine-readable `backup`/`download`/`extract`/`ready` markers

**Coverage:** Auto — [`update-preparation.test.js`](../../../../electron-app/src/services/update-preparation.test.js)
**Type:** Update
**Preconditions:** A reinstall in progress (K-03).

**Steps:**
1. Tail the update output (UI progress + `~/Library/Logs/portico/main.log`).
2. Look for the markers: `backup`, `download`, `extract`, `ready`.

**Expected:**
- All four markers appear in order.

**Fail indicators:**
- A marker is missing.
- Markers appear out of order.

<!-- @portico:test-status:begin id=K-06 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:59.739Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/update-preparation.test.js -- 1s
<!-- @portico:test-status:end -->

---

### K-07 — Update failure surfaces the *real* prep-script error

**Coverage:** Auto — [`update-failure-message.test.js`](../../../../electron-app/src/services/update-failure-message.test.js)
**Type:** Update
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Force a prep-script failure via the test fixture.
2. Inspect the user-visible error message.

**Expected:**
- User-visible error string contains the underlying prep-script error.
- No generic "exit code 1" only.

**Fail indicators:**
- UI shows generic exit code only.
- Real cause hidden.

<!-- @portico:test-status:begin id=K-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:52:00.247Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/update-failure-message.test.js -- 0s
<!-- @portico:test-status:end -->

---

### K-08 — Channel switch (Stable → Beta) immediately re-evaluates available updates

**Coverage:** Partial — [`updates-cloudsmith.test.js`](../../../../electron-app/tests/updates-cloudsmith.test.js)
**Type:** Update
**Preconditions:** Packaged build on Stable; a different version available on Beta.

**Steps:**
1. Switch to Beta via `Help → Channel → Beta`.
2. Wait for the auto-update poll or click `Check for Updates…`.

**Expected:**
- Update banner now refers to a Beta build.
- Stale Stable target is dropped.

**Fail indicators:**
- Update poll still references Stable.

<!-- @portico:test-status:begin id=K-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:58.704Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/tests/updates-cloudsmith.test.js -- 0s
<!-- @portico:test-status:end -->

---

### K-09 — Release ZIP round-trip and DMG preserve signatures/notarization

**Coverage:** Manual (release CI)
**Type:** Update / Security
**Preconditions:** A freshly produced release payload ZIP and DMG; testing on a Mac that has not run the build before.

**Steps:**
1. Run `release_build.sh <payload.zip> --channel <channel> --dry-run`; confirm final ZIP validation succeeds.
2. Extract the payload with `/usr/bin/ditto -x -k <payload.zip> <temporary-directory>`.
3. Run `codesign --verify --deep --strict` for both extracted app architectures.
4. Validate the extracted app and DMG notarization tickets with `xcrun stapler validate`.
5. Double-click the native DMG, drag the app to `/Applications`, and launch it.
6. Run `spctl --assess --type execute /Applications/Portico\ AI\ Chat.app` and `codesign -dvvv /Applications/Portico\ AI\ Chat.app`.

**Expected:**
- DMG mounts.
- Both app bundles remain valid after the release ZIP round trip.
- App and DMG notarization tickets validate.
- App launches.
- `spctl` reports `accepted`.
- `codesign` reports a valid Developer ID and notarization timestamp.

**Fail indicators:**
- Gatekeeper warning ("can't be opened because it is from an unidentified developer").
- Extracted payload app reports `invalid signature` or loses AppleDouble metadata.
- `spctl` reports rejection.
- `codesign` shows missing or invalid signature.

<!-- @portico:test-status:begin id=K-09 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### K-10 — Cloudsmith read-token is provisioned in packaged builds; upload-token is NOT present (N-005)

**Coverage:** Auto — [`cloudsmith-config.test.js`](../../../../electron-app/src/config/cloudsmith-config.test.js)
**Type:** Update / Security
**Preconditions:** Packaged build at hand.

**Steps (regression-investigation only):**
1. Inspect the packaged ASAR / app resources for any Cloudsmith token strings.
2. Run `node --test electron-app/src/config/cloudsmith-config.test.js`.

**Expected:**
- Read token (with read-only scope) is bundled.
- Upload token is NOT bundled.
- Test passes.

**Fail indicators:**
- Upload token bundled (N-005 regression).

<!-- @portico:test-status:begin id=K-10 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:38.743Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/config/cloudsmith-config.test.js -- 0s
<!-- @portico:test-status:end -->
