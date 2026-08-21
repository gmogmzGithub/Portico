# E.2 — In-chat find

Three scenarios for `Cmd+F` find-in-page, schema-version invariant, and search-index resync after edits.

- Up: [`docs/testing/plan/search/README.md`](README.md).

---

## Scenarios

### E-07 — Find-in-page (`Cmd+F`) highlights matches; Esc closes overlay and restores focus

**Coverage:** Auto — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js)
**Type:** Search
**Preconditions:** A focused chat with multiple occurrences of a known term.

**Steps:**
1. Press `Cmd+F`. Type the term.
2. Press `Cmd+G` to advance.
3. Press `Esc` to close the overlay.
4. Type into chat input.

**Expected:**
- Highlights appear over each match.
- `Esc` closes the overlay and returns keyboard focus to the chat input.

**Fail indicators:**
- Esc leaves focus orphan.
- Highlight color invisible in current theme.

<!-- @portico:test-status:begin id=E-07 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:35.956Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### E-08 — Search modal `_FTS_VERSION` matches production schema (currently 7)

**Coverage:** Auto — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js)
**Type:** Search
**Preconditions:** None — investigation only.

**Steps (regression-investigation only):**
1. From `electron-app/`, run `node --test src/services/tab-search-regressions.test.js`.
2. Search the test file for `_FTS_VERSION` and confirm it expects `7` (or whatever production currently uses).

**Expected:**
- Test passes.
- Constant matches the current production schema.

**Fail indicators:**
- Test fails with version mismatch.

<!-- @portico:test-status:begin id=E-08 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:36.038Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### E-09 — Search index updates after a message edit (resync)

**Coverage:** Auto — [`tab-search-regressions.test.js`](../../../../electron-app/src/services/tab-search-regressions.test.js)
**Type:** Search
**Preconditions:** A chat with a unique token (e.g. `originalToken`).

**Steps:**
1. Run a global search for `originalToken` — confirm it matches.
2. Edit the message and replace `originalToken` with `editedToken`.
3. Re-run global search for both tokens.

**Expected:**
- After the edit, `originalToken` returns no results.
- `editedToken` returns one result pointing at the edited message.

**Fail indicators:**
- Both tokens return matches (stale index).
- Neither token returns matches (index lost the message).

<!-- @portico:test-status:begin id=E-09 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-04-28T14:51:36.108Z
- Build: pre-beta-tmp @ fc4efce1-dirty
- Executor: bshor
- Notes: /usr/local/lib/nodejs/node-v20.19.0-darwin-arm64/bin/node --test electron-app/src/services/tab-search-regressions.test.js -- 0s
<!-- @portico:test-status:end -->

---

### E-10 — Local find is scoped to the chat transcript (no sidebar / nav leakage)

**Coverage:** Manual
**Type:** Search
**Preconditions:** Sidebar shows chat titles or nav labels containing a known token (e.g. `Налаштування`, `Slack`); the currently-open chat contains the same token at least once in a message body.

**Steps:**
1. Press `Cmd+F`. Type the token that exists in both sidebar and chat.
2. Read the match counter ("N of M") in the find overlay.
3. Press `Cmd+G` repeatedly to cycle through every match.
4. Inspect the sidebar visually after each step.

**Expected:**
- The counter equals the number of occurrences inside the chat transcript only — sidebar/nav occurrences are excluded.
- No highlight (passive or active) appears anywhere in the sidebar, settings row, folder list, or any non-transcript chrome rendered inside the OWUI document.
- `Cmd+G` cycles only between transcript matches; the page never scrolls to or focuses a sidebar position.
- Sidebar text remains fully visible and readable throughout the session (no visibility/display tricks).

**Fail indicators:**
- Counter inflated by sidebar/nav matches.
- Any yellow/native or themed highlight visible outside the chat panel.
- `Cmd+G` lands an "active" highlight on a sidebar entry.
- Sidebar contents disappear or change opacity while typing.

<!-- @portico:test-status:begin id=E-10 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-11 — Streaming response updates match count without flicker

