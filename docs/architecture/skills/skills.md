# Agent Skills Specification

Agent Skills provide modular, on-demand capability injection for Portico. Instead of loading all instructions upfront, skills are activated dynamically based on user needs, significantly reducing base context usage.

## Overview

### What Are Skills?

Skills are self-contained instruction sets that extend the LLM's capabilities for specific tasks. Each skill contains:
- **Metadata**: Name, description, triggers, priority
- **Instructions**: Detailed guidance for the LLM
- **References** (optional): Additional documentation loaded on-demand
- **Scripts** (optional): Executable Python scripts that run in isolated containers

### Benefits

- **Context Efficiency**: ~84% reduction in baseline context (from ~1100 lines to ~170 lines)
- **Progressive Disclosure**: Load instructions only when needed
- **Maintainability**: Update individual skills without touching core prompt
- **Extensibility**: Users can create custom skills
- **Code Execution**: Skills can include scripts for programmatic tasks (PDF processing, data transformation, etc.)

## Directory Structure

```
skills/                      # System-delivered skills (version controlled)
├── mcp-server-management/
│   ├── SKILL.md            # Core skill instructions (253 lines)
│   └── references/
│       ├── oauth-workflow.md    # Detailed OAuth process (200 lines)
│       └── server-types.md      # HTTP/SSE/stdio patterns (257 lines)
├── tool-server-selection/
│   └── SKILL.md            # 191 lines
├── browser-automation/
│   ├── SKILL.md            # 145 lines
│   └── references/         # Empty directory
└── pdf/                     # PDF manipulation skill with executable scripts
    ├── SKILL.md            # Core instructions + script documentation
    ├── references/
    │   └── forms.md        # Detailed form filling workflows
    └── scripts/            # Executable Python scripts
        ├── check_fillable_fields.py
        ├── extract_form_field_info.py
        ├── fill_fillable_fields.py
        ├── convert_pdf_to_images.py
        ├── create_validation_image.py
        ├── check_bounding_boxes.py
        └── fill_pdf_form_with_annotations.py

skills-marketplace/          # Downloaded from marketplace (gitignored)
└── .gitkeep

skills-user/                 # User-created skills (gitignored)
└── .gitkeep

workspaces/                  # Per-chat file workspaces (gitignored)
└── {chat_id}/
    ├── input/              # Files for script input (uploaded files copied here)
    └── output/             # Files created by scripts
```

### Priority Order

Skills are loaded with the following priority (highest to lowest):
1. `skills-user/` - User's custom skills (can override anything)
2. `skills/` - System-delivered skills
3. `skills-marketplace/` - Downloaded skills

## Limits

| Limit | Value | Location |
|-------|-------|----------|
| Activation TTL | 7 days | `tools.py:SKILL_TTL_SECONDS = 604800` |
| Reference file types | `.md`, `.txt`, `.json`, `.yaml` | `skill_manager.py` |
| Script execution timeout | 300 seconds | `script_executor.py:DEFAULT_TIMEOUT` |
| Script container memory | 512 MB | `script_executor.py:MEMORY_LIMIT` |
| Script container CPU | 1 core | `script_executor.py:CPU_QUOTA` |
| Workspace file size | 50 MB per file | `workspace_manager.py` |

## SKILL.md Format

Each skill is defined by a `SKILL.md` file with YAML frontmatter and markdown content.

### Required Frontmatter Fields

```yaml
---
name: skill-name                    # Unique identifier (kebab-case, must match directory name)
description: Brief description      # Shown in available skills list
license: Proprietary               # License type
compatibility: Portico       # Target application
metadata:
  author: portico-ai-team           # Author name
  version: "1.0"                   # Semantic version
  priority: medium                 # low | medium | high
  triggers:                        # Keywords for auto-activation
    - "keyword1"
    - "keyword2"
---
```

### Priority Levels

| Priority | Behavior |
|----------|----------|
| `high` | Auto-activates when trigger keywords match (substring, case-insensitive) |
| `medium` | Available for explicit activation |
| `low` | Available but rarely auto-suggested |

### Example Skill

```markdown
---
name: browser-automation
description: Browser automation guidance for explicit Chrome DevTools workflows.
license: Proprietary
compatibility: Portico
metadata:
  author: portico-ai-team
  version: "1.0"
  priority: medium
  triggers:
    - "browser"
    - "browser-use"
    - "web automation"
---

# Browser Automation Skill

This skill provides guidance for deterministic Chrome DevTools browser workflows.

## When Chrome DevTools Is Available

If you see `server:chrome-devtools` in your available tool servers...

[Rest of skill instructions]
```

