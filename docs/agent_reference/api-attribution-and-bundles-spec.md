# External Client Guide: API-Key Access for Solutions and Bundles

## Overview

External clients can publish, update, and retrieve marketplace solutions through the `/api/solutions` service by supplying a valid API key.

This guide focuses on how an API-key client can:

1. create a solution,
2. attach user attribution as LDAP or email,
3. store a typed bundle for installable content such as an Portico agent or a skill,
4. update or bulk-ingest solutions, and
5. read the solution envelope and bundle back later.

## Authentication

Send the API key in either header:

```http
X-API-Key: <secret>
```

or:

```http
Authorization: Bearer <secret>
```

## Routes Available to API-Key Clients

| Method | Path | Purpose |
|-------|------|---------|
| `POST` | `/api/solutions` | Create one solution |
| `POST` | `/api/solutions/bulk` | Create or upsert many solutions |
| `PUT` | `/api/solutions/:id` | Update an existing solution |
| `DELETE` | `/api/solutions/:id` | Soft-delete a solution |
| `GET` | `/api/solutions/:id` | Read the solution envelope |
| `GET` | `/api/solutions/:id/bundle` | Read the stored bundle |
| `POST` | `/api/solutions/search` | Search solutions |

## Core Payload Shape

For create or update requests, the main fields relevant to external publishers are:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | yes on create | Marketplace display name |
| `description` | `string` | yes on create | Searchable summary |
| `author` | `string` | yes on create | Displayed provider or owner label |
| `type` | `string` | yes on create | Solution type, such as `portico-agents` or `skills` |
| `detail_url` | `string` | required unless `bundle` is present | External detail page |
| `bundle` | `object` | optional | Installable payload stored by the service |
| `submitted_by` | `string` | optional | User attribution, usually LDAP or email |
| `comment` | `string` | optional | Additional searchable text |

## User Attribution for External Clients

If you want to simulate user attribution when publishing through the API-key route, send `submitted_by` in the request body.

### What to send

- Send LDAP directly if you already have it, for example `jdoe`.
- Send email if that is the identifier you have, for example `jdoe@example.invalid`.
- Keep `author` separate from `submitted_by`.

Example:

```json
{
  "author": "Jane Doe",
  "submitted_by": "jdoe@example.invalid"
}
```

### Recommended client behavior

For best consistency with user-submission flows:

1. Send `submitted_by` as the user's full email, for example `jdoe@example.invalid`.
2. Use the same email for the `x-remote-user` viewer header so search/visibility and ownership checks agree.
3. Use `author` for the visible provider label, not for identity tracking.

### Important note about current behavior

Today, the admin/API-key route stores `submitted_by` as provided. If you send an email, it is stored as an email. If you send LDAP, it is stored as LDAP.

That means an external client should choose one format consistently. The Portico client now sends the signed-in user's full email for both `submitted_by` and `x-remote-user`, and the per-agent allow list (`allowed_emails`) is matched on email.

## Bundle Support

A solution may include a `bundle` when the solution itself is installable.

Bundle shape:

```json
{
  "type": "skills",
  "payload": {}
}
```

Rules:

1. `bundle.type` must match the top-level `type`.
2. `bundle.payload` is validated based on the bundle type.
3. The service stores the bundle verbatim.
4. The create or update response omits the full bundle blob.
5. The bundle can be fetched later from `GET /api/solutions/:id/bundle`.

If `bundle` is present and `detail_url` is omitted, the service may default `detail_url` to `/api/solutions/:id/bundle`.

## Supported Bundle Types

| `type` | Use case | Minimum payload expectation |
|-------|----------|-----------------------------|
| `portico-agents` | Installable AI Chat agent | Agent payload with at least `name` and `system_prompt` |
| `skills` | Installable skill package | Payload with at least `skill_md` |
| `mcp-servers` | Installable MCP server definition | MCP server payload |

If a solution is not installable, you can omit `bundle` and use `detail_url` only.

## Create an Agent

```json
POST /api/solutions
X-API-Key: <secret>
Content-Type: application/json

{
  "name": "Data Analyst Agent",
  "description": "Answers questions about metrics and dashboards.",
  "author": "Jane Doe",
  "submitted_by": "jdoe",
  "type": "portico-agents",
  "bundle": {
    "type": "portico-agents",
    "payload": {
      "name": "Data Analyst Agent",
      "description": "Answers questions about metrics and dashboards.",
      "base_model_id": "Atlas Opus",
      "system_prompt": "Use evidence and be precise.",
      "skill_ids": ["company-knowledge"],
      "tool_server_ids": ["server:glean"],
      "tool_server_refs": [
        {
          "tool_server_id": "server:glean",
          "solution_id": "glean-mcp-server-solution-id"
        }
      ]
    }
  }
}
```

What happens:

1. The solution is created.
2. The bundle is validated and stored.
3. Searchable text may be extracted from the bundle for search indexing.
4. The response returns the solution envelope, without the raw bundle payload.

`tool_server_refs` is optional. Include it when an agent depends on an MCP
server that is also published as an installable marketplace solution. During
agent install, clients can fetch those referenced MCP server bundles, install
them locally, enable the required servers, and then alert users if any server
still needs configuration before the agent can use it.

## Create a Skill

