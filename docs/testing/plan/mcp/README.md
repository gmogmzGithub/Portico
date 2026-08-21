# G — MCP orchestration & marketplace

Toggles, marketplace operations, and per-server debug surfaces.

- Up: [`docs/testing/README.md`](../../README.md).
- Cross-references: see [`docs/CHANGELOG.md`](../../../CHANGELOG.md) and [`docs/incidents/`](../../../incidents/) for MCP regression history.

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    25 |     11 |   14 |    0 |       0 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                    | Type | Coverage | Status | Last run | File |
|-------|-----------------------------------------------------------------------------|------|----------|--------|----------|------|
| G-01  | Toggle one core integration on; container becomes healthy; tools usable     | MCP  | Auto     | Pass   | 2026-04-28 | [orchestration.md](orchestration.md) |
| G-02  | Toggle off → tools removed from active context                              | MCP  | Auto     | Pass   | 2026-04-28 | [orchestration.md](orchestration.md) |
| G-03  | Toggle returns `needs_oauth` (not `starting`) for OAuth servers             | MCP  | Partial  | Pass   | 2026-04-28 | [orchestration.md](orchestration.md) |
| G-04  | Bulk disable clears startup failures unconditionally after `mutateMcpToggles` | MCP | Auto     | Pass   | 2026-04-28 | [orchestration.md](orchestration.md) |
| G-05  | `restart_mcp_infrastructure` is serialized; nginx never corrupted           | MCP  | Auto     | Pass   | 2026-04-28 | [orchestration.md](orchestration.md) |
| G-06  | Cross-validated status agrees with Electron API (no false "available")      | MCP  | Manual   | NotRun | -        | [orchestration.md](orchestration.md) |
| G-07  | Three integrations enabled in parallel reach `tool_ready` within 45s        | MCP  | Manual   | NotRun | -        | [orchestration.md](orchestration.md) |
| G-10  | Default OOTB marketplace lists expected core servers                        | MCP  | Auto     | Pass   | 2026-04-28 | [marketplace.md](marketplace.md) |
| G-11  | Add a custom GitLab marketplace URL → server list refreshes                 | MCP  | Auto     | Pass   | 2026-04-28 | [marketplace.md](marketplace.md) |
| G-12  | `syncAllMarketplaces` reports per-marketplace failures without aborting     | MCP  | Auto     | Pass   | 2026-04-28 | [marketplace.md](marketplace.md) |
| G-13  | Disable a marketplace → its servers are unlisted                            | MCP  | Partial  | NotRun | -        | [marketplace.md](marketplace.md) |
| G-14  | Install a marketplace skill → it appears in the skill manager               | MCP  | Partial  | Pass   | 2026-04-28 | [marketplace.md](marketplace.md) |
| G-20  | Open MCP debug tab → tail logs for any running server                       | MCP  | Auto     | Pass   | 2026-04-28 | [per-server-debug.md](per-server-debug.md) |
| G-21  | Restart an individual server from the debugger → no nginx race              | MCP  | Auto     | Pass   | 2026-04-28 | [per-server-debug.md](per-server-debug.md) |
| G-22  | Delete a custom MCP server → config + container removed cleanly             | MCP  | Auto     | Pass   | 2026-04-28 | [per-server-debug.md](per-server-debug.md) |
| G-23  | Startup failures display a fail-loud badge in the control plane             | MCP  | Auto     | Pass   | 2026-04-28 | [per-server-debug.md](per-server-debug.md) |
| G-24  | Tooltip on server status badge keeps focus during keyboard nav              | MCP  | Auto     | Pass   | 2026-04-28 | [per-server-debug.md](per-server-debug.md) |
| G-30  | Read-only MCP tools bypass the gate                                         | MCP  | Auto     | NotRun | -        | [tool-confirmation.md](tool-confirmation.md) |
| G-31  | Multi-call assistant turn surfaces one card per destructive call            | MCP  | Auto     | NotRun | -        | [tool-confirmation.md](tool-confirmation.md) |
| G-32  | Destructive-tool registry stays in sync with `mcp-configs/`                 | MCP  | Manual   | NotRun | -        | [tool-confirmation.md](tool-confirmation.md) |
| G-40  | `run_task_now` returns immediately with a run handle                        | MCP  | Auto     | NotRun | -        | [scheduling.md](scheduling.md) |
| G-41  | `run_task_now` is idempotent for an already-running task                    | MCP  | Auto     | NotRun | -        | [scheduling.md](scheduling.md) |
| G-42  | `cancel_run` aborts an in-flight run; status becomes `cancelled`            | MCP  | Auto     | NotRun | -        | [scheduling.md](scheduling.md) |
| G-43  | Daemon restart re-attaches to in-flight runs                                | MCP  | Auto     | NotRun | -        | [scheduling.md](scheduling.md) |
| G-44  | Run-signal queue wakes the daemon within ~1s of `run_task_now`              | MCP  | Auto     | NotRun | -        | [scheduling.md](scheduling.md) |

## Files in this folder

- [orchestration.md](orchestration.md) — toggles & lifecycle (G-01 .. G-07).
- [marketplace.md](marketplace.md) — marketplace operations (G-10 .. G-14).
- [per-server-debug.md](per-server-debug.md) — per-server debug surfaces (G-20 .. G-24).
- [tool-confirmation.md](tool-confirmation.md) — MCP × confirmation-gate integration (G-30, G-31, G-32).
- [scheduling.md](scheduling.md) — scheduling MCP run lifecycle: run_task_now, cancel_run, daemon re-attach (G-40 .. G-44).