`triggers` is canonically a string or list of strings. Imported marketplace skills
may also use `- keywords: ["keyword1", "keyword2"]`; those keywords are flattened
into the same trigger list. Empty, duplicate, and unsupported trigger values are
ignored so malformed metadata in one skill cannot disable unrelated skills or tools.

## Reference Files

Skills can include additional reference documentation that loads on-demand.

### Structure

```
skills/mcp-server-management/
├── SKILL.md                          # Core instructions (~200 lines)
└── references/
    ├── oauth-workflow.md             # Detailed OAuth process
    └── server-types.md               # HTTP/SSE/stdio patterns
```

### Loading References

When the LLM needs detailed information, it calls:
```
skills_get_skill_reference(skill_name, reference_path, chat_id)
```

This keeps the main SKILL.md lean while providing access to detailed documentation.

## Executable Scripts (Agent VM)

Skills can include executable Python scripts that run in isolated Docker containers. This enables skills to perform programmatic tasks like PDF processing, data transformation, and file manipulation.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Portico                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  Open WebUI  ◄──► MCP Assistant ◄──► Script Executor ◄──► Agent VM     │
│     (UI)          (tools.py)        (new manager)      (ephemeral)     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────┐ │
│  │ SkillManager │   │ Workspace    │   │ Agent VM Container           │ │
│  │              │   │ Manager      │   │ ┌──────────────────────────┐ │ │
│  │ - skills/    │   │              │   │ │ Python 3.12              │ │ │
│  │ - scripts/   │   │ /workspaces/ │   │ │ Pre-installed deps       │ │ │
│  │ - references │   │   {chat_id}/ │   │ │ No network access        │ │ │
│  └──────────────┘   └──────────────┘   │ │ Memory/CPU limits        │ │ │
│                                         │ └──────────────────────────┘ │ │
│                                         └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Script Execution Flow

```
User uploads file + sends message
    │
    ▼
Skills Filter (inlet) auto-copies file to workspace
    │
    ▼
Trigger keywords match → PDF skill auto-activates
    │
    ▼
LLM sees <activated_skill> with <available_scripts>
    │
    ▼
LLM calls execute_skill_script(skill="pdf", script="check_fillable_fields.py")
    │
    ▼
ScriptExecutor:
    1. Validates script path (security check)
    2. Creates ephemeral agent-vm container
    3. Mounts:
       - /skill (read-only) ← skill directory
       - /work (read-write) ← workspace/{chat_id}/
    4. Runs: python /skill/scripts/check_fillable_fields.py /work/input/file.pdf
    5. Captures stdout/stderr
    6. Lists new output files
    7. Destroys container
    │
    ▼
LLM receives result, continues workflow
```

### Skill Structure with Scripts

```
skills/pdf/
├── SKILL.md                              # Main instructions + script docs
├── references/
│   └── forms.md                          # Detailed form filling workflows
└── scripts/
    ├── check_fillable_fields.py          # Check for form fields
    ├── extract_form_field_info.py        # Extract field metadata
    ├── fill_fillable_fields.py           # Fill form fields
    ├── convert_pdf_to_images.py          # PDF → PNG conversion
    ├── create_validation_image.py        # Annotated preview
    ├── check_bounding_boxes.py           # Validate coordinates
    └── fill_pdf_form_with_annotations.py # Text overlay for non-fillable
```

### Prompt Injection with Scripts

When a skill with scripts is activated, the `<activated_skill>` block includes available scripts:

```xml
<activated_skill name="pdf">
  [SKILL.md content]

  <available_references>
    - references/forms.md
  </available_references>

  <available_scripts>
    - scripts/check_fillable_fields.py: Check if PDF has fillable form fields
    - scripts/extract_form_field_info.py: Extract form field information as JSON
    - scripts/fill_fillable_fields.py: Fill form fields with provided values
    - scripts/convert_pdf_to_images.py: Convert PDF pages to PNG images
    - scripts/create_validation_image.py: Create annotated validation preview
    - scripts/check_bounding_boxes.py: Validate bounding box coordinates
    - scripts/fill_pdf_form_with_annotations.py: Fill non-fillable PDFs with overlays
  </available_scripts>
</activated_skill>
```

### Agent VM Container

The `agent-vm` Docker image provides the secure execution environment:

**Dockerfile.agent-vm:**
```dockerfile
FROM python:3.12-slim

# System dependencies for PDF processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl poppler-utils libmagic1 jq ghostscript \
    && rm -rf /var/lib/apt/lists/*

# PRE-INSTALLED DEPENDENCIES FOR SECURITY
# All dependencies installed at BUILD time so scripts can run with network_disabled=True
RUN pip install --no-cache-dir \
    pypdf>=4.0.0 pdfplumber>=0.10.0 reportlab>=4.0.0 \
    pdf2image>=1.16.0 Pillow>=10.0.0 pyyaml>=6.0.0 requests>=2.31.0

RUN mkdir -p /work/input /work/output /skill
WORKDIR /work
```

