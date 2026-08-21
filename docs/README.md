# Portico — Documentation

Welcome to the Portico knowledge base. This folder is the single
canonical home for design docs, how-tos, security material, test plans,
release notes, and historical incident write-ups.

> **New here?** Start with the
> [codebase infographic](portico-codebase-infographic.svg)
> for a one-page mental model, then jump into the architecture section
> below.

---

## Where things live

| Folder | What's in it                                                                                                    | Audience |
|---|-----------------------------------------------------------------------------------------------------------------|---|
| [`architecture/`](architecture/) | Technical design and system reference. Subdivided by topic: `auth`, `chat-ui`, `llm`, `mcp`, `skills`, `runtime`. | Engineers maintaining the system. |
| [`development/`](development/) | Engineering process and contribution guidelines.                                                                | Contributors. |
| [`howto/`](howto/) | Step-by-step guides. Split into `users/` (end-user docs) and `developers/` (operator/debug guides).             | Users + on-call engineers. |
| [`security/`](security/) | Hardening overview, tool-confirmation gate model, Vault prerequisites.                                          | Engineers + security reviewers. |
| [`testing/`](testing/) | Release test plan, scenario IDs, status, runners.                                                               | QA + release-management. |
| [`releases/`](releases/) | Per-release notes, named `<YYYY-MM-DD>-<short-sha>.md`.                                                         | All readers; release management. |
| [`incidents/`](incidents/) | Historical RCAs and bug-fix write-ups.                                                                          | Engineers — preserved as institutional memory. |
| [`manual-test-prompts/`](manual-test-prompts/) | Pasteable prompts for ad-hoc manual testing.                                                                    | Engineers running smoke checks. |
| [`blog/`](blog/) | Long-form / external-audience content.                                                                          | Anyone. |
| [`_drafts/`](_drafts/) | Work-in-progress documents. Not yet curated.                                                                    | Authors. |
| [`_archive/`](_archive/) | Historical material kept for evidence but not maintained.                                                       | Reviewers checking provenance. |

The top-level files are:

- [`CHANGELOG.md`](CHANGELOG.md) — rolling product changelog.
- [`TO_REMOVE.md`](TO_REMOVE.md) — single tracker for legacy code paths slated for cleanup.
- [`README.md`](README.md) — this file.

Development process references:

- [`development/branching-strategy.md`](development/branching-strategy.md) — accepted branch roles and daily, beta-release, and hotfix flows.

---

## Architecture quick links

| Topic | Entry point |
|---|---|
| Authentication & OAuth | [`architecture/auth/oauth.md`](architecture/auth/oauth.md), [`architecture/auth/okta-and-mcp-oauth.md`](architecture/auth/okta-and-mcp-oauth.md), [`architecture/auth/slack-oauth.md`](architecture/auth/slack-oauth.md) |
| Chat UI internals | [`architecture/chat-ui/chip-system.md`](architecture/chat-ui/chip-system.md), [`architecture/chat-ui/tabs.md`](architecture/chat-ui/tabs.md), [`architecture/chat-ui/search.md`](architecture/chat-ui/search.md), [`architecture/chat-ui/artifact-versioning.md`](architecture/chat-ui/artifact-versioning.md), [`architecture/chat-ui/progressive-disclosure.md`](architecture/chat-ui/progressive-disclosure.md) |
| LLM routing & behavior | [`architecture/llm/gpt-prompt-caching.md`](architecture/llm/gpt-prompt-caching.md), [`architecture/llm/reasoning-effort.md`](architecture/llm/reasoning-effort.md), [`architecture/llm/subagents.md`](architecture/llm/subagents.md) |
| MCP system | [`architecture/mcp/mcp-system.md`](architecture/mcp/mcp-system.md), [`architecture/mcp/mcp-user-installed.md`](architecture/mcp/mcp-user-installed.md), [`architecture/mcp/scheduled-task-runtime.md`](architecture/mcp/scheduled-task-runtime.md) |
| Skills | [`architecture/skills/skills.md`](architecture/skills/skills.md), [`architecture/skills/skills-hot-reload.md`](architecture/skills/skills-hot-reload.md) |
| Runtime / packaging | [`architecture/runtime/docker-footprint.md`](architecture/runtime/docker-footprint.md) |

The architecture section also has its own index at
[`architecture/README.md`](architecture/README.md).

---

## Conventions

- **File names** are `kebab-case.md`. Do not introduce
  `UPPER_SNAKE.md` or `PascalCase.md` files in the curated tree.
- **Cross-links** between docs use relative paths.
- **Each document** opens with a one-line `Audience:` and `Last
  reviewed:` near the top, plus a top-level heading describing the
  topic, not the ticket.
- **Don't** embed chat IDs, debug request IDs, ticket numbers,
  branch names, or absolute developer-machine paths in curated docs.
  If those identifiers matter, capture them in `incidents/` (for
  historical record) or `_drafts/` (for work-in-progress).
- **Diagrams** prefer Mermaid blocks over external image files when
  possible.

---

## Contributing

When you ship a change:

1. If user-visible behavior changed, add a one-liner under the matching
   month in [`CHANGELOG.md`](CHANGELOG.md).
2. If you cut a tagged release, add a per-release file under
   [`releases/`](releases/) with the full detail.
3. If you added or moved a document, update this README and any
   relevant section index.
4. If you removed a legacy code path that was tracked in
   [`TO_REMOVE.md`](TO_REMOVE.md), move its row into the
   "Recently removed" section there.

---

## Architecture-layer language

When writing or reviewing docs, frame issues in terms of the 12
architecture layers used throughout the codebase: Electron Shell,
IPC/Communication, Docker Orchestration, MCP Orchestration, LLM
Routing, Chat UI, Agent Skills, Agent VM/Code Execution, State &
Persistence, Health Check & Configuration, Observability, Update &
Distribution. The full reference lives in
`.claude/docs/architecture-layers.md` at the repo root.
