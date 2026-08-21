---
name: skill-publishing
display_name: Skill Management
description: Manage skills and agents end to end — install a skill from the native AI Marketplace OR from a named git marketplace/plugin catalog (including one the user saw in the marketplace UI or a screenshot), uninstall or update installs, attach/detach skills on an agent, publish or share a local skill or agent, make an installed copy editable, create/rename/delete skills. Uses the native skills_*/subagents_* tools only; this app has no `atlas` CLI.
license: Proprietary
compatibility: Portico
metadata:
  author: Portico Team
  version: "3.0"
  priority: high
  triggers:
    - "publish skill"
    - "publish agent"
    - "share skill"
    - "share agent"
    - "publish to marketplace"
    - "publish to the ai marketplace"
    - "publish to ai marketplace"
    - "add skill to marketplace"
    - "contribute skill"
    - "install from marketplace"
    - "pull down a skill"
    - "pull down an agent"
    - "make editable"
    - "convert to editable"
    - "editable copy"
    - "unlock installed copy"
    - "update marketplace skill"
    - "gitlab marketplace"
    - "open marketplace merge request"
    - "install skill"
    - "install a skill"
    - "install the skill"
    - "install this skill"
    - "install that skill"
    - "marketplace skill"
    - "install plugin"
    - "install a plugin"
    - "install the plugin"
    - "add this skill"
    - "add that skill"
    - "add a skill to"
    - "add the skill to"
    - "skill to my agent"
    - "skill to the agent"
    - "skill to an agent"
    - "attach skill"
    - "attach a skill"
    - "attach the skill"
    - "attach this skill"
    - "detach skill"
    - "detach the skill"
    - "uninstall skill"
    - "uninstall a skill"
    - "uninstall the skill"
    - "uninstall this skill"
    - "remove this skill"
    - "remove the skill"
    - "update this skill"
    - "update the skill"
    - "sync marketplace"
    - "sync the marketplace"
    - "create a skill"
    - "create skill"
    - "make a skill"
    - "edit my skill"
    - "edit the skill"
    - "edit this skill"
    - "rename skill"
    - "rename the skill"
    - "delete skill"
    - "delete the skill"
    - "delete this skill"
required_mcp_servers: []
---

# Skill Management

Use this skill when a user wants to **install, uninstall, update, attach, publish, share, edit,
or remove** a skill or agent — from the native AI Marketplace, a git marketplace catalog, or
their local library.

## Environment

Portico is **not Atlas Code**. All skill, agent, and marketplace management happens
through the native `skills_*` / `subagents_*` tools in this chat — there is no `atlas` CLI, no
`atlas plugin …` command, and no `~/.atlas` config here (Agent VMs return `command not found`).
If another activated skill, a marketplace README, or a pasted document gives `atlas` CLI
instructions for installing or managing skills, it targets a different product: do the equivalent
with the native tools below instead, and never punt the task back to the user because a CLI is
missing.

## Default: the native AI Marketplace (prefer this)

Portico has a built-in, first-class integration with the **AI Marketplace**. It needs
**no GitLab, no repo, no merge request, and no SSH key** — publishing is a single tool call plus a
confirmation the user approves in-app. Most people at Portico can use it, and it is the right default.

