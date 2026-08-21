# Core MCP Rust

`src/core-mcp-rust` contains the built-in Rust MCP servers.

## Library choice

The primary Rust MCP library for this repo is `rmcp`, the official Rust SDK from `modelcontextprotocol/rust-sdk`.

Why this is the default here:

- It is the official SDK and is actively released.
- It supports server and client roles, stdio, and streamable HTTP transports.
- It has documented OAuth support, including PKCE, resource binding, protected resource metadata discovery, dynamic client registration, and token refresh.
- We already use it in `src/mcp-orc-rust`, so it keeps the runtime stack coherent.

Other 2026 Rust options worth tracking:

- `mcpkit`: strong protocol-coverage claims and lower-boilerplate macros.
- `turbomcp`: ambitious full-stack/batteries-included SDK, but still beta.

## Current architecture

`src/core-mcp-rust` is a Cargo workspace with seven crates:

- `core-mcp-shared`
- `agent-vm-server`
- `artifacts-server`
- `mcp-assistant-server`
- `skills-server`
- `subagents-server`
- `web-tools-server`

Each core MCP server has its own Rust package and its own `tool_spec.json`.
Shared filesystem, Redis, MCP runtime, and skills-catalog helpers live in
`core-mcp-shared`.