**Key Design Decisions:**
- Dependencies pre-installed at build time (no runtime PyPI access)
- Network completely disabled for security
- All file I/O through mounted volumes only

### Docker-in-Docker Architecture

The ScriptExecutor runs inside the `mcpo-core-mcp-assistant` container and spawns `agent-vm` containers via the Docker socket. This requires special path handling:

```
Host filesystem:
  /Users/alice/project/skills/pdf/           ← actual files
  /Users/alice/project/workspaces/{chat}/    ← workspace files

mcpo-core-mcp-assistant container:
  /app/skills/pdf/           ← mounted from host
  /app/workspaces/{chat}/    ← mounted from host

agent-vm container (spawned):
  /skill/                    ← needs HOST path, not /app/skills/pdf
  /work/                     ← needs HOST path, not /app/workspaces/{chat}
```

**Solution:** `HOST_PROJECT_ROOT` environment variable provides the host path:

```python
# script_executor.py
def _container_to_host_path(self, container_path: str) -> str:
    """Convert container path to host path for Docker volume mounts."""
    if not self.host_project_root:
        return container_path  # Local dev, no conversion needed

    # /app/skills/pdf → {HOST_PROJECT_ROOT}/skills/pdf
    path_mappings = {
        "/app/skills": "skills",
        "/app/workspaces": "workspaces",
    }
    for container_prefix, relative in path_mappings.items():
        if container_path.startswith(container_prefix):
            suffix = container_path[len(container_prefix):]
            return os.path.join(self.host_project_root, relative + suffix)
    return container_path
```

### Workspace System

Each chat session gets an isolated workspace directory:

```
/app/workspaces/{chat_id}/
├── input/      # Files for script input
│   ├── document.pdf    (uploaded by user, auto-copied)
│   └── data.json       (manually copied)
└── output/     # Files created by scripts
    ├── filled.pdf      (script output)
    └── field_info.json (script output)
```

**Auto-Copy Feature:**
When users attach files to messages, the Skills Filter automatically copies them to the workspace:

```python
# skills_loader.py inlet()
files = body.get("metadata", {}).get("files", [])
if chat_id and files:
    for file_info in files:
        workspace_manager.copy_to_workspace(
            chat_id=chat_id,
            source_path=file_info["path"],
            target_name=file_info["name"],
            directory="input"
        )
```

This makes file handling transparent - users just upload files and reference them naturally.

### Security Model

| Control | Implementation |
|---------|----------------|
| Network Isolation | `network_disabled=True` on container |
| Memory Limit | 512 MB (`mem_limit="512m"`) |
| CPU Limit | 1 core (`cpu_period=100000, cpu_quota=100000`) |
| Timeout | 300 seconds default, enforced via `container.wait(timeout=)` |
| Path Traversal | Script paths validated to stay within skill directory |
| Read-Only Skills | Skill directory mounted as `ro` (read-only) |
| Pre-installed Deps | No runtime package installation (no network needed) |
| Ephemeral Containers | Container destroyed immediately after execution |

### Dependency Management

Dependencies are NOT installed at runtime. Instead:

1. **At Build Time:** All dependencies listed in `Dockerfile.agent-vm`
2. **At Parse Time:** ScriptExecutor extracts imports from script content
3. **At Run Time:** Just logs which pre-installed packages are used

```python
# script_executor.py
IMPORT_TO_PACKAGE = {
    'pypdf': 'pypdf',
    'pdfplumber': 'pdfplumber',
    'reportlab': 'reportlab',
    'PIL': 'pillow',
    # ...
}

def _extract_dependencies(self, script_content: str) -> List[str]:
    """Extract pip packages from import statements."""
    imports = re.findall(r'^(?:from|import)\s+(\w+)', script_content, re.MULTILINE)
    return [IMPORT_TO_PACKAGE.get(imp, imp) for imp in imports if imp not in STDLIB_MODULES]
```

**To add new skill dependencies:** Update `Dockerfile.agent-vm` and rebuild:
```bash
docker build -f Dockerfile.agent-vm -t agent-vm:latest .
```

### MCP Tools for Script Execution (server:agent-vm)

