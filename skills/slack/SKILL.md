---
name: slack
description: Search Slack conversations, threads, and channel activity efficiently. Use when the user asks about Slack messages, recent conversations, channel themes, thread context, or discussion summaries.
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Team
  version: "1.2"
  priority: high
  triggers:
    - "slack"
    - "slack conversation"
    - "slack conversations"
    - "slack thread"
    - "slack threads"
    - "channel activity"
    - "recent messages"
    - "recent slack"
    - "messages in slack"
required_mcp_servers:
  - "server:slack"
---

# Slack Skill

Use Slack tools for live Slack conversation research and summaries.

## Primary Tools

- `slack_conversations_search_messages` for finding candidate conversations
- `slack_conversations_history` for reading a selected channel window
- `slack_conversations_replies` for reading selected threads
- `slack_channels_list` for discovery only when the user needs channel lookup

## Channel and User References — Get the Format Right the First Time

Channel parameters (`channel_id`, `filter_in_channel`) accept EXACTLY
three shapes. Anything else is rejected with `invalid channel format`
before any search runs — never spend a failed call discovering this:

- A raw conversation ID: `C0123ABCDEF` (channels), `G…` (private),
  `D…` (DMs). IDs are always the safest reference — reuse them from any
  earlier result instead of re-resolving names.
- A hash-prefixed channel name: `#help-portico`. The leading `#`
  is mandatory — `help-portico` alone is invalid.
- A DM handle: `@username_dm`.

When the user names a channel in prose ("summarize help-portico"),
normalize it yourself: add the `#` before the first call.

Scoping a search to one channel: prefer Slack's native query operator
over the filter parameter — put `in:#channel-name` inside `search_query`
(e.g. `search_query="in:#help-portico"` plus your keywords).
Slack resolves the name server-side, which also covers org-wide channels
hosted on other grid workspaces that local name lookup cannot see. The
result rows include the channel ID — reuse it for `conversations_history`
and `conversations_replies`.

If a `#name` reference returns "not found", do not widen scope or guess
alternative spellings: resolve it with one `search_query="in:#name"`
call and continue with the ID from the results.

## Posting Messages — Confirmation Required

`slack_conversations_add_message` posts a message into a channel, DM, or
group DM. Use it only when the user has just asked, in their immediately
previous turn, to send THIS exact message to THIS exact destination.

Required workflow before calling `slack_conversations_add_message`:

1. Show the user the proposed message in plain text. Include the
   destination (channel/DM/mpim id and human-readable name when known)
   and the FULL message body, character-for-character.
2. Ask a direct yes/no confirmation question, e.g. "Should I send this
   message to #foo now?".
3. Only call the tool after the user replies with an unambiguous "yes"
   / "do it" / "send it" directed at this exact action.

A bare "yes" earlier in the conversation, or agreement to a broader
plan, is NOT approval to post. If the user asks for edits, redraft the
message and re-confirm. The runtime will refuse to dispatch any
unconfirmed `slack_conversations_add_message` call and surface a
confirmation card; do not retry without a fresh user confirmation.

Read-only Slack tools (search, history, replies, channels_list) do not
require confirmation.

## Search Discipline

- Treat explicit channel lists and time windows in the delegated prompt as hard scope boundaries. Do not pivot to other channels unless the user explicitly asked to broaden scope or you need one brief alias lookup to map a named channel.
- Start with focused keywords tied to the project, incident, launch, bug, owner, or team.
- Avoid `search_query="*"` unless you have already failed with narrower searches and need a small fallback sample.
<!-- OPT_FLAG:slack_multi_channel_budget_guidance START -->
- Use modest initial search limits. Increase only when you have evidence the first pass missed essential coverage.
- Use a small number of searches per project/theme before you switch to synthesis or thread follow-up.
- Search the most relevant channels first instead of blasting every channel with the same broad query.
- For “last 2 weeks across many channels” tasks, do not run a keyword x channel matrix on the first pass.
- Start with workspace-wide searches for the major themes first. Only if that misses signal should you target individual channels.
- Keep the first pass focused for a multi-channel report unless you still have a material coverage gap.
- Do not call `slack_conversations_history` on every named channel. Use history only for requested channels that still have coverage gaps after search.
- Use `slack_channels_list` only after a channel lookup actually fails and that channel is critical enough to justify discovery.
- For a broad recent-conversation report, avoid history calls on the first pass unless the initial searches miss one of the named channels entirely.
<!-- OPT_FLAG:slack_multi_channel_budget_guidance END -->

