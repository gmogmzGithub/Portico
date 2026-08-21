# Progressive Disclosure Architecture

This document describes Portico's progressive disclosure system for MCP tool servers, which reduces cognitive load and context usage by only activating capabilities when users actually need them.

## Overview

Instead of enabling all tool servers for every chat session, the system uses **skills-based progressive disclosure**:

1. **Minimal core servers** are always enabled, including the Agent VM tool server without creating a VM container
2. **Additional servers** are activated dynamically via skills based on user prompts
3. **Skills auto-activate** using trigger keyword matching
4. **Skills auto-enable** their required MCP servers when activated

This approach:
- Reduces initial context size for the LLM
- Provides clearer tool organization for users
- Only loads capabilities when needed
- Maintains full functionality through on-demand activation

---

## Architecture

### Always-Enabled Servers

These core servers are always enabled because they're needed for skill activation, agent orchestration, and tool-backed execution setup:

| Server | Purpose |
|--------|---------|
| `server:mcp-assistant` | MCP server management, enabling tools |
| `server:subagents` | Agent delegation and workflows |
| `server:skills` | Skill activation and management |
| `server:agent-vm` | Agent VM tool surface; VM containers are created on demand |

### Skill-Activated Servers

These servers are only enabled when their corresponding skill is activated:

| Server | Activating Skill | Trigger Examples |
|--------|-----------------|------------------|
| `server:glean` | `company-knowledge` | "company docs", "policies", "glean" |
| `server:web-tools` | `web-search` | "search the web", "current news", "google" |
| `server:artifacts` | `artifacts` | "create artifact", "web app", "live preview" |

### Configuration

The `always_enabled` field in MCP server YAML configs controls this behavior:

```yaml
# mcp-configs/mcp-assistant/mcp-assistant.yaml
name: "MCP Assistant"
id: "mcp-assistant"
is_core: true
always_enabled: true  # Always enabled for every chat
user_installed: false
```

```yaml
# mcp-configs/glean/glean.yaml
name: "Glean MCP Server"
id: "glean"
is_core: false
always_enabled: false  # Only enabled via skill activation
user_installed: false
```

**Note:** The `is_core` flag is separate and controls UI behavior, protection from modification, etc. The `always_enabled` flag only controls auto-enabling behavior.

---

## How It Works

### 1. Skill Discovery

On startup, the skill manager scans the `skills/` directory and loads skill metadata including:
- Trigger keywords for auto-activation
- Required MCP servers (`required_mcp_servers` field)

### 2. Auto-Activation Flow

When a user sends a message:

```
User Message
    │
    ▼
┌─────────────────────────────┐
│ Phase 1: Check trigger      │
│ keywords against all skills │
└─────────────────────────────┘
    │
    ▼ (matches found)
┌─────────────────────────────┐
│ Activate matching skills    │
│ Store in Redis: chat_skills │
│ Auto-enable required MCP    │
│ servers (chat_tools)        │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│ Phase 2: VM Creation        │
│ (only if code-execution or  │
│ artifacts skill activated)  │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│ Phase 3: Merge tools        │
│ always_enabled + chat_tools │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│ Inject skill instructions   │
│ and VM context (if exists)  │
│ into system prompt          │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│ LLM receives full context   │
│ with activated capabilities │
└─────────────────────────────┘
```

**Key Point:** VMs are only created when the `code-execution` or `artifacts` skill is activated. Simple chats (like "Hello") don't create VMs or enable those servers.

### 3. Persistence

- Activated skills persist for **7 days** per chat session
- Enabled tool servers persist for **7 days** per chat session
- Survives page refresh and session changes

---

## Example 1: Simple Greeting - "Hello"

Let's first see what happens with a simple greeting that doesn't trigger any skills.

### User Sends

```
User: "Hello"
```

### Trigger Keyword Matching

The unified context filter scans the message against all skill triggers:

| Skill | Triggers Checked | Match? |
|-------|-----------------|--------|
| `company-knowledge` | "company docs", "policies", "glean"... | No |
| `web-search` | "search the web", "current news"... | No |
| `code-execution` | "run python", "execute code"... | No |
| `artifacts` | "create artifact", "web app"... | No |

**No matches found** - no skills are activated.

### Result

Only always-enabled core servers are enabled:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`

**No VM container is created**, no Glean, no web tools, no artifacts. The LLM receives minimal context and can respond quickly to the greeting.

---

## Example 2: "Generate a simple calculator web app"

Let's walk through how the system handles this request using progressive disclosure.

### Initial State

When a new chat starts, only always-enabled core servers are enabled:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`

### Step 1: User Sends Request

```
User: "Generate a simple calculator web app"
```

### Step 2: Trigger Keyword Matching

The unified context filter scans the message against all skill triggers:

| Skill | Triggers Checked | Match? |
|-------|-----------------|--------|
| `company-knowledge` | "company docs", "policies", "glean"... | No |
| `web-search` | "search the web", "current news"... | No |
| `code-execution` | "run python", "execute code"... | No |
| `artifacts` | "create artifact", "**web app**", "live preview"... | **YES** |

The phrase "web app" matches the `artifacts` skill trigger.

### Step 3: Skill Auto-Activation

The `artifacts` skill is automatically activated:
- Added to Redis: `chat_skills:{chat_id} = ["artifacts"]`
- Skill instructions loaded into system prompt

### Step 4: MCP Server Auto-Enable

The `artifacts` skill has `required_mcp_servers`:
```yaml
required_mcp_servers:
  - "server:agent-vm"
  - "server:artifacts"
```

The artifacts server is auto-enabled; Agent VM is already attached as an always-on core server:
- Added to Redis: `chat_tools:{chat_id} = ["server:mcp-assistant", "server:subagents", "server:skills", "server:agent-vm", "server:artifacts"]`

### Step 5: Context Injection

The LLM receives:

1. **Always-enabled tools**: mcp-assistant, subagents, skills, agent-vm
2. **Skill-activated tools**: artifacts
3. **Skill instructions**: Full artifacts skill documentation including:
   - How to create files in VM
   - How to create artifacts with live preview
   - Best practices and examples

### Step 6: LLM Execution

With the artifacts skill activated, the LLM follows the skill instructions:

```
1. VM auto-created (or existing VM reused)
   vm_id: "abc-123-def"

2. Create calculator files:
   vm_create_files_batch(vm_id="abc-123-def", files=[
     {path: "index.html", content: "<!DOCTYPE html>..."},
     {path: "style.css", content: "body { font-family: sans-serif; }..."},
     {path: "calculator.js", content: "function calculate() {...}"}
   ])

3. Create artifact with live preview:
   create_artifact(
     vm_id="abc-123-def",
     chat_id="xyz-789",
     name="Calculator App",
     start_command="python -m http.server 5173",
     container_port=5173
   )

4. Preview panel opens automatically in Electron app
```

### Result

The user sees:
- A live preview of their calculator app in the Electron side panel
- The ability to interact with the app in real-time
- All without needing to manually enable any tools or activate any skills

### What Didn't Load

Because progressive disclosure was used, these capabilities were **not** loaded (saving context):
- Glean (company knowledge search)
- Anthropic Web Tools (web search)
- Browser automation tools
- Any other non-essential servers

---

## Benefits

### For Users
- **Simpler interface**: Only see relevant capabilities
- **Faster responses**: Less context for LLM to process
- **Automatic**: No need to manually enable tools

### For the System
- **Reduced token usage**: Smaller system prompts
- **Better focus**: LLM has clearer instructions for the task
- **Scalability**: Can add many tools without bloating every chat

### For Developers
- **Modular**: Each skill is self-contained
- **Extensible**: Easy to add new skills with their own triggers
- **Maintainable**: Clear separation of concerns

---

## Adding New Skills

To add a new skill with progressive disclosure:

1. **Create skill directory**: `skills/my-skill/`

2. **Create SKILL.md** with frontmatter:
```yaml
---
name: my-skill
description: Description of what this skill does
metadata:
  priority: high
  triggers:
    - "trigger phrase 1"
    - "trigger phrase 2"
required_mcp_servers:
  - "server:my-mcp-server"
---

# My Skill

Instructions for the LLM when this skill is activated...
```

3. **Set server config** (if new server):
```yaml
# mcp-configs/my-server/my-server.yaml
always_enabled: false  # Only via skill activation
```

4. **Test trigger matching**: Ensure your triggers are specific enough to match user intent but broad enough to catch variations.

---

## Troubleshooting

### Skill Not Activating

1. Check trigger keywords in `SKILL.md` frontmatter
2. Verify skill is in `skills/` directory (not `skills-user/` for system skills)
3. Check logs for trigger matching: `UnifiedContextFilter - Auto-activated skill`

### MCP Server Not Enabling

1. Verify `required_mcp_servers` in skill's SKILL.md
2. Check that server ID matches exactly (e.g., `server:agent-vm`)
3. Verify server exists in `mcp-configs/` directory

### Fallback Behavior

If MCP metadata fetch fails, the system falls back to a hardcoded list:
- `server:mcp-assistant`
- `server:subagents`
- `server:skills`
- `server:agent-vm`

This ensures basic functionality even if the MCP infrastructure is unavailable.

---

## Related Documentation

- [`../mcp/mcp-system.md`](../mcp/mcp-system.md) — MCP orchestration overview.
- [`../skills/skills.md`](../skills/skills.md) — skills system.
