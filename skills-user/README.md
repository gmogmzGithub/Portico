# User-Defined Skills

Create custom skills that work identically to system (built-in) skills. User skills have the same auto-activation, MCP auto-enable, and reference file capabilities.

> For a detailed code-level analysis of system vs user skill parity, see [ANALYSIS.md](ANALYSIS.md).

## Directory Structure

```
skills-user/
├── README.md                          ← this file
├── my-skill/
│   ├── SKILL.md                       ← required: skill definition
│   └── references/                    ← optional: supplementary files
│       ├── guide.md
│       └── patterns.md
└── another-skill/
    └── SKILL.md
```

Each skill lives in its own directory under `skills-user/`. The directory name should match the `name` field in the SKILL.md frontmatter.

## SKILL.md Format

Every skill requires a `SKILL.md` file with YAML frontmatter and markdown body.

### Frontmatter (Required)

```yaml
---
name: my-skill
description: "What this skill does — shown in skill listings"
license: Proprietary
compatibility: Portico
metadata:
  author: Your Name
  version: "1.0"
  priority: high           # high | medium | low (NOTE: parsed but not yet used for ranking)
  triggers:                 # keywords that auto-activate this skill
    - "keyword one"
    - "keyword two"
    - "another trigger"
required_mcp_servers:       # MCP servers auto-enabled when skill activates
  - "server:server-name"
---
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier. Must not collide with system skill names. |
| `description` | Yes | One-line description of the skill's purpose. |
| `license` | Yes | Use `Proprietary` for Portico skills. |
| `compatibility` | Yes | Use `Portico`. |
| `metadata.author` | Yes | Author name. |
| `metadata.version` | Yes | Semantic version string (e.g., `"1.0"`). |
| `metadata.priority` | Yes | `high`, `medium`, or `low`. Currently parsed and stored but **not used for ranking** — all matching skills activate in discovery order. See `ANALYSIS.md` for details. |
| `metadata.triggers` | Yes | Array of trigger phrases (see Auto-Activation below). |
| `required_mcp_servers` | No | Array of MCP server IDs to auto-enable. Format: `"server:<name>"`. |

Trigger phrases should normally be written as a flat string list. For compatibility
with imported marketplace skills, Portico also accepts entries shaped as
`- keywords: ["keyword one", "keyword two"]`. Empty, duplicate, or unsupported
trigger values are ignored and cannot prevent the skill or other skills from loading.

### Body (Markdown)

The body contains the skill's instructions, injected into the system prompt when activated. Structure it with:

- **When to Use / When Not to Use** — Clear scope boundaries
- **Decision Trees** — Help the model choose the right tool or approach
- **Tool Reference** — Parameters, examples, and patterns for each tool
- **Examples** — Concrete right/wrong patterns
- **Reference Files** — Links to supplementary content in `references/`

## Auto-Activation

Skills auto-activate when a user message contains any trigger phrase.

**Matching rules:**
- Case-insensitive substring matching
- `"employee search"` matches "Can you do an **employee search** for Jane?"
- Up to 4 skills can activate simultaneously per message
- Both system and user skills compete for the same 4 slots

**Writing effective triggers:**
- Use 2-3 word phrases specific to your skill's domain
- Avoid single common words ("search", "find", "help") — too many false activations
- Avoid triggers that overlap with system skill triggers (see Limitations)
- Test by asking: "Would a user naturally say this phrase when they want THIS skill?"

## MCP Auto-Enable

When `required_mcp_servers` is set, the listed servers are automatically enabled in the chat when the skill activates. This means:

- Users don't need to manually enable MCP servers
- The skill is self-contained — it declares its own dependencies
- Multiple skills can declare the same server without conflict

**Server ID format:** `"server:<server-name>"` where `<server-name>` matches the server's configuration key.

## Authoring Best Practices

Follow these guidelines (adapted from [Anthropic's skill authoring docs](https://platform.atlas.com/docs/en/agents-and-tools/agent-skills/best-practices)) to write effective skills.

### Description Quality

The `description` field is critical — it appears in skill listings and in the `<description>` tag of the prompt XML.

- **Include both WHAT and WHEN** — "Guides deployment to production environments when users ask about releases or CI/CD pipelines"
- **Write in third person** — "Processes files..." not "I can help you process files..."
- **Be specific** — "Searches Portico's Glean knowledge base for internal documentation" beats "Searches for stuff"

### SKILL.md Size and Structure

- Keep `SKILL.md` under **500 lines**. If you need more, use reference files.
- Structure the body with clear sections: When to Use, Decision Trees, Tool Reference, Examples.
- Use consistent terminology throughout — don't alternate between "query" and "search" for the same concept.

### Reference Files

- Keep references **one level deep** from SKILL.md. Avoid A→B→C chains where one reference loads another.
- For reference files over **100 lines**, include a table of contents at the top.
- Name files descriptively: `form_validation_rules.md` not `doc2.md`.

### Naming

- Use **kebab-case**: `deploy-helper`, not `DeployHelper` or `deploy_helper`.
- Be descriptive: `jira-ticket-creator` not `helper` or `utils`.
- Keep names under **64 characters**.

### Triggers

- Use 2-3 word phrases specific to your domain.
- Avoid single common words that cause false activations.

> **Note:** PORTICO uses trigger-based skill discovery (not description-based like Anthropic's API), but description quality still matters — it's injected into the prompt XML and influences how the LLM uses the skill.

## Reference Files

For complex skills, put supplementary content in a `references/` subdirectory. Reference files:

- Are loaded on-demand (not automatically injected with the skill)
- Can be fetched via `skills_get_skill_reference(skill_name="my-skill", reference_path="references/guide.md")`
- Keep the main SKILL.md focused; put deep-dive content in references
- Use any filename and structure within `references/`

## Example: Minimal Skill

```yaml
---
name: deploy-helper
description: "Guides through Portico's deployment process"
license: Proprietary
compatibility: Portico
metadata:
  author: Jane Smith
  version: "1.0"
  priority: medium
  triggers:
    - "deploy to production"
    - "deployment checklist"
    - "release process"
