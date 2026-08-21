# Glean MCP Regression Timeline

## Summary

I inspected historical Open WebUI chat history stored in the local SQLite database at:

- `open-webui-data/webui.db`

The Glean MCP tool results are stored inside the `chat` table, in the `chat.chat` JSON blob, under:

- `history.messages[*].content`

Tool call results are embedded in assistant message HTML like:

```html
<details type="tool_calls" ... name="glean_search" ... result="...">
```

From that history, there is clear evidence that multiple Glean tools changed response format over time from compact assistant-friendly summaries to large raw JSON payloads.

The strongest regression date is:

- **February 20, 2026** for `glean_search` and `glean_read_document`

A second regression date is:

- **March 6, 2026** for `glean_chat`

For `glean_user_activity`, the earliest calls I found were already regressed on:

- **March 7, 2026**

## Method

I analyzed historical chats from the last 90 days and extracted Glean tool calls from assistant message content.

The main Glean tool names found in history were:

- `glean_search`
- `glean_read_document`
- `glean_chat`
- `glean_user_activity`
- `glean_employee_search`
- `glean_code_search`

For each tool call, I extracted:

- timestamp
- tool name
- serialized result length
- high-level response shape
- title of the containing chat

I classified responses into shapes such as:

- markdown summary
- plain text / markdown
- raw JSON with `documents`
- raw JSON with `Documents`
- raw JSON with `messages`
- raw JSON with `activities`

## Findings

### 1. `glean_search` changed on February 20, 2026

There is definitive evidence that `glean_search` switched from summarized markdown output to raw `documents` JSON on **February 20, 2026**.

Last old-format response:

- Timestamp: `2026-02-20 01:41:14 UTC`
- Chat: `🆔 Your Teamworks Team IDs`
- Length: `66,381` characters
- Format: markdown summary
- Prefix:

```text
## Search Results (21 found)  ### 1. Andrew / Dionny 1-1 ...
```

First new-format response:

- Timestamp: `2026-02-20 20:15:19 UTC`
- Chat: `🌍 Multi-Location Filtering Caveat`
- Length: `103,923` characters
- Format: raw JSON
- Prefix:

```json
{
  "documents": [
    {
      "title": "Nexus Language Filtering: Issues & Solutions",
      "datasource": "gdrive",
      ...
```

Additional evidence:

- Total `glean_search` calls found: `1053`
- Shape counts:
  - `881` markdown summary
  - `66` raw `documents` JSON
  - `72` other
  - `34` empty
- After the first raw JSON response on `2026-02-20`, every later non-empty raw-format result stayed in the raw `documents` JSON shape.

Size comparison:

- Old markdown summary median: `70,921` chars
- New raw JSON median: `103,976.5` chars
- Approximate increase: `1.47x`

### 2. `glean_read_document` changed on February 20, 2026

There is definitive evidence that `glean_read_document` switched from summarized retrieval output to raw `Documents` JSON on **February 20, 2026**.

Last old-format response:

- Timestamp: `2026-02-09 04:48:29 UTC`
- Chat: `📊 EJP Platform Infrastructure Ramp Report`
- Length: `29,314` characters
- Format: markdown retrieval summary
- Prefix:

```text
## Retrieval Status  - **Requested**: 2 document(s) - **Successfully retrieved**: 2 ...
```

First new-format response:

- Timestamp: `2026-02-20 20:15:19 UTC`
- Chat: `🌍 Multi-Location Filtering Caveat`
- Length: `53,817` characters
- Format: raw JSON
- Prefix:

```json
{
  "Documents": [
    {
      "Id": "GDRIVE_1umtPslLrLWCNnQFXibW5WscBGJAuSzfB4muXhUQg7YA",
      "AuthorName": "Dionny Santiago",
      ...
```

Additional evidence:

- Total `glean_read_document` calls found: `127`
- Shape counts:
  - `48` markdown summary
  - `3` raw `Documents` JSON
  - `76` other
