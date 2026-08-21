---
name: mcp-bridge-setup
description: Use the Portico Host MCP Bridge assistant tools and auto-config UI to check bridge health, configure supported external MCP clients, and answer setup-community undo/fallback questions without producing manual MCP client setup commands, URLs, snippets, or tokens.
license: Proprietary
compatibility: Portico
metadata:
  author: Adam Ullrich
  version: "2.1"
  priority: high
  triggers:
    - "mcp bridge"
    - "host mcp bridge"
    - "cursor mcp"
    - "claude desktop mcp"
    - "claude code mcp"
    - "codex mcp"
    - "amp mcp"
    - "use portico tools in cursor"
    - "use Portico tools in claude"
---

# MCP Bridge Setup

Do not provide manual MCP client configuration, command snippets, bridge URLs, bearer tokens, token-file paths, or legacy proxy instructions in chat.

Use the app-managed bridge tools when they are available:

- For health, readiness, script action, or configured-client questions, call `mcp_assistant_get_host_mcp_bridge_status`.
- When the user asks PORTICO to configure a supported external client, first call `mcp_assistant_get_host_mcp_bridge_status`, then confirm the exact supported client ids to change. Then call `mcp_assistant_configure_host_mcp_bridge_clients` with `confirm: true` and explicit `client_ids`.
- Always pass `client_ids`. If the user asks for all detected supported clients, pass the exact detected supported client ids returned by status.

Supported auto-config clients are Claude Code, Claude Desktop, Codex, Cursor, and Amp. Windsurf is not supported by this flow.

If the assistant tool is unavailable, tell the user to use the same app-managed configuration flow in the UI:

- Open the bug drawer.
- In Service Status, find Host MCP Bridge.
- Click the cog button next to the log button.
- Select the detected clients to configure.
- Click Configure.

The app generates per-client bearer tokens behind the scenes, writes supported client configuration directly, and opens the Claude Desktop extension package for the normal Claude Desktop confirmation flow when Claude Desktop is selected.

## Operational Questions

When the user asks if the bridge is healthy, call `mcp_assistant_get_host_mcp_bridge_status`. Healthy means the PORTICO Host MCP Bridge is reachable and ready; it does not by itself mean every external client has been configured. If the status reports `enable_bridge`, PORTICO is reachable and setup scripts can still activate the bridge on demand.

When the user asks which clients are configured, call `mcp_assistant_get_host_mcp_bridge_status` and summarize the configured, detected, and unreadable client states. The UI modal labels supported clients as Configured, Detected, Not detected, or Config unreadable. Setup scripts can also read the status hook and inspect the configured client ids.

When the user asks whether they can undo or switch away from the PORTICO Bridge during the setup-community POC, tell them to rerun `setup-community/run-mcp-servers`. The scripts should choose PORTICO Bridge when PORTICO is available and fall back to the existing ToolHive path when it is not. Do not instruct users to manually edit client config files.
