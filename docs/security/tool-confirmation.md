# MCP Tool Confirmation Gate — Destructive Tool Catalogue

Source-of-truth for which MCP tools require an explicit per-action user confirmation before they are dispatched. This document is the human-readable companion to [`mcp-policy/destructive-tools.json`](../../mcp-policy/destructive-tools.json) — the JSON file is consumed by the runtime gate; the table below is what reviewers and security read.

When a new MCP server is added to [`mcp-configs/`](../../mcp-configs/), its tools must be classified into "read-only" or "destructive" and any destructive entry must appear here AND in the JSON registry. The default glob fallback in the JSON catches name patterns that look destructive even when an explicit rule is missing — but explicit entries must always be preferred so the confirmation chip can show a meaningful summary instead of the raw tool name.

Threat-model cross-ref: [`hardening-overview.md`](hardening-overview.md) — `N-012`.

## Classification rules

A tool is **destructive** if invoking it has any externally-observable, user-impacting side effect: posting a message, sending a message/email, creating/updating/deleting a record outside the local agent VM, executing a remote workflow, granting/revoking access, etc.

A tool is **read-only** if it only retrieves information (search, list, history, replies, get-by-id) and a repeated call with the same arguments would be safe.

Edge cases:
- Tools that mutate purely local state inside the PORTICO agent VM (`agent_vm_*`) are **not** gated; the VM is sandboxed and the user can clean it up at will.
- Read tools that require a non-trivial OAuth scope but produce no side effect (e.g. `gmail_messages_list` with `gmail.readonly`) are **read-only**.
- Confirmation-style tools that themselves prompt the user (e.g. interactive UI flows) are still **destructive** if a successful flow performs the action.

## Catalogue

### Slack — [`mcp-configs/slack/`](../../mcp-configs/slack/)

| Tool name | Effect | Side-effect class |
|---|---|---|
| `slack_conversations_add_message` | Posts a message into a channel, DM, or group DM (mpim) | external-write |

OAuth scopes that grant write capability today (still requested even though the gate is what enforces): `chat:write`, `im:write`, `mpim:write`.

Read-only tools (NOT gated): `slack_conversations_search_messages`, `slack_conversations_history`, `slack_conversations_replies`, `slack_channels_list`.

### Google Workspace — [`mcp-configs/google_workspace/`](../../mcp-configs/google_workspace/)

| Tool name pattern | Effect | Side-effect class |
|---|---|---|
| `gmail_send_*`, `gmail_compose_*`, `gmail_drafts_send`, `gmail_messages_send` | Sends email as the user | external-write |
| `gmail_labels_create`, `gmail_labels_update`, `gmail_labels_delete` | Mutates Gmail labels | external-write |
| `drive_files_create`, `drive_files_update`, `drive_files_delete`, `drive_files_copy`, `drive_files_move` | Mutates Drive files | external-write |
| `drive_permissions_create`, `drive_permissions_update`, `drive_permissions_delete` | Changes Drive sharing | external-write |
| `docs_documents_create`, `docs_documents_batchUpdate` | Creates / mutates Google Docs | external-write |
| `sheets_spreadsheets_create`, `sheets_values_update`, `sheets_values_append`, `sheets_values_clear`, `sheets_spreadsheets_batchUpdate` | Mutates Sheets | external-write |
| `slides_presentations_create`, `slides_presentations_batchUpdate` | Mutates Slides | external-write |
| `calendar_events_insert`, `calendar_events_update`, `calendar_events_patch`, `calendar_events_delete`, `calendar_events_move` | Mutates calendar events | external-write |
| `calendar_calendars_insert`, `calendar_calendars_update`, `calendar_calendars_delete` | Creates / mutates calendars | external-write |

OAuth scopes: `gmail.send`, plus the umbrella `drive`, `documents`, `spreadsheets`, `presentations`, `calendar` (each grants both read AND write upstream — only the `*.readonly` variants are pure-read).

