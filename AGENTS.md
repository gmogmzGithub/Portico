# Portico contributor instructions

Portico is a provider-neutral, local-first workbench for building AI assistants
around MCP servers, skills, workspaces, and consent-aware tool integrations.

## Development

- Keep provider and organization integrations configurable and opt-in.
- Never commit credentials, generated runtime state, local databases, or private
  service URLs. Use `.env.example` for documented configuration.
- Prefer observable behavior tests over assertions on source-code spelling.
- Keep JavaScript output used by automated tests ASCII-only.
- Run `./run-tests.sh` after changes to source, tests, scripts, configuration,
  packaging, or runtime behavior.

## Runtime

- Use the repository's documented installer and foreground Electron workflow for
  UI verification.
- Treat Docker, MCP configuration, model routing, OAuth, and workspace state as
  separate boundaries. Changes crossing those boundaries need targeted tests.
- New integrations should be added as explicit adapters or user configuration,
  not as hard-coded defaults.
