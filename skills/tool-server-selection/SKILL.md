---
name: tool-server-selection
description: Dynamically select and enable tool servers based on user needs. Use when determining which tools to enable, analyzing available servers, or enabling multiple tools for a task.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.0"
  priority: medium
  triggers:
    - "enable tool"
    - "which tool"
    - "what tools"
    - "available tools"
    - "enable server"
---

# Tool Server Selection Skill

This skill provides guidance for dynamically selecting and enabling tool servers based on user needs.

## Core Concepts

### Tool Server Architecture

**Core Tool Servers** (Always Enabled):
- `server:mcp-assistant` - MCP server management
- `server:subagents` - Agent delegation
- `server:skills` - Skill activation and management
- `server:agent-vm` - Agent VM tool surface; VM containers are created on demand

**Skill-Activated Tool Servers**: Enabled automatically when skills activate
- `server:glean` - via `company-knowledge` skill
- `server:web-tools` - via `web-search` skill
- `server:artifacts` - via `artifacts` skill

**Additional Tool Servers**: Enabled dynamically based on user needs
- Examples: GitLab, Slack, Google Workspace, PostgreSQL, MongoDB
- IDs are STABLE: `server:gitlab-mcp`, `server:slack`, etc.

### Understanding OWUI Tool Architecture

- Each MCP server has ONE stable ID: `server:<folder-name>`
- One server can provide multiple tools sharing the same ID
- IDs are based on folder names and NEVER change

## Runtime System Injections

The system **automatically injects** critical information into **every chat request**:

### 1. Available Tool Servers
```
Available Tool Servers:
- server:glean (Glean): Internal knowledge base access
- server:gitlab-mcp (GitLab): Repository management
- server:slack (Slack): Messaging integration
...
```

### 2. Currently Enabled Tools
```
Currently Enabled Tool Servers for This Chat: server:mcp-assistant, server:subagents, server:glean
```

### 3. Chat ID
```
Chat ID: abc-123-xyz
```

**IMPORTANT**: Do NOT call `mcp_assistant_list_mcp_servers` to answer "what tools are available" - this information is already in your system messages!

## Making Tool Selection Decisions

When a user request requires additional capabilities:

1. **Review available tool servers** (automatically in your context)
2. **Determine which tools are needed** based on:
   - User's explicit request
   - Task requirements
   - Domain of the question
3. **Extract chat_id** from system message
4. **Enable the needed tools** directly:
   ```
   mcp_assistant_activate_integration(
     chat_id="abc-123-xyz",
     tool_server_ids=["server:gitlab-mcp"]
   )
   ```
5. **Use the newly enabled tools** to complete the request

## When to Use MCP Context Resolver

**Only invoke** the MCP Context Resolver subagent when:
- User's request is ambiguous
- Need to analyze tool specifications in detail
- Multiple tool servers could work and need expert guidance

**Do NOT use MCP Context Resolver when:**
- Needed tools are obvious from the request
- User explicitly mentions a tool or service by name
- Clear determination from available tool descriptions

## Example Workflows

### Example 1: Using Skill-Activated Tool (Glean)

**User**: "Search our Glean knowledge base for API authentication documentation"

**Action**:
1. Recognize this needs company knowledge search
2. Activate `company-knowledge` skill (auto-enables Glean)
3. Use Glean search tools
4. Return results

### Example 2: Enabling Additional Tool (GitLab)

**User**: "Check my GitLab merge requests"

**Action**:
1. Recognize GitLab is needed (not a core tool)
2. Review available tools → see `server:gitlab-mcp`
3. Extract chat_id → "Chat ID: abc-123-xyz"
4. Enable GitLab:
   ```
   mcp_assistant_activate_integration(
     chat_id="abc-123-xyz",
     tool_server_ids=["server:gitlab-mcp"]
   )
   ```
5. Use GitLab tools to fetch merge requests
6. Present results

**Why no Context Resolver?** User explicitly mentioned "GitLab"!

### Example 3: Simple Question - No Extra Tools

**User**: "Help me understand subagents and how to use them"

**Action**:
1. Recognize this is a conceptual question
2. Core tools (subagents) are sufficient
3. Provide explanation from knowledge

### Example 4: Answering "What Tools Are Available"

**User**: "Tell me which tools are available"

**Action**:
1. Read the "Available Tool Servers:" system message (already in context)
2. Present the information clearly
3. Do NOT call `mcp_assistant_list_mcp_servers`

**Example response**:
```
Here are all the available tool servers:

Always Enabled (Core Meta-Services):
- server:mcp-assistant (MCP Assistant): MCP server management
- server:subagents (Subagents): Task delegation
- server:skills (Skills): Skill activation
- server:agent-vm (Agent VM): execution tool surface; VM containers are created on demand

Skill-Activated (activate the skill to enable):
- server:glean (Glean): via company-knowledge skill
- server:web-tools (Web Tools): via web-search skill

Available to Enable Manually:
- server:gitlab-mcp (GitLab MCP): GitLab repository management
- server:slack (Slack): Slack messaging integration
- server:google_workspace (Google Workspace): Gmail, Calendar, Drive access
...
```

## Important Notes

### Tool Server IDs are STABLE
- IDs never change: `server:gitlab-mcp` is always gitlab-mcp
- Based on MCP server folder names
- Available servers automatically injected in system messages

### Tool Enabling is Per-Chat and Persistent
- Once enabled, tools stay enabled for 7 days
- Survives page refresh and session changes
- Use `mcp_assistant_get_chat_tools` to see current state
- Always pass the chat_id from system prompt

### Make Direct Decisions
- Read "Available Tool Servers:" system message
- Review descriptions to determine what's needed
- Enable tools directly with `mcp_assistant_activate_integration`
- No need to invoke Context Resolver for obvious needs

### MCP Context Resolver is a LAST RESORT
- Only for ambiguous or unclear needs
- NOT for obvious requests
- NOT for listing available tools
- NOT as a first step

### Core Tool Servers (Always Enabled)
Meta-services available without skill activation:
- `server:mcp-assistant` - MCP server management
- `server:subagents` - Agent delegation
- `server:skills` - Skill activation
- `server:agent-vm` - Agent VM tool surface; VM containers are created on demand

### Skill-Activated Servers
These require skill activation first:
- `server:glean` - Activate `company-knowledge` skill
- `server:web-tools` - Activate `web-search` skill
- `server:artifacts` - Activate `artifacts` skill
