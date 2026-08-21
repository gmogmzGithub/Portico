# Raw `<thinking>` Tags Briefly Visible Mid-Stream (March 2026)

**Layers affected:** MCP Orchestration / middleware (streaming reasoning normalization in `src/patches/backend/open_webui/utils/middleware.py`), Chat UI (Svelte streaming append paths in `Chat.svelte`).

## Symptom

In a rare live-streaming edge case, the chat UI briefly painted raw provider markup such as

```text
<thinking>
…reasoning text…
</thinking>
```

A few seconds later the same message re-rendered correctly as a `Thought` block. The persisted message was always correct (a serialized `<details type="reasoning">` block plus a `contentBlocks[0]` entry of `type: "reasoning"`); the bug lived only in the transient live-render path between the backend stream emission and the frontend incremental append.

The reproduction rate was roughly 1 in 100+ chats and was driven by the model emitting inline reasoning tags inline in streamed text rather than in a separate `reasoning_content` field.

## Root cause

A timing hole between backend pending-delta emission and frontend raw-delta append:

1. **Backend inline reasoning stripping was gated to `is_gpt5`.** The middleware already had inline-reasoning helpers (`split_inline_reasoning_sections`, `extract_pending_start_tag_prefix`, marker stripping), but they only ran for GPT-5 models. Atlas streams that carried inline `<thinking>…</thinking>` bypassed normalization until a later snapshot replaced them.
2. **The inline path was not fully tag-driven.** It operated on `DEFAULT_REASONING_TAGS` instead of the request's effective `metadata["params"]["reasoning_tags"]`, and `ensure_reasoning_block_open()` hard-wired `<think>` / `</think>`, so the actual matched pair was lost when stored in the `contentBlocks` entry.
3. **Reasoning-tagged chunks could remain as raw pending payloads.** Outbound `chat:completion` updates were batched through `last_delta_data` / `flush_pending_delta_data()`. For ordinary text that is correct; for a reasoning-tagged chunk it meant the frontend could briefly paint the raw provider markup before the later normalized snapshot replaced it. A second narrow leak: `pending_reasoning_prefix` was being flushed into visible text at stream end when the stream stopped after a partial start tag like `<thi`.
4. **The frontend marker list was incomplete.** `Chat.svelte`'s structured-streaming detection only matched `<details type="reasoning">`, `<details type="tool_calls">`, `<think>` and `</think>` — it did not cover `<thinking>` / `</thinking>` or other configured reasoning-tag variants, so the offending chunk slipped through the fast-path direct append.

## Fix

### Backend — make reasoning normalization tag-driven before anything reaches the UI

In `src/patches/backend/open_webui/utils/middleware.py`:

- Removed the `is_gpt5` restriction. Inline-reasoning handling now applies to any model whose stream contains matching tags.
- Inline helpers operate on the request's effective reasoning-tag set (`metadata["params"]["reasoning_tags"]` when configured, otherwise `DEFAULT_REASONING_TAGS`).
- The actual matched `start_tag` / `end_tag` are preserved in streaming state and on the resulting reasoning block, so a `<thinking>…</thinking>` stream lands in `contentBlocks` as `<thinking>` / `</thinking>` rather than being rewritten to `<think>`.
- A reasoning-tagged chunk is never queued as the raw pending outbound payload. Whenever a chunk contains a full reasoning tag, a buffered partial prefix, or opens / appends to / closes a reasoning block, the queued payload is a normalized snapshot (`{"content": serialize_content_blocks(blocks), "contentBlocks": blocks}`). Plain narrative chunks still take the raw-delta fast path.
- Force-flush on reasoning-block close is preserved.
- A partial reasoning-tag prefix in `pending_reasoning_prefix` is treated as transport state only: if the stream ends mid-prefix, it is dropped from visible content rather than flushed.

### Frontend — defense-in-depth guard so raw tags never paint

In `src/patches/frontend/src/lib/components/chat/Chat.svelte`:

- The structured-streaming marker helper recognises the full backend-supported reasoning-tag set: `<think>` / `</think>`, `<thinking>` / `</thinking>`, `<reason>` / `</reason>`, `<reasoning>` / `</reasoning>`, `<thought>` / `</thought>` (any case), `<|begin_of_thought|>` / `<|end_of_thought|>`, `◁think▷` / `◁/think▷`, plus the existing `<details type="reasoning">` / `<details type="tool_calls">` markers.
- The same helper is reused by both raw-append paths (`chat:message:delta` / `message` socket events and `chatCompletionEventHandler` `choices[0].delta.content`) and by the snapshot-replacement guard.
- A streamed text chunk containing a reasoning marker skips the direct-append fast path and waits for the next normalized `content` snapshot from the backend. Plain-text streaming behaviour is unchanged.

### System-wide rule

After the fix:

- Raw reasoning tags are transport detail.
- The serialized `<details type="reasoning">` block is the only user-visible reasoning representation.

## Verification

- Backend unit tests cover full `<thinking>` streams, split-prefix streams (`<thi` + `nking>`), interrupted streams that end on a partial prefix, and a non-reasoning regression check that asserts the raw-delta fast path is preserved for plain text.
- Manual verification on a Atlas reasoning turn confirmed the live UI never displays literal `<thinking>` / `</thinking>`, the reasoning area appears directly as a `Thinking…` / `Thought` block, and final stored content is unchanged.