**Coverage:** Manual
**Type:** Search
**Preconditions:** A model that produces a long, streaming assistant response. Pick a query token guaranteed to appear repeatedly in that response (e.g. `the`).

**Steps:**
1. Send a prompt that triggers a long streaming response.
2. While streaming is in progress, press `Cmd+F` and type the query token.
3. Observe the counter for ~10 seconds while tokens continue to arrive.
4. Press `Cmd+G` once to advance to the next match.

**Expected:**
- Match count increases monotonically as new matching text streams in.
- Highlights do not visibly flicker more than briefly when a chunk arrives (≤ 1 animation frame).
- Active match identity is preserved across mutations: pressing `Cmd+G` advances from the previously-active match, not from match #1.
- No console errors and no observable UI stall (input remains responsive).

**Fail indicators:**
- Counter stops updating before streaming completes.
- Highlights vanish for > 1 frame between chunks.
- Active match resets to first match every time content streams.
- Typing in the find overlay lags noticeably while streaming.

<!-- @portico:test-status:begin id=E-11 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-12 — Find-next reaches matches inside collapsed hidden history

**Coverage:** Manual
**Type:** Search
**Preconditions:** A long chat where older messages are paginated/hidden by OWUI's hidden-history mechanism. A unique token exists only in a hidden message.

**Steps:**
1. Confirm the chat is scrolled near the bottom and the hidden-history banner/region is present.
2. Press `Cmd+F`, type the unique token.
3. Press `Cmd+G` to navigate to the match.

**Expected:**
- Hidden history expansion is requested (existing `request-hidden-history-expansion` event fires).
- After expansion completes, the count reflects the now-rendered matches.
- The view scrolls to the previously-hidden match and the active highlight lands on it.

**Fail indicators:**
- Count remains 0 (or undercount) even though the token exists in the chat.
- Expansion does not trigger.
- Match counted but `Cmd+G` cannot navigate to it.

<!-- @portico:test-status:begin id=E-12 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-13 — Editable regions are excluded from matches

**Coverage:** Manual
**Type:** Search
**Preconditions:** A chat with a message you can put into edit mode whose text contains a known token. The composer is also visible.

**Steps:**
1. Type the same token into the composer (do not send).
2. Open edit mode on the message containing the token.
3. Press `Cmd+F` and type the token.

**Expected:**
- Match count excludes:
  - The composer textarea contents.
  - The contents of the editable message under edit mode.
- Matches in sibling (non-edited) messages are still counted and navigable.
- Closing edit mode causes the previously-editable message's matches to reappear in the count automatically.

**Fail indicators:**
- Count includes composer or editable text.
- Highlights paint on top of editable text.
- Closing edit mode does not refresh count.

<!-- @portico:test-status:begin id=E-13 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-14 — KaTeX, code blocks, and rich markdown match correctly

**Coverage:** Manual
**Type:** Search
**Preconditions:** A chat containing at least one KaTeX-rendered formula (e.g. `$E = mc^2$`), at least one fenced code block, and at least one inline code span. Identify a token that appears in each.

**Steps:**
1. Press `Cmd+F` and search for a token visible in the rendered KaTeX output (use a Latin token also present in the markup).
2. Search for a token present only inside a fenced code block.
3. Search for a token present only in inline code.

**Expected:**
- Each query returns the expected number of visible matches.
- No double counting from KaTeX MathML / `.sr-only` / `.katex-mathml` mirrors.
- Active highlight in code blocks is positioned correctly over the rendered glyph.

**Fail indicators:**
- KaTeX query count is 2× the visible occurrences (MathML mirror counted).
- Code-block matches missing.
- Active highlight visually misaligned (off by a line or character).

<!-- @portico:test-status:begin id=E-14 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-15 — Theme toggle mid-session updates highlight colors

**Coverage:** Manual
**Type:** Search
**Preconditions:** App launched in light theme; a chat with several occurrences of a known token.

**Steps:**
1. Press `Cmd+F`, type the token. Confirm passive + active highlights are visible.
2. Toggle the app theme (light → dark) without closing the find overlay.
3. Toggle back (dark → light).

