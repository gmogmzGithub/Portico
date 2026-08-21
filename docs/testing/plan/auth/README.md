# H — Authentication, OAuth & integrations

Portico corporate auth, the OAuth wizard for per-server authorization, and token-based integrations driven via the guided-setup config modal.

- Up: [`docs/testing/README.md`](../../README.md).
- Cross-references: V-001, N-008 in [`docs/security/hardening-overview.md`](../../../security/hardening-overview.md); see [`docs/CHANGELOG.md`](../../../CHANGELOG.md) and [`docs/incidents/`](../../../incidents/) for OAuth-related regression history.

---

## Status snapshot

<!-- @portico:status-snapshot:begin -->
| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |
|---:|---:|---:|---:|---:|---:|---:|
|    19 |      0 |   18 |    0 |       0 |       0 |   1 |
<!-- @portico:status-snapshot:end -->

## At-a-glance

| ID    | Scenario                                                                               | Type | Coverage | Status | Last run | File |
|-------|----------------------------------------------------------------------------------------|------|----------|--------|----------|------|
| H-01  | Initial Portico corporate auth completes from guided setup                              | Auth | Auto     | Pass   | 2026-04-28 | [portico-corporate.md](portico-corporate.md) |
| H-02  | Vault LLM key path provisions `PORTICO_LLM_API_KEY` from Vault                          | Auth | Auto     | Pass   | 2026-04-28 | [portico-corporate.md](portico-corporate.md) |
| H-03  | VPN check screen detects on-VPN status correctly                                       | Auth | Auto     | Pass   | 2026-04-28 | [portico-corporate.md](portico-corporate.md) |
| H-10  | Slack OAuth: HTTPS callback succeeds; token stored                                     | Auth | Auto     | Pass   | 2026-04-28 | [oauth-wizard.md](oauth-wizard.md) |
| H-11  | Slack: cert is trusted in login Keychain (no "Connection is not private" warning)      | Auth | Manual   | Pass   | 2026-05-05 | [oauth-wizard.md](oauth-wizard.md) |
| H-12  | Slack tool call after OAuth succeeds without exposing token-type jargon                | Auth | Manual   | Pass   | 2026-05-05 | [oauth-wizard.md](oauth-wizard.md) |
| H-13  | Google Workspace: full OAuth flow + tool call works                                    | Auth | Manual   | Pass   | 2026-05-05 | [oauth-wizard.md](oauth-wizard.md) |
| H-14  | Glean: full OAuth flow + search tool works                                             | Auth | Manual   | Pass   | 2026-05-05 | [oauth-wizard.md](oauth-wizard.md) |
| H-15  | Already-authorized server reopens chat without showing OAuth modal                     | Auth | Auto     | Pass   | 2026-04-28 | [oauth-wizard.md](oauth-wizard.md) |
| H-16  | Sequential setup of two OAuth servers does not overlap modals                          | Auth | Auto     | Pass   | 2026-04-28 | [oauth-wizard.md](oauth-wizard.md) |
| H-17  | Dismiss OAuth modal mid-flow → AI receives `dismissed` reason and offers retry         | Auth | Manual   | Pass   | 2026-05-05 | [oauth-wizard.md](oauth-wizard.md) |
| H-18  | OAuth callback timeout fires within ~10s for contractor / data-plat-mcp; ~30s for others | Auth | Manual | NotApplicable | 2026-05-06 | [oauth-wizard.md](oauth-wizard.md) |
| H-19  | OAuth IPC is single-fire (one auth URL via single wizard)                              | Auth | Auto     | Pass   | 2026-04-28 | [oauth-wizard.md](oauth-wizard.md) |
| H-20  | OAuth tokens delete cleanly via control plane → server enters `<needs_auth>`           | Auth | Auto     | Pass   | 2026-04-28 | [oauth-wizard.md](oauth-wizard.md) |
| H-21  | Token refresh / expired 401 prompts user before re-triggering guided setup             | Auth | Manual   | Pass    | 2026-05-06 | [oauth-wizard.md](oauth-wizard.md) |
| H-30  | GitLab guided setup: PAT entry → container healthy → tools work                        | MCP  | Auto     | Pass   | 2026-04-28 | [token-based-integrations.md](token-based-integrations.md) |
| H-31  | First-run GitLab `npx`-based 120s install survives the 180s timeout                    | MCP  | Manual   | Pass   | 2026-05-06 | [token-based-integrations.md](token-based-integrations.md) |
| H-32  | Guided setup writes preset env vars (e.g. `GITLAB_API_URL`) along with user fields     | MCP  | Manual   | Pass   | 2026-05-06 | [token-based-integrations.md](token-based-integrations.md) |
| H-33  | Cancel config modal mid-flow → AI sees `cancelled`, offers retry                       | MCP  | Manual   | Pass   | 2026-05-06 | [token-based-integrations.md](token-based-integrations.md) |

## Files in this folder

- [portico-corporate.md](portico-corporate.md) — Portico corporate auth & VPN (H-01 .. H-03).
- [oauth-wizard.md](oauth-wizard.md) — Per-server OAuth wizard (H-10 .. H-21).
- [token-based-integrations.md](token-based-integrations.md) — Guided-setup token integrations (H-30 .. H-33).