---

# Deployment Helper

Guide users through Portico's deployment process.

## Checklist

1. All tests passing on CI
2. Code review approved (2 reviewers)
3. Staging deployment verified
4. Release notes updated
5. Deploy via Jenkins pipeline
```

## Known Limitations

Understanding these limitations helps you write effective skills and avoid surprises.

### Name Collision (Silent Skip)
If a user skill has the same `name` as a system skill, one silently wins — no error is shown to the user. **Always check existing system skill names before choosing yours.** Current system skills: `artifacts`, `atlassian-portico`, `browser-automation`, `code-execution`, `company-knowledge`, `mcp-server-management`, `n8n-handover`, `tool-server-selection`, `web-search`.

### No Trigger Priority Between Skills
All matching skills activate (up to 4). There is no way to say "activate this skill instead of that one." If your triggers overlap with another skill, both will activate and consume activation slots.

### Substring Matching Only
Triggers use simple substring matching — no regex, no word boundaries. The trigger `"search"` would match "**search**ing", "re**search**", and "**search**". Use multi-word phrases to avoid false matches.

### No Skill Composition or Dependencies
Skills cannot declare dependencies on other skills. If your skill needs another skill's behavior, duplicate the relevant instructions or rely on both activating via their own triggers.

### No Override Mechanism for System Skills
User skills cannot replace or modify system skills. They can only complement them by covering different triggers and use cases.

### No Testing Framework
There is no automated way to test trigger matching, activation, or content injection. Testing requires manual verification by sending messages and checking logs.

### Maximum 4 Concurrent Skills
Only 4 skills can be active per message. If more than 4 match, some will be silently dropped. Design triggers to be specific enough to avoid unnecessary activation.
