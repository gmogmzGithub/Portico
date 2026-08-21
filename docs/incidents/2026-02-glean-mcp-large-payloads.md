# Glean MCP Large Response Payloads

## Summary

We are seeing a recent regression where Glean MCP tool calls return extremely large payloads. This is clearly happening for at least:

- `user activity`
- `search`
- `read document`

The payloads no longer look like compact tool responses intended for LLM consumption. Instead, they look much closer to raw or near-raw search/index records.

In practice this causes several problems:

- A single tool call can expand into an enormous token payload.
- MCP clients can hit output-size limits and return invalid or truncated JSON.
- Tool use becomes much more expensive than it should be.
- The model spends context budget parsing repeated metadata instead of useful signal.

The payload samples in this doc are good examples of the issue.

## What The Responses Look Like

### User Activity

At a high level the response shape is:

```json
{
  "activities": [
    {
      "activity": "CREATED | EDITED | MENTIONED",
      "created_at": "YYYY-MM-DD HH:MM:SS",
      "updated_at": "YYYY-MM-DD HH:MM:SS",
      "documentSummary": {
        "datasource": "googlecalendar | gmailnative | gdrive | zoom | slackentgrid | ...",
        "docType": "event | thread | Document | Spreadsheet | Presentation | meeting | ...",
        "title": "Human-readable title",
        "url": "Canonical link",
        "updateTime": "ISO timestamp",
        "owner": {
          "name": "Owner Name"
        },
        "attachments": [
          {
            "fileId": "...",
            "title": "...",
            "url": "..."
          }
        ],
        "percentRetrieved": "100.00%",
        "snippets": [
          "Human-readable snippet or excerpt",
          "{\"custom_facets\": ... }"
        ]
      }
    }
  ]
}
```

Important notes:

- `created_at` appears on some activity types, `updated_at` appears on others, and some entries only have `documentSummary.updateTime`.
- The useful business data is spread across both normal fields and large strings inside `documentSummary.snippets`.
- The second snippet is often not a natural-language snippet at all. It is a stringified JSON blob containing metadata and facet data.

### Search

The search response is shaped more like:

```json
{
  "documents": [
    {
      "createTime": "ISO timestamp",
      "updateTime": "ISO timestamp",
      "datasource": "confluence | slackentgrid | jira | gdrive | ...",
      "title": "Title",
      "url": "Canonical link",
      "owner": {
        "name": "Owner Name"
      },
      "matchingFilters": {
        "...": ["many", "facet", "values"]
      },
      "snippets": [
        "snippet 1",
        "snippet 2",
        "..."
      ],
      "... datasource-specific fields ...": "..."
    }
  ]
}
```

Important notes:

- Search results are highly heterogeneous across datasources.
- `matchingFilters` can be very large and include many arrays of facet values.
- Some results include datasource-specific blobs that are not MCP-friendly, such as `linkedIssues` containing JSON serialized into a string.
- Some results include long thread bodies or article excerpts as many separate snippet strings.
- Some results include boilerplate fallback text such as "We do not have snippets for this document...", which still consumes tokens without adding much signal.

### Read Document

The read document response is shaped more like:

```json
{
  "Documents": [
    {
      "Title": "Document title",
      "Datasource": "gdrive",
      "Url": "Canonical link",
      "AuthorName": "Author",
      "Content": [
        {
          "Snippets": [
            {
              "SnippetText": "line of document text",
              "Metadata": {
                "closest_header": "section header"
              },
              "SegmentIndex": 0,
              "...": "..."
            }
          ]
        }
      ],
      "Hit": {
        "_source": {
          "all_snippetable_text_2": ["same content again", "..."]
        },
        "highlight": {
          "all_snippetable_text_2": ["large encoded highlight payload"]
        }
      }
    }
  ]
}
```

Important notes:

