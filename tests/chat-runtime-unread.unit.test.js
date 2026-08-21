// PORTICO-432: the sidebar "New activity" dot must be owned by the chat-scoped
// activity registry, never by the shell's per-tab flag.
//
// The bug: the dot was `activity.unread || shellState.unread`. The shell's copy
// is per TAB and clears only on tab activation or reuse, so opening a chat from
// the sidebar (in-page navigation) could not clear it and it survived until the
// app restarted. It also followed a tab onto the next chat, flagging chats that
// never had activity.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
test.before(async () => {
  mod = await import(
    pathToFileURL(
      path.resolve(
        __dirname,
        '..',
        'src/patches/frontend/src/lib/utils/chatRuntimeUnread.js',
      ),
    ).href
  );
});

const activity = (overrides = {}) => ({
  busy: false,
  phase: 'idle',
  unread: false,
  attentionRequired: false,
  ...overrides,
});

test('the registry alone decides unread', () => {
  const entry = mod.resolveChatRuntimeEntry({ activity: activity({ unread: true }) });
  assert.equal(entry.unread, true);
});

test("a stale per-tab flag can no longer light the sidebar dot", () => {
  // This is the regression. Before the fix the shell's unread was unioned in,
  // so this returned unread: true and nothing the user did could clear it.
  const entry = mod.resolveChatRuntimeEntry({
    activity: activity({ unread: false }),
    shellState: { unread: true, attentionRequired: false },
  });
  assert.equal(
    entry.unread,
    false,
    'shell tab state must not be able to mark a chat unread',
  );
});

test('a chat the registry is not tracking has nothing unread', () => {
  const entry = mod.resolveChatRuntimeEntry({
    activity: null,
    shellState: { unread: true, attentionRequired: false },
  });
  assert.equal(entry.unread, false);
  assert.equal(entry.busy, false);
  assert.equal(entry.phase, 'idle');
});

test('attentionRequired keeps its union — it is a different, shell-owned signal', () => {
  assert.equal(
    mod.resolveChatRuntimeEntry({
      activity: activity(),
      shellState: { unread: false, attentionRequired: true },
    }).attentionRequired,
    true,
    'the shell still owns native-input attention',
  );
  assert.equal(
    mod.resolveChatRuntimeEntry({ activity: activity({ attentionRequired: true }) })
      .attentionRequired,
    true,
  );
  assert.equal(
    mod.resolveChatRuntimeEntry({ activity: activity(), nativeInputAttention: true })
      .attentionRequired,
    true,
  );
  assert.equal(
    mod.resolveChatRuntimeEntry({ activity: activity() }).attentionRequired,
    false,
  );
});

test('busy and phase still come through, and phase is idle when not busy', () => {
  const busy = mod.resolveChatRuntimeEntry({
    activity: activity({ busy: true, phase: 'thinking' }),
  });
  assert.equal(busy.busy, true);
  assert.equal(busy.phase, 'thinking');

  const settled = mod.resolveChatRuntimeEntry({
    activity: activity({ busy: false, phase: 'thinking' }),
  });
  assert.equal(settled.busy, false);
  assert.equal(settled.phase, 'idle', 'a settled chat must not report a live phase');
});

test('an absent activity entry degrades without throwing', () => {
  const entry = mod.resolveChatRuntimeEntry({});
  assert.deepEqual(entry, {
    busy: false,
    phase: 'idle',
    unread: false,
    attentionRequired: false,
  });
  assert.deepEqual(mod.resolveChatRuntimeEntry(), {
    busy: false,
    phase: 'idle',
    unread: false,
    attentionRequired: false,
  });
});