| Tool | Parameters | Description |
|------|------------|-------------|
| `execute_skill_script` | `skill_name`, `script_name`, `chat_id`, `args[]`, `timeout_seconds?` | Execute a Python script in isolated container |
| `vm_list_workspace_files` | `chat_id`, `directory?` ("input", "output", "all") | List files in workspace |
| `vm_write_to_workspace` | `chat_id`, `filename`, `content`, `is_base64?`, `directory?` | Write content to workspace |

**execute_skill_script Response:**
```json
{
  "success": true,
  "skill_name": "pdf",
  "script_name": "scripts/check_fillable_fields.py",
  "chat_id": "abc-123",
  "exit_code": 0,
  "stdout": "{\"has_fillable_fields\": true, \"field_count\": 15}",
  "stderr": "",
  "output_files": [],
  "execution_time_seconds": 1.23,
  "message": "Script executed successfully"
}
```

### Example: PDF Form Filling Workflow

```
User: [uploads w4_form.pdf] Help me fill out this W-4 form with my info

System (auto):
  1. File auto-copied to workspace/input/w4_form.pdf
  2. PDF skill auto-activated (trigger: "form")

LLM sees:
  - <workspace_files> showing w4_form.pdf in input/
  - <activated_skill name="pdf"> with available scripts

LLM calls: execute_skill_script(skill="pdf", script="check_fillable_fields.py",
                                 args=["input/w4_form.pdf"], chat_id="...")
Result: {"has_fillable_fields": true, "field_count": 15}

LLM calls: execute_skill_script(skill="pdf", script="extract_form_field_info.py",
                                 args=["input/w4_form.pdf"], chat_id="...")
Result: {"fields": [{"name": "first_name", "type": "text"}, ...]}

LLM analyzes fields, maps user's info:
  - first_name → "John"
  - last_name → "Smith"
  - ...

LLM calls: execute_skill_script(skill="pdf", script="fill_fillable_fields.py",
                                 args=["input/w4_form.pdf",
                                       '{"first_name":"John","last_name":"Smith",...}'],
                                 chat_id="...")
Result: {"success": true, "output_file": "output/w4_filled.pdf"}

LLM: "Done! Here's your filled W-4 form: [link to output/w4_filled.pdf]"
```

## Current Skills

### System Skills (skills/)

| Skill | Description | Priority | Triggers | Has Scripts |
|-------|-------------|----------|----------|-------------|
| `mcp-server-management` | Install, configure, update MCP servers | high | "install mcp", "create server", "oauth", "add tool", "install server", "setup mcp", "mcp server", "install integration" | No |
| `tool-server-selection` | Dynamic tool server selection | medium | "enable tool", "which tool", "what tools", "available tools", "enable server" | No |
| `browser-automation` | Chrome DevTools browser automation guidance | medium | "browser", "browser-use", "playwright", "web automation", "open browser", "use browser" | No |
| `pdf` | PDF manipulation: form filling, text extraction, merging, splitting | high | "pdf", "form", "fill out", "fillable", "form fields" | Yes (7 scripts) |

## Implementation Architecture

### Components

1. **SkillManager** (`src/managers/skill_manager.py`)
   - Discovers skills at startup from 3 directories
   - Parses SKILL.md frontmatter using regex
   - Caches metadata in memory (singleton pattern)
   - Provides API for skill access
   - Path traversal protection for reference loading
   - Discovers scripts in `scripts/` subdirectory

2. **Skills Filter** (`src/filters/skills_loader.py`)
   - Open WebUI inlet filter (requires v0.6.4+)
   - Injects available skills into system prompt
   - Checks for auto-activation triggers
   - Loads activated skills from Redis
   - Injects activated skill content
   - **Auto-copies uploaded files to workspace** (transparent to user)

3. **Skills MCP Server** (`src/core-mcp-rust/skills/src/skills_server/tools.py`)
   - `activate_skill(skill_name, chat_id)` - Activate skill for chat
   - `deactivate_skill(skill_name, chat_id)` - Deactivate skill
   - `list_skills(include_content?, filter_source?)` - List available skills
   - `get_skill_reference(skill_name, reference_path, chat_id)` - Load reference file
   - `get_activated_skills(chat_id)` - Get activated skills for chat
   - Skill CRUD tools for skills-user/ management

4. **Agent VM MCP Server** (`src/core-mcp-rust/agent-vm/src/agent_vm_server/tools.py`)
   - `execute_skill_script(skill_name, script_name, chat_id, args)` - Run skill script in ephemeral container
   - `vm_list_workspace_files(chat_id, directory)` - List workspace files
   - `vm_write_to_workspace(chat_id, filename, content, is_base64, directory)` - Write to workspace
   - Persistent VM tools (create_agent_vm, vm_execute_bash, etc.)