- The useful document text appears in `Content`, but the response also includes a large amount of search-index internals in `Hit`.
- Each small text fragment is wrapped in repeated metadata structures.
- The same content appears multiple times in different representations.
- The `highlight` payload appears especially large and looks like search-engine/debug output rather than MCP-facing content.

## Where The Payload Size Comes From

The size problem is not just "many activities". It is also that each activity is individually very heavy.

### 1. `snippets` contains far more than snippets

For many activities, `documentSummary.snippets` contains:

- Large excerpts from docs, spreadsheets, presentations, email threads, Slack threads, and calendar invites
- Full Zoom join blocks and invite boilerplate
- Full Slack thread bodies including replies
- Large serialized metadata objects embedded as strings

This is the single biggest source of bloat.

### 2. Metadata is duplicated in multiple forms

The same information often appears more than once:

- `owner.name` and owner values again inside custom facets
- `updateTime` plus event timestamps embedded inside stringified JSON
- participant lists as arrays and again as a comma-separated `meetingParticipants` string
- attachments as structured objects plus references in snippets

This looks denormalized for retrieval/debugging, but it is very expensive for MCP use.

### 3. The stringified JSON snippet is especially expensive

Many entries include a second snippet that looks like this:

```json
"{\"custom_facets.user_facet_canonical_names\": { ... }, \"eventStartTime\": \"...\", ... }"
```

This is costly for several reasons:

- It duplicates fields already present elsewhere
- It is embedded as a string rather than as normal structured JSON
- It often contains very large arrays such as `mentions`, `participants`, and `meetingParticipants`
- It includes fields that are useful for analytics/indexing but not for a default MCP summary

### 4. Calendar data is especially verbose

Calendar records often include:

- full invite text
- passcodes and dial-in blocks
- large participant lists
- recurrence IDs
- event start/end metadata
- visibility and status fields

Recurring events are also represented as many separate edited instances, which multiplies the total size quickly.

### 5. The same real-world object appears in multiple mirrored records

A single meeting may appear as:

- a Google Calendar event
- a Gmail invite / accepted / declined thread
- a Zoom meeting record
- a Drive notes document
- a Slack thread about the meeting

That may be correct from an indexing perspective, but it is not a good default for an MCP tool unless there is strong deduplication or summarization.

### 6. Large participant / mention arrays dominate many entries

Some records include very large lists in:

- `mentions`
- `participants`
- `meetingParticipants`
- other `custom_facets.user_facet_canonical_names.*`

These lists are often repeated across mirrored artifacts and repeated again inside the stringified metadata snippet.

### 7. Search returns very large facet payloads by default

In the search examples, many results include a large `matchingFilters` object with arrays for:

- app
- department
- documentcategory
- labels / tags
- workspace
- status
- type
- many other datasource-specific dimensions

This is useful for faceting or debugging search results, but it is expensive and usually not necessary for an MCP tool response.

### 8. Search results contain datasource-specific fields that are effectively raw records

Examples from the sample search response include:

- Jira issue metadata such as components, labels, project fields, priorities, and status
- Slack workspace lists and reactions
- channel metadata
- fields like `linkedIssues` containing a large JSON blob serialized into a string

This suggests the search tool is returning a broad union of raw datasource schemas rather than a compact normalized search result.

### 9. Search snippets are often entire articles, threads, or playbooks

In the sample search response, a single result can include dozens of snippet entries. For example:

- long Confluence how-to articles
- multi-message Slack threads
- Jira ticket descriptions and technical details

This makes result lists extremely expensive before the user has even selected which document to inspect.

### 10. Read document returns line-level wrappers around every text fragment

In the sample read response, each short line or bullet point is wrapped in a full structure containing:

- score
- snippet source
- type
- snippet metadata
- mime type
- page number
- ranges
- segment index
- snippet ordering

That is a lot of JSON overhead per line of actual text.

### 11. Read document appears to include both parsed content and raw index internals

The sample read response includes:

