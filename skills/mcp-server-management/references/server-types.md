# MCP Server Configuration Patterns

This reference provides detailed configuration patterns for different MCP server types.

## Server Type Detection

When user provides MCP server information, identify the server type:

| Vendor Term | MCPO Format |
|-------------|-------------|
| "http" or "HTTP" | `streamable-http` type |
| "server-sent events" or "SSE" | `sse` type |
| "stdio" or `command`/`npx`/`uvx` | stdio pattern |
| "OAuth required" | Add `oauth` configuration block |

## Fragment Patterns

### Pattern 1: Streamable HTTP (Basic)

**When to use**: Server URL provided, no OAuth, HTTP-based protocol

```json
{
  "type": "streamable-http",
  "url": "http://api.example.com/mcp/default"
}
```

**Example - Glean HTTP server:**
```json
{
  "type": "streamable-http",
  "url": "http://portico-be.glean.com/mcp/default"
}
```

### Pattern 2: Streamable HTTP with OAuth

**When to use**: HTTP server requiring OAuth 2.1 authentication

```json
{
  "type": "streamable-http",
  "url": "http://api.example.com/mcp",
  "oauth": {
    "server_url": "http://api.example.com"
  }
}
```

**Important OAuth Notes:**
- MCPO defaults to dynamic client registration
- Only `server_url` is required in most cases
- Do NOT set `scope`, `authorization_endpoint`, or `token_endpoint` unless server lacks metadata support
- Optional fields: `callback_port` (default: 3030), `storage_type` (default: "file")

### Pattern 3: SSE (Server-Sent Events)

**When to use**: Server uses SSE transport with custom headers

```json
{
  "type": "sse",
  "url": "http://127.0.0.1:8001/sse",
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}",
    "X-Custom-Header": "value"
  }
}
```

Declare `API_TOKEN` in the YAML `required_env_vars` with `sensitive: true`; never inline its value.

### Pattern 4: stdio with npx (npm package)

**When to use**: Node.js-based MCP server from npm registry

```json
{
  "command": "npx",
  "args": ["-y", "@gleanwork/mcp-server@latest"]
}
```

### Pattern 5: stdio with uvx (Python package)

**When to use**: Python-based MCP server from PyPI

```json
{
  "command": "uvx",
  "args": ["mcp-server-time", "--local-timezone=America/New_York"],
  "env": {
    "TIMEZONE": "America/New_York"
  }
}
```

### Pattern 6: stdio with Binary

**When to use**: Pre-built binary inside Docker container

```json
{
  "command": "/app/mcp-servers/binary-name",
  "args": ["--transport", "stdio"]
}
```

## Deployment Type Selection

### Use DOCKER deployment for:
- HTTP-based servers (streamable-http, SSE)
- Servers connecting to external APIs/services
- Cloud service integrations (S3, Redis)
- npm/uvx packages that don't need filesystem access
- **Examples**: Glean HTTP, Slack API, Atlassian, database clients

### Use HOST deployment (REQUIRED) for:
- Filesystem operations (reading/writing local files)
- Browser automation (Playwright, Puppeteer)
- Local tool execution (git, shell commands)
- System-level access (processes, network interfaces)
- **Examples**: filesystem server, chrome-devtools

**Default to DOCKER unless explicitly requiring host-level access.**

## Environment Variables

**CRITICAL**: User-installed servers embed non-secret environment values in the fragment's `env` object. Secrets are placeholders backed by YAML `required_env_vars` and the Control Plane Configure flow.

**Do NOT instruct users to add variables to the .env file.**

Example fragment with env vars:
```json
{
  "command": "uvx",
  "args": ["mcp-server-postgres"],
  "env": {
    "POSTGRES_HOST": "localhost",
    "POSTGRES_PORT": "5432",
    "POSTGRES_USER": "admin",
    "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}",
    "POSTGRES_DB": "mydb"
  }
}
```

