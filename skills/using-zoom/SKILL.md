---
name: using-zoom
description: Find Zoom meetings and retrieve meeting assets, recordings, transcripts, summaries, action items, and playback links through Glean. Use when a user asks about Zoom meetings, recordings, transcripts, AI summaries, next steps, or playing or jumping to a recorded moment.
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Team
  version: "1.0"
  priority: high
  triggers:
    - "zoom"
    - "zoom meeting"
    - "zoom meetings"
    - "zoom recording"
    - "zoom recordings"
    - "zoom transcript"
    - "zoom transcripts"
    - "zoom summary"
    - "zoom action items"
required_mcp_servers:
  - "server:glean"
---

# Use Zoom in Portico

## Prerequisite

This skill requires the Glean MCP server (`server:glean`). Use the Glean tools
attached to the current Portico conversation; Zoom tools use the
`glean_zoom_mcp_*` namespace. If Glean is unavailable or requires
authorization, follow Portico's normal integration guidance. Do not look
for, install, or configure a standalone Zoom MCP server.

## Find a meeting and its assets

1. If the user did not provide a meeting UUID, establish the user's current
   timezone before interpreting relative dates such as "yesterday." Discover
   the meeting with `glean_zoom_mcp_search_meetings`.
2. Prefer the returned `meeting_uuid` over a meeting number for later calls.
   If several meetings match, use the title, time, host, and participants to
   resolve the intended meeting; ask the user when the choice remains
   ambiguous.
3. Call `glean_zoom_mcp_get_meeting_assets` with the meeting UUID to retrieve
   the available summary, notes, recording, agenda, documents, whiteboards, and
   participant information.
4. Treat missing assets as a possible permission or processing-state result.
   Do not imply that an asset exists when Glean does not return it.

## Retrieve recording content

When the request involves a recording, transcript, summary, action item, next
step, or playback:

1. Call `glean_zoom_mcp_get_recording_resource` for the selected recording.
   Request only the resource types needed by the user.
2. Use transcript content for quoted or topic-specific answers, summary content
   for overviews, and `nextStep` content for action items.
3. For "play the part where..." requests, retrieve the transcript and playback
   URL, locate the relevant transcript timestamp, and request or construct the
   tool-supported playback result with `play_time`.
4. Preserve source timestamps and distinguish tool-provided content from your
   own synthesis. Convert UTC meeting times to the user's timezone when useful.

## Guardrails

- Respect the access controls reflected by Glean. Do not bypass permissions or
  expose meeting content beyond the user's authorized request.
- Follow the schemas and instructions returned by current tool discovery rather
  than guessing parameters or relying on a stale complete tool inventory.
- Do not add a Zoom MCP server, container, authentication flow, or replacement
  tool interface. The routing layer is Glean.

## Using from the MCP bridge

This is a secondary compatibility path for an agent operating through the Host
MCP Bridge rather than directly in Portico. Use `find_relevant_tools` to
discover the current `glean__zoom_mcp_*` tools, then invoke only returned tools
through `call_bridge_tool`. The principal bridge tools for this workflow are
`glean__zoom_mcp_search_meetings`, `glean__zoom_mcp_get_meeting_assets`, and
`glean__zoom_mcp_get_recording_resource`.