- `Content` with extracted snippet text
- `Hit._source.all_snippetable_text_2` with the same content again
- `Hit.highlight.all_snippetable_text_2` with a very large encoded payload
- additional search/index fields such as `matched_queries`, `_score`, and document source internals

This is one of the clearest signs that the MCP response is leaking internal retrieval structures.

### 12. Empty, default, and repeated fields add noise

Examples seen in the samples:

- `Score: 0` repeated everywhere
- `Ranges: []`
- `ImageMetadata: null`
- empty `Url`
- `Type: "UNKNOWN"`
- `PercentRetrieved` / `percentRetrieved` repeated on almost every object

These fields are low-value in the default MCP response and add substantial overhead at scale.

### 13. The response contract is inconsistent across tools

The samples also show inconsistent schema conventions:

- `documents` vs `Documents`
- `createTime` vs `created_at`
- `docType` vs `Doctype`
- `owner.name` vs `AuthorName` vs `ownedAndUpdatedBy.name`

This inconsistency is not the main source of token bloat, but it makes MCP integration harder and increases client-side normalization work.

## What This Payload Is Telling Us

The responses appear to be returning richly indexed source records rather than MCP-oriented summary views.

In other words, the payload currently looks optimized for:

- document retrieval
- search debugging
- ranking context
- index inspection
- internal analytics / facets

It does not look optimized for:

- LLM tool calling
- token efficiency
- bounded JSON responses
- deterministic structured output

## Why This Is A Problem For MCP

For MCP and LLM usage, the default response should be compact, predictable, and cheap to parse.

The current shape is a poor fit because:

- token cost scales with repeated boilerplate, not with useful signal
- the model must parse embedded JSON strings inside arrays of natural-language snippets
- the model must also parse raw search/index internals that it should never have seen
- mirrored records force the model to deduplicate mentally
- truncation at transport or client limits can produce invalid JSON
- large raw payloads crowd out the rest of the conversation context

This is consistent with reports that clients are hitting size ceilings and receiving malformed output once the payload is cut off.

## Recommendations For The Glean Team

### 1. Make the default MCP response compact

The default should return only the fields most useful to an assistant:

- activity type
- one canonical timestamp
- datasource
- doc type
- title
- canonical URL
- owner
- a short snippet

Everything else should be opt-in.

### 2. Stop putting large metadata blobs inside `snippets`

`snippets` should contain only actual short human-readable snippets.

The stringified JSON metadata blob should either:

- be removed from the default response, or
- move into a separate structured field returned only when explicitly requested

If returned, it should be actual JSON, not JSON serialized into a string.

### 3. Add explicit field-selection controls

Examples:

- `max_activities`
- `include_snippets`
- `snippet_char_limit`
- `include_attachments`
- `include_facets`
- `include_participants`
- `include_raw_metadata`
- `dedupe`

For MCP, the safe defaults should be conservative.

### 4. Cap large arrays by default

For example:

- include the first few participants only
- provide `participant_count`
- provide `mention_count`
- omit full participant lists unless requested

This preserves useful signal without shipping hundreds of names by default.

### 5. Dedupe mirrored artifacts

Where possible, collapse activity records that clearly refer to the same underlying object or event.

Examples:

- calendar event + Gmail invite + Zoom meeting
- multiple records for the same recurring series instance
- repeated copies of the same doc edit surfaced through different views

At minimum, provide enough stable IDs for clients to dedupe cleanly.

### 6. Offer a summary mode and a hydration mode

A good pattern would be:

- default "summary" response: cheap, short, bounded
- follow-up "hydrate this one record" call: richer detail for a single selected result

That keeps the default tool call cheap while still allowing deep inspection when needed.

### 7. Guarantee valid JSON under truncation limits

If the server enforces byte or token limits, it should:

- truncate at record boundaries, not in the middle of JSON
- return valid JSON always
- include explicit indicators such as `truncated: true`
- include a `next_page_token` or equivalent

Returning cut-off JSON is especially harmful for MCP clients.

