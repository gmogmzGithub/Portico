# Portico

Portico is a local-first workbench for building AI assistants around real integrations.
It brings together model providers, MCP servers, agent skills, isolated workspaces,
and a desktop control surface so teams can assemble useful workflows without
rewriting the surrounding application for every integration.

The repository is currently being prepared as an open-source project. The core
runtime and integration patterns are here, but the public configuration surface
is still being separated from deployment-specific adapters and release services.

## What Portico is for

- Connect one or more model providers through a configurable gateway.
- Run MCP servers locally or connect to remote MCP endpoints.
- Discover, enable, and manage tools with explicit consent and health checks.
- Add reusable agent skills and marketplace-style content.
- Give agents isolated workspaces for files, artifacts, and code execution.
- Use a desktop application or the containerized web interface.
- Keep credentials in local secret stores and pass only the minimum required
  configuration to each runtime.

## Current architecture

Portico combines four layers:

1. **Chat surface** — a patched Open WebUI interface and an Electron desktop
   application.
2. **Model gateway** — a provider-neutral boundary for model catalogs,
   streaming, routing, cost metadata, and request policy.
3. **MCP control plane** — orchestration, OAuth callbacks, health reporting,
   server lifecycle, and tool exposure.
4. **Agent runtime** — skills, subagents, schedules, workspaces, artifacts,
   and approval gates.

## Development status

This is an active extraction and stabilization effort, not yet a polished
one-command distribution. See [`docs/open-source-readiness.md`](docs/open-source-readiness.md)
for the public-release boundary, known blockers, and the proposed naming
direction.

## Local development

The current development path requires Docker or an equivalent local container
runtime, Node.js, Rust, Python, and the project dependencies. Start by reviewing
the [development documentation](docs/README.md) and the checked-in environment
template before starting services.

The main local services are exposed on loopback by default:

- Open WebUI: <http://localhost:3789>
- MCP control plane: <http://localhost:8765>

Do not commit `.env` files, generated Compose overrides, runtime state,
credentials, or local build output. The root `.gitignore` protects the common
cases, but review `git status` before every commit.

## Contributing

Contributions should add provider-neutral capabilities or clearly isolated
adapters. New integrations should document their authentication model,
permissions, data handling, failure behavior, and local test path.

Before opening a pull request, run the relevant focused tests and then the
repository gate:

```bash
./run-tests.sh
```

## License and publication status

The source is being reviewed for public publication. A license, contributor
guide, security policy, and complete public dependency/configuration inventory
must be finalized before the first public release.