Read-only tools: anything matching `*_get`, `*_list`, `*_search`, `*_messages_get`, `*_files_get`, `gmail_messages_list`, `drive_files_list`, etc.

### GitLab — [`mcp-configs/gitlab-mcp/`](../../mcp-configs/gitlab-mcp/)

| Tool name pattern | Effect | Side-effect class |
|---|---|---|
| `gitlab_create_or_update_file`, `gitlab_create_branch`, `gitlab_push_files` | Modifies repo content | external-write |
| `gitlab_create_merge_request`, `gitlab_update_merge_request`, `gitlab_merge_merge_request`, `gitlab_close_merge_request`, `gitlab_reopen_merge_request` | Mutates MRs | external-write |
| `gitlab_create_issue`, `gitlab_update_issue`, `gitlab_close_issue`, `gitlab_reopen_issue`, `gitlab_delete_issue` | Mutates issues | external-write |
| `gitlab_create_note`, `gitlab_update_note`, `gitlab_delete_note` | Adds/edits comments | external-write |
| `gitlab_create_label`, `gitlab_update_label`, `gitlab_delete_label` | Mutates labels | external-write |
| `gitlab_create_pipeline` | Triggers a CI pipeline | external-write |
| `gitlab_fork_repository` | Creates a fork in the user's namespace | external-write |

Upstream gating: `GITLAB_READ_ONLY_MODE=true` disables all of these at the MCP server level. With `false` (current default in [`mcp-configs/gitlab-mcp/gitlab-mcp.yaml`](../../mcp-configs/gitlab-mcp/gitlab-mcp.yaml)) every entry above is exposed to the model.

Read-only tools: `gitlab_search_*`, `gitlab_get_*`, `gitlab_list_*`.

### Data Platform — [`mcp-configs/data-plat-mcp/`](../../mcp-configs/data-plat-mcp/)

| Tool name pattern | Effect | Side-effect class |
|---|---|---|
| `*query_execute*` (executes a SQL/notebook query against the workforce data platform) | Runs a query that may have side effects (insert/update/delete/DDL) depending on which warehouse role is active | external-write |
| `*workspace*write*`, `*idash*write*` | Mutates idash workspace metadata | external-write |
| `*query_generate*` | Generates SQL only — no execution. NOT gated. | read |

OAuth scopes: `workforce.data_platform.idash_workspace.write`, `workforce.data_platform.query.execute`.

### n8n — [`mcp-configs/mcp-n8n/`](../../mcp-configs/mcp-n8n/)

The built-in instance MCP exposes these write and execution tools through the
[official n8n MCP scope registry](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/modules/mcp/mcp-scopes.ts).

| Tool names | Effect | Side-effect class |
|---|---|---|
| `create_workflow_from_code`, `update_workflow`, `archive_workflow`, `restore_workflow_version`, `publish_workflow`, `unpublish_workflow` | Mutates workflow definitions or publication state | external-write |
| `execute_workflow`, `test_workflow`, `prepare_test_pin_data` | Executes a workflow or prepares mutable workflow test state | external-write |
| `create_data_table`, `rename_data_table`, `add_data_table_column`, `delete_data_table_column`, `rename_data_table_column`, `add_data_table_rows` | Mutates n8n data tables | external-write |

### n8n (Community Fork, deprecated) — [`mcp-configs/n8n-community-mcp/`](../../mcp-configs/n8n-community-mcp/)

Bundled fork of [czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp) kept for
migration off the community tooling; its tool names differ from the built-in
instance MCP above. Registry entries for this server bind to the **prefixed
dispatched names** (`n8n_community_mcp_<tool>`), the form the confirmation gate
actually matches against.

