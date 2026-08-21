# Tool-call history flatten on follow-up turns (March 2026)

**Status:** resolved.
**Layers affected:** Chat UI, State & Persistence, LLM Routing.

## Symptom

Phoenix observability could parse the **first** request in a chat correctly,
but on **follow-up** requests it could not track tool usage. The LLM also
saw a degraded conversation history because Anthropic structured content
blocks (`reasoningContent`, `toolUse`, `toolResult`) had been collapsed
into a single text block.

```
Turn 2 request to model (within the same agentic loop) — CORRECT
{
  "role": "assistant",
  "content": [
    {"reasoningContent": {...}},
    {"text": "I'll use the tool..."},
    {"toolUse": {"name": "...", "toolUseId": "...", "input": {}}}
  ]
},
{
  "role": "user",
  "content": [{"toolResult": {"content": [...], "toolUseId": "..."}}]
}

Turn 3 request after a new user message — BROKEN
{
  "role": "assistant",
  "content": [{
    "text": "I'll use...\n\"&quot;{escaped JSON result}&quot;\"\n..."
    // structure flattened into a single string
  }]
}
```

## Root cause

Inside a single agentic loop the middleware kept structured content blocks
in memory and forwarded them to the model. When the assistant message was
persisted to SQLite (`open-webui-data/webui.db`), the
`serialize_content_blocks()` helper collapsed the blocks into an HTML
`<details>`-wrapped string for display and only that string was stored.
On the next user turn the frontend retrieved that string, sent it back to
the backend, and the backend forwarded it as plain text to the model. The
structured tool-call payload was therefore lost between turns.

The two earlier hypotheses that turned out to be wrong:

- "We just need to parse the HTML `<details>` tags back into tool calls."
  The HTML was lossy; rebuilding tool calls from it was fragile and never
  produced a clean follow-up request.
- "It's a frontend rendering bug." The frontend was rendering correctly;
  the data going into the request body was already flat.

## Fix

The fix lives across three patch points (all in
`src/patches/`):

| Layer | File | Change |
|---|---|---|
| Backend persistence | `backend/open_webui/utils/middleware.py` | `Chats.upsert_message_*` calls now persist BOTH `content` (HTML for the UI) and `contentBlocks` (structured array for the API). |
| Backend request pipeline | `backend/open_webui/utils/middleware.py` | New `reconstruct_anthropic_format(messages)` helper, called at the very top of `process_chat_payload`, expands any assistant message that carries `contentBlocks` back into proper assistant + tool + assistant turns via the existing `convert_content_blocks_to_messages`. |
| Frontend request build | `frontend/src/lib/components/chat/Chat.svelte` | When building the body for `POST /api/chat/completions`, preserve `contentBlocks` on each message instead of destructuring only `role` and `content`. |

Backwards compatibility: messages without a `contentBlocks` field fall
through unchanged, so older chats keep working.

## Verification

1. Restart the OWUI container so the patched middleware loads.
2. Start a new chat, ask the model to use a tool (any tool — the original
   repro used the available-tools listing tool).
3. Send a follow-up message such as "thanks!".
4. Confirm in the request that goes to the model that the assistant turn
   contains structured `toolUse` blocks rather than a single flattened
   text block, and that there is a separate user turn carrying the
   `toolResult`.
5. Confirm Phoenix tracks tool usage on the follow-up request as well as
   the first request.

A more detailed step-by-step debugging walkthrough lives at
[`../_archive/debug-tool-call-history.md`](../_archive/debug-tool-call-history.md)
for engineers who need to chase a regression in this area.

## Related cleanup

The original investigation added logging hooks via the legacy
`src/bifrost-bridge-rust/` Bifrost bridge path. Those hooks are no longer the
primary observability surface and are tracked for removal in
[`docs/TO_REMOVE.md`](../TO_REMOVE.md) alongside the rest of the Bifrost bridge
proxy.
