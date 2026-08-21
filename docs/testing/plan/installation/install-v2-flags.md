# A.1 — `install_v2.sh` flag matrix

Eleven scenarios exercising each of the supported `install_v2.sh` invocation flags. Most are manual because they require a real macOS host and a real Docker daemon; the unit-tested ones are noted explicitly.

- Up: [`docs/testing/plan/installation/README.md`](README.md).
- Source: [`install_v2.sh`](../../../../install_v2.sh).

---

## Scenarios

### A-01 — `install_v2.sh` (no flags) installs Bifrost stack + advanced config and launches

**Coverage:** Partial — [`docker-mcp-regressions.test.js`](../../../../electron-app/src/services/docker-mcp-regressions.test.js)
**Type:** Setup / Install
**Preconditions:**
- Repo cloned at a known path.
- OrbStack/Docker running.
- Either prior install removed via `clean_full.sh` or fresh machine.

**Steps:**
1. Run `./install_v2.sh` from the repo root.
2. Wait for the script to finish (it auto-launches the app at the end).

**Expected:**
- The Bifrost gateway container is selected (not Bifrost bridge).
- The advanced compose stack (`docker-compose.advanced.yml`) is in use.
- The packaged app launches with no error toast.

**Fail indicators:**
- Bifrost bridge-related containers appear in `docker ps` after install.
- App fails to launch.

<!-- @portico:test-status:begin id=A-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:11.667Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/docker-mcp-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### A-02 — `install_v2.sh --no-launch` builds without launching

**Coverage:** Manual
**Type:** Setup / Install
**Preconditions:** Same as A-01.

**Steps:**
1. Run `./install_v2.sh --no-launch`.
2. After the script exits, run `ls /Applications/Portico\ AI\ Chat.app` to confirm the bundle exists.
3. Run `pgrep -f "Portico"` and confirm no process is running.

**Expected:**
- Bundle is present in `/Applications`.
- No app process is running.
- `pgrep` returns empty.

**Fail indicators:**
- App launches anyway.
- Bundle missing.

<!-- @portico:test-status:begin id=A-02 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-03 — `install_v2.sh --skip-deps` rebuilds Electron only

**Coverage:** Manual
**Type:** Setup / Install
**Preconditions:**
- A previous successful install.
- Docker / MCP containers already up.

**Steps:**
1. Touch a file under `electron-app/src/` to invalidate Electron build cache.
2. Run `./install_v2.sh --skip-deps`.
3. Compare timestamps of running Docker MCP containers before/after via `docker ps --format '{{.Names}} {{.Status}}'`.

**Expected:**
- Electron app rebuilds and relaunches.
- Docker MCP containers' `Status` (uptime) is unchanged — they were not restarted.

**Fail indicators:**
- Docker containers were torn down and recreated.

<!-- @portico:test-status:begin id=A-03 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-04 — `install_v2.sh --node` runs local dev build via `npm`

**Coverage:** Manual
**Type:** Setup / Dev
**Preconditions:** Node + npm installed; repo cloned.

**Steps:**
1. Run `./install_v2.sh --node`.
2. Observe terminal output.

**Expected:**
- Script invokes `npm install` and then `npm start` (or equivalent local dev launch).
- App starts via Electron-CLI in dev mode (DevTools menu visible).

**Fail indicators:**
- Script tries to build a `.app` bundle.
- App starts in packaged mode (no DevTools menu).

<!-- @portico:test-status:begin id=A-04 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-05 — `install_v2.sh --legacy` boots the Python MCP stack + Bifrost bridge gateway

**Coverage:** Manual
**Type:** Setup / Legacy
**Preconditions:** Same as A-01.

**Steps:**
1. Run `./install_v2.sh --legacy`.
2. After install, run `docker ps` and confirm Bifrost bridge container is present and healthy.
3. Send a chat message and verify it routes through Bifrost bridge (check `~/Library/Logs/portico/main.log` for `llm-gateway`).

**Expected:**
- Legacy stack boots; chat routing succeeds.

**Fail indicators:**
- Bifrost containers also present (mode confusion).
- Chat routing fails.

