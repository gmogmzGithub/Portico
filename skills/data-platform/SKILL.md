---
name: data-platform
description: Operational guardrails for Portico Data Platform query discovery, async execution, and status polling. Use when working with Trino, IQL, Snowflake, iDash, or data-plat-mcp query tools.
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Data Platform
  version: "1.0"
  priority: high
  triggers:
    - "trino"
    - "iql"
    - "snowflake"
    - "datalake"
    - "execute query"
    - "data platform"
    - "idash"
    - "query status"
    - "rcpimpressions"
    - "applicationfunnel"
    - "usersession"
required_mcp_servers:
  - "server:data-plat-mcp"
---

# Data Platform Skill

Use this skill to keep Data Platform query execution disciplined and observable. This is operational guidance for query lifecycle management, not query-authoring syntax.

## Query Resolution First

Before running a query, make sure you know what query text and engine you are actually executing.

If the user provides an idash query URL like `https://data.example.invalid/idash/workspace/114164/queries/16`:

1. Extract both `workspaceId` and `queryId` from the URL.
2. Call `data_plat_mcp_list_workspace_queries(workspaceId=...)`.
3. Find the saved query by nested `id.id == queryId`, not by `.id == queryId`.
4. Parse the query object's `contents` JSON string before reading `name`, `engine`, or query text.
5. Use the parsed `engine` and query text as the source of truth for execution.

If `list_workspace_queries` overflows into an Agent VM file:

1. Do targeted inspection only.
2. Prefer a jq filter like `.[] | select(.id.id == QUERY_ID)`.
3. Parse `.contents` as JSON before inspecting `name`, `engine`, or query text.
4. Do not conclude that a query is missing just because `.id == QUERY_ID` returns nothing.
5. Do not rely on top-level `name` fields from the overflowed list payload; use parsed `contents`.

## TRINO Execution Rule

Apply this section whenever the query you are about to run is a TRINO query, even if you only discover that through agentic lookup of a saved query or idash URL.

1. If the user already specified the TRINO environment, respect it.
2. If the user did not specify the environment, ask with `skills_ask_user_question` and `chat_id` before execution.
3. For the default blocking choice, offer exactly two options:
   - `Interactive`
   - `Prod`
4. Map those choices to `queryEnvironment: "interactive"` or `queryEnvironment: "prod"`.
5. If the user explicitly asks for another valid TRINO environment such as `stage`, respect that explicit instruction instead of overriding it.
6. On the first `data_plat_mcp_execute_query` call for a new TRINO query text, always pass `maxWait: 120`.
7. Never use `maxWait: 0` on the first attempt.
8. Never use `maxWait` greater than `120`.
9. Keep one query in flight at a time.

## Continue Waiting Gate

If a TRINO execution does not finish successfully within the initial `maxWait: 120` window but returns a non-terminal timeout / in-progress style result with an `executionId`:

1. Do not auto-poll.
2. Do not re-run the query.
3. Ask the user with `skills_ask_user_question` and `chat_id` whether to:
   - `Continue waiting`
   - `Stop`
4. Only start polling if the user explicitly chooses `Continue waiting`.
5. If the user chooses `Stop`, stop and report the `executionId`.

Results may have landed while the `Continue waiting` question was unanswered, so check status before sleeping again.

Use this exact pacing pattern for async queries:

1. Immediately call `data_plat_mcp_get_query_status(executionId=...)`; do not wait first.
2. If status is `QUEUED` or `IN_PROGRESS`, call `skills_wait(seconds=30)`.
3. After waiting, repeat from step 1.

After five polls, increase the wait to `skills_wait(seconds=60)`.

Stop polling when status is one of:

- `COMPLETED`
- `FAILED`
- `EXCEEDED_TIME_LIMIT`
- `EXCEEDED_MEMORY_LIMIT`

If polling shows that a TRINO query running on `Interactive` hit `EXCEEDED_TIME_LIMIT`, treat that as the Interactive environment's hard 10 minute timeout:

1. Do not keep waiting.
2. Do not silently re-run the query.
3. Ask the user with `skills_ask_user_question` and `chat_id` whether to:
   - `Retry in Prod`
   - `Optimize the query`
   - `Stop`
4. If the user chooses `Retry in Prod`, that is explicit permission to submit a fresh run of the same query text against `queryEnvironment: "prod"` with `maxWait: 120`.
5. If the user chooses `Optimize the query`, stop polling and switch to helping them improve the query instead of re-running it.
6. If the user chooses `Stop`, stop and report the terminal timeout plus the `executionId`.
7. Remember that `Prod` queries can run for up to 60 minutes before timing out, but you must still cap `maxWait` at `120` and continue through polling rather than holding a single tool call open longer.

For any other terminal status, stop and report the terminal result. Do not ask whether to keep waiting on a terminal failure.

## Single-Submission Invariant

- Never submit the same query text more than once in a row unless the user explicitly asks for a fresh re-run.
- Before composing or submitting a different query, check whether the last known `executionId` is still `IN_PROGRESS`.
- If a prior query is still running and the user chose `Continue waiting`, continue polling that execution instead of composing a replacement query.
- Do not run two variants of the same investigation concurrently unless the user explicitly asks for separate intentional runs.

## OAuth Scope Recovery

If a Data Platform tool call fails because the current OAuth grant is missing required scopes, treat it as an under-scoped OAuth token, not as a server restart or query-writing problem.

Forced re-auth applies when the error includes any of:

- HTTP `401`
- `OAuth re-authorization required`
- missing scope or insufficient scope
- `oauth_recovery_required`
- `force_auth_recommended`
- an explicit Data Platform scope such as `workforce.data_platform.idash_workspace.read`

When this happens, call `mcp_assistant_authorize_integration({server_id: "data-plat-mcp", chat_id: <current chat id>, force_auth: true})`.

Use `force_auth: true` because existing token files may still be present and valid enough for generic readiness, but under-scoped for the blocked Data Platform action. The authorize flow clears the persisted OAuth token and client files before launching the browser auth flow.

Do not recommend restarting Data Platform, replacing tokens manually, or going to Control Plane before trying agentic forced re-auth. If forced re-auth succeeds and the integration reaches `tool_ready`, retry the original blocked Data Platform action once. If forced re-auth is dismissed or fails, report that the fallback is Control Plane -> Integrations -> Data Platform -> Re-auth.

## Error Handling

- If status is `FAILED`, `EXCEEDED_TIME_LIMIT`, or `EXCEEDED_MEMORY_LIMIT`, stop.
- Surface the failure clearly to the user and include the `executionId`.
- Do not silently retry.
- The one exception to immediate stop is a TRINO query on `Interactive` that hits `EXCEEDED_TIME_LIMIT`: ask whether to `Retry in Prod`, `Optimize the query`, or `Stop` before doing anything else.
- Do not re-submit the same query after a timeout, raw `504`, or in-progress result unless the user explicitly tells you to run it again.
- A syntax fix, schema fix, or logic change is a fresh intentional submission and should be described as such.

## Discovery First

Before scanning catalog tables or `information_schema`, prefer these tools when they fit the task:

- `data_plat_mcp_search_data_assets`
- `data_plat_mcp_get_data_asset_fields`
- `data_plat_mcp_get_data_asset_query_history`

Use them to identify the right asset or prior query pattern before writing a new query. Avoid broad `%like%` scans when a direct data asset lookup is available.

## Authoring Help

This skill does not teach Trino or IQL syntax.

- If the user wants query-authoring help and the Data Platform marketplace skills are installed, activate `data-plat-skills/trino-query-writing` for Trino help.
- Activate `data-plat-skills/iql-query-writing` for IQL help.
- If those marketplace skills are not installed, say so plainly and continue with operational guidance only.

## Honesty Rule

When asked whether you submitted a query, answer by referencing the recorded `executionId` values returned by prior tool calls. Never claim you did not submit a query if you have an `executionId` proving that you did.