Declare the secret separately in the YAML configuration:
```json
{
  "required_env_vars": [
    {
      "name": "POSTGRES_PASSWORD",
      "description": "Postgres password",
      "sensitive": true
    }
  ]
}
```

If creation reports `NOT_CONFIGURED`, call `mcp_assistant_trigger_guided_setup` with the current `chat_id`. Do not call `agent_vm_request_sensitive_information` for this custom-server credential; guided setup is the only prompt that persists it to the server's secure runtime path.

## YAML Configuration Rules

**ALL Required fields** (validation will fail if any are missing):

```json
{
  "name": "Human-readable Server Name",
  "id": "server-id",
  "display_name": "Clean Display Name",
  "deployment_type": "docker",
  "description": "Brief description",
  "user_installed": true,
  "is_core": false,
  "required_env_vars": [],
  "use_cases": ["Use case 1", "Use case 2"],
  "experimental": false
}
```

### display_name Formatting Rules

- **NEVER use emojis** (❌ "🔍 Glean" → ✅ "Glean")
- **NEVER use parentheses** (❌ "Glean (OAuth)" → ✅ "Glean OAuth")
- **NEVER use special characters** except spaces and hyphens
- Keep it clean and professional

**Good examples:**
- "Glean OAuth"
- "PostgreSQL Client"
- "Slack Integration"
- "File System"

**Bad examples:**
- "🔍 Glean (OAuth)"
- "Glean-[OAuth]"
- "Glean™ OAuth"

### Server ID Naming

- Must be unique
- Must NOT collide with system servers (glean, slack, mcp-assistant, subagents, etc.)
- Use lowercase with hyphens: `my-server-name`

## Quick Decision Tree

**User provides:**
1. **HTTP URL** → Use Pattern 1 (streamable-http)
2. **HTTP URL + OAuth** → Use Pattern 2 (streamable-http + oauth)
3. **SSE endpoint** → Use Pattern 3 (sse + headers)
4. **npm package** → Use Pattern 4 (npx)
5. **Python package** → Use Pattern 5 (uvx)
6. **Binary path** → Use Pattern 6 (command + binary)

**Deployment:**
- Needs filesystem/browser/local tools → **HOST**
- Everything else → **DOCKER**

## Complete Example (HTTP Server with OAuth)

**User request**: "Install Glean MCP server at https://portico-be.glean.com with OAuth"

**Configuration:**
```json
{
  "server_id": "glean-oauth",
  "yaml_config": {
    "name": "Glean OAuth MCP Server",
    "id": "glean-oauth",
    "display_name": "Glean OAuth",
    "deployment_type": "docker",
    "description": "Glean search and knowledge base integration with OAuth",
    "user_installed": true,
    "is_core": false,
    "required_env_vars": [],
    "use_cases": [
      "Search internal knowledge base",
      "Find documentation and guides"
    ]
  },
  "fragment": {
    "type": "streamable-http",
    "url": "https://portico-be.glean.com/mcp/default",
    "oauth": {
      "server_url": "https://portico-be.glean.com"
    }
  }
}
```

Note:
- All required YAML fields are present
- The display_name is clean: "Glean OAuth" (no emojis, no parentheses)
- OAuth configuration only needs `server_url` for dynamic client registration

## OAuth Servers Requiring Manual Registration

Some OAuth providers advertise dynamic client registration but block it with 403 Forbidden.

**Known Cases:**
- **Figma MCP Remote** (`https://mcp.figma.com/mcp`) - Requires pre-approval form
  - Alternative: Use local Figma MCP at `http://127.0.0.1:3845/mcp` (no OAuth)

**How to Detect:**
- After `mcp_assistant_restart_mcp_infrastructure`, check logs for: "Registration failed: 403 Forbidden"
- Server will be in "failed" state

**What to Do:**
1. Check if provider offers a local/alternative endpoint without OAuth
2. Inform user about manual registration requirement
3. For Figma: Recommend local server instead of remote OAuth server
