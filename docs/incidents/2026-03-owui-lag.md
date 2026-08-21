# Open WebUI Streaming Lag (March 2026)

**Layers affected:** Chat UI (Svelte streaming renderer + scroll lock), MCP Orchestration / LLM Routing (backend stream pacing).

## Symptom

Chat UI was responsive when idle, but became visibly slow only *while* the assistant was actively streaming a long answer. Users reported drip-fed tokens, scroll jitter, `setTimeout` long-task violations in DevTools, and `commitMs` rising linearly with content length. After the stream completed the UI was fast again. A separate symptom — `<!---->` artifacts leaking into rendered text and an invisible (black-on-black) main scrollbar — was reported in the same window.

## Root cause

A Chrome Performance trace identified two compounding O(n) bottlenecks in the streaming render path, plus one O(n) "fallback":

1. **Full-content re-tokenization on every streaming commit.** `Markdown.svelte` ran `marked.lexer()` on the *entire* message content for every chunk. At ~80k chars this cost ~14 ms by itself. The custom `<details>` tokenizer extension ran `src.search(/<details/i)` at every block boundary, making it a profiled hot-spot.
2. **Full DOM reconstruction in `MarkdownTokens.svelte`.** `{#each tokens as token, tokenIdx (tokenIdx)}` used index-based keying, but `marked.lexer()` returns all-new objects on every call. Svelte therefore treated every item as changed and called `create_fragment_from_html` for every token. This accounted for ~93.5% of total rendering time in the bottom-up profiler view.
3. **Plain-text fallback was still O(n).** The `STREAMING_PLAIN_RENDER_THRESHOLD_CHARS = 1200` workaround forced plain text for long streaming content, but updating a single text node with 80k chars forces the browser to re-layout the entire text block (word wrap, line breaks) on every commit, so `commitMs` still grew linearly.

A separate, smaller class of issues amplified the perceived jank: redundant auto-scroll writers (post-commit `tick`, `ResizeObserver`, a 50 ms polling interval, and a final delayed snap) creating layout-read-after-write churn during streaming, and stale `done=false` assistant messages stuck in plain-text streaming mode.

## Fix

### Incremental Markdown rendering (O(delta) per commit)

`Markdown.svelte` was rewritten to layer two optimizations:

1. **Incremental lexing.** During streaming, maintain a stable prefix of already-lexed tokens and only run `marked.lexer()` on the ~500-char growing tail. Reduces lexer cost from O(n) to O(delta).
2. **Token reference reuse.** Compare fresh tokens with previous ones by `type` + `raw`; substitute the old JS object reference where they match. Svelte's keyed `{#each}` then sees the same reference and skips `create_fragment_from_html` entirely for unchanged items. Reduces DOM work from O(n) to O(delta).

### Removed the plain-text fallback

`ResponseMessage.svelte` no longer drops to plain text for long streaming content. With incremental rendering, full markdown renders during streaming without growing cost. The `disable_markdown_renderer` localStorage toggle is retained for A/B debugging.

### Relaxed commit pacing

`Chat.svelte` previously backed off to 700–2200 ms commit intervals for long messages. With O(delta) commit work, frequent commits no longer overwhelm the browser, so the curve was relaxed to 150–350 ms.

### `<details>` tokenizer fast path

`extension.ts` adds a `src.indexOf('<d')` check before the regex `src.search(/<details/i)`. For content without `<details>` tags (the vast majority) this eliminates the O(remaining-length) regex search at every block boundary.

### Adjacent fixes shipped in the same window

- Sanitize `<!---->` framework comment artifacts from stream / replacement paths.
- Normalize stale assistant messages (`done=false` with no active task) to a terminal state with an age guard, so they no longer render in plain-text streaming mode.
- Make the chat scroll bar visible/readable in the dark theme.
- Add a backend `[STREAM-TPS]` periodic + final log so frontend timestamps can be correlated with backend throughput.

## Expected performance

| Metric | Before | After |
|---|---|---|
| `commitMs` at 80k chars | ~200 ms | ~7 ms |
| Commits / sec at 80k chars | 0.5 | ~5 |
| DOM nodes created per commit | all (~800) | delta only (~3) |
| `marked.lexer()` input size | full content | ~500-char tail |
| Frame budget headroom | -184 ms (over) | +9 ms (under) |

## Diagnostic toggles

- Frontend stream perf logs: `localStorage.setItem('stream_perf_logging', 'true'); location.reload();` (default off).
- Markdown A/B: `localStorage.setItem('disable_markdown_renderer', 'true' | 'false'); location.reload();`.
- Backend `[STREAM-TPS]` emits unconditionally from the stream handler during active streams.
