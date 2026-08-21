# Cross-Tool Routing Rules & Examples

## Cross-Tool Routing Rules

### Prefer Slack MCP for Slack-specific requests

If the user is asking for specific Slack information such as:
- channel history
- recent messages
- a thread or conversation
- a Slack URL
- a specific channel, DM, or person in Slack

Then prefer the Slack MCP server over Glean **when Slack is already available to use**.

**Slack routing policy:**
- If Slack is ACTIVE for the chat, use Slack tools.
- If Slack is enabled system-wide but not yet attached to the chat, activate it and use Slack tools.
- If Slack is DISABLED, do **not** push the user into enabling/configuring Slack from this skill. Fall back to Glean instead.
- If Slack is otherwise not ready or not configured, prefer the Glean fallback instead of steering into Slack setup.

### Prefer Google Workspace MCP for Google content

If the user is asking for specific Gmail, Google Calendar, meeting, Google Docs, or Drive information, prefer Google Workspace MCP over Glean.

**Google Workspace routing policy:**
- Use Google Workspace tools for Gmail search/read, meeting/calendar lookup, and reading Google Docs/Drive files.
- If Google Workspace is enabled system-wide but not yet attached to the chat, activate it and use it.
- If Google Workspace is DISABLED or needs authentication, it is acceptable to run the normal enable/auth/activate flow automatically because setup is usually just a quick OAuth consent.
- Do not keep using Glean for Google-specific retrieval just because Google Workspace is not active in the current chat yet.

### Avoid non-search Glean tools when a native integration fits better

Even if Glean exposes tools for chat/synthesis or service-specific retrieval, avoid these when a native integration is the better source:
- Avoid `glean_chat` unless search results were not enough.
- Avoid `glean_read_document` when Google Workspace can read the source document directly.
- Avoid `glean_gmail_search`, `glean_meeting_lookup`, and `glean_read_document` when Google Workspace can answer the request.
- Avoid Glean for Slack-specific retrieval when Slack MCP is already available.

## Decision Tree

```
User Request
    |
    v
Is it about Slack-specific information?
    |
    |-- YES --> Is Slack ready / activatable for this chat?
    |           |
    |           |-- YES --> Use Slack MCP tools
    |           |-- NO --> Fall back to Glean Search
    |
    |-- NO --> Is it about Gmail, meetings/calendar, Google Docs, or Drive?
                |
                |-- YES --> Use Google Workspace MCP tools
                |           (enable/auth/activate if needed)
                |
                |-- NO --> Is it about company documentation/policies/knowledge?
                            |
                            |-- YES --> Use Glean Search first
                            |           |
                            |           |-- If search is insufficient --> Glean Chat as last resort
                            |
                            |-- NO --> Does user have a specific URL or service?
                                        |
                                        |-- YES --> Use that service's tool
                                        |-- NO --> Consider other tools/skills
```

## Example Usage

### Searching for Documentation
```
User: "Find our API authentication documentation"

1. Skill auto-activates (triggers: "documentation")
2. Use glean_search(query="API authentication documentation")
3. Return relevant results with summaries and source links
```

### Policy Questions
```
User: "What's our PTO policy?"

1. Skill auto-activates (triggers: "policy")
2. Use glean_search(query="Portico PTO policy")
3. If search results are insufficient, use glean_chat as a last resort
4. Return the answer with sources
```

### Technical Guides
```
User: "How do I set up my dev environment?"

1. Skill auto-activates (triggers: "internal docs")
2. Use glean_search(query="developer environment setup guide")
3. Return relevant runbooks and guides
```

### Slack-Specific Information
```
User: "What was posted in the #hiring-ops Slack channel this morning?"

1. If Slack MCP is already available or can be activated for this chat, use Slack tools instead of Glean
2. If Slack is disabled or not ready, do not steer into Slack setup from this skill
3. Fall back to glean_search(query="hiring-ops this morning")
```

### Google Workspace Content
```
User: "Find the meeting notes from yesterday's roadmap review"

1. Prefer Google Workspace MCP over Glean for meeting/calendar/docs retrieval
2. If Google Workspace is not active in the chat yet, activate it
3. If Google Workspace is disabled or needs OAuth, it is acceptable to enable/auth/activate it automatically
4. Use Glean only as a fallback if the native Google tools are unavailable or insufficient
```

## Common Mistakes to Avoid

| User Request | WRONG Approach | RIGHT Approach |
|-------------|----------------|----------------|
| "Check this GitLab MR: gitlab.com/..." | Use Glean | Enable GitLab tool, use directly |
| "What's in my recent Slack messages?" | Use Glean first by default | Use Slack if it is already available; otherwise fall back to Glean without pushing Slack setup |
| "Search my Gmail for the hiring update" | Use Glean | Use Google Workspace |
| "What meetings do I have today?" | Use Glean | Use Google Workspace |
| "Read this Google Doc for me" | Use `glean_read_document` first | Use Google Workspace document tools first |
| "This Glean search overflowed into `/work/.mcp-overflow/...`" | Dump the raw file with `cat` or large `jq` output | Run `scripts/compact_glean_payload.py`, inspect the reduced file, then continue |
| "Search for current React 19 docs" | Use Glean | Use web-search skill (external info) |
| "Find our API auth documentation" | Enable random tools | Use this skill (Glean) |