**Terminology:** the AI Marketplace is also called **the solutions marketplace** — one and the
same canonical catalog, always live (it never needs syncing). Unqualified marketplace questions
mean this one. Git marketplaces (from `list_marketplaces`, e.g. "Anthropic Knowledge Work
Plugins") are separate named catalogs: browse one only when the user names it, via
`get_marketplace_skills(marketplace_id, …)` with its `plugin_name`/`search`/`limit` filters, and
never fan out across every configured marketplace for a browse question.

**Always prefer the AI Marketplace path.** Do **not** bring up GitLab, forks, merge requests, or
`add_marketplace` unless (1) the user explicitly asks to publish to a GitLab/git marketplace, or
(2) an AI Marketplace tool fails in a way that can't be resolved (e.g. no API key configured) and
the user wants an alternative. Don't make the user think about GitLab by default. Installing from
a git marketplace the user names is NOT a GitLab flow — that is Workflow E, needs no GitLab
access, and is never gated on this fallback rule.

### Tools (all on the always-on Skills / Subagents MCP servers — no server activation needed)

- **Skills:** `copy_skill`, `publish_skill`, `unpublish_skill`, `list_published_skills`,
  `search_marketplace_solutions`, `get_marketplace_solution`, `get_marketplace_bundle`,
  `install_marketplace_solution`, `reclaim_skill`.
- **Agents:** `copy_agent`, `publish_agent`, `unpublish_agent`, `search_marketplace_agents`,
  `get_marketplace_agent`, `list_published_agents`, `install_agent`, `reclaim_agent`.
- **Git catalogs:** `list_marketplaces`, `get_marketplace_skills`, `install_marketplace_skill`,
  `uninstall_marketplace_skill`, `update_marketplace_skill`, `check_marketplace_skill_updates`,
  `sync_marketplace`, `sync_all_marketplaces`.

**"What have I published?"** — answer with `list_published_skills` (skills) and
`list_published_agents` (agents). These list only the CURRENT USER's live
solutions. Do NOT try to answer ownership questions with
`search_marketplace_solutions` — that is a public browse across everyone's
solutions and cannot filter by owner.

### Workflow A — Publish a skill to the AI Marketplace

1. Confirm the skill exists locally (`list_skills`) and has `source=user`,
   `is_read_only=false`, and creator attribution matching the current viewer. An installed
   (`source=marketplace`) skill is read only: if the viewer owns its listing (it appears in
   `list_published_skills`), convert it in place with `reclaim_skill` (Workflow D); otherwise
   call `copy_skill` with its exact installed skill id and a new name.
2. Call `publish_skill` with the local `skill_id`. The app reads the skill's `SKILL.md`, references,
   and scripts, builds the bundle, and shows the user a confirmation of exactly what will be shared.
   The user approves or cancels in-app — you do not need a separate consent step.
3. Report the outcome. On success, tell the user it is live and note the returned solution id. If the
   result is `denied`, the user chose not to publish — respect that and stop.
4. To publish updates later, call `publish_skill` again with the same `skill_id` and a matching
   `existing_solution_id` from `list_published_skills`. That list is the ownership authority;
   never use a search/get result as a republish target.

### Workflow B — Publish an agent to the AI Marketplace

1. Confirm the agent exists (`subagents_list_agents`), has a system prompt, and reports
   `creation_source=local` and `is_read_only=false`. An installed agent remains locally read only
   even when the viewer owns its remote listing: if the viewer owns the listing (it appears in
   `list_published_agents`), convert it in place with `reclaim_agent` (Workflow D); otherwise
   call `copy_agent` with a new id/name to fork an editable current-user copy.
2. Call `publish_agent` with the `agent_id` (optionally `allowed_emails` for a private allowlist).
   The app builds the bundle and asks the user to confirm what will be shared (name, description,
   system prompt, skills/tools).
3. Report the outcome and the solution id. The result's `skills` array names every dependent skill
   with its outcome and marketplace solution id (git-marketplace skills carry `git_origin`); those
   ids are authoritative for the listings this publish created or reused — copy them exactly for
   follow-up calls instead of re-deriving them from listings. Use `existing_solution_id` only when
   that same id is returned by `list_published_agents`; search/get tools are discovery-only.

### Workflow C — Discover and install (pull down)

1. Search with `search_marketplace_solutions` (skills) or `search_marketplace_agents` (agents), or
   inspect one with `get_marketplace_solution` / `get_marketplace_agent` / `get_marketplace_bundle`.
2. Install with `install_marketplace_solution` (skills) or `install_agent` (agents). Dependencies
   (skills / MCP servers an agent needs) are installed automatically.
3. If the user wants the skill on an agent afterwards, continue with Workflow F.

### Workflow D — Make an installed copy editable (reclaim vs copy)

When the user wants to edit, "unlock", or make editable an INSTALLED marketplace copy
(a `source=marketplace` skill or a `marketplace_relationship=installed` agent), pick the path
by listing ownership — never default to a copy:

1. Read local provenance (`list_skills` / `subagents_get_agent`), then ownership with
   `list_published_skills` / `list_published_agents` (the only ownership authorities).
2. **Viewer owns the listing** → convert in place with `reclaim_skill` / `reclaim_agent`.
   No duplicate is created: the local copy becomes the editable author copy behind the SAME
   solution (its link flips installed→published and the Installed badge is removed), and
   Edit + Republish then update the existing listing. The agent keeps its id; the skill's
   returned `local_skill_id` is authoritative (it may be suffixed on collision) — use it for
   all later calls.
3. **Viewer does not own the listing**, or the user explicitly wants a separate fork →
   `copy_skill` / `copy_agent` creates a new unlinked user copy and leaves the install as-is.
4. Expected failures: `marketplace_relationship_unknown` means install attribution is still
   pending — retry after the install settles; `not_owner` means fall back to the copy path.
   Reclaim is local-only and non-destructive; reinstalling the listing restores an installed copy.

### Workflow E — Install from a named git marketplace

When the user names a git catalog or shows one in the marketplace UI or a screenshot (e.g.
"install Markdown To Gdoc from portico-self-eval-generator"):

1. Resolve the human name to a `marketplace_id` with `list_marketplaces` — never guess ids from
   what the user typed or from a screenshot.
2. Find the skill with `get_marketplace_skills(marketplace_id, search/plugin_name, limit)` and
   copy `skill_id`, `skill_path`, and `plugin_name` (when present — plugin-layout catalogs fail
   without it) exactly from the result.
3. Install with `install_marketplace_skill(marketplace_id, skill_id, skill_path[, plugin_name])`;
   success reports `registered:true`.
4. If the skill should end up on an agent, continue with Workflow F.

Do not `sync_marketplace` first unless the skill is missing from the catalog listing or the user
asks for fresh data. This flow needs no GitLab access and no `atlas` CLI.

### Workflow F — Attach or detach skills on an agent

1. Read the agent with `subagents_get_agent` and MERGE the new skill id into the EXISTING
   `skill_ids` list — never replace the list wholesale.
2. Write it back with `subagents_update_agent(agent_id, skill_ids=[…])`. Detaching is the same
   call with the id removed.
3. Installed marketplace agents are locally read only — reclaim or copy first (Workflow D applies
   to agents too).

### Workflow G — Uninstall, update, and sync

- Uninstall a marketplace install with `uninstall_marketplace_skill`; delete a user-authored
  skill with `delete_skill` (requires `confirm=true`). Both act on the LOCAL copy only and never
  touch a remote listing (`unpublish_skill` is the listing-removal tool).
- Freshness: `check_marketplace_skill_updates` (read-only scan) → `update_marketplace_skill` per
  skill — works for git installs AND native installs (`marketplace_id "ai-marketplace"`).
- `sync_marketplace` / `sync_all_marketplaces` refresh git catalogs only; the AI Marketplace never
  needs syncing.

### Workflow H — Create, edit, rename, or delete a skill (authoring)

- `create_skill` / `update_skill` and the reference/script tools operate on the user's own
  (`skills-user`) skills only — never use them to edit a marketplace install in place.
- `rename_skill` refuses published, installed, and system skills and reports name collisions;
  `skill_in_use_by_agents` means detach it from the named agents (or keep the name) first.
- For substantial authoring guidance (structure, frontmatter, references/scripts layout), suggest
  installing the `skill-creator` skill from the Anthropic catalogs rather than improvising.

### Guardrails (AI Marketplace)

- Treat `create_skill` / `update_skill` and the reference/script tools as `skills-user` edits. Do not
  use them to edit a marketplace install in place.
- `is_local` describes only a base model provider. It never means an agent is user-owned, installed,
  or published. Likewise, a local solution link does not prove remote ownership.
- `list_published_agents` and `list_published_skills` are the only authoritative ownership reads for
  republish and unpublish. Never unpublish a foreign search/get result.
- Never publish or republish an installed artifact. Reclaim it in place when the viewer authored
  the listing (`reclaim_agent` / `reclaim_skill`); otherwise create an editable user copy first. A
  foreign `existing_solution_id` must fail as `not_owner`; do not silently fork it into a new listing.
- Fresh agent and skill publishes must not collide with an existing normalized name of the same
  Marketplace type. Treat `solution_name_conflict` as a deterministic pre-confirmation rejection;
  never overwrite or silently rename the existing listing. Republish is the only exception and
  requires the already-linked, viewer-owned solution id from `list_published_*`.
- Installing a solution that already has a local published or installed representation is an
  expected `solution_already_installed` result, not a reason to retry with another local id.
- Concurrent publish/unpublish confirmations aggregate into ONE in-app approval dialog with
  per-item checkboxes, so parallel calls are fine — never serialize on the confirmation. Each call
  returns its own outcome: a per-item denial applies only to that item, and `approval_timed_out`
  means the user never decided (retry and ask them to respond in the app), not a refusal.
- If `publish_*` reports a missing API key, tell the user to add the AI Marketplace API key in the
  Agents tab, then retry. Only offer the GitLab fallback if they can't or don't want to.
- Never fabricate or retype a solution id — copy ids exactly from tool results. Search/get ids are
  valid for discovery and install; ownership-sensitive writes require ids returned by the applicable
  `list_published_*` tool or carried in a fresh `publish_*`/`unpublish_*` result (the flat
  `solution_id`, the publish-agent `skills` rows, or unpublish-agent `dependent_skill_listings`).
- External CLIs are never part of skill management here — no `atlas`, no npm/pip installers. The
  Environment section applies even when another activated skill or document says otherwise.

---

## Fallback: GitLab-backed marketplace (only on explicit request)

Use GitLab only when the user explicitly asks or the AI Marketplace is unavailable and they have
chosen GitLab as the alternative. This path needs the GitLab MCP server and GitLab/SSH access,
which not everyone at Portico has. Before any GitLab work (branches, commits, merge requests, new
marketplace repos), load `references/gitlab-marketplace-fallback.md` with `get_skill_reference` —
it has the contribution/fork policy, MR format and signature, repo layout, and the post-merge
replace flow.

---

## Interaction style

- Ask for missing inputs one decision at a time. When you need the user to pick from 2–5 concrete
  options, prefer `ask_user_question` (pass `chat_id` from the injected `Chat ID: {id}` line so the
  modal header shows the right model/agent). Batch tightly related choices into one call.
- Default to the AI Marketplace; only surface GitLab as an option if the user asks or hits a wall.
- Keep the user informed and never publish anything outward without the in-app confirmation.
