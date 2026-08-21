# J — Agent skills, agent VM, sub-agents

Nine scenarios covering skill activation, the agent-VM HARD RULE, code execution paths, parallelism, budget guard, image viewer, and artifact panel.

- Up: [`docs/testing/plan/skills/README.md`](README.md).

---

## Scenarios

### J-01 — Built-in skill activates and exposes its tools to the LLM context

**Coverage:** Auto — [`skill-frontmatter.test.js`](../../../../electron-app/src/services/skill-frontmatter.test.js)
**Type:** Skills
**Preconditions:** A built-in skill present (e.g. `pdf-from-script`).

**Steps:**
1. In a chat, type `Activate the pdf-from-script skill` (or open the skill manager and toggle it on).
2. Send another message that should trigger the skill's tools.

**Expected:**
- Skill activation succeeds.
- The model lists the skill's tools in its `<active>` context.
- A subsequent tool call works.

**Fail indicators:**
- Activation silent.
- Tools missing from context.

<!-- @portico:test-status:begin id=J-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:44.102Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/skill-frontmatter.test.js -- 0s
<!-- @portico:test-status:end -->

---

### J-02 — LLM activates `agent-vm` *before* calling `agent_vm_*` tools (HARD RULE #51)

**Coverage:** Manual (legacy item 30)
**Type:** Skills
**Preconditions:** A chat configured to use the agent-VM workflow.

**Steps:**
1. Trigger an `agent_vm_*` tool flow.
2. Inspect the assistant's reasoning trace.

**Expected:**
- The trace shows `agent-vm` skill activation as the immediately-preceding action before any `agent_vm_*` call.

**Fail indicators:**
- Tool called without preceding skill activation (HARD RULE #51 violation).

<!-- @portico:test-status:begin id=J-02 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### J-03 — Code execution: bash / python / node tools run inside agent VM

**Coverage:** Auto — `cargo test --manifest-path src/core-mcp-rust/Cargo.toml --workspace --test stdio_smoke`
**Type:** Skills
**Preconditions:** `agent-vm` activated.

**Steps:**
1. Ask the agent to run `bash -c 'uname -a'`.
2. Repeat with `python3 -c 'import sys; print(sys.version)'` and `node -e 'console.log(process.version)'`.

**Expected:**
- Each command runs inside the agent VM (a sandboxed Docker container).
- Output looks like a Linux container, not the host macOS.

**Fail indicators:**
- `Darwin` shows in `uname` output (the host got hit instead of the VM).

<!-- @portico:test-status:begin id=J-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:46.723Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> src/core-mcp-rust Cargo smoke tests -- 2s
<!-- @portico:test-status:end -->

---

### J-04 — PDF-from-script integration produces an artifact and renders

**Coverage:** Auto — [`tests/test_code_execution_pdf_script.py`](../../../../tests/test_code_execution_pdf_script.py)
**Type:** Skills
**Preconditions:** `pdf-from-script` skill activated; `agent-vm` activated.

**Steps:**
1. Ask the agent to "make a one-page PDF that says HELLO".
2. Wait for completion.

**Expected:**
- A PDF artifact appears in the artifact panel.
- The PDF renders inline (one page with HELLO).

**Fail indicators:**
- Skill produces no artifact.
- Artifact panel renders an error.

<!-- @portico:test-status:begin id=J-04 -->
**Last execution:**
- Status: `Skipped`
- Date: 2026-04-28T14:51:49.766Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_code_execution_pdf_script.py -- pytest collected 0 tests (exit 5)
<!-- @portico:test-status:end -->

---

### J-05 — Agent VM startup cleanup removes stale containers from previous session

**Coverage:** Auto — [`agent-vm-startup-cleanup.unit.test.js`](../../../../electron-app/src/services/agent-vm-startup-cleanup.unit.test.js)
**Type:** Skills
**Preconditions:** App was force-quit (e.g. via Activity Monitor) while an agent-VM container was running, leaving a stale container behind.

**Steps:**
1. Confirm a stale container exists: `docker ps -a | grep agent-vm`.
2. Relaunch the app.
3. Re-check `docker ps -a`.

**Expected:**
- Stale containers removed on startup.

**Fail indicators:**
- Stale containers remain.

<!-- @portico:test-status:begin id=J-05 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:50.276Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/agent-vm-startup-cleanup.unit.test.js -- 0s
<!-- @portico:test-status:end -->

---

### J-06 — Sub-agents run consistently in parallel (chat consistency runner)

**Coverage:** Auto — [`tests/test_run_subagents_parallel_chat_consistency.py`](../../../../tests/test_run_subagents_parallel_chat_consistency.py)
**Type:** Skills
**Preconditions:** Sub-agent feature available.

**Steps (regression-investigation only):**
1. Run the test file.
2. Manually verify a parallel sub-agent run in chat.

**Expected:**
- Test passes.
- Manual verification: parallel sub-agents return consistent results across multiple runs.

**Fail indicators:**
- Inconsistent or interleaved outputs across sub-agents.

<!-- @portico:test-status:begin id=J-06 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:52.885Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_run_subagents_parallel_chat_consistency.py -- 2s
<!-- @portico:test-status:end -->

---

### J-07 — Subagent budget guard caps token usage

**Coverage:** Auto — [`tests/test_subagent_budget_guard.py`](../../../../tests/test_subagent_budget_guard.py)
**Type:** Skills
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. Run `python -m pytest tests/test_subagent_budget_guard.py`.

**Expected:**
- Test passes.
- Budget guard halts a sub-agent before exceeding the configured token cap.

**Fail indicators:**
- Test fails: budget guard exceeded.

<!-- @portico:test-status:begin id=J-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:55.631Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_subagent_budget_guard.py -- 2s
<!-- @portico:test-status:end -->

---

### J-08 — Image viewer skill renders inline images and respects DPR

**Coverage:** Auto — [`agent-skills-image-viewer.unit.test.js`](../../../../electron-app/src/services/agent-skills-image-viewer.unit.test.js)
**Type:** Skills
**Preconditions:** Image viewer skill activated; chat that produced an image.

**Steps:**
1. Render an image in the chat (e.g. ask the agent for a generated chart).
2. Inspect rendering on a HiDPI display.

**Expected:**
- Image renders inline.
- DPR honored — no blurry pixels on retina.

**Fail indicators:**
- Image only displayed as a download link.
- Blurry image at 2x DPR.

<!-- @portico:test-status:begin id=J-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:56.111Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/agent-skills-image-viewer.unit.test.js -- 1s
<!-- @portico:test-status:end -->

---

### J-09 — Artifact panel renders the latest artifact and supports version menu

**Coverage:** Auto — [`artifact-panel-layout.unit.test.js`](../../../../electron-app/src/services/artifact-panel-layout.unit.test.js)
**Type:** Skills
**Preconditions:** A chat that produced ≥2 versions of an artifact (e.g. asked the agent to revise it).

**Steps:**
1. Open the artifact panel.
2. Use the version menu to switch between versions.

**Expected:**
- Latest version is shown by default.
- Version menu lists each version with timestamp.
- Selecting a version swaps the rendered content.

**Fail indicators:**
- Version menu missing.
- Switching versions does not actually change content.

<!-- @portico:test-status:begin id=J-09 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:08.258Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/artifact-panel-layout.unit.test.js -- 1s
<!-- @portico:test-status:end -->