| Tool name pattern | Effect | Side-effect class |
|---|---|---|
| `n8n_community_mcp_n8n_create_*` (`n8n_create_workflow`) | Creates workflows | external-write |
| `n8n_community_mcp_n8n_update_*` (`n8n_update_full_workflow`, `n8n_update_partial_workflow`) | Mutates workflow definitions | external-write |
| `n8n_community_mcp_n8n_delete_workflow`, `n8n_community_mcp_n8n_delete_*` | Deletes workflows or other n8n resources | external-write |
| `n8n_community_mcp_n8n_test_workflow` | Test-executes a workflow ("test" is not a fallback verb — needs this explicit entry) | external-write |
| `n8n_community_mcp_n8n_deploy_template` | Creates a workflow from a template ("deploy" is not a fallback verb — needs this explicit entry) | external-write |
| `n8n_community_mcp_n8n_autofix_workflow` | Rewrites a workflow with automated fixes | external-write |
| `n8n_community_mcp_n8n_trigger_*`, `n8n_community_mcp_n8n_credential_*` | Defensive: webhook execution / credential mutation (absent from Portico's current fork build, which disables dangerous tools server-side) | external-write |

Read-only tools in the current build (`n8n_list_workflows`, `n8n_get_workflow`,
`n8n_executions`, `n8n_workflow_versions`, `n8n_search_example_workflows`,
`search_nodes`, `get_node`, `tools_documentation`, `validate_node`,
`validate_workflow`, `n8n_health_check`) match no registry entry and no fallback
verb — not gated. (`n8n_executions` is safe from the fallback because the verb
list matches whole segments: `executions` ≠ `execute`.)

### Atlassian — [`mcp-configs/mcp-atlassian/`](../../mcp-configs/mcp-atlassian/)

| Tool name pattern | Effect | Side-effect class |
|---|---|---|
| `jira_create_issue`, `jira_update_issue`, `jira_delete_issue`, `jira_transition_issue`, `jira_assign_issue` | Mutates Jira issues | external-write |
| `jira_add_comment`, `jira_update_comment`, `jira_delete_comment` | Mutates Jira comments | external-write |
| `jira_create_link`, `jira_delete_link` | Mutates issue links | external-write |
| `confluence_create_page`, `confluence_update_page`, `confluence_delete_page`, `confluence_move_page` | Mutates Confluence pages | external-write |
| `confluence_add_comment`, `confluence_update_comment`, `confluence_delete_comment` | Mutates Confluence comments | external-write |
| `confluence_create_attachment`, `confluence_delete_attachment` | Mutates attachments | external-write |

### Notifications — [`mcp-configs/notifications-mcp-server/`](../../mcp-configs/notifications-mcp-server/)

| Tool name pattern | Effect | Side-effect class |
|---|---|---|
| `notifications_send_*`, `notifications_publish_*` | Sends a notification to an external channel (PagerDuty / OpsGenie / etc.) | external-write |

Tools that emit a purely local OS-level toast inside the PORTICO app are not gated (display-only; user can dismiss).

### Out-of-scope MCPs (read-only or sandboxed)

Confirmed read-only or local-only at audit time, no entries needed in the registry:

- [`mcp-configs/agent-vm/`](../../mcp-configs/agent-vm/) — local sandboxed VM; mutations are user-recoverable.
- [`mcp-configs/scheduling/`](../../mcp-configs/scheduling/) — internal scheduling helper; read-only against the LLM.
- [`mcp-configs/sourcegraph/`](../../mcp-configs/sourcegraph/) — read-only code search.
- [`mcp-configs/chrome-devtools/`](../../mcp-configs/chrome-devtools/) — debugging surface; out of model reach in normal operation.
- [`mcp-configs/snowflake/`](../../mcp-configs/snowflake/) — read-only against the connected warehouse.
- [`mcp-configs/mcp-assistant/`](../../mcp-configs/mcp-assistant/) — internal helper; read-only.
- [`mcp-configs/skills/`](../../mcp-configs/skills/) — read-only skill discovery.
- [`mcp-configs/datadog/`](../../mcp-configs/datadog/) — read-only metrics.
- [`mcp-configs/glean/`](../../mcp-configs/glean/) — read-only enterprise search.
- [`mcp-configs/artifacts/`](../../mcp-configs/artifacts/) — local artifact persistence inside the PORTICO user data dir.
- [`mcp-configs/web-tools/`](../../mcp-configs/web-tools/) — fetch / search; read-only at the protocol level (HTTP GET).
- [`mcp-configs/teamworks-mcp/`](../../mcp-configs/teamworks-mcp/) — read-only.
- [`mcp-configs/subagents/`](../../mcp-configs/subagents/) — local sub-agent dispatch; sub-agents themselves run inside the gate, so their write tools get gated when invoked.
- [`mcp-configs/ownership-mcp/`](../../mcp-configs/ownership-mcp/) — read-only.

If any of these grow a write tool, add a row to the appropriate section above and a rule to the JSON registry.

## How the registry is loaded

The runtime reads [`mcp-policy/destructive-tools.json`](../../mcp-policy/destructive-tools.json) once at process start. Each rule has:

- `tool_name_glob` — matches against the resolved MCP tool name (e.g. `slack_conversations_add_message`). Glob syntax: `*` matches any non-empty segment.
- `mcp` — informational, used by audit logging and the confirmation chip title.
- `summary_template` — Mustache-style template used to render the human-readable confirmation summary; supports `{{field}}` and pipe filters `{{body|truncate:160}}`, `{{to|join:', '}}`, `{{body|chars}}`.
- `side_effect` — `external-write` (default) or `read` for explicit allowlist exceptions.

A `default_glob_fallback` regex catches future tool names that look destructive even when no explicit rule exists. The fallback regex is intentionally broad and produces a generic summary if it matches — the cost of a false-positive (extra confirmation) is far lower than the cost of a false-negative (silent dispatch). To allow-list a tool that the fallback matches but isn't actually destructive, add an explicit rule with `side_effect: "read"`.

## Scheduled-run scope binding (Phase 1 of the chip rework)

Scheduled tasks present a particular UX challenge for N-012: the user is not interactively present when the run fires, so the standard "click a chip to approve" flow stalls forever. We resolve this by binding consent to a CLASS of actions at task-creation time, then enforcing per-action hash binding inside that class at run time.

### Model

When the user creates a scheduled task they pick a list of `tool_server_ids` the task is allowed to use. The scheduling daemon snapshots that list onto the task record (`ScheduledTask.tool_server_ids`) and, when it dispatches a run, stamps the resulting OWUI sub-agent chat's `chat.meta` with:

```json
{
  "run_origin": "scheduled",
  "scheduled_task_id": "<task id>",
  "scheduled_approved_scope": ["server-id-1", "server-id-2"]
}
```

The keys are defined as constants in both:

- [`src/core-mcp-rust/crates/scheduling-server/src/runtime.rs`](../../src/core-mcp-rust/crates/scheduling-server/src/runtime.rs) — the daemon side (writer).
- [`src/patches/backend/open_webui/utils/scheduled_run_scope.py`](../../src/patches/backend/open_webui/utils/scheduled_run_scope.py) — the gate side (reader).

### Trust boundary

Only the scheduling daemon writes `chat.meta` for a freshly-created chat at `/api/v1/chats/new` (using the OWUI service token). The model running inside the chat **cannot** edit `chat.meta` — no MCP tool exposes that write, and the chip-resolve REST endpoint also doesn't mutate it. The gate is therefore allowed to TRUST the values it reads back. If that boundary ever changes (e.g. a `chat:tags:update`-style API starts touching `meta`, or `Chats.update_chat` becomes reachable from the model), this code path MUST be re-audited and the daemon-stamped metadata MUST move to a tamper-evident location (signed envelope, separate scheduling-server-side lookup keyed on chat_id).

### Per-action evaluation inside a scheduled run

Inside a scheduled-run sub-agent chat, every destructive tool call is still evaluated by the gate exactly as in an interactive chat — N-012's hash binding still applies. The only thing that changes is what happens AFTER `evaluate_tool_call` returns `block`:

1. The gate consults `chat.meta.scheduled_approved_scope`.
2. **In scope** (the tool's `mcp` label or tool-name prefix matches an entry): the gate marks the same hash approved, emits a `dispatched_scheduled_pre_approved` audit event, and re-evaluates so the call dispatches in the same turn. The chip never surfaces; the audit log shows the full picture (proposed → pre-approved → dispatched).
3. **Out of scope**: the gate drops the standard pending entry and proposes a `clarification` chip with three security-bounded options:
   - `out_of_scope_block` — block this run. Audit `cancelled` with `reason="out_of_scope_block"`. Run ends.
   - `out_of_scope_approve_once` — register the approved hash for the original call so the model's next-turn re-emit dispatches. Single-use (the gate's existing single-use machinery consumes it). Audit `approved` with `reason="out_of_scope_approve_once"`.
   - `out_of_scope_widen_scope` — same as approve-once, plus the system note instructs the model to first call `scheduling_update_task` to add the new `tool_server_id` to the task's scope. Future runs of the same task pick up the wider scope automatically. Audit `approved` with `reason="out_of_scope_widen_scope"` plus `tool_server_id` field for traceability.

A "never ask again" / "trust forever" option is intentionally NOT offered — that bypass would let a single clarification turn silently grow a model's persistent capability and defeats N-012's per-action invariant.

### Pre-flight integration health (Phase 2 of the chip rework)

A scheduled task whose `tool_server_ids` reference an offline integration would fail at the first tool call inside an unattended run — and worse, would do so silently at midnight with no observer. We block that two ways:

- **At creation time**, [`skills/scheduled-tasks/SKILL.md`](../../skills/scheduled-tasks/SKILL.md) instructs the model to call `mcp_assistant_list_mcp_servers` before `scheduling_create_task` and refuse to create the task if any required integration is offline (and the user declines activation). This is the user-facing safety net.
- **At run start**, the daemon's executor calls a defensive [`check_tool_servers_available`](../../src/core-mcp-rust/crates/scheduling-server/src/preflight.rs) that walks the local MCP configs directories and the toggle file. If any `tool_server_id` is missing or explicitly disabled, the run is recorded as `last_run_status: "missing_integration"` and `last_run_error` names every offending integration. No sub-agent chat is created. This is the belt for when prompt drift, integration removal, or toggle changes between creation and execution would otherwise produce a silent failure.

The skill side is observable to the user; the executor side is observable to whoever inspects `last_run_*`. Together they make the failure mode actionable instead of mysterious.

### Threat model deltas vs. the original N-012

| Threat | Mitigation in the original gate | Additional mitigation in the scope-binding extension |
|--------|--------------------------------|------------------------------------------------------|
| Model self-approves via stale "yes" | Hash binding + per-turn TTL | Same — hash binding still applies inside scheduled runs. |
| Model exfiltrates via a tool the user didn't intend to expose | Per-action chip blocks every destructive call | Out-of-scope chip surfaces immediately when the tool's mcp/prefix isn't in `approved_scope`. The user sees the unexpected tool BEFORE it dispatches. |
| Model invents an approval option (e.g. `approve_forever`) | n/a | Gate validates option_id against the chip's declared options; unknown ids audit `gate_bypass_attempted` and the resolver returns no record. |
| Model spoofs `chat.meta` via a synthesized user message | n/a | Reader only consults `Chats.get_chat_by_id`, never user-message content. Pinned by `test_forged_user_message_cannot_supply_chat_meta_to_bypass_gate` in `tests/test_scheduled_run_scope.py`. |
| Scheduled task whose integration disappears later | n/a | Executor preflight FAIL-CLOSED records `missing_integration`; cron tasks advance schedule, once-tasks disable themselves. |
| User abandons a scheduled run mid-way through an unexpected tool call | Run hangs forever waiting for a chip nobody will see | Open question; the proposed TTL follow-up is tracked in the architecture doc at [`../architecture/chat-ui/chip-system.md`](../architecture/chat-ui/chip-system.md). |
