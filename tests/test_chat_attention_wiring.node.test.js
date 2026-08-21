// PORTICO PATCH (Round 4 / Issue 7b — wiring tests).
//
// These tests pin the structural contract of the per-chat amber-dot
// pipeline so the user actually sees the indicator the gate has been
// emitting in audit logs all along:
//
//   gate _pending  ──> chat_attention_for_user(user_id)
//                  └─> GET /api/v1/utils/chat-attention
//                      └─> $lib/apis/chatAttention.ts
//                          └─> $lib/stores/chatAttention.ts (writable)
//                              └─> ChatItem.svelte renders TaskAttentionDot
//
// Each test below targets one link in that chain.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");

const PATCH_BASE = path.join(REPO_ROOT, "src", "patches", "frontend", "src");
const BACKEND_BASE = path.join(REPO_ROOT, "src", "patches", "backend");

const apiClientSource = fs.readFileSync(
  path.join(PATCH_BASE, "lib", "apis", "chatAttention.ts"),
  "utf8",
);
const storeSource = fs.readFileSync(
  path.join(PATCH_BASE, "lib", "stores", "chatAttention.ts"),
  "utf8",
);
const sidebarSource = fs.readFileSync(
  path.join(PATCH_BASE, "lib", "components", "layout", "Sidebar.svelte"),
  "utf8",
);
const chatItemSource = fs.readFileSync(
  path.join(
    PATCH_BASE,
    "lib",
    "components",
    "layout",
    "Sidebar",
    "ChatItem.svelte",
  ),
  "utf8",
);
const utilsRouterSource = fs.readFileSync(
  path.join(BACKEND_BASE, "open_webui", "routers", "utils.py"),
  "utf8",
);
const gateSource = fs.readFileSync(
  path.join(
    BACKEND_BASE,
    "open_webui",
    "utils",
    "tool_confirmation_gate.py",
  ),
  "utf8",
);

// ---------------------------------------------------------------------------
// Backend route + gate method
// ---------------------------------------------------------------------------