<!-- @portico:test-status:begin id=A-05 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-06 — `install_v2.sh --no-cache` rebuilds Docker images without cache

**Coverage:** Manual
**Type:** Setup / Docker
**Preconditions:** Existing image cache (a previous install or pull).

**Steps:**
1. Note the time the script starts.
2. Run `./install_v2.sh --no-cache`.
3. Observe Docker build output for `CACHED` lines.

**Expected:**
- Docker build output contains no `CACHED` lines.
- Total install time is meaningfully longer than a normal `install_v2.sh`.

**Fail indicators:**
- Docker output shows `CACHED` for any layer.

<!-- @portico:test-status:begin id=A-06 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-07 — `install_v2.sh --force-no-host` forces `HOST_MODE=FALSE`

**Coverage:** Auto — [`host-mode-state.test.js`](../../../../electron-app/src/services/host-mode-state.test.js)
**Type:** Setup
**Preconditions:** Repo cloned; you can run unit tests.

**Steps (regression-investigation only):**
1. Run `cd electron-app && node --test src/services/host-mode-state.test.js`.
2. For a manual smoke run: `./install_v2.sh --force-no-host`, then inspect `~/Library/Application Support/portico/runtime-state.json` for `HOST_MODE: "FALSE"`.

**Expected:**
- Test file passes 100%.
- Manual: state file shows `HOST_MODE=FALSE`.

**Fail indicators:**
- `HOST_MODE` is `TRUE` after install.

<!-- @portico:test-status:begin id=A-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:09.203Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/host-mode-state.test.js -- 1s
<!-- @portico:test-status:end -->

---

### A-08 — `install_v2.sh --force-local-build` skips Harbor pull and builds locally

**Coverage:** Manual
**Type:** Setup
**Preconditions:** Network access to Harbor (so the default path would have used Harbor).

**Steps:**
1. Run `./install_v2.sh --force-local-build`.
2. Observe install log for absence of `Pulling from harbor.example.invalid/...` lines.

**Expected:**
- No Harbor pulls in the log.
- Local Dockerfile builds run for every image.

**Fail indicators:**
- Log shows Harbor pulls.

<!-- @portico:test-status:begin id=A-08 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-09 — `install_v2.sh --mac-all-arch` produces both x64 and arm64 builds

**Coverage:** Manual
**Type:** Setup / Distribution
**Preconditions:** Mac with sufficient disk space.

**Steps:**
1. Run `./install_v2.sh --mac-all-arch`.
2. After completion, list `electron-app/dist/` (or wherever build artifacts land).

**Expected:**
- Two DMGs produced — one for `x64`, one for `arm64`.

**Fail indicators:**
- Only one DMG produced.

<!-- @portico:test-status:begin id=A-09 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-10 — `install_v2.sh --rust-full` fails install when Rust toolchain is missing

**Coverage:** Manual (regression #46)
**Type:** Setup
**Preconditions:** Rust toolchain not installed (e.g. fresh user).

**Steps:**
1. Confirm `which cargo` returns nothing.
2. Run `./install_v2.sh --rust-full`.
3. Observe exit status: `echo $?`.

**Expected:**
- Script exits non-zero.
- Error message clearly mentions Rust/cargo missing (does not silently fall through via PIPESTATUS).

**Fail indicators:**
- Exit status `0` despite missing toolchain (the original bug).

<!-- @portico:test-status:begin id=A-10 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### A-11 — `install_v2.sh` auto-installs Rust toolchain on a fresh macOS profile

**Coverage:** Manual (regression #47)
**Type:** Setup
**Preconditions:** Fresh user profile or one without Rust.

**Steps:**
1. Confirm `which cargo` returns nothing.
2. Run `./install_v2.sh` (default flags).
3. After install, run `which cargo` and `cargo --version`.

**Expected:**
- Rust toolchain installed under `$HOME/.cargo`.
- `cargo --version` reports a stable version.

**Fail indicators:**
- `which cargo` still empty.
- Install bailed before installing Rust.

<!-- @portico:test-status:begin id=A-11 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->