4. **Middleware** (`src/patches/backend/open_webui/utils/middleware.py`)
   - `load_initial_skills_from_redis()` - Loads at request start
   - `reload_chat_skills_from_redis()` - Loads NEW skills mid-turn
   - `reload_chat_skill_references_from_redis()` - Loads NEW references mid-turn

5. **ScriptExecutor** (`src/managers/script_executor.py`) **[NEW]**
   - Executes skill scripts in isolated Docker containers
   - Manages Docker-in-Docker volume mounts with host path translation
   - Enforces security: network isolation, memory limits, timeouts
   - Discovers dependencies from script imports (pre-installed in image)

6. **WorkspaceManager** (`src/managers/workspace_manager.py`) **[NEW]**
   - Creates per-chat isolated directories
   - Manages input/output file organization
   - Provides file listing and cleanup operations
   - Enforces file size limits

### Flow

```
Startup:
  skills/ → discover SKILL.md files → parse metadata → cache (singleton)

Per-Request (filter inlet):
  1. Inject <skill_instructions> usage guidelines
  2. Inject <available_skills> metadata into prompt
  3. Check for auto-activation triggers (high-priority skills only)
  4. Load activated skills from Redis (chat_skills:{chat_id})
  5. Inject <activated_skill> blocks with content

Mid-Turn (middleware):
  1. LLM calls activate_skill tool
  2. Tool stores activation in Redis
  3. Tool caches skill content for immediate injection
  4. Middleware injects content in same turn
```

### Prompt Injection Format

The filter injects three system messages in order:

**1. Skill Instructions:**
```xml
<skill_instructions>
## Agent Skills System

You have access to Agent Skills - specialized capabilities loaded on-demand.

### Using Skills
- Review <available_skills> to see what capabilities are available
- When a task matches a skill's description, activate it using:
  `skills_activate_skill(skill_name="skill-name", chat_id="<chat_id>")`
- Once activated, the skill's detailed instructions appear in <activated_skill> tags
- Skills persist for 7 days per chat session

### Loading References
- Activated skills may have <available_references> listing additional documentation
- Load references on-demand using:
  `skills_get_skill_reference(skill_name="skill-name", reference_path="references/file.md")`

### Currently Activated Skills: [list]
</skill_instructions>
```

**2. Available Skills Metadata:**
```xml
<available_skills>
  <skill>
    <name>mcp-server-management</name>
    <description>Install, configure, and manage MCP servers...</description>
    <priority>high</priority>
    <source>system</source>
  </skill>
  <skill>
    <name>browser-automation</name>
    <description>Browser automation guidelines...</description>
    <priority>medium</priority>
    <source>system</source>
  </skill>
</available_skills>
```

**3. Activated Skill Content:**
```xml
<activated_skill name="mcp-server-management">
  [Full SKILL.md content without frontmatter]

  <available_references>
    - references/oauth-workflow.md
    - references/server-types.md
  </available_references>
</activated_skill>
```

**4. Skill Reference Content (when loaded):**
```xml
<skill_reference skill="mcp-server-management" path="references/oauth-workflow.md">
  [Content of oauth-workflow.md file]
</skill_reference>
```

## Activation Modes

### 1. Auto-Activation (High Priority Skills)

Skills with `priority: high` can auto-activate when:
- User message matches skill `triggers` keywords
- Filter detects trigger match (case-insensitive substring matching)

**Algorithm:**
```python
message_lower = user_message.lower()
for trigger in skill.triggers:
    if trigger.lower() in message_lower:
        activate_skill(skill.name)
        break
```

Example: User says "install the slack mcp server" → matches "install mcp" → auto-activates `mcp-server-management`

**Note:** Substring matching means "install" in message matches "install" trigger, but also "reinstall" would match.

### 2. Explicit Activation

LLM calls the activation tool:
```
skills_activate_skill(skill_name="browser-automation", chat_id="abc-123")
```

Used for:
- Skills that need deliberate selection
- Providing audit trail of activation decisions
- Lower-priority skills

## Persistence

### Redis Keys

| Key Pattern | Content | TTL |
|-------------|---------|-----|
| `chat_skills:{chat_id}` | JSON array of skill names | 7 days |
| `skill_content:{skill_name}` | Formatted skill content for mid-turn injection | 7 days |
| `chat_skill_refs:{chat_id}` | JSON array of loaded reference keys | 7 days |
| `skill_ref_content:{skill_name}:{ref_path}` | Reference file content | 7 days |

### Behavior
- **Survives**: Page refresh, session changes, browser close
- **TTL Reset**: TTL resets on each activation (uses `setex`)
- **Chat-Scoped**: Skills are per-chat, not per-user