- After the first raw JSON response on `2026-02-20`, all later successful raw-format responses were in the raw `Documents` JSON shape.

Size comparison:

- Old markdown summary median: `42,900.5` chars
- New raw JSON median: `165,266` chars
- Approximate increase: `3.85x`

Largest observed example:

- Timestamp: `2026-03-06`
- Chat: `New Conversation Started`
- Length: `4,268,312` characters
- Format: raw `Documents` JSON

This is consistent with the report that a single document-read can consume an extremely large token budget.

### 3. `glean_chat` changed on March 6, 2026

There is definitive evidence that `glean_chat` switched later than the other two tools, on **March 6, 2026**.

Last old-format response:

- Timestamp: `2026-02-20 01:41:14 UTC`
- Chat: `🆔 Your Teamworks Team IDs`
- Length: `976` characters
- Format: plain text / markdown answer
- Prefix:

```text
Based on the available search results, the Teamworks team ID for a team managed by Dionny Santiago ...
```

First new-format response:

- Timestamp: `2026-03-06 01:24:54 UTC`
- Chat: `📰 This Week at Portico`
- Length: `105,182` characters
- Format: raw JSON
- Prefix:

```json
{
  "messages": [
    {
      "agentConfig": {
        "agent": "DEFAULT",
        "mode": "DEFAULT"
      },
      ...
```

Additional evidence:

- Total `glean_chat` calls found: `67`
- Shape counts:
  - `55` text / markdown
  - `4` raw `messages` JSON
  - `8` empty
- After the first raw JSON response on `2026-03-06`, all later non-empty responses were raw `messages` JSON.

Size comparison:

- Old text / markdown median: `3,553` chars
- New raw JSON median: `113,256` chars
- Approximate increase: `31.9x`

### 4. `glean_user_activity` is already regressed in the first calls found

I found only two `glean_user_activity` calls in the last 90 days, and both were already in the large raw `activities` JSON shape.

Observed calls:

1. `2026-03-07 01:20:28 UTC`
   - Chat: `📅 Portico Weekly Updates`
   - Length: `367,554` chars
   - Prefix:

```json
{
  "activities": [
    {
      "activity": "CREATED",
      "created_at": "2026-03-06 23:00:00",
      ...
```

2. `2026-03-09 03:16:21 UTC`
   - Chat: `What's going on at Portico this week?`
   - Length: `366,411` chars

Because there are no earlier `glean_user_activity` calls in the sampled chat history, I cannot prove the exact transition date for this tool. I can only say that by **March 7, 2026** it was already returning the regressed raw payload shape.

## Strongest Evidence

The strongest evidence of a Glean-side contract change is:

1. The format changes are abrupt, not gradual.
2. The change affects multiple Glean tools.
3. The new formats expose raw top-level transport objects:
   - `documents`
   - `Documents`
   - `messages`
   - `activities`
4. After the first switch date for each tool, responses remain in the new raw format.
5. The new responses are materially larger and carry raw retrieval/index structures instead of assistant-oriented summaries.

Inference:

- This does **not** look like prompt variation.
- This **does** look like a response-contract change on the Glean MCP side or in an adjacent Glean integration layer.

## Practical Timeline

- `2026-02-20`: `glean_search` flips from markdown summary to raw `documents` JSON
- `2026-02-20`: `glean_read_document` flips from retrieval summary to raw `Documents` JSON
- `2026-03-06`: `glean_chat` flips from plain text / markdown to raw `messages` JSON
- `2026-03-07`: earliest observed `glean_user_activity`, already returning raw `activities` JSON

## Conclusion

There is definitive evidence in Open WebUI historical chat data that major Glean MCP response regressions began on **February 20, 2026**, with additional regression on **March 6, 2026**.

The clearest pattern is a tool-by-tool shift away from compact assistant-facing summaries and toward raw structured payloads that expose underlying retrieval and document objects directly. This matches the current symptoms:

- dramatically larger payloads
- higher token cost
- more brittle client handling
- malformed output risk when clients or transports truncate oversized responses