### 8. Consider an MCP-specific response contract

Search/index APIs and MCP/LLM APIs have different requirements.

If the current payload shape is coming from a shared backend response, it may be worth adding an MCP-specific presentation layer that:

- strips retrieval-only fields
- shortens snippets
- deduplicates noisy records
- enforces hard response budgets

### 9. Normalize the response schema across tools

At minimum, the MCP-facing contract should use consistent naming and field conventions across tools.

Examples:

- consistent casing
- one canonical timestamp field per item
- one canonical owner field
- one canonical snippet field
- one canonical document type field

This reduces both integration complexity and prompt complexity.

### 10. Search should return compact result cards, not raw source records

A default search result should look more like:

- id
- datasource
- doc type
- title
- url
- owner
- last updated timestamp
- one short snippet

Fields like `matchingFilters`, reactions, workspace lists, linked issue graphs, and datasource-specific metadata should be opt-in.

### 11. Read document should return normalized content only

The default document-reader response should not include:

- raw `Hit` internals
- `_source`
- encoded `highlight` payloads
- repeated zero/default fields on every line

Instead it should return either:

- plain text, or
- a small list of chunks with only the text and minimal location metadata

### 12. Remove placeholder boilerplate from default responses

Strings like:

- "We do not have snippets for this document..."

should be replaced with a compact signal such as:

- `snippet_available: false`

That conveys the same information far more cheaply.

## Proposed Compact Response Shape

### User Activity

Something like this would be much more MCP-friendly:

```json
{
  "activities": [
    {
      "activity": "EDITED",
      "timestamp": "2026-03-06T18:43:42Z",
      "datasource": "gdrive",
      "docType": "Document",
      "title": "Portico 2026 (beta)",
      "owner": "Dionny Santiago",
      "url": "https://docs.google.com/document/d/...",
      "snippet": "Portico has been re-architected from the ground up...",
      "attachment_count": 0
    }
  ],
  "truncated": true,
  "next_page_token": "..."
}
```

If richer detail is needed, a second call could fetch the full metadata for a selected activity.

### Search

```json
{
  "documents": [
    {
      "id": "ITOPS-7400",
      "datasource": "jira",
      "docType": "Epic",
      "title": "Portico employees cannot check their laptop refresh eligibility date...",
      "url": "https://portico.atlassian.net/browse/ITOPS-7400",
      "owner": "Mo Sirker",
      "updated_at": "2026-01-23T15:16:45Z",
      "snippet": "Employees are experiencing a lack of visibility into their laptop refresh eligibility date...",
      "snippet_available": true
    }
  ],
  "truncated": true,
  "next_page_token": "..."
}
```

### Read Document

```json
{
  "documents": [
    {
      "id": "GDRIVE_1Hc-Wa50YFfsDnZWceMHfmuVEGbVmv6DGMHpoP0hEzE8",
      "datasource": "gdrive",
      "docType": "Document",
      "title": "Notes - Feature Decay",
      "url": "https://docs.google.com/document/d/...",
      "author": "Dionny Santiago",
      "content": [
        {
          "section": "Jan 4, 2023 | Feature Decay",
          "text": "# Jan 4, 2023 | Feature Decay\nAttendees: ...\nAgenda:\n1. Talk through concerns ..."
        }
      ],
      "content_trimmed": false
    }
  ]
}
```

## Bottom Line

The issue is not only that the responses contain a lot of records. The deeper problem is that the default MCP payloads are carrying too much denormalized content and too many internal fields by default:

- long body excerpts
- invite boilerplate
- full thread content
- large participant lists
- large facet payloads
- datasource-specific raw metadata
- raw index/search internals
- repeated metadata
- stringified JSON blobs inside `snippets`

That makes the payload inappropriate as a default MCP response. A compact summary-by-default contract with explicit opt-in for raw metadata would materially reduce cost, reduce client breakage, and make the tool much more usable for LLM workflows.