## Filter Configuration

The Skills Filter is configurable via Open WebUI's Valves system:

```python
class Valves(BaseModel):
    enable: bool = True                     # Master enable/disable
    enable_auto_activation: bool = True     # Auto-activate high-priority skills
    redis_host: str = "redis"               # Redis connection
    redis_port: int = 6379
    log_level: str = "INFO"
```

## API Reference

### SkillMetadata Dataclass

```python
@dataclass
class SkillMetadata:
    name: str                                    # Unique identifier
    description: str                             # For UI display
    source: str                                  # 'system', 'marketplace', 'user'
    path: str                                    # Full path to skill directory
    license: Optional[str] = None
    compatibility: Optional[str] = None
    priority: str = "medium"                     # 'low', 'medium', 'high'
    triggers: List[str] = field(default_factory=list)
    version: Optional[str] = None
    author: Optional[str] = None
    references: List[str] = field(default_factory=list)  # e.g., ['references/file.md']
```

### SkillManager Methods

```python
class SkillManager:
    # Singleton access
    get_skill_manager(base_dir: str = None) -> SkillManager
    reset_skill_manager() -> None  # For testing

    # Discovery
    def discover_skills(force_refresh: bool = False) -> List[SkillMetadata]
    def reload_skills() -> List[SkillMetadata]

    # Metadata access
    def get_skill_metadata(skill_name: str) -> Optional[SkillMetadata]
    def get_all_metadata() -> List[SkillMetadata]
    def skill_exists(skill_name: str) -> bool
    def get_skill_source(skill_name: str) -> Optional[str]  # 'system', 'marketplace', 'user'

    # Content access
    def get_skill_content(skill_name: str) -> Optional[str]  # Body without frontmatter
    def get_skill_reference(skill_name: str, ref_path: str) -> Optional[str]

    # Auto-activation
    def check_auto_activation(message: str) -> List[str]  # High-priority skills only

    # Formatting for injection
    def format_skills_for_prompt(skills: List[SkillMetadata] = None) -> str
    def format_activated_skill(skill_name: str) -> Optional[str]
```

### MCP Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `activate_skill` | `skill_name`, `chat_id` | Activate a skill for current chat. Returns skill metadata and references. |
| `deactivate_skill` | `skill_name`, `chat_id` | Deactivate a skill. Returns remaining skills. |
| `list_skills` | `include_content?=false`, `filter_source?="all"` | List all available skills with metadata. |
| `get_skill_reference` | `skill_name`, `reference_path`, `chat_id` | Load a reference file. Returns content and caches for injection. |
| `get_activated_skills` | `chat_id` | Get currently activated skills with metadata. |

### Tool Response Formats

**activate_skill:**
```json
{
  "success": true,
  "skill_name": "mcp-server-management",
  "chat_id": "abc-123",
  "message": "Skill 'mcp-server-management' activated successfully",
  "skill_info": {
    "description": "...",
    "priority": "high",
    "source": "system",
    "references": ["references/oauth-workflow.md"]
  },
  "activated_skills": ["mcp-server-management"],
  "total_activated": 1,
  "note": "The skill's instructions will be injected immediately..."
}
```

**get_activated_skills:**
```json
{
  "success": true,
  "chat_id": "abc-123",
  "activated_skills": [
    {
      "name": "mcp-server-management",
      "description": "Install, configure, and manage MCP servers...",
      "priority": "high",
      "source": "system",
      "references": ["references/oauth-workflow.md"]
    }
  ],
  "total": 1,
  "message": "Found 1 activated skill(s)"
}
```

## Security

### Path Traversal Protection

Reference loading includes security checks to prevent directory traversal attacks:

```python
# skill_manager.py
normalized_path = os.path.normpath(reference_path)
if normalized_path.startswith('..') or os.path.isabs(normalized_path):
    logger.error(f"Invalid reference path (path traversal attempt): {reference_path}")
    return None
```

**Blocked paths:**
- `../../etc/passwd` → rejected (starts with `..`)
- `/etc/passwd` → rejected (absolute path)

### File Access Validation

The Electron IPC handlers also validate file paths:
- Only allows reading from `skills/`, `skills-user/`, `skills-marketplace/` directories
- Uses path resolution to prevent escaping skill directories

## Electron UI Integration

### Component Overview

**File**: `electron-app/src/renderer/components/agent-skills.js` (1014 lines)

The Electron app provides a visual interface for browsing and managing Agent Skills.

### Features

1. **Card-Based Layout**
   - Skills displayed as cards with metadata badges
   - Priority indicators: high (red), medium (yellow), low (green)
   - Source badges: system (blue), user (green), marketplace (purple)

