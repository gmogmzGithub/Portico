# E.1 — Global search

Six scenarios for `Shift+Cmd+F`-driven global search across all chats.

- Up: [`docs/testing/plan/search/README.md`](README.md).

---

## Scenarios

### E-01 — Global search shows unified result cards

**Coverage:** Auto — [`tests/test_chat_search_reliability.py`](../../../../tests/test_chat_search_reliability.py)
**Type:** Search
**Preconditions:**
- Multiple chats indexed (≥3).
- A search term that matches both chat titles and inline messages.

**Steps:**
1. Press `Shift+Cmd+F`.
2. Type the search term (e.g. `mcp`).
3. Inspect result cards.

**Expected:**
- Each result card shows the chat title plus snippet hits merged into one unit (no duplicate cards for the same chat).

**Fail indicators:**
- Two cards for the same chat (one title-hit, one snippet-hit).
- Snippets missing.

<!-- @portico:test-status:begin id=E-01 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:31.650Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_chat_search_reliability.py -- 4s
<!-- @portico:test-status:end -->

---

### E-02 — Plain-text query with punctuation returns literal results

**Coverage:** Auto — [`tests/test_chat_search_reliability.py`](../../../../tests/test_chat_search_reliability.py)
**Type:** Search
**Preconditions:** A chat that contains `(foo)`, `{bar}`, `"hello"`, and `server:mcp-assistant` somewhere in its content.

**Steps:**
1. Press `Shift+Cmd+F`.
2. Type `(foo)` and press Enter.
3. Repeat for `{bar}`, `"hello"`, `server:mcp-assistant`.

**Expected:**
- Each query returns literal matches.
- No "FTS syntax error" toast.

**Fail indicators:**
- "FTS syntax error" appears for any of the inputs.
- Empty results when the term is clearly present.

<!-- @portico:test-status:begin id=E-02 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:31.727Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_chat_search_reliability.py -- 4s
<!-- @portico:test-status:end -->

---

### E-03 — Regex mode toggle is opt-in; ReDoS patterns time out safely

**Coverage:** Auto — [`tests/test_chat_search_security.py`](../../../../tests/test_chat_search_security.py)
**Type:** Search / Security
**Preconditions:** None (regression-investigation only).

**Steps (regression-investigation only):**
1. Press `Shift+Cmd+F`.
2. Toggle the regex switch on.
3. Paste a ReDoS pattern such as `(a+)+$` and search.

**Expected:**
- Search either returns within ~500ms or aborts cleanly with a "regex timed out" toast.
- Renderer remains responsive.

**Fail indicators:**
- Renderer freezes for >5s.
- App crashes.

<!-- @portico:test-status:begin id=E-03 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:34.944Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_chat_search_security.py -- 2s
<!-- @portico:test-status:end -->

---

### E-04 — "Include Agent Traces" toggle exposes hidden content; default is off

**Coverage:** Auto — [`tests/test_chat_search_security.py`](../../../../tests/test_chat_search_security.py)
**Type:** Search
**Preconditions:** A chat with at least one tool call / reasoning block whose content includes a unique token (e.g. `myReasoningKey`).

**Steps:**
1. Press `Shift+Cmd+F`.
2. Search for `myReasoningKey`.
3. Toggle "Include Agent Traces" on.
4. Re-search.

**Expected:**
- Default search returns no results (agent-trace content hidden).
- After toggle on, the trace match shows up.

**Fail indicators:**
- Default search exposes agent-trace content (privacy regression).

<!-- @portico:test-status:begin id=E-04 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:35.023Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_chat_search_security.py -- 2s
<!-- @portico:test-status:end -->

---

### E-05 — Click on a result jumps to that chat and scrolls to the message

**Coverage:** Partial — [`tests/test_electron_chat_focus.cjs`](../../../../tests/test_electron_chat_focus.cjs)
**Type:** Search
**Preconditions:** A search result that points to a message buried mid-history.

**Steps:**
1. Run a global search.
2. Click a result card.

**Expected:**
- The corresponding chat tab is focused.
- The viewport scrolls to the matched message.
- The matched message is highlighted briefly.

**Fail indicators:**
- Chat opens but viewport sits at the bottom.
- Tab focus succeeds but no scroll happens.

<!-- @portico:test-status:begin id=E-05 -->
**Last execution:**
- Status: `NotRun`
- Date: -
- Build: -
- Executor: -
- Notes: -
<!-- @portico:test-status:end -->

---

### E-06 — Result list is ordered by recency after merging hits

**Coverage:** Auto — [`tests/test_chat_search_reliability.py`](../../../../tests/test_chat_search_reliability.py)
**Type:** Search
**Preconditions:** ≥5 chats with hits over a range of timestamps.

**Steps:**
1. Run a global search.
2. Inspect result order.

**Expected:**
- Most-recent chat (by `updated_at`) appears first.
- Order monotonically decreases.

**Fail indicators:**
- Order is by relevance score only or alphabetical.

<!-- @portico:test-status:begin id=E-06 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:31.804Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: uv run --python /opt/homebrew/bin/python3 --with pytest --with pytest-asyncio --with docker --with pypdf --with-requirements <REPO_ROOT>/requirements-open-webui-slim.txt python -m pytest --rootdir <REPO_ROOT> tests/test_chat_search_reliability.py -- 4s
<!-- @portico:test-status:end -->
