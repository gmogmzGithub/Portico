# Architecture

Technical design and reference for the major subsystems of Portico AI
Chat. Documents are organized by topic.

## Authentication

Topic owners: identity, OAuth, MCP server authorization.

| Document | Scope |
|---|---|
| [`auth/oauth.md`](auth/oauth.md) | End-to-end OAuth implementation across the Electron shell, MCPO, and per-server containers. State machine, callback routing, token storage, six concrete flows. |
| [`auth/okta-and-mcp-oauth.md`](auth/okta-and-mcp-oauth.md) | The two distinct OAuth systems in the app: Okta-based first-run user identity vs. per-server MCP OAuth. |
| [`auth/mcp-secret-broker.md`](auth/mcp-secret-broker.md) | Host-mediated OAuth/static-secret broker: safeStorage durable records, scoped bridge tokens, container runtime materialization, and first-time OAuth bootstrap constraints. |
| [`auth/slack-oauth.md`](auth/slack-oauth.md) | Slack-specific OAuth flow with HTTPS callback, PKCE public client behavior, broker-mediated runtime token delivery, and Slack's `user_scope` parameter. |

## Chat UI

Topic owners: the Open WebUI fork, message rendering, chips, search, artifacts.

| Document | Scope |
|---|---|
| [`chat-ui/chip-system.md`](chat-ui/chip-system.md) | The interactive chip primitive used for tool confirmations, clarifications, and task-creation prompts. |
| [`chat-ui/tabs.md`](chat-ui/tabs.md) | The browser-style tab system: tab bar, detached windows, lifecycle. |
| [`chat-ui/search.md`](chat-ui/search.md) | Cross-conversation search, in-chat find, search index, agent-trace toggle. |
| [`chat-ui/artifact-versioning.md`](chat-ui/artifact-versioning.md) | The VM pool model: one VM per artifact version, FIFO eviction, hot vs. cold version switching. |
| [`chat-ui/progressive-disclosure.md`](chat-ui/progressive-disclosure.md) | Skill-driven progressive activation of tool servers. |

## LLM

Topic owners: routing to model providers, reasoning configuration, sub-agents.

| Document | Scope |
|---|---|
| [`llm/gpt-prompt-caching.md`](llm/gpt-prompt-caching.md) | How GPT prompt caching is preserved across multi-turn tool-bearing requests: instructions hoisting and namespace-based tool packaging. |
| [`llm/reasoning-effort.md`](llm/reasoning-effort.md) | Per-model reasoning effort configuration, the GPT-5 summary parameter, persistence. |
| [`llm/subagents.md`](llm/subagents.md) | The Run-Sub-Agent MCP server: hierarchical agent orchestration, the `model` + `prompt` interface. |

## MCP

Topic owners: MCP server lifecycle, integrations, scheduling.

| Document | Scope |
|---|---|
| [`mcp/mcp-system.md`](mcp/mcp-system.md) | The MCP Server Configuration System: declarative YAML, Three-tier MCPO, partial restart with chat preservation. |
| [`mcp/host-mcp-bridge.md`](mcp/host-mcp-bridge.md) | Host MCP Bridge daemon: authenticated local MCP gateway, client auto-configuration, token registry, and failure modes. |
| [`mcp/mcp-user-installed.md`](mcp/mcp-user-installed.md) | User-installed MCP servers: full CRUD via the MCP Assistant, mcp-configs-user/ separation. |
| [`mcp/scheduled-task-runtime.md`](mcp/scheduled-task-runtime.md) | Scheduled task runtime: the scheduling daemon, sub-agent dispatch, scope binding. |
| [`mcp/integrations/n8n.md`](mcp/integrations/n8n.md) | n8n MCP integration: configuration, available tools, troubleshooting. |

## Skills

Topic owners: agent skills system, hot-reload across containers.

| Document | Scope |
|---|---|
| [`skills/skills.md`](skills/skills.md) | The Agent Skills specification: metadata, instructions, references, scripts. |
| [`skills/skills-hot-reload.md`](skills/skills-hot-reload.md) | Cross-container cache invalidation for skills: Redis pub/sub + filesystem watchers. |

## Runtime

Topic owners: Docker, packaging.

| Document | Scope |
|---|---|
| [`runtime/docker-footprint.md`](runtime/docker-footprint.md) | Reliability-first Docker delivery and the slim OWUI runtime plan. |
