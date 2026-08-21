# J — Agent skills, agent VM, sub-agents

Built-in skills, agent-VM activation, code execution, sub-agent budget guards, image viewer, and artifact panel.

- Up: [`docs/testing/README.md`](../../README.md).

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|     9 |      1 |    7 |    0 |       1 |       0 |   0 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                            | Type   | Coverage | Status | Last run |
|-------|-------------------------------------------------------------------------------------|--------|----------|--------|----------|
| J-01  | Built-in skill activates and exposes its tools to the LLM context                   | Skills | Auto     | Pass   | 2026-04-28 |
| J-02  | LLM activates `agent-vm` *before* calling `agent_vm_*` tools (HARD RULE #51)        | Skills | Manual   | NotRun | -        |
| J-03  | Code execution: bash / python / node tools run inside agent VM                      | Skills | Auto     | Pass   | 2026-04-28 |
| J-04  | PDF-from-script integration produces an artifact and renders                        | Skills | Auto     | Skipped | 2026-04-28 |
| J-05  | Agent VM startup cleanup removes stale containers from previous session             | Skills | Auto     | Pass   | 2026-04-28 |
| J-06  | Sub-agents run consistently in parallel                                             | Skills | Auto     | Pass   | 2026-04-28 |
| J-07  | Subagent budget guard caps token usage                                              | Skills | Auto     | Pass   | 2026-04-28 |
| J-08  | Image viewer skill renders inline images and respects DPR                           | Skills | Auto     | Pass   | 2026-04-28 |
| J-09  | Artifact panel renders the latest artifact and supports version menu                | Skills | Auto     | Pass   | 2026-04-28 |

See [agent-skills.md](agent-skills.md) for full per-scenario procedures.

## Files in this folder

- [agent-skills.md](agent-skills.md) — All 9 skills/agent-VM/sub-agent scenarios (J-01 .. J-09).