2. **Search & Filter**
   - Real-time text search by name/description
   - Filter by source type (system/user/marketplace)
   - Sort by name or priority

3. **Skill Details Modal**
   - File browser tree view showing all skill files
   - Markdown preview with syntax highlighting
   - Raw file view toggle
   - Reference file navigation
   - Skill logo display (with fallback to default icon)

### IPC Handlers

**Preload Bridge** (`electron-app/src/services/preload.js`):
```javascript
skills: {
    getSkills: () => ipcRenderer.invoke('get-skills'),
    getSkillFiles: (skillName) => ipcRenderer.invoke('get-skill-files', skillName),
    readSkillFile: (filePath) => ipcRenderer.invoke('read-skill-file', filePath),
}
```

**Handler Implementation** (`electron-app/src/services/ipc.js`):

| Handler | Purpose |
|---------|---------|
| `get-skills` | Scans skill directories, parses SKILL.md, returns metadata with base64 logos |
| `get-skill-files` | Returns recursive file tree for a skill directory |
| `read-skill-file` | Reads file content with path validation (security) |

**Data Flow:**
```
User clicks "Agent Skills" tab
    → component calls window.electronAPI.skills.getSkills()
    → IPC handler scans directories in priority order
    → parses SKILL.md frontmatter with yaml-front-matter
    → loads logo.png as base64 (or default icon)
    → returns array of skill metadata

User clicks skill card
    → component calls getSkillFiles(skillName)
    → IPC handler recursively scans skill directory
    → returns file tree structure

User clicks file in tree
    → component calls readSkillFile(filePath)
    → IPC handler validates path, reads content
    → returns file content for preview
```

## Creating User Skills

### 1. Create Directory

```bash
mkdir -p skills-user/my-custom-skill
```

### 2. Create SKILL.md

```markdown
---
name: my-custom-skill
description: Description of what this skill does
license: Proprietary
compatibility: Portico
metadata:
  author: your-name
  version: "1.0"
  priority: medium
  triggers:
    - "my keyword"
    - "another trigger"
---

# My Custom Skill

Instructions for the LLM when this skill is activated.

## Section 1

Details...

## Section 2

More details...
```

### 3. Add References (Optional)

```bash
mkdir skills-user/my-custom-skill/references
# Add reference markdown files
```

### 4. Add Logo (Optional)

Place a `logo.png` in the skill directory for display in the Electron UI.

### 5. Test

The skill will be automatically discovered on next filter execution. Test by:
1. Starting a new chat
2. Using a trigger keyword (for high-priority) or calling `activate_skill`
3. Verifying skill activation with `get_activated_skills`

### 6. Add Scripts (Optional)

Skills can include executable Python scripts for programmatic tasks:

```bash
mkdir skills-user/my-custom-skill/scripts
```

Create a script (e.g., `scripts/process_data.py`):
```python
#!/usr/bin/env python3
"""Process data and output results."""

import sys
import json
from pathlib import Path

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No input file provided"}))
        sys.exit(1)

    input_file = Path(sys.argv[1])
    if not input_file.exists():
        print(json.dumps({"error": f"File not found: {input_file}"}))
        sys.exit(1)

    # Process the file...
    result = {"success": True, "processed": str(input_file)}
    print(json.dumps(result))

if __name__ == "__main__":
    main()
```

Document scripts in SKILL.md:
```markdown
## Available Scripts

### scripts/process_data.py
Processes data files and outputs JSON results.

**Arguments:**
- `input/filename.ext` - Path to input file in workspace

**Output:**
- JSON to stdout with processing results
- Files to `output/` directory as needed
```

**Important:**
- Scripts run in isolated containers with no network access
- Add dependencies to `Dockerfile.agent-vm` before using them
- Use `/work/input/` and `/work/output/` paths for file I/O
- Output JSON to stdout for structured responses

## Best Practices

### Writing Effective Skills

1. **Clear Description**: Write a description that helps the LLM decide when to activate
2. **Specific Triggers**: Use unique, unambiguous trigger keywords
3. **Modular Content**: Keep SKILL.md under 200 lines; use references for details
4. **Action-Oriented**: Write instructions as clear directives
5. **Examples**: Include examples of correct behavior

### Avoiding Common Mistakes

- Don't duplicate core system prompt content
- Don't create overly broad skills (be specific)
- Don't rely solely on auto-activation for critical workflows
- Don't store sensitive information in skills
- Don't use triggers that are substrings of common words

### Writing Effective Scripts

