# Agentic MCP Test Harness

Sandboxed stack for running the agentic test plans in `agentic-test-plans/`
against the **real** core MCP servers and the **real** Electron service layer,
with the Solutions Marketplace and Open WebUI mocked in memory. Spans the
**MCP Orchestration**, **IPC/Communication**, and **Agent Skills** architecture
layers.

## Topology

```
 you (agent) ── HTTP ──> mcp-broker (18766)
                           │  newline-delimited JSON-RPC / MCP stdio
                           ├─> target/debug/skills-server     (REAL Rust binary)
                           └─> target/debug/subagents-server  (REAL Rust binary)
                                 │ ELECTRON_API_BASE                │ OPENWEBUI_BASE_URL
                                 v                                  v
                    electron-api-host (18976)              mock-owui (18801)
                    REAL api.js + ops/install/               in-memory models,
                    marketplace-service/link registries      chats, folders
                                 │ AI_MARKETPLACE_BASE_URL
                                 v
                    mock-solutions-marketplace (18800)
                    in-memory /api/solutions per
                    docs/agent_reference/api-attribution-and-bundles-spec.md
                                 +
                    portico-agentic-redis (docker, 127.0.0.1:16390)
```

- `AI_MARKETPLACE_BASE_URL` is the env var that swaps the Solutions
  Marketplace URL (read by `electron-app/src/services/ai-marketplace-client.js`).
- Publish/unpublish approvals ride the shipped dev-build auto-approve
  mechanism: `portico_AGENTIC_AUTO_APPROVE=1` (harness default) writes
  `marketplace-auto-approve.json` into the sandbox userData; the headless host
  completes the real pending+poll confirm flow exactly as `ipc.js` would on an
  `action:"approved"` completion. Real renderer, real modal, and real user are
  the only missing pieces.
- A dedicated Redis container (`portico-agentic-redis`) keeps chat-activation and
  token state real and cross-process (do NOT use `CORE_MCP_TEST_REDIS=memory`
  here: it is per-process and silently disables skill-provenance enrichment).

## Files

| File | Role |
|---|---|
| `harness.js` | Orchestrator: seeds the fixture, boots everything, writes `<dir>/endpoints.json`. |
| `mock-solutions-marketplace.js` | In-memory Solutions Marketplace + `/__test/*` hooks (seed foreign-author listings, behind-the-scenes update/delete, state dump, reset, ownership toggle). |
| `mock-owui.js` | In-memory Open WebUI surface used by subagents-server (models, tools, folders, chats, completions). |
| `electron-api-host.js` | Headless host for the REAL `api.js` (fixture-style electron/bootstrap/docker-mcp/current-user/owui-views stubs); `docker-mcp.invokeMcpTool` routes back to the broker so tool-in-tool paths hit the real Rust binaries. Admin: `/__harness/state`, `/__harness/viewer`, `/__harness/clear-broadcasts`. |
| `mcp-broker.js` | Long-lived MCP stdio client for both Rust binaries + `POST /call` HTTP surface (mirrors mcpo's production role). |
| `call.js` | One-shot tool invocation CLI: `node call.js <dir> <server> <tool> ['<json>']`. |
| `reset-state.js` | Between-scenario teardown: clears skills-user/marketplace/archive, restores OOTB `marketplaces.json` + preinstalled skills, wipes link registries, FLUSHALL redis, resets both mocks. |
| `purge-mock-artifacts.js` | Dev-profile cleanup after app-mode mock sessions: unlinks published-to-mock skill/agent links (entities revert to local-only) and removes installed-from-mock registry records + payload dirs. Dry-run by default, `--apply` to execute, refuses while the app is running. Reached via `./install_v2.sh --unlink-mock-marketplace-entities`. |

## Usage

```bash
# 1. build the servers once
cd src/core-mcp-rust && cargo build -p skills-server -p subagents-server

# 2. boot (stays alive; prints endpoints JSON; also written to <dir>/endpoints.json)
node tests/agentic/harness.js --dir /tmp/portico-agentic

# 3. drive tools
node tests/agentic/call.js /tmp/portico-agentic skills list_skills '{"filter_source":"user"}'
node tests/agentic/call.js /tmp/portico-agentic subagents create_agent \
  '{"name":"A","base_model_id":"mock-base-model","system_prompt":"..."}'

# 4. teardown between scenarios
node tests/agentic/reset-state.js /tmp/portico-agentic
```

## App mode (GUI against the mock)

To test the **renderer surface** for consistency with the agentic surface,
launch the real app pointed at this same mock — zero app-code changes (the
swap rides `AI_MARKETPLACE_BASE_URL`, re-read per request):

```bash
./install_v2.sh --force-local-build --node --mock-marketplace
```

- Mock runs standalone (detached, survives installer exit) on port **18808**
  (`portico_MOCK_MARKETPLACE_PORT` overrides; the harness's 18800 coexists). A
  leftover mock from an older session that serves a stale API shape (contract
  beacon `GET /__test/contract` < 2 or absent — e.g. pre-parity search with no
  `results` key, or envelopes that still inline the bundle) is detected and
  restarted automatically.
- **Keyless on purpose**: never export `AI_MARKETPLACE_API_KEY` for mock mode —
  `resolveAiMarketplaceApiKey` persists env-provided keys into the macOS
  Keychain, clobbering the real one. The app's real key header is simply
  ignored by a keyless mock.
- Seed content behind the scenes (foreign-author listing example — installable
  because it carries a bundle):

  ```bash
  curl -s -X POST http://127.0.0.1:18808/__test/seed \
    -H 'Content-Type: application/json' \
    -d '{"name":"demo-skill","description":"Seeded demo skill","author":"someone.else","submitted_by":"someone.else@example.invalid","type":"skills","bundle":{"type":"skills","payload":{"name":"demo-skill","skill_md":"---\nname: demo-skill\ndescription: Seeded demo skill\n---\nDemo body."}}}'
  curl -s http://127.0.0.1:18808/__test/state   # inspect
  curl -s -X POST http://127.0.0.1:18808/__test/reset
  ```
- ⚠️ The mock is in-memory and DIVERGES from the real marketplace: GUI
  installs/publishes during a mock session write real registry records and
  publish links that reference mock-only solution ids (on a later
  real-marketplace launch those records just fail freshness resolution
  fail-open until cleaned). Clean up before returning to the real
  marketplace:

  ```bash
  ./install_v2.sh --unlink-mock-marketplace-entities   # dry-run report + confirm
  ```

  Published-to-mock entities are unlinked (back to plain local user
  entities); installed-from-mock copies are removed; OWUI agents installed
  from the mock stay behind as local agents (delete in-app if unwanted).
- Stop the mock: `lsof -ti tcp:18808 | xargs kill`. Packaged (non `--node`)
  launches are unsupported-ish: the `open` fallback drops env and there is no
  CDP.

Fixture layout under `--dir`: `project-root/` (skills/, skills-user/,
skills-marketplace/ with the OOTB preinstalled payload, marketplaces.json,
mcp-configs/, workspaces/, app-support/, workspace-cfg/) and `user-data/`
(link registries + auto-approve preference).

## Safety

The harness never touches the developer's real profile: it picks its own
ports, its own Redis container, and a disposable fixture dir, and it never
calls `startApiServer` (which would kill whatever owns the real port 9876).