```json
POST /api/solutions
X-API-Key: <secret>
Content-Type: application/json

{
  "name": "Incident Review Skill",
  "description": "Guides responders through incident review.",
  "author": "Site Reliability Engineering",
  "submitted_by": "sre-owner",
  "type": "skills",
  "bundle": {
    "type": "skills",
    "payload": {
      "skill_md": "# Incident Review\n\nUse this skill to summarize incidents."
    }
  }
}
```

## Bulk Ingest Multiple Solutions

Use `POST /api/solutions/bulk` to send multiple rows at once.

```json
{
  "solutions": [
    {
      "name": "Data Analyst Agent",
      "description": "Agent bundle",
      "author": "Jane Doe",
      "submitted_by": "jdoe",
      "type": "portico-agents",
      "bundle": {
        "type": "portico-agents",
        "payload": {
          "name": "Data Analyst Agent",
          "system_prompt": "Be precise."
        }
      }
    },
    {
      "name": "Incident Review Skill",
      "description": "Skill bundle",
      "author": "SRE",
      "submitted_by": "sre-owner",
      "type": "skills",
      "bundle": {
        "type": "skills",
        "payload": {
          "skill_md": "# Incident Review"
        }
      }
    }
  ]
}
```

Notes:

- Maximum batch size is 500.
- Each row may have its own `submitted_by`.
- Existing IDs can be upserted through the bulk route.

## Read Back What You Stored

### Read the solution envelope

```http
GET /api/solutions/:id
```

Returns metadata such as:

- `id`
- `name`
- `description`
- `author`
- `submitted_by`
- `type`
- `detail_url`
- `has_bundle`

### Read the stored bundle

```http
GET /api/solutions/:id/bundle
```

Returns:

```json
{
  "type": "skills",
  "payload": {}
}
```

## Update an Existing Solution

Use:

```http
PUT /api/solutions/:id
```

You can update fields such as:

- `name`
- `description`
- `author`
- `submitted_by`
- `detail_url`
- `bundle`

If you replace `bundle`, the previous stored bundle is overwritten.

## Search for Solutions

Use:

```http
POST /api/solutions/search
```

Search works across regular solution fields and extracted bundle text, so clients can publish agents or skills and later discover them through the same search API.

## Recommended External Client Pattern

For an external publishing client:

1. Choose a stable `type` for the content you publish.
2. Send `author` as the display label users should see.
3. Send `submitted_by` as a stable identity, preferably the user's full email.
4. Include a `bundle` when the content should be installable from the marketplace.
5. Persist the returned solution `id` so future updates can use `PUT /api/solutions/:id`.
6. Use `GET /api/solutions/:id/bundle` when the installer needs the raw payload later.

## Portico Local Agent Attribution (`created_by_email`)

The Portico desktop client surfaces "Created by" on its own local agent cards, independent of the marketplace fields above. The desktop application and Subagents MCP server own this attribution contract; calling models never supply it.

- `create_agent` does not expose a `created_by_email` input. The Subagents server resolves the authenticated desktop session through Electron and stores its exact, trimmed full email in `meta.subagent_created_by_email` together with `meta.subagent_creation_source: "local"`. Creation fails before the model write if that identity is unavailable.
- On Marketplace install, the app writes a pending installed-link record before model creation. Reconciliation then replaces the temporary local creator with the solution's original `submitted_by` **verbatim**, records `subagent_creation_source: "marketplace"`, and clears the pending state. A blank `submitted_by` blocks the install before dependencies or the model are mutated.
- Local creator identities are full authenticated emails. Marketplace creator identities are intentionally not normalized at storage time because `submitted_by` may be a full email or a bare handle. No code guesses or appends an email domain.
- The versioned local link registry records `relationship` (`published`, `installed`, or legacy `unknown`), `authorIdentity`, and `attributionPending`. Publish, install, update, and unpublish lifecycle writes happen in the shared main-process operation layer used by both GUI and chat paths.
- Startup reconciliation backfills only custom, non-system, unlinked agents with a blank creator. It never overwrites an existing creator, and it skips base models, `portico_agent_*` system agents, and legacy linked agents other than pending fresh installs.
- Agent list/detail results expose `creation_source`, `marketplace_relationship`, and `marketplace_solution_id`. The compatibility field `is_local` means only that a **base model** is supplied by local LM Studio; it is never evidence of agent ownership, machine residence, publication, or Marketplace installation.
- Any consumer that needs to check whether a viewer *is* the stored creator (e.g. for edit-access decisions) must normalize **both** the stored value and the viewer's identity through the same local-part-only comparison (lowercase, strip everything from `@` onward) before comparing — never assume either side is already in a specific format. The client's reference implementation of this is `normalizeMarketplaceOwnerIdentity()` in `electron-app/src/renderer/components/agents.js`.
- `bundle.payload` never carries identity fields — attribution lives only on the solution envelope (verified via `GET /api/solutions/:id/bundle`, which returns `{"payload": {...}, "type": "..."}` with no `submitted_by`/`author` keys inside `payload`).

## Current Constraints

- API keys unlock the admin-style routes, but they do not turn the request into the user-submission flow.
- Ownership checks used by `/api/solutions/submit` are not applied automatically to API-key writes.
- The service currently stores `submitted_by` exactly as sent by the API client.
- The main create/update response does not inline the full bundle payload.
