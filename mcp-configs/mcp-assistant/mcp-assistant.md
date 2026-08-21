# MCP Assistant

**Category:** Core Server (Always Enabled)

## Overview

The MCP Assistant is a Core MCP Server that provides conversational installation and management of User-Installed MCP servers. It enables users to extend the system with any MCP server from the ecosystem through natural language conversation, without requiring manual configuration or technical expertise.

## Features

- **Conversational Installation**: Install MCP servers by chatting with the AI
- **Docker vs Host Guidance**: Automatically determines correct deployment type
- **System Debugging**: Read system-delivered server configs for troubleshooting
- **Full CRUD Operations**: Create, read, update, and delete user-installed servers
- **Naming Collision Prevention**: Validates server IDs against system servers
- **Fragment Validation**: Ensures MCP fragments are valid before creation
- **Environment Variable Management**: User servers embed vars in fragments (not `.env`)

## What It Does

The MCP Assistant provides 7 tools that the AI can use:

1. **list_mcp_servers** - List all available servers
2. **get_system_mcp_config** - Read system server config (debugging only)
3. **create_user_mcp_server** - Create new user-installed server
4. **read_user_mcp_server** - Read user server config
5. **update_user_mcp_server** - Update user server config
6. **delete_user_mcp_server** - Delete user server
7. **validate_mcp_fragment** - Validate fragment JSON

## Example Usage

```
User: "I want to install the filesystem MCP server"

AI: "I'll help you install the filesystem server! Since it needs access to your
     local filesystem, I'll set it up as a HOST server. What directory should
     it have access to?"

User: "/Users/john/Documents"

AI: [Uses MCP Assistant to create the server]

AI: "Perfect! I've installed the filesystem server with read-write access to
     your Documents folder. To activate it:

     1. Go to the Control Panel
     2. Find 'Filesystem' (it will have a 'USER' badge)
     3. Toggle it ON
     4. Restart services

     Once activated, you'll be able to read and write files in your Documents folder."
```

## Docker vs Host Deployment

The MCP Assistant provides clear guidance on deployment types:

- **Docker**: Use for servers connecting to external APIs/services (databases over network, REST APIs, cloud services)
- **Host**: REQUIRED for servers needing host-level access (filesystem operations, browser automation, local tools)

## Configuration

This is a Core Server and requires no configuration. It has:
- Read-only access to `mcp-configs/` (system-delivered servers)
- Read-write access to `mcp-configs-user/` (user-installed servers)

## User-Installed Servers

Servers created via MCP Assistant:
- Are stored in `mcp-configs-user/`
- Embed environment variables in fragment files
- Can be toggled on/off like system servers
- Are merged with system servers in final configs
- Support both Docker and Host deployment types

## Security

- **Path Traversal Prevention**: Strict server ID validation
- **Naming Collision Detection**: Prevents conflicts with system servers
- **Read-Only System Access**: Cannot modify system-delivered servers
- **Command Validation**: Dangerous characters blocked in fragments
- **Resource Limits**: Max 50 user servers, 1MB icon, 10KB configs

## Notes

- This is a **Core Server** and cannot be disabled
- Always available to help users install and manage MCP servers
- Provides safe, conversational interface to MCP server management
- No manual file editing required