**Expected:**
- Passive and active highlight colors update to the new theme on each toggle.
- Counter and active match index do not change.
- No flicker beyond the theme transition itself.

**Fail indicators:**
- Highlights become invisible against the new background.
- Counter resets.
- Active match index changes.

<!-- @portico:test-status:begin id=E-15 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-16 — Detached chat window and main window have independent find sessions

**Coverage:** Manual
**Type:** Search
**Preconditions:** A detached conversation window (via existing detach flow) plus the main shell window, each showing a different chat. Each chat contains a different known token.

**Steps:**
1. In the main window, press `Cmd+F` and search for token A.
2. In the detached window, press `Cmd+F` and search for token B.
3. Press `Cmd+G` in each window in turn.

**Expected:**
- Each window's counter reflects only its own chat's matches.
- Cycling in one window does not change the active match in the other.
- Closing the find overlay in one window does not close it in the other.

**Fail indicators:**
- Counters cross-pollinate.
- Cycling in one window scrolls/highlights the other.
- Sessions interfere on close/ESC.

<!-- @portico:test-status:begin id=E-16 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-17 — Regex and case-sensitive toggles match documented semantics

**Coverage:** Manual
**Type:** Search
**Preconditions:** A chat containing both `Foo` and `foo`, plus a string matching a regex pattern (e.g. `bug-\d+`).

**Steps:**
1. Search `foo` with case-sensitive **off** → expect both `Foo` and `foo` matched.
2. Toggle case-sensitive **on** → expect only `foo`.
3. Toggle regex **on**, search `bug-\d+` → expect each `bug-N` token matched.
4. With regex on, enter an invalid pattern (`[`) → expect graceful "invalid regex" indication, no crash.

**Expected:**
- Behavior matches the documented CMD+F semantics in [`docs/architecture/chat-ui/search.md`](../../../architecture/chat-ui/search.md).
- Counter updates correctly on each toggle without requiring a re-type.
- Invalid regex sets count to 0 and shows a non-blocking error indicator in the overlay.

**Fail indicators:**
- Toggles do not re-evaluate without re-typing.
- Invalid regex throws or freezes UI.
- Case-sensitive on still matches differing case.

<!-- @portico:test-status:begin id=E-17 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-18 — Copy preserves plain text (no highlight artifacts)

**Coverage:** Manual
**Type:** Search
**Preconditions:** A chat with at least one passive match for a known token.

**Steps:**
1. Press `Cmd+F`, type the token, leave passive highlights visible.
2. Select a paragraph that contains a passive match.
3. Copy and paste into a plain-text editor.

**Expected:**
- Pasted text contains only the original characters.
- No `<mark>`, no zero-width spaces, no inserted styling, no duplicated characters.

**Fail indicators:**
- Pasted content includes HTML wrappers or stray characters.
- Selection visually misaligned over highlighted text.

<!-- @portico:test-status:begin id=E-18 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->

---

### E-19 — Performance gate at long-transcript scale

**Coverage:** Manual
**Type:** Search
**Preconditions:** Synthetic transcript fixture with 200 messages × ~5 KB visible text per message loaded into a real `WebContentsView`.

**Steps:**
1. Run the scripted performance harness.
2. Harness opens local find, types a 20-character query at 50 ms intervals, then triggers `Cmd+G` 50 times.
3. Harness records main-thread time per keystroke and per navigation.

**Expected:**
- Per-keystroke main-thread time < 30 ms at p95.
- Per-`Cmd+G` navigation < 16 ms at p95.
- Memory delta over 100 cycles of (open find → type → close) < 10 MB.

**Fail indicators:**
- p95 keystroke time exceeds 30 ms.
- Memory grows monotonically across cycles (Range/Highlight leak).

<!-- @portico:test-status:begin id=E-19 -->
**Last execution:**
- Status: `Pass`
- Date: 2026-05-01T08:38:13.000Z
- Build: pre-beta-tabs-and-search-fixes @ 2cd19449
- Executor: odubo
- Notes: Live-app validation against the running Electron build.
<!-- @portico:test-status:end -->
