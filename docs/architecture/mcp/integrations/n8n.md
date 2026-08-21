# n8n MCP Integrations

Portico bundles **two** n8n MCP servers out of the box:

| Server | Folder | Transport | Auth | Status |
|---|---|---|---|---|
| **n8n** (native) | [`mcp-configs/mcp-n8n/`](../../../../mcp-configs/mcp-n8n/) | streamable-http to `https://n8n.example.invalid/mcp-server/http` | OAuth (DCR) | current |
| **n8n (Community Fork)** | [`mcp-configs/n8n-community-mcp/`](../../../../mcp-configs/n8n-community-mcp/) | stdio via `docker run` | `N8N_API_KEY` | **deprecated** |

The native server is n8n's built-in instance MCP and is the recommended
integration. The community fork remains bundled (with a `deprecated: true`
flag and a DEPRECATED badge in the setup wizard and Control Plane) to ease
migration for existing fork users — its tool names differ from the native
server's, so skills written against one do not transparently work with the
other (dispatched prefixes: `mcp_n8n_*` for native, `n8n_community_mcp_*`
for the fork).

---

# n8n (Community Fork) — `n8n-community-mcp`, deprecated

A Model Context Protocol (MCP) server that provides AI assistants with access to n8n node documentation and workflow management capabilities.  This is forked from the community version but removes telemetry, cloud hosting options, adds custom nodes and disables dangerous tools.

## Quick Start

### Running Against Portico N8N Instance

This server connects to your N8N instance at `https://n8n.example.invalid/` to provide workflow management capabilities through AI assistants.

### Prerequisites

- Docker or OrbStack installed on your system
- N8N API Key from your Portico N8N instance

### Build Docker Image

```bash
# Pull the latest image
docker pull harbor.example.invalid/n8n/n8n-mcp:latest
```

## Configuration for Portico

The fork ships bundled as `n8n-community-mcp` — enable it from the Control
Plane (or the guided setup wizard) and supply your `N8N_API_KEY` when
prompted; no manual JSON configuration is needed. The bundled fragment is
equivalent to:

```json
{
  "mcpServers": {
    "n8n-community-mcp": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--init",
        "-e", "MCP_MODE=stdio",
        "-e", "LOG_LEVEL=error",
        "-e", "DISABLE_CONSOLE_OUTPUT=true",
        "-e", "N8N_API_URL=https://n8n.example.invalid/",
        "-e", "N8N_API_KEY=your-api-key-here",
        "harbor.example.invalid/n8n/n8n-mcp:latest"
      ]
    }
  }
}
```

Your API key comes from https://n8n.example.invalid/settings/api and is stored in
the app's encrypted secret store (keyed by variable name, so a key saved for
the pre-migration `mcp-n8n` fork configuration carries over automatically).

## What This Enables

Once configured, your AI assistant can:

- 📚 Access documentation for 500+ n8n nodes
- 🔧 Go from a lucidchart screenshot to n8n workflow 
- ✅ Validate node configurations
- 🔄 Create, read and update workflows
- ⚡ Execute workflows and monitor results
- 🎯 Search workflow templates
- 🤖 Build AI agent workflows

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `N8N_API_URL` | Your N8N instance URL | Yes |
| `N8N_API_KEY` | Your N8N API key | Yes |
| `MCP_MODE` | Communication mode (use "stdio") | Yes |
| `LOG_LEVEL` | Logging level (error/info/debug) | No |
| `DISABLE_CONSOLE_OUTPUT` | Disable console logging ("true"/"false") | No |

## Getting Your N8N API Key

1. Go to https://n8n.example.invalid/settings/api
2. Create a new API key
3. Copy the key and add it to your configuration

## Available Tools

The AI assistant will have access to powerful n8n tools including:

- **Node Discovery**: Search and explore n8n nodes
- **Node Configuration**: Get property details and examples
- **Validation**: Validate configurations before deployment
- **Workflow Management**: Create, update, and manage workflows
- **Execution**: Trigger workflows and monitor results
- **Templates**: Access 2,500+ workflow templates

## Troubleshooting

### Connection Issues

If the AI assistant can't connect to your N8N instance:

1. Verify your `N8N_API_URL` is correct: `https://n8n.example.invalid/`
2. Check that your API key is valid
3. Ensure your N8N instance is accessible from your machine
4. Check the logs by setting `LOG_LEVEL: "debug"`

### Permission Issues

If you see permission errors:

1. Ensure your API key has the necessary permissions
2. Verify your user account has access to workflow management

## Support

For issues or questions:

- Repository: https://example.invalid/n8n/n8n-mcp
- Original Project: https://github.com/czlonkowski/n8n-mcp

## License

MIT License — see the upstream `LICENSE` file in the n8n-MCP project.
