---
name: mcp-server-management
description: Install, configure, update, and delete MCP tool servers. Use when user mentions installing tools, MCP servers, OAuth setup, creating/deleting servers, or managing integrations.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.0"
  priority: high
  triggers:
    - "install mcp"
    - "create server"
    - "oauth"
    - "add tool"
    - "install server"
    - "setup mcp"
    - "mcp server"
    - "install integration"
---

# MCP Server Management Skill

This skill provides comprehensive guidance for installing, configuring, updating, and deleting MCP (Model Context Protocol) servers in Portico.

## Core Concepts

### MCP Server Types

MCP servers come in several types based on their transport mechanism:

| Type | When to Use |
|------|-------------|
| `streamable-http` | HTTP-based servers, most common for remote APIs |
| `sse` | Server-Sent Events transport with custom headers |
| `stdio` | Local command execution (npm/uvx packages) |

### Deployment Types

- **DOCKER** (default): HTTP servers, API clients, cloud integrations
- **HOST**: Filesystem access, browser automation, local tools requiring system access

## Security & Installation Consent

**NEVER install MCP servers without explicit user consent.**

### Risk Classification

**HIGH RISK** (Require explicit consent + OAuth recommendation):
- Cluster/Infrastructure Management (Kubernetes, Docker Swarm)
- Database Access with write permissions
- Admin Tools with production access
- CI/CD Systems with deployment access

**MEDIUM RISK** (Require consent with explanation):
- Code Analysis Tools that modify files
- API Clients for third-party services
- Source Control operations
- Monitoring Tools with log access

**LOW RISK** (Require brief consent):
- Development Tools (Playwright, local dev servers)
- Read-Only Tools
- Local Utilities
- Testing Frameworks

### Consent Protocol

1. **ASK FOR CONSENT FIRST** - Never install autonomously
2. **Assess the risk level** - Evaluate what the server can access/modify
3. **Explain capabilities and risks** - Tell user what the server will be able to do
4. **Recommend OAuth for high-risk servers** - Production access should use OAuth
5. **Wait for explicit approval** - User must say "yes", "install it", "go ahead"

## Installation Workflow

### Non-OAuth Servers (Simple)

After obtaining user consent:

1. Create server with `mcp_assistant_create_user_mcp_server`
2. Inspect the returned `readiness_phase` and `next_steps`; creation already runs the normal enable lifecycle, so do not perform a redundant infrastructure restart
3. If the server reports `NOT_CONFIGURED`, call `mcp_assistant_trigger_guided_setup` with the current `chat_id`
4. Let the user enter all declared credentials in that single Configure flow, then follow its result
5. Enable for chat with `mcp_assistant_activate_integration` once the server is ready
6. Ask permission to test, then test if approved

Never use `agent_vm_request_sensitive_information` for credentials declared in this custom server's `required_env_vars`. That tool creates a temporary Agent VM file and cannot populate the server's secure runtime variables, so using it here would ask for the credential twice. Integration-specific code-execution workflows may still use it when their setup script explicitly consumes the temporary file.

### OAuth Servers (8-Step Workflow)

For detailed OAuth installation instructions, load the reference:
`references/oauth-workflow.md`

## Configuration Patterns

### Fragment Examples

**HTTP-based (streamable-http):**
```json
{
  "type": "streamable-http",
  "url": "http://api.example.com/mcp/default"
}
```

**HTTP with OAuth:**
```json
{
  "type": "streamable-http",
  "url": "http://api.example.com/mcp",
  "oauth": {
    "server_url": "http://api.example.com"
  }
}
```

**SSE with Headers:**
```json
{
  "type": "sse",
  "url": "http://127.0.0.1:8001/sse",
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

Declare `API_TOKEN` in the YAML `required_env_vars` with `sensitive: true`; never inline its value.

**stdio (npm):**
```json
{
  "command": "npx",
  "args": ["-y", "@package/mcp-server@latest"]
}
```

**stdio (uvx/Python):**
```json
{
  "command": "uvx",
  "args": ["mcp-server-name"],
  "env": {
    "VAR_NAME": "value"
  }
}
```

### YAML Configuration Requirements

**ALL Required fields** for user-installed servers:
```json
{
  "name": "Human-readable Server Name",
  "id": "server-id",
  "display_name": "Clean Display Name",
  "deployment_type": "docker",
  "description": "Brief description",
  "user_installed": true,
  "is_core": false,
  "required_env_vars": []
}
```

**CRITICAL - display_name Rules**:
- **NEVER include emojis** (Use "Glean OAuth" not "🔍 Glean OAuth")
- **NEVER include parentheses** (Use "Glean OAuth" not "Glean (OAuth)")
- Keep it clean: alphanumeric, spaces, and hyphens only

## System Resource Protection

**NEVER modify or delete system-delivered resources:**

### Base Models
- Have NO `base_model_id` field
- Cannot be updated or deleted
- Can be used as base for custom agents

### System Agents
- Start with `portico_agent_` prefix
- Cannot be updated or deleted
- Can be invoked with `subagents_run_subagent`

### System MCP Servers
- Located in `mcp-configs/` directory
- Cannot be modified
- Can only read with `mcp_assistant_get_system_mcp_config`

### User-Installed Servers
- Located in `mcp-configs-user/`
- Can be fully managed (create, update, delete)

## Infrastructure Restarts

Create and update operations already apply the targeted MCP lifecycle. Do not restart infrastructure redundantly. Call `mcp_assistant_restart_mcp_infrastructure` only when returned recovery guidance recommends it, using `server_id` for a targeted restart whenever possible.

## Testing New Servers

**CRITICAL: NEVER test newly installed servers without user consent!**

After installation:
1. Ask: "Would you like me to test it now by [specific action]?"
2. Wait for explicit approval
3. Only test after user says "yes", "test it", "go ahead"

## Troubleshooting

For OAuth-specific troubleshooting, see: `references/oauth-workflow.md`

For server type configuration patterns, see: `references/server-types.md`