test("backend exposes GET /api/v1/utils/chat-attention", () => {
  assert.match(
    utilsRouterSource,
    /@router\.get\(['"]\/chat-attention['"]\)/,
    "the chat-attention REST route must be registered on the utils router",
  );
});

test("chat-attention route requires the verified user", () => {
  // Without ``Depends(get_verified_user)`` the endpoint would happily
  // hand back the gate's pending list to anyone.
  const routeBlock = utilsRouterSource
    .split(/@router\.get\(['"]\/chat-attention['"]\)/)[1]
    .split(/@router\./)[0];
  assert.match(
    routeBlock,
    /Depends\(get_verified_user\)/,
    "chat-attention route must auth via get_verified_user",
  );
});

test("chat-attention route cross-references chat ownership", () => {
  // Defense-in-depth: the gate already filters by user_id, but the
  // route must double-check ownership so a stale user_id stamp can't
  // surface another user's chat ids.
  const routeBlock = utilsRouterSource
    .split(/@router\.get\(['"]\/chat-attention['"]\)/)[1]
    .split(/@router\./)[0];
  assert.match(
    routeBlock,
    /get_chat_by_id_and_user_id/,
    "ownership check must use get_chat_by_id_and_user_id per chat",
  );
});

test("Gate exposes chat_attention_for_user method", () => {
  assert.match(
    gateSource,
    /def chat_attention_for_user\(\s*self,\s*user_id/,
    "Gate.chat_attention_for_user must exist on the gate",
  );
});

test("chat_attention_for_user maps tool_confirmation -> awaiting_confirmation", () => {
  // Lock in the reason vocabulary the frontend depends on. If the
  // strings drift, the tooltip on the dot will silently fall back to
  // the default copy.
  assert.match(gateSource, /['"]awaiting_confirmation['"]/);
  assert.match(gateSource, /['"]awaiting_clarification['"]/);
});

// ---------------------------------------------------------------------------
// Frontend API client
// ---------------------------------------------------------------------------

test("chatAttention API client targets the correct REST path", () => {
  assert.match(apiClientSource, /\/api\/v1\/utils\/chat-attention/);
});

test("chatAttention API client uses bearer auth", () => {
  assert.match(apiClientSource, /Authorization:\s*`Bearer \$\{token\}`/);
});

test("chatAttention API client soft-fails to an empty payload", () => {
  // Network error must not break the sidebar render — the helper
  // returns ``emptyChatAttentionResponse()``.
  assert.match(apiClientSource, /emptyChatAttentionResponse\(\)/);
  assert.match(apiClientSource, /catch \(error\)/);
});

test("chatAttention API client exposes indexAttentionItems folder", () => {
  // The ChatItem row does an O(1) lookup via the indexed Map. If
  // this helper goes missing the sidebar would either re-implement
  // the fold inline or do an O(N) scan per row render.
  assert.match(apiClientSource, /export const indexAttentionItems/);
  assert.match(apiClientSource, /new Map<string, string>\(\)/);
});

// ---------------------------------------------------------------------------
// Svelte store
// ---------------------------------------------------------------------------

test("chatAttention store is a writable Map", () => {
  assert.match(storeSource, /import \{ writable \} from ['"]svelte\/store['"]/);
  assert.match(
    storeSource,
    /export const chatAttention\s*=\s*writable<Map<string, string> \| null>/,
  );
});

test("refreshChatAttention coalesces concurrent calls", () => {
  // Without the in-flight latch, a chat-list reload + a chip
  // resolution arriving in the same tick would fire two backend
  // requests. The latch keeps it to one.
  assert.match(storeSource, /let inFlight: Promise<void> \| null = null/);
  assert.match(storeSource, /if \(inFlight\) \{[\s\S]*return inFlight/);
});

test("refreshChatAttention treats missing token as empty map", () => {
  // No token === logged out / pre-bootstrap. We reset the store to
  // an empty Map (NOT null) so the dots disappear cleanly across
  // sign-out events.
  assert.match(
    storeSource,
    /if \(!token\) \{\s*\n\s*chatAttention\.set\(new Map\(\)\)/,
  );
});

test("clearChatAttentionLocally provides optimistic single-chat clear", () => {
  // The chip-resolution handler can call this so the dot vanishes
  // on the chat the user just clicked, before the next backend
  // refresh comes back.
  assert.match(storeSource, /export const clearChatAttentionLocally/);
});

// ---------------------------------------------------------------------------
// Sidebar wiring
// ---------------------------------------------------------------------------

test("Sidebar imports the refresh helper", () => {
  assert.match(
    sidebarSource,
    /from ['"]\$lib\/stores\/chatAttention['"]/,
  );
  assert.match(sidebarSource, /refreshChatAttention/);
});

test("Sidebar refreshes attention on every chat-list reload", () => {
  // The refresh call must live inside ``initChatList()`` (the only
  // entry point the chat list uses). If a future refactor moves the
  // refresh out, this test fails loudly so we don't ship a stale
  // dot pipeline.
  const initBlock = sidebarSource
    .split("const initChatList = async () => {")[1]
    .split("const loadMoreChats")[0];
  assert.match(
    initBlock,
    /refreshChatAttention\(localStorage\.token\)/,
    "refreshChatAttention must run inside initChatList",
  );
});

// ---------------------------------------------------------------------------
// ChatItem render
// ---------------------------------------------------------------------------

test("ChatItem subscribes to the chatAttention store", () => {
  assert.match(
    chatItemSource,
    /from ['"]\$lib\/stores\/chatAttention['"]/,
  );
  assert.match(chatItemSource, /\$chatAttention\?\.get\(id\)/);
});

test("ChatItem imports and renders TaskAttentionDot", () => {
  assert.match(chatItemSource, /import TaskAttentionDot from ['"]\.\/TaskAttentionDot\.svelte['"]/);
  assert.match(chatItemSource, /<TaskAttentionDot[^/]*needsAttention[^/]*reason=\{attentionReason\}/);
});

test("ChatItem derives needsAttention reactively from the store", () => {
  // The reactive declaration is the linchpin — without it the dot
  // wouldn't update when the store refreshes.
  assert.match(chatItemSource, /\$:\s*persistedAttentionReason\s*=\s*\$chatAttention\?\.get\(id\)/);
  assert.match(
    chatItemSource,
    /\$:\s*needsAttention\s*=\s*persistedAttentionReason\s*!==\s*null\s*\|\|\s*runtimeState\?\.attentionRequired\s*===\s*true/,
  );
});

test("ChatItem keeps the title clipping on the truncated div, not the row", () => {
  // The dot lives at the right edge so the title still gets the
  // available width via ``flex-1 min-w-0``. A regression here would
  // either hide the title behind the dot or push the dot off-screen.
  const titleBlock = chatItemSource.split("<TaskAttentionDot")[0];
  // Find the latest title-row block (just before the dot insertion).
  const lastFlexBlock = titleBlock.match(
    /<div[^>]*flex self-center flex-1[^>]*>[\s\S]*$/,
  );
  assert.ok(
    lastFlexBlock,
    "expected a flex container with self-center flex-1 wrapping the title",
  );
  assert.match(lastFlexBlock[0], /flex-1/);
  assert.match(lastFlexBlock[0], /min-w-0/);
});