## Thread Discipline

- Use `slack_conversations_replies` only for the strongest candidate threads.
- Do not read every thread returned by search.
<!-- OPT_FLAG:slack_multi_channel_budget_guidance START -->
- Prefer summarizing a small set of high-signal threads over exhaustively dumping channel history.
- Keep first-pass thread reads focused unless a missing theme genuinely requires more.
- When the task names many channels, stop after you have one representative thread per major theme. Do not try to prove coverage with a thread from every single channel.
- For broad multi-channel reports, prefer early synthesis once the main themes have representative evidence; only continue searching for a specific named gap.
- Dedupe candidate threads by `thread_ts` before any reply reads. If the same thread appears in multiple searches, it still counts as one thread and should be opened once.
- Never call `slack_conversations_replies` more than once for the same `thread_ts`.
- In delegated multi-channel summaries, avoid opening redundant threads after the main themes are represented.
- After you have representative threads for the main themes, synthesize. Do not keep opening more threads just to improve channel-by-channel coverage.
<!-- OPT_FLAG:slack_multi_channel_budget_guidance END -->

## Handling Large Payloads

- If a Slack tool returns `overflow_file: true`, do not `cat` the raw overflow file.
- Immediately compact Slack CSV/text overflow with `agent_vm_execute_skill_script`:

```text
agent_vm_execute_skill_script(
  skill_name="slack",
  script_name="scripts/compact_slack_csv.py",
  vm_id="<vm_id from Slack result>",
  args=[
    "--input", "/work/.mcp-overflow/<file>.txt",
    "--output", "/work/slack/compact.json",
    "--max-items", "8",
    "--text-chars", "160",
    "--keyword", "advanced screening",
    "--keyword", "basic screening",
    "--keyword", "ai job management"
  ]
)
```

- Read the compaction script stdout summary first. Only inspect the compact JSON if the summary is missing something essential.
- The compaction stdout summary includes thread IDs, participants, and representative samples. Use that directly for thread follow-up instead of opening the compact JSON.
- Prefer `read_fragment(..., max_chars=1000-1500)` on reduced artifacts and never exceed `2000`.
- Keep any single inline extract under `2,000` chars.
<!-- OPT_FLAG:slack_multi_channel_budget_guidance START -->
- Do not read more than `2` chunks from the same Slack artifact unless you first create a smaller reduced artifact for one channel or thread.
- For a delegated Slack summary, read only the reduced Slack artifact fragments needed to fill concrete gaps.
<!-- OPT_FLAG:slack_multi_channel_budget_guidance END -->
- Prefer `slack_conversations_replies` or one narrower rerun of `compact_slack_csv.py` over reading the compact JSON.
- If you need to inspect many rows, write a reduced CSV/JSON/TXT artifact first, then read that artifact in small chunks.
- Keep `agent_vm_bash` and `agent_vm_python` stdout concise. Redirect bulky output to files instead of printing it.

## Hard Stops

<!-- OPT_FLAG:slack_multi_channel_budget_guidance START -->
- If you already have strong themes with representative evidence, stop searching and synthesize.
- Do not attempt exhaustive proof that every named channel discussed every project.
- If coverage is still uneven after focused searches, state that explicitly in the synthesis instead of continuing to expand scope.
<!-- OPT_FLAG:slack_multi_channel_budget_guidance END -->

## Reporting Workflow

1. Identify likely channels and themes with focused `slack_conversations_search_messages` queries.
2. For broad multi-channel requests, start with `1` workspace-wide search per major theme and only add targeted channel searches when the global results are too noisy or missing expected coverage.
3. Compact any large search/history/replies artifact before reading it.
4. Select the few threads/messages that best represent each theme from the compact summary.
5. Read thread replies only for those selected discussions.
6. Build a structured synthesis by theme, including notable accomplishments, blockers, owners, and timing.