1. **Structured Output**: Always output JSON to stdout for structured responses
2. **Error Handling**: Return proper exit codes (0=success, non-zero=error)
3. **Argument Validation**: Check required arguments and file existence early
4. **Workspace Paths**: Use `/work/input/` and `/work/output/` prefixes
5. **Documentation**: Document script purpose, arguments, and outputs in SKILL.md
6. **Dependencies**: Only use packages pre-installed in `Dockerfile.agent-vm`
7. **No Network**: Scripts cannot make network requests (security isolation)
8. **Idempotency**: Scripts should be safe to run multiple times
9. **Progress Output**: For long operations, output progress to stderr
10. **File Cleanup**: Don't leave temporary files outside of `/work/output/`

## Troubleshooting

### Skill Not Activating

1. Check skill exists in correct directory
2. Verify SKILL.md has valid frontmatter
3. Check trigger keywords match user intent
4. Verify Redis connectivity for persistence
5. Check max skills limit (4 per chat)

### Skill Not Discovered

1. Check file permissions
2. Verify SKILL.md is valid markdown with YAML frontmatter
3. Ensure `name` field matches directory name
4. Check SkillManager logs for parsing errors
5. Try `skills_list_skills()` to see discovered skills

### Reference Not Loading

1. Verify reference file exists in `references/` subdirectory
2. Check file path matches exactly (case-sensitive)
3. Verify reference is valid markdown/text
4. Ensure reference is listed in skill's metadata.references

### Auto-Activation Not Working

1. Verify skill has `priority: high`
2. Check triggers are lowercase in SKILL.md
3. Verify `enable_auto_activation` is true in filter config
4. Check user message contains trigger (substring match)

### Script Execution Failing

1. **"Script not found"**
   - Verify script exists in skill's `scripts/` directory
   - Check script path in tool call matches exactly (case-sensitive)
   - Ensure skill is activated before calling execute_skill_script

2. **"Docker image not found: agent-vm:latest"**
   - Build the image: `docker build -f Dockerfile.agent-vm -t agent-vm:latest .`
   - Or run `bash install_v2.sh` which auto-builds the image

3. **"docker package not available"**
   - Ensure `docker>=7.0.0` is in mcpo-core-mcp-assistant's dependencies
   - Rebuild and restart: `bash src/scripts/docker-compose.sh restart`

4. **Script runs but can't find files**
   - Files must be in workspace: use `vm_list_workspace_files` to check
   - Use `vm_write_to_workspace` to write files to workspace
   - Script args should use workspace paths: `input/filename.pdf`

5. **Container timeout**
   - Default timeout is 300 seconds
   - For long-running scripts, increase `timeout_seconds` parameter
   - Check script for infinite loops or excessive processing

6. **Dependency not available**
   - Dependencies must be pre-installed in `Dockerfile.agent-vm`
   - Add new deps to Dockerfile and rebuild image
   - Network is disabled at runtime - no pip install possible

7. **"No such file or directory: /work/bash"**
   - This indicates ENTRYPOINT conflict in Dockerfile.agent-vm
   - Ensure Dockerfile has NO ENTRYPOINT (script executor provides full command)

8. **Path conversion errors (Docker-in-Docker)**
   - Verify `HOST_PROJECT_ROOT` environment variable is set in mcpo-core-mcp-assistant
   - Check docker-compose.override.yml was regenerated after script changes
   - Run: `docker exec mcpo-core-mcp-assistant printenv HOST_PROJECT_ROOT`

### Workspace Issues

1. **Files not visible in workspace**
   - Verify workspaces volume is mounted in mcpo-core-mcp-assistant
   - Check docker-compose.override.yml has `./workspaces:/app/workspaces:rw`
   - Regenerate: `./src/scripts/mcp-orc-cli.sh generate-docker-compose-override && bash src/scripts/docker-compose.sh restart`

2. **Auto-copy not working**
   - Check Skills Filter is enabled and running
   - Verify file metadata is passed in request body
   - Check filter logs for errors

## Base Directory Resolution

SkillManager auto-detects its base directory:

```python
# Docker container
if os.path.exists("/app/skills"):
    base_dir = "/app"
# Local development
else:
    base_dir = project_root  # 3 levels up from skill_manager.py
```

Expected structure:
```
{base_dir}/
├── skills/
├── skills-user/
├── skills-marketplace/
└── src/managers/skill_manager.py
```

## Future: Skills Marketplace

> Note: Marketplace integration is planned for a future phase.

The architecture supports:
- Downloading skills from a central marketplace
- Automatic updates
- Skill ratings and reviews
- Publisher verification

Skills from the marketplace will be installed to `skills-marketplace/` and managed separately from system and user skills.
