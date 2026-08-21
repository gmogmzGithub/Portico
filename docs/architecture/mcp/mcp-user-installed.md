# User-Installed MCP Servers - Implementation Plan

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [MCP Assistant Core Server](#mcp-assistant-core-server)
4. [Folder Structure](#folder-structure)
5. [Data Model Changes](#data-model-changes)
6. [Environment Variable Strategy](#environment-variable-strategy)
7. [Tool Interface Design](#tool-interface-design)
8. [Config Generation Enhancements](#config-generation-enhancements)
9. [Docker Compose Changes](#docker-compose-changes)
10. [Implementation Phases](#implementation-phases)
11. [Security Considerations](#security-considerations)
12. [User Experience Flow](#user-experience-flow)

---

## Executive Summary

This document outlines the implementation plan for **User-Installed MCP Servers**, a new capability that enables users to install and manage arbitrary MCP servers through conversational interaction with the **MCP Assistant** - a new Core MCP Server.

### Key Innovation
Users can chat with the AI to install any MCP server from the MCP ecosystem without requiring manual file editing, configuration, or technical expertise. The MCP Assistant provides full CRUD operations for user-installed servers while maintaining read-only access to system-delivered servers for debugging purposes.

### Core Principles
1. **Separation of Concerns**: System-delivered vs User-Installed servers are physically separated
2. **Zero .env Pollution**: User-installed servers embed environment variables in fragments
3. **Conversational Setup**: Natural language installation via MCP Assistant
4. **Full Control**: Users can create, read, update, and delete their own servers
5. **Safe Debugging**: Read-only access to system server configs for troubleshooting

---

## Architecture Overview

### Current Server Categories
| Category | Description | Toggleable | Deployment |
|----------|-------------|-----------|------------|
| **Core** | Essential services (e.g., Subagents) | No | Docker or Host |
| **Non-Core** | Optional integrations (e.g., Slack, Glean) | Yes | Docker or Host |

### New Server Categories
| Category | Description | Toggleable | Deployment | Managed By |
|----------|-------------|-----------|------------|------------|
| **Core** | Essential services (e.g., Subagents, **MCP Assistant**) | No | Docker or Host | System |
| **System-Delivered** | Pre-configured integrations (e.g., Slack, Glean) | Yes | Docker or Host | System |
| **User-Installed** | User-configured servers | Yes | Docker or Host | User |

### Relationship Diagram
```
┌─────────────────────────────────────────────────────┐
│                   MCP Servers                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────┐       ┌──────────────────┐   │
│  │ System-Delivered │       │ User-Installed   │   │
│  │  (mcp-configs/)  │       │(mcp-configs-user)│   │
│  ├─────────────────┤       ├──────────────────┤   │
│  │ • Core          │       │ • Docker         │   │
│  │   - Subagents   │       │ • Host           │   │
│  │   - MCP Asst.   │       │ • Toggleable     │   │
│  │ • Non-Core      │       │ • Full CRUD      │   │
│  │   - Slack       │       │ • Env in Frag    │   │
│  │   - Glean       │       │                  │   │
│  │   - Atlassian   │       │                  │   │
│  └─────────────────┘       └──────────────────┘   │
│         ↑                           ↑              │
│    Read-Only                   Read-Write          │
│         └───────────┬───────────────┘              │
│                     │                              │
│            ┌────────▼────────┐                     │
│            │  MCP Assistant  │                     │
│            │   (Core Server) │                     │
│            └─────────────────┘                     │
└─────────────────────────────────────────────────────┘
```

---

## MCP Assistant Core Server

### Purpose
The MCP Assistant is a new **Core MCP Server** that provides tools for managing User-Installed MCP servers through natural language conversation.

### Key Characteristics
- **Type**: Core Server (always enabled, cannot be disabled)
- **Deployment**: Docker
- **Location**: `src/core-mcp-rust/mcp-assistant/`
- **Language**: Python (follows run-sub-agent pattern)
- **Access Pattern**:
  - Read-only to `mcp-configs/`
  - Read-write to `mcp-configs-user/`

### Why Core?
1. **Essential Capability**: Installing MCP servers is a fundamental system feature
2. **System Safety**: Should always be available to help users fix broken configs
3. **Self-Service**: Enables users to extend the system without admin intervention
4. **Troubleshooting**: Can read system configs to help debug integration issues

---

## Folder Structure

### Directory Layout
```
<project-root>/
├── mcp-configs/                          # System-Delivered Servers (READ-ONLY to MCP Assistant)
│   ├── run-sub-agent/
│   │   ├── run-sub-agent.yaml           # user_installed: false
│   │   ├── run-sub-agent.fragment
│   │   └── run-sub-agent.md             # Setup instructions for guided wizard
│   ├── mcp-assistant/                    # NEW: The MCP Assistant itself
│   │   ├── mcp-assistant.yaml           # user_installed: false, is_core: true
│   │   ├── mcp-assistant.fragment
│   │   └── mcp-assistant.md
│   ├── glean/
│   │   ├── glean.yaml                   # user_installed: false
│   │   ├── glean.fragment
│   │   └── glean.md
│   └── .../
│
├── mcp-configs-user/                     # User-Installed Servers (READ-WRITE to MCP Assistant)
│   ├── my-custom-server/
│   │   ├── my-custom-server.yaml        # user_installed: true
│   │   ├── my-custom-server.fragment    # Contains inline env vars
│   │   └── my-custom-server.png         # Optional icon
│   ├── filesystem-server/
│   │   ├── filesystem-server.yaml       # user_installed: true
│   │   ├── filesystem-server.fragment
│   │   └── filesystem-server.png
│   └── .../
│
├── src/core-mcp-rust/                         # Internal MCP Server Implementations
│   ├── run-sub-agent/                   # Existing subagent server
│   └── mcp-assistant/                    # NEW: MCP Assistant implementation
│       ├── src/
│       │   └── mcp_assistant_server/
│       │       ├── __init__.py
│       │       ├── server.py            # Main MCP server
│       │       ├── tools.py             # Tool definitions
│       │       ├── file_ops.py          # File operations
│       │       └── validation.py        # YAML/JSON validation
│       ├── pyproject.toml
│       ├── README.md
│       └── tests/
│
├── .env                                  # System env vars (unchanged)
├── mcp_toggles.json                     # Toggle state (includes user-installed)
├── mcp_config_advanced.json             # Generated Docker config (both types)
├── mcp_config_host_sideload.json        # Generated Host config (both types)
└── src/scripts/mcp-orc-cli.sh generate-mcp-config       # Enhanced config generator
```

### File Organization Rules

#### System-Delivered Servers (`mcp-configs/`)
- **Purpose**: Pre-packaged integrations maintained by system administrators
- **Structure**: `{server-id}/` containing:
  - `{server-id}.yaml` - Metadata with `user_installed: false`
  - `{server-id}.fragment` - MCP config (env vars from .env)
  - `{server-id}.md` - Setup instructions for guided wizard
  - `{server-id}.png` - Optional icon
- **Access**: Read-only to MCP Assistant
- **Env Vars**: Stored in `.env` file

#### User-Installed Servers (`mcp-configs-user/`)
- **Purpose**: Custom servers installed by users via MCP Assistant
- **Structure**: `{server-id}/` containing:
  - `{server-id}.yaml` - Metadata with `user_installed: true`
  - `{server-id}.fragment` - MCP config with **inline env vars**
  - `{server-id}.png` - Optional icon (NO .md file)
- **Access**: Read-write to MCP Assistant
- **Env Vars**: Embedded directly in fragment file

---

## Data Model Changes

### YAML Schema Enhancement

#### New Field: `user_installed`
```yaml
# Required field for ALL MCP server YAML files
user_installed: false  # System-delivered servers
user_installed: true   # User-installed servers
```

#### Updated System-Delivered YAML Example
```yaml
name: "Glean MCP Server"
id: "glean"
display_name: "Glean"
deployment_type: "docker"
experimental: false
is_core: false
user_installed: false              # NEW: Marks as system-delivered
description: "Provides access to Portico's internal knowledge base"
use_cases:
  - "Finding company documentation"
  - "Searching policies"

required_env_vars:
  - name: GLEAN_API_TOKEN
    placeholder: "your_glean_api_token"
    description: "Glean API Token"
    sensitive: true
  - name: GLEAN_INSTANCE
    placeholder: "portico"
    description: "Glean Instance Name"
    default: "portico"
```

#### User-Installed YAML Example (Host Server for Filesystem Access)
```yaml
name: "Filesystem MCP Server"
id: "filesystem-server"
display_name: "Filesystem"
deployment_type: "host"            # MUST be "host" for filesystem access
experimental: false
is_core: false
user_installed: true               # NEW: Marks as user-installed
description: "Provides read/write access to local filesystem"
use_cases:
  - "Reading files from disk"
  - "Writing files to disk"
  - "Searching file contents"

required_env_vars: []              # Empty - env vars in fragment
```

### Migration Strategy

All existing system-delivered YAML files must be updated to include:
```yaml
user_installed: false
```

This will be done via a migration script:
```bash
# src/scripts/migrate-add-user-installed-flag.sh
for yaml in mcp-configs/*/*.yaml; do
  if ! grep -q "user_installed:" "$yaml"; then
    # Insert user_installed: false after is_core line or after deployment_type
    sed -i '/^is_core:/a user_installed: false' "$yaml"
  fi
done
```

---

## Environment Variable Strategy

### Problem Statement
System-delivered servers store environment variables in `.env`, which is shared across all services. User-installed servers must not pollute this file because:

1. **Namespace Conflicts**: User vars might collide with system vars
2. **Security**: .env is version-controlled (with .gitignore, but still risky)
3. **Separation**: User configs should be self-contained
4. **Portability**: User servers should be easy to share/backup

### Solution: Inline Environment Variables

#### System-Delivered Pattern (Current)
**YAML** specifies required vars:
```yaml
required_env_vars:
  - name: GLEAN_API_TOKEN
    placeholder: "your_glean_api_token"
    description: "Glean API Token"
    sensitive: true
```

**Fragment** references them:
```json
{
  "command": "npx",
  "args": ["-y", "@gleanwork/mcp-server@latest"]
}
```

**Runtime**: MCP proxy injects vars from `.env`

#### User-Installed Pattern (New)
**YAML** has no required vars:
```yaml
required_env_vars: []  # Empty - vars embedded in fragment
```

**Fragment** includes inline env (Host server uses uvx):
```json
{
  "command": "uvx",
  "args": ["@modelcontextprotocol/server-filesystem@latest"],
  "env": {
    "FILESYSTEM_ROOT": "/home/user/documents",
    "FILESYSTEM_READONLY": "false",
    "FILESYSTEM_MAX_SIZE": "10485760"
  }
}
```

**Runtime**: MCP proxy reads vars directly from fragment

### Configuration Generation Changes

The `mcp-orc-cli generate-mcp-config` script must be enhanced to:

1. **Skip .env check for user-installed servers**:
```bash
is_server_configured() {
    local server_dir="$1"
    local yaml_file="${server_dir}/${server_name}.yaml"

    # Check if user-installed
    local user_installed=$(grep "^user_installed:" "$yaml_file" | sed 's/.*: *//' | tr -d '"' | tr -d "'")

    if [ "$user_installed" = "true" ]; then
        # User-installed servers are always "configured" (env in fragment)
        return 0
    fi

    # System-delivered: check .env as before
    # ... existing logic ...
}
```

2. **Scan both directories**:
```bash
# Process system-delivered servers
for server_dir in "$MCP_CONFIGS_DIR"/*; do
    # ... existing logic ...
done

# Process user-installed servers
for server_dir in "$MCP_CONFIGS_USER_DIR"/*; do
    # ... same logic, different source ...
done
```

### MCP Assistant Guidance

The MCP Assistant must provide clear guidance to the calling LLM:

```python
TOOL_DESCRIPTION = """
create_user_mcp_server: Create a new user-installed MCP server.

CRITICAL: User-installed servers MUST embed ALL environment variables
directly in the fragment file's "env" object. Do NOT instruct users to
add variables to the .env file.

Example fragment with embedded env vars:
{
  "command": "npx",
  "args": ["-y", "some-mcp-server@latest"],
  "env": {
    "API_KEY": "user-provided-key",
    "INSTANCE_URL": "https://example.com",
    "DEBUG": "false"
  }
}

For system-delivered servers (read-only), environment variables are
managed in the .env file and referenced by the config generation script.
"""
```

---

## Tool Interface Design

### MCP Assistant Tool Set

### Critical Guidance: Docker vs Host Deployment

**The MCP Assistant MUST provide clear guidance to the LLM on when to use Docker vs Host deployment:**

#### When to Use DOCKER Deployment:
- ✅ Servers connecting to **external APIs/services over network**
- ✅ PostgreSQL/MySQL connections (over TCP/IP)
- ✅ REST API wrappers
- ✅ npm packages that don't need filesystem access
- ✅ Cloud service integrations (S3, Redis, etc.)
- ✅ Examples: Slack, Glean, Atlassian, Time

#### When to Use HOST Deployment (REQUIRED):
- ⚠️ **Filesystem operations** (read/write local files)
- ⚠️ **Browser automation** (Playwright, Puppeteer)
- ⚠️ **Local tool execution** (git, shell commands)
- ⚠️ **System-level access** (processes, network interfaces)
- ⚠️ Examples: filesystem servers and custom local automation tools

**IMPORTANT**: If unsure, ask the user about the server's requirements. Filesystem access = HOST deployment mandatory.

---

#### 1. `list_mcp_servers`
**Purpose**: List all available MCP servers

**Input Schema**:
```json
{
  "filter": {
    "type": "string",
    "enum": ["all", "system", "user"],
    "description": "Filter servers by type",
    "default": "all"
  },
  "include_disabled": {
    "type": "boolean",
    "description": "Include disabled servers in the list",
    "default": true
  }
}
```

**Output**:
```json
{
  "servers": [
    {
      "id": "glean",
      "name": "Glean MCP Server",
      "display_name": "Glean",
      "deployment_type": "docker",
      "is_core": false,
      "user_installed": false,
      "enabled": true,
      "configured": true
    },
    {
      "id": "filesystem-server",
      "name": "Filesystem MCP Server",
      "display_name": "Filesystem",
      "deployment_type": "docker",
      "is_core": false,
      "user_installed": true,
      "enabled": true,
      "configured": true
    }
  ],
  "summary": {
    "total": 2,
    "system": 1,
    "user": 1,
    "core": 0
  }
}
```

#### 2. `get_system_mcp_config`
**Purpose**: Read system-delivered server configuration (debugging only)

**Input Schema**:
```json
{
  "server_id": {
    "type": "string",
    "description": "The ID of the system server to read"
  }
}
```

**Output**:
```json
{
  "server_id": "glean",
  "yaml_config": {
    "name": "Glean MCP Server",
    "id": "glean",
    "display_name": "Glean",
    "deployment_type": "docker",
    "user_installed": false,
    "description": "...",
    "required_env_vars": [...]
  },
  "fragment": {
    "command": "npx",
    "args": ["-y", "@gleanwork/mcp-server@latest"]
  },
  "readonly": true,
  "note": "This is a system-delivered server and cannot be modified via MCP Assistant"
}
```

#### 3. `create_user_mcp_server`
**Purpose**: Create a new user-installed MCP server

**IMPORTANT GUIDANCE FOR LLM:**
- **Docker deployment**: Use for servers connecting to external APIs/services (PostgreSQL over network, REST APIs, npm packages that don't need host access)
- **Host deployment**: REQUIRED for servers needing host-level access (filesystem operations, browser automation, local tools)
- **Naming**: Server ID MUST NOT collide with existing system-delivered servers (glean, slack, etc.)

**Input Schema**:
```json
{
  "server_id": {
    "type": "string",
    "description": "Unique identifier (must match directory name). Will be validated against existing servers to prevent collisions.",
    "pattern": "^[a-z0-9-]+$"
  },
  "yaml_config": {
    "type": "object",
    "description": "YAML configuration object",
    "required": ["name", "id", "display_name", "deployment_type", "description"],
    "properties": {
      "name": {"type": "string"},
      "id": {"type": "string"},
      "display_name": {"type": "string"},
      "deployment_type": {"type": "string", "enum": ["docker", "host"]},
      "experimental": {"type": "boolean", "default": false},
      "is_core": {"type": "boolean", "default": false},
      "description": {"type": "string"},
      "use_cases": {"type": "array", "items": {"type": "string"}},
      "required_env_vars": {"type": "array", "default": []}
    }
  },
  "fragment": {
    "type": "object",
    "description": "MCP server fragment with embedded env vars",
    "required": ["command", "args"],
    "properties": {
      "command": {"type": "string"},
      "args": {"type": "array", "items": {"type": "string"}},
      "env": {
        "type": "object",
        "description": "Environment variables embedded in fragment"
      }
    }
  },
  "icon_base64": {
    "type": "string",
    "description": "Optional base64-encoded PNG icon"
  }
}
```

**Output**:
```json
{
  "success": true,
  "server_id": "filesystem-server",
  "message": "User-installed MCP server 'filesystem-server' created successfully",
  "files_created": [
    "mcp-configs-user/filesystem-server/filesystem-server.yaml",
    "mcp-configs-user/filesystem-server/filesystem-server.fragment",
    "mcp-configs-user/filesystem-server/filesystem-server.png"
  ],
  "next_steps": [
    "Toggle the server on in the Control Panel",
    "Restart services to apply changes",
    "Test the server by invoking its tools"
  ]
}
```

#### 4. `read_user_mcp_server`
**Purpose**: Read user-installed server configuration

**Input Schema**:
```json
{
  "server_id": {
    "type": "string",
    "description": "The ID of the user-installed server"
  }
}
```

**Output**: Same as `get_system_mcp_config` but with `readonly: false`

#### 5. `update_user_mcp_server`
**Purpose**: Update user-installed server configuration

**Input Schema**: Same as `create_user_mcp_server` (all fields optional except `server_id`)

**Output**:
```json
{
  "success": true,
  "server_id": "filesystem-server",
  "message": "User-installed MCP server 'filesystem-server' updated successfully",
  "files_modified": [
    "mcp-configs-user/filesystem-server/filesystem-server.yaml",
    "mcp-configs-user/filesystem-server/filesystem-server.fragment"
  ]
}
```

#### 6. `delete_user_mcp_server`
**Purpose**: Delete user-installed server

**Input Schema**:
```json
{
  "server_id": {
    "type": "string",
    "description": "The ID of the server to delete"
  },
  "confirm": {
    "type": "boolean",
    "description": "Confirmation flag to prevent accidental deletion",
    "default": false
  }
}
```

**Output**:
```json
{
  "success": true,
  "server_id": "filesystem-server",
  "message": "User-installed MCP server 'filesystem-server' deleted successfully",
  "files_deleted": [
    "mcp-configs-user/filesystem-server/filesystem-server.yaml",
    "mcp-configs-user/filesystem-server/filesystem-server.fragment",
    "mcp-configs-user/filesystem-server/filesystem-server.png"
  ]
}
```

#### 7. `validate_mcp_fragment`
**Purpose**: Validate fragment JSON before creation/update

**Input Schema**:
```json
{
  "fragment": {
    "type": "object",
    "description": "Fragment to validate"
  }
}
```

**Output**:
```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    "Fragment includes 'env' object - ensure all sensitive values are correct"
  ]
}
```

---

## Config Generation Enhancements

### Updated Script: `src/scripts/mcp-orc-cli.sh generate-mcp-config`

#### Critical Requirement: Merge Both Directories

The script MUST process both `mcp-configs/` (system-delivered) and `mcp-configs-user/` (user-installed) and merge them into the SAME output files:
- Docker servers from both → `mcp_config_advanced.json`
- Host servers from both → `mcp_config_host_sideload.json`

#### Key Changes

1. **Dual Directory Scanning with Merge**:
```bash
MCP_CONFIGS_DIR="mcp-configs"
MCP_CONFIGS_USER_DIR="mcp-configs-user"

# Process system-delivered servers first
for server_dir in "$MCP_CONFIGS_DIR"/*; do
    # ... process and add to appropriate output file ...
done

# Then process user-installed servers (merged into same files)
if [ -d "$MCP_CONFIGS_USER_DIR" ]; then
    for server_dir in "$MCP_CONFIGS_USER_DIR"/*; do
        # ... process and add to appropriate output file ...
    done
fi
```

2. **User-Installed Detection**:
```bash
is_user_installed() {
    local yaml_file="$1"
    local user_installed=$(grep "^user_installed:" "$yaml_file" 2>/dev/null | sed 's/.*: *//' | tr -d '"' | tr -d "'")

    if [ "$user_installed" = "true" ]; then
        return 0  # User-installed
    fi
    return 1  # System-delivered
}

get_server_type_label() {
    local yaml_file="$1"
    if is_user_installed "$yaml_file"; then
        echo "user-installed"
    else
        echo "system-delivered"
    fi
}
```

3. **Configuration Check Override**:
```bash
is_server_configured() {
    local yaml_file="$1"

    # User-installed servers are always configured (env in fragment)
    if is_user_installed "$yaml_file"; then
        return 0
    fi

    # System-delivered: check .env as before
    local server_dir=$(dirname "$yaml_file")
    local server_name=$(basename "$server_dir")

    # Extract required environment variables from YAML
    local required_vars=$(grep -A 50 "required_env_vars:" "$yaml_file" 2>/dev/null | grep "name:" | sed 's/.*name: *//' | tr -d '"' | tr -d "'")

    if [ -z "$required_vars" ]; then
        return 0
    fi

    # Check each required variable in .env
    for var in $required_vars; do
        if ! is_env_configured "$var"; then
            return 1
        fi
    done

    return 0
}
```

4. **Naming Collision Detection**:
```bash
check_server_name_collision() {
    local server_id="$1"

    # Check if server exists in system-delivered configs
    if [ -d "${MCP_CONFIGS_DIR}/${server_id}" ]; then
        return 0  # Collision detected
    fi

    return 1  # No collision
}
```

#### Runtime Collision Precedence (Manual Filesystem Edits)

If a user manually creates `mcp-configs-user/<server_id>/` with an ID that already exists in
`mcp-configs/<server_id>/`, runtime behavior is:

1. System-delivered server is kept (authoritative)
2. User-installed colliding server is ignored
3. A warning is emitted in generator logs and in `health_status.json` under:
   `warnings.ignored_user_server_id_collisions`

5. **Enhanced Output**:
```bash
local server_type=$(get_server_type_label "$yaml_file")
echo -e "${GREEN}  ✓ $server_name is configured (${deployment_type}, ${server_type})${NC}"
```

#### Complete Enhanced Script

The complete enhanced script is available at `docs/generate_mcp_config_enhanced.sh` and should replace the existing `src/scripts/mcp-orc-cli.sh generate-mcp-config`.

**Key Features:**
1. ✅ Processes both `mcp-configs/` and `mcp-configs-user/` directories
2. ✅ Merges servers from both into single output files
3. ✅ Detects user-installed vs system-delivered servers
4. ✅ Skip .env check for user-installed servers
5. ✅ Enhanced output with server type labels
6. ✅ Proper HOST_MODE detection and handling

**To Use:**
```bash
# Replace existing script
cp docs/generate_mcp_config_enhanced.sh src/scripts/mcp-orc-cli.sh generate-mcp-config
chmod +x src/scripts/mcp-orc-cli.sh generate-mcp-config

# Test it
bash src/scripts/mcp-orc-cli.sh generate-mcp-config
```

---

## Docker Compose Changes

### Volume Mounts for mcpo Container

#### Current Configuration
```yaml
mcpo:
  volumes:
    - ./mcp_config_advanced.json:/app/mcp_config_advanced.json
    - /var/run/docker.sock:/var/run/docker.sock
```

#### Enhanced Configuration
```yaml
mcpo:
  volumes:
    - ./mcp_config_advanced.json:/app/mcp_config_advanced.json
    - /var/run/docker.sock:/var/run/docker.sock
    # NEW: System-delivered MCP configs (read-only)
    - ./mcp-configs:/app/mcp-configs:ro
    # NEW: User-installed MCP configs (read-write)
    - ./mcp-configs-user:/app/mcp-configs-user:rw
```

#### Rationale

1. **Read-Only System Configs**: Prevents accidental modification of system servers
2. **Read-Write User Configs**: Enables MCP Assistant to manage user servers
3. **Debugging Support**: Allows MCP Assistant to read system configs for troubleshooting

#### Internal MCP Volume Mounting

The `src/core-mcp-rust/mcp-assistant/` directory must also be accessible:

```yaml
mcpo:
  volumes:
    # ... existing volumes ...
    # Internal MCP servers
    - ./src/core-mcp:/app/internal-mcp:ro
```

This allows the MCP Assistant fragment to reference:
```json
{
  "command": "uv",
  "args": [
    "run",
    "--directory",
    "/app/internal-mcp/mcp-assistant",
    "mcp-assistant-server"
  ]
}
```

---

## Implementation Phases

### Phase 1: Foundation (Data Model & Folder Structure)

**Tasks**:
1. Create `mcp-configs-user/` directory
2. Add `user_installed: false` to all existing YAML files
3. Create migration script: `src/scripts/migrate-add-user-installed-flag.sh`
4. Run migration to update all system YAMLs
5. Create `.gitkeep` in `mcp-configs-user/`
6. Update `.gitignore` to include `mcp-configs-user/*/`

**Deliverables**:
- `mcp-configs-user/` directory created
- All system YAMLs updated with `user_installed: false`
- Migration script committed
- Git configuration updated

**Validation**:
```bash
# Verify all system YAMLs have user_installed field
for yaml in mcp-configs/*/*.yaml; do
  if ! grep -q "user_installed:" "$yaml"; then
    echo "ERROR: Missing user_installed in $yaml"
  fi
done
```

### Phase 2: Config Generation Enhancement

**Tasks**:
1. Update `src/scripts/mcp-orc-cli.sh generate-mcp-config`:
   - Add `MCP_CONFIGS_USER_DIR` variable
   - Add `is_user_installed()` function
   - Modify `is_server_configured()` to skip .env check for user-installed
   - Add dual directory scanning loop
   - Enhance output messages to indicate server type
2. Test config generation with empty `mcp-configs-user/`
3. Create test user-installed server manually
4. Test config generation with test user server

**Deliverables**:
- Enhanced `mcp-orc-cli generate-mcp-config`
- Test scripts for validation
- Documentation updates

**Validation**:
```bash
# Create test user server
mkdir -p mcp-configs-user/test-server
cat > mcp-configs-user/test-server/test-server.yaml <<EOF
name: "Test Server"
id: "test-server"
display_name: "Test"
deployment_type: "docker"
user_installed: true
description: "Test server"
required_env_vars: []
EOF

cat > mcp-configs-user/test-server/test-server.fragment <<EOF
{
  "command": "echo",
  "args": ["test"],
  "env": {
    "TEST_VAR": "test_value"
  }
}
EOF

# Run config generation
bash src/scripts/mcp-orc-cli.sh generate-mcp-config

# Verify test-server in output
jq '.mcpServers["test-server"]' mcp_config_advanced.json
```

### Phase 3: Docker Compose Integration

**Tasks**:
1. Update `docker-compose.yml` mcpo volumes:
   - Add `./mcp-configs:/app/mcp-configs:ro`
   - Add `./mcp-configs-user:/app/mcp-configs-user:rw`
2. Test container startup
3. Verify volume mounts inside mcpo container

**Deliverables**:
- Updated `docker-compose.yml`
- Validation test script

**Validation**:
```bash
# Start services
docker-compose up -d mcpo

# Verify mounts
docker exec mcpo ls -la /app/mcp-configs
docker exec mcpo ls -la /app/mcp-configs-user

# Verify permissions
docker exec mcpo touch /app/mcp-configs-user/test.txt  # Should succeed
docker exec mcpo touch /app/mcp-configs/test.txt       # Should fail (read-only)
```

### Phase 4: MCP Assistant Implementation

**Tasks**:
1. Create `src/core-mcp-rust/mcp-assistant/` directory structure
2. Implement Python MCP server:
   - `server.py` - Main MCP server setup
   - `tools.py` - Tool definitions (7 tools)
   - `file_ops.py` - File operations (read/write/delete YAML/fragment/icon)
   - `validation.py` - YAML/JSON validation
3. Add dependencies in `pyproject.toml`
4. Create README and tests
5. Create MCP Assistant YAML config:
   - `mcp-configs/mcp-assistant/mcp-assistant.yaml` with `is_core: true, user_installed: false`
6. Create fragment referencing internal server
7. Test MCP Assistant locally with `uv run`

**Deliverables**:
- Complete MCP Assistant Python implementation
- Configuration files
- Unit tests
- Integration tests

**Tool Implementation Checklist**:
- [ ] `list_mcp_servers`
- [ ] `get_system_mcp_config`
- [ ] `create_user_mcp_server`
- [ ] `read_user_mcp_server`
- [ ] `update_user_mcp_server`
- [ ] `delete_user_mcp_server`
- [ ] `validate_mcp_fragment`

**Validation**:
```bash
# Local testing
cd src/core-mcp-rust/mcp-assistant
uv run mcp-assistant-server

# Test with MCP inspector
npx @modelcontextprotocol/inspector uv run mcp-assistant-server
```

### Phase 5: UI Integration

**Tasks**:
1. Update Guided Setup Wizard:
   - Scan both `mcp-configs/` and `mcp-configs-user/`
   - Display "USER" badge for user-installed servers
   - Handle `user_installed` flag in server cards
2. Update Control Panel:
   - Show user-installed servers with badge
   - Add "MCP Assistant" to core servers list
3. Test toggle functionality for user-installed servers
4. Update CSS for user-installed badge styling

**Deliverables**:
- Updated `electron-app/src/guided-setup.html`
- Updated `electron-app/src/services/renderer.js`
- Updated `electron-app/src/styles.css`
- UI screenshots

**Badge Styling**:
```css
/* User-installed badge - teal/cyan */
.deployment-badge-user {
  background: rgba(20, 184, 166, 0.15);
  color: #14b8a6;
  border: 1px solid rgba(20, 184, 166, 0.3);
}
```

### Phase 6: End-to-End Testing

**Tasks**:
1. Create test scenarios:
   - Install filesystem server via conversation
   - Update server configuration
   - Enable/disable server
   - Delete server
   - Debug system server using MCP Assistant
2. Test both Docker and Host deployment types
3. Test error handling (invalid JSON, duplicate IDs, etc.)
4. Load testing with multiple user servers
5. Validate config generation after each operation

**Deliverables**:
- Test suite
- Test documentation
- Known issues log

**Test Scenarios**:

**Scenario 1: Install Filesystem Server**
```
User: "I want to install the MCP filesystem server"
AI: [Uses MCP Assistant to gather requirements]
AI: "I'll install the filesystem server. What directory should it access?"
User: "/home/user/documents"
AI: [Creates server with embedded env vars]
AI: "Server installed! Please restart services and toggle it on."
```

**Scenario 2: Debug System Server**
```
User: "My Glean server isn't working"
AI: [Uses get_system_mcp_config to read Glean config]
AI: "I see the Glean server requires GLEAN_API_TOKEN. Let me check your .env..."
AI: [Identifies missing/invalid token]
AI: "Your GLEAN_API_TOKEN appears to be a placeholder. Please update it in .env"
```

### Phase 7: Documentation & Training

**Tasks**:
1. Update user documentation
2. Create tutorial videos/guides
3. Write troubleshooting guide
4. Update system architecture diagrams
5. Create FAQ document

**Deliverables**:
- Updated `docs/architecture/mcp/mcp-system.md`
- New `docs/mcp_user_installed.md` (this document)
- User guide: `docs/user_guide_mcp_assistant.md`
- Developer guide: `docs/dev_guide_mcp_assistant.md`

---

## Security Considerations

### Access Control

#### File System Permissions
```yaml
# docker-compose.yml
mcpo:
  user: "1000:1000"  # Run as non-root
  volumes:
    - ./mcp-configs:/app/mcp-configs:ro        # Read-only
    - ./mcp-configs-user:/app/mcp-configs-user:rw  # Read-write
```

#### Path Traversal Prevention
```python
# file_ops.py
import os
from pathlib import Path

USER_CONFIGS_BASE = Path("/app/mcp-configs-user")
SYSTEM_CONFIGS_BASE = Path("/app/mcp-configs")

def validate_server_id(server_id: str, user_installed: bool) -> Path:
    """Prevent path traversal attacks"""

    # Only allow alphanumeric and hyphens
    if not re.match(r'^[a-z0-9-]+$', server_id):
        raise ValueError(f"Invalid server ID: {server_id}")

    base = USER_CONFIGS_BASE if user_installed else SYSTEM_CONFIGS_BASE
    server_path = (base / server_id).resolve()

    # Ensure resolved path is within base directory
    if not str(server_path).startswith(str(base)):
        raise ValueError(f"Path traversal detected: {server_id}")

    return server_path
```

### Input Validation

#### YAML Validation
```python
# validation.py
import yaml
from jsonschema import validate, ValidationError

YAML_SCHEMA = {
    "type": "object",
    "required": ["name", "id", "display_name", "deployment_type", "description"],
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 100},
        "id": {"type": "string", "pattern": "^[a-z0-9-]+$", "maxLength": 50},
        "display_name": {"type": "string", "minLength": 1, "maxLength": 50},
        "deployment_type": {"type": "string", "enum": ["docker", "host"]},
        "experimental": {"type": "boolean"},
        "is_core": {"type": "boolean"},
        "user_installed": {"type": "boolean"},
        "description": {"type": "string", "minLength": 1, "maxLength": 500},
        "use_cases": {
            "type": "array",
            "items": {"type": "string", "maxLength": 200},
            "maxItems": 10
        },
        "required_env_vars": {
            "type": "array",
            "maxItems": 0  # Must be empty for user-installed
        }
    }
}

def validate_user_yaml(data: dict) -> None:
    """Validate user-installed YAML config"""

    # Schema validation
    validate(instance=data, schema=YAML_SCHEMA)

    # Additional rules
    if data.get("user_installed") != True:
        raise ValidationError("user_installed must be true")

    if data.get("is_core") == True:
        raise ValidationError("User-installed servers cannot be core")

    if data.get("required_env_vars"):
        raise ValidationError("User-installed servers must have empty required_env_vars")
```

#### Fragment Validation
```python
# validation.py
FRAGMENT_SCHEMA = {
    "type": "object",
    "required": ["command", "args"],
    "properties": {
        "command": {"type": "string", "minLength": 1, "maxLength": 200},
        "args": {
            "type": "array",
            "items": {"type": "string", "maxLength": 500},
            "maxItems": 50
        },
        "env": {
            "type": "object",
            "patternProperties": {
                "^[A-Z_][A-Z0-9_]*$": {"type": "string"}
            },
            "maxProperties": 50
        }
    }
}

def validate_fragment(data: dict) -> None:
    """Validate MCP fragment JSON"""

    validate(instance=data, schema=FRAGMENT_SCHEMA)

    # Check command injection risks
    dangerous_chars = [';', '|', '&', '`', '$', '(', ')']
    if any(char in data['command'] for char in dangerous_chars):
        raise ValidationError("Command contains dangerous characters")
```

#### Naming Collision Detection
```python
# validation.py
import os
from pathlib import Path

SYSTEM_CONFIGS_BASE = Path("/app/mcp-configs")

def check_server_name_collision(server_id: str) -> bool:
    """Check if server ID collides with system-delivered server"""

    system_server_path = SYSTEM_CONFIGS_BASE / server_id
    if system_server_path.exists():
        raise ValidationError(
            f"Server ID '{server_id}' collides with existing system-delivered server. "
            f"Please choose a different name."
        )

    return True

def validate_server_id(server_id: str) -> None:
    """Comprehensive server ID validation"""

    # Pattern validation
    if not re.match(r'^[a-z0-9-]+$', server_id):
        raise ValidationError(
            f"Invalid server ID: {server_id}. "
            f"Only lowercase letters, numbers, and hyphens are allowed."
        )

    # Length validation
    if len(server_id) < 3 or len(server_id) > 50:
        raise ValidationError(
            f"Server ID must be between 3 and 50 characters"
        )

    # Collision detection
    check_server_name_collision(server_id)
```

### Sensitive Data Handling

#### Environment Variable Security
```python
# tools.py
def sanitize_fragment_for_display(fragment: dict) -> dict:
    """Redact sensitive env vars when displaying config"""

    if "env" not in fragment:
        return fragment

    sanitized = fragment.copy()
    sanitized["env"] = {}

    for key, value in fragment["env"].items():
        # Redact sensitive keys
        if any(term in key.lower() for term in ["token", "key", "secret", "password", "credential"]):
            sanitized["env"][key] = "***REDACTED***"
        else:
            sanitized["env"][key] = value

    return sanitized
```

### Resource Limits

#### Disk Space Management
```python
# file_ops.py
MAX_SERVERS = 50
MAX_ICON_SIZE = 1_048_576  # 1MB
MAX_YAML_SIZE = 10_240     # 10KB
MAX_FRAGMENT_SIZE = 10_240 # 10KB

def check_resource_limits() -> None:
    """Ensure user hasn't exceeded resource limits"""

    user_servers = list(USER_CONFIGS_BASE.iterdir())

    if len(user_servers) >= MAX_SERVERS:
        raise RuntimeError(f"Maximum of {MAX_SERVERS} user-installed servers reached")
```

---

## User Experience Flow

### Scenario 1: Installing a New MCP Server

**User Goal**: Install the official filesystem MCP server

**Conversation Flow**:

```
User: "I want to install the filesystem MCP server so I can read and write files."

AI: "I can help you install the filesystem MCP server! First, let me gather some information:

1. What directory path should the server have access to?
2. Should it be read-only or read-write?
3. Do you want to set a maximum file size limit?

Please provide the directory path and your preferences."

User: "/Users/john/Documents"
User: "Read-write access"
User: "Max size 10MB"

AI: [Uses MCP Assistant's create_user_mcp_server tool]

AI: "Perfect! I've installed the filesystem MCP server with these settings:
- Access: /Users/john/Documents (read-write)
- Max file size: 10MB

The server has been created as 'filesystem-server' in your user-installed servers.

To activate it:
1. Go to the Control Panel
2. Find 'Filesystem' server (it will have a 'USER' badge)
3. Toggle it ON
4. Click 'Save Changes'
5. Restart services when prompted

Once activated, you'll be able to:
- Read files from your Documents folder
- Write new files
- Search file contents
- Create and delete files

Would you like me to help with anything else?"
```

### Scenario 2: Debugging a System Server

**User Goal**: Figure out why Glean isn't working

**Conversation Flow**:

```
User: "My Glean server isn't working. When I try to search, it says 'server unavailable'."

AI: "Let me check your Glean configuration to diagnose the issue."

AI: [Uses MCP Assistant's get_system_mcp_config tool]

AI: "I've reviewed your Glean configuration. I found the issue:

**Problem**: Your GLEAN_API_TOKEN environment variable is set to 'your_glean_api_token', which is a placeholder value.

**Solution**: You need to obtain a real API token from Glean and update your .env file:

1. Go to Glean's API settings: https://portico.glean.com/admin/api
2. Generate a new API token (requires manager approval)
3. Open your .env file
4. Replace the placeholder: GLEAN_API_TOKEN=your_real_token_here
5. Restart services

Your GLEAN_INSTANCE is correctly set to 'portico', so that's good.

Once you update the token, Glean should work properly. Would you like me to explain any of these steps in more detail?"
```

### Scenario 3: Updating a User Server

**User Goal**: Change filesystem server to read-only

**Conversation Flow**:

```
User: "I want to make my filesystem server read-only"

AI: "I can update your filesystem server to be read-only. Let me make that change."

AI: [Uses MCP Assistant's read_user_mcp_server to get current config]
AI: [Uses MCP Assistant's update_user_mcp_server to modify env vars]

AI: "Done! I've updated your filesystem server to read-only mode.

Changes made:
- Set FILESYSTEM_READONLY=true in the server configuration

To apply the changes:
1. Restart services (Control Panel → Restart)
2. The filesystem server will now only allow read operations

The server will no longer be able to:
- Create new files
- Modify existing files
- Delete files

But it will still allow:
- Reading file contents
- Listing directories
- Searching files

Would you like me to revert this change or make any other adjustments?"
```

### Scenario 4: Exploring Available Servers

**User Goal**: See what MCP servers are available

**Conversation Flow**:

```
User: "What MCP servers do I have available?"

AI: [Uses MCP Assistant's list_mcp_servers tool with filter="all"]

AI: "Here are all your available MCP servers:

**Core Servers** (always enabled):
- Subagents - Task delegation and parallel processing
- MCP Assistant - Manage user-installed MCP servers

**System-Delivered Servers**:
- ✓ Glean - Internal knowledge base search (enabled)
- ✓ Slack - Message reading and posting (enabled)
- ✗ Google Workspace - Gmail, Drive, Calendar (disabled)
- ✗ Atlassian - Jira and Confluence access (disabled)
- ✓ Time - Timezone and date utilities (enabled)

**User-Installed Servers**:
- ✓ Filesystem - Local file access (enabled)

You have 6 enabled servers out of 8 total. Would you like to:
- Enable any disabled servers?
- Install a new MCP server?
- Learn more about a specific server?"
```

---

## Success Metrics

### Technical Metrics
- **Config Generation**: No errors when generating configs with user servers
- **Volume Mounts**: Correct permissions (ro/rw) verified in container
- **Tool Invocations**: All 7 MCP Assistant tools work correctly
- **Validation**: Malformed YAML/JSON rejected with clear errors

### User Experience Metrics
- **Installation Time**: Average time to install a server < 2 minutes
- **Success Rate**: 95%+ successful server installations
- **Error Clarity**: Users can resolve issues without external help
- **Documentation**: FAQs cover 90%+ of user questions

### Performance Metrics
- **Config Generation Speed**: < 2 seconds with 50 user servers
- **Tool Response Time**: < 500ms for CRUD operations
- **Container Startup**: No significant delay from volume mounts

---

## Risks & Mitigations

### Risk 1: Path Traversal Attacks
**Impact**: Users could read/write outside `mcp-configs-user/`

**Mitigation**:
- Strict server ID validation (alphanumeric + hyphens only)
- Path resolution validation in `file_ops.py`
- Read-only mount for system configs

### Risk 2: Resource Exhaustion
**Impact**: Users create hundreds of servers, fill disk

**Mitigation**:
- Hard limit of 50 user-installed servers
- File size limits (1MB icon, 10KB YAML/fragment)
- Periodic cleanup of disabled servers

### Risk 3: Command Injection
**Impact**: Malicious fragment executes arbitrary commands

**Mitigation**:
- Fragment validation with strict JSON schema
- Command string inspection for dangerous characters
- Sandboxed execution environment (Docker)

### Risk 4: Configuration Conflicts
**Impact**: User server ID collides with system server

**Mitigation**:
- Server ID uniqueness check across both directories
- Clear error message if conflict detected
- Recommend naming convention (e.g., "user-*")

### Risk 5: Lost User Servers
**Impact**: User loses servers after upgrade/reinstall

**Mitigation**:
- `mcp-configs-user/` in backup instructions
- Export/import functionality (future enhancement)
- Git-ignored but documented for manual backup

---

## Future Enhancements

### Phase 8+: Advanced Features

#### 1. MCP Server Templates
Pre-built templates for common servers:
- Filesystem (read-only/read-write)
- PostgreSQL/MySQL connection
- REST API wrapper
- Git repository access

```
User: "Install a PostgreSQL server"
AI: [Uses template to gather: host, port, database, user, password]
AI: [Creates server with template defaults]
```

#### 2. Server Import/Export
```python
# New tools:
- export_user_mcp_servers → ZIP file
- import_user_mcp_servers ← ZIP file
```

#### 3. Server Testing
```python
# New tool: test_user_mcp_server
# Validates server starts and tools are discoverable
{
  "server_id": "filesystem-server",
  "test_results": {
    "startup": "success",
    "tools_discovered": 5,
    "sample_invocation": "success"
  }
}
```

#### 4. Version Management
```yaml
# In YAML:
version: "1.0.0"
changelog:
  - version: "1.0.0"
    date: "2025-01-15"
    changes: ["Initial release"]
```

#### 5. Community Sharing
- Share user-installed servers with team
- Public registry of community servers
- Rating and review system

#### 6. Automatic Updates
- Check for MCP server package updates
- Notify user when new version available
- One-click upgrade

---

## Appendix A: File Examples

### Example 1: User-Installed Filesystem Server (Host Server)

**File**: `mcp-configs-user/filesystem-server/filesystem-server.yaml`
```yaml
name: "Filesystem MCP Server"
id: "filesystem-server"
display_name: "Filesystem"
deployment_type: "host"            # MUST be "host" for filesystem access
experimental: false
is_core: false
user_installed: true
description: "Provides read/write access to local filesystem"
use_cases:
  - "Reading files from disk"
  - "Writing files to disk"
  - "Searching file contents"
  - "Managing directory structure"

required_env_vars: []
```

**File**: `mcp-configs-user/filesystem-server/filesystem-server.fragment`
```json
{
  "command": "uvx",
  "args": [
    "@modelcontextprotocol/server-filesystem@latest"
  ],
  "env": {
    "FILESYSTEM_ROOT": "/home/user/documents",
    "FILESYSTEM_READONLY": "false",
    "FILESYSTEM_MAX_SIZE": "10485760"
  }
}
```

**Note**: Filesystem servers MUST use `deployment_type: "host"` because they require direct access to the host machine's filesystem.

### Example 2: User-Installed PostgreSQL Server

**File**: `mcp-configs-user/postgres-server/postgres-server.yaml`
```yaml
name: "PostgreSQL MCP Server"
id: "postgres-server"
display_name: "PostgreSQL"
deployment_type: "docker"
experimental: false
is_core: false
user_installed: true
description: "Connect to PostgreSQL database for queries and schema inspection"
use_cases:
  - "Running SQL queries"
  - "Inspecting database schema"
  - "Managing tables and indexes"

required_env_vars: []
```

**File**: `mcp-configs-user/postgres-server/postgres-server.fragment`
```json
{
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-postgres"
  ],
  "env": {
    "POSTGRES_HOST": "localhost",
    "POSTGRES_PORT": "5432",
    "POSTGRES_DB": "myapp",
    "POSTGRES_USER": "postgres",
    "POSTGRES_PASSWORD": "secretpassword",
    "POSTGRES_SSL": "false"
  }
}
```

### Example 3: User-Installed Custom REST API Server

**File**: `mcp-configs-user/my-api-server/my-api-server.yaml`
```yaml
name: "My Custom API MCP Server"
id: "my-api-server"
display_name: "My API"
deployment_type: "docker"
experimental: false
is_core: false
user_installed: true
description: "Wrapper for my company's internal REST API"
use_cases:
  - "Querying customer data"
  - "Creating support tickets"
  - "Retrieving analytics"

required_env_vars: []
```

**File**: `mcp-configs-user/my-api-server/my-api-server.fragment`
```json
{
  "command": "uvx",
  "args": [
    "my-company-mcp-server@latest"
  ],
  "env": {
    "API_BASE_URL": "https://api.mycompany.com/v2",
    "API_KEY": "abc123xyz789",
    "API_TIMEOUT": "30",
    "API_RATE_LIMIT": "100"
  }
}
```

---

## Appendix B: Implementation Checklist

### Phase 1: Foundation ✅
- [ ] Create `mcp-configs-user/` directory
- [ ] Add `user_installed: false` to all system YAMLs
- [ ] Create migration script
- [ ] Run migration
- [ ] Update `.gitignore`
- [ ] Create `.gitkeep` in `mcp-configs-user/`

### Phase 2: Config Generation ✅
- [ ] Add `MCP_CONFIGS_USER_DIR` variable
- [ ] Implement `is_user_installed()` function
- [ ] Modify `is_server_configured()` function
- [ ] Add dual directory scanning
- [ ] Enhance output messages
- [ ] Test with empty user directory
- [ ] Test with sample user server

### Phase 3: Docker Compose ✅
- [ ] Add `mcp-configs` volume mount (ro)
- [ ] Add `mcp-configs-user` volume mount (rw)
- [ ] Test container startup
- [ ] Verify mount permissions
- [ ] Test read-only enforcement

### Phase 4: MCP Assistant ✅
- [ ] Create project structure
- [ ] Implement `server.py`
- [ ] Implement `tools.py` (7 tools)
- [ ] Implement `file_ops.py`
- [ ] Implement `validation.py`
- [ ] Write unit tests
- [ ] Create integration tests
- [ ] Write README
- [ ] Create YAML config
- [ ] Create fragment config

### Phase 5: UI Integration ✅
- [ ] Update Guided Setup scanner
- [ ] Add "USER" badge styling
- [ ] Update Control Panel scanner
- [ ] Add badge to server cards
- [ ] Test toggle functionality
- [ ] Update CSS

### Phase 6: E2E Testing ✅
- [ ] Test scenario 1: Install server
- [ ] Test scenario 2: Debug system server
- [ ] Test scenario 3: Update user server
- [ ] Test scenario 4: Delete user server
- [ ] Test scenario 5: List servers
- [ ] Test Docker deployment
- [ ] Test Host deployment
- [ ] Test error handling
- [ ] Load test (50 servers)

### Phase 7: Documentation ✅
- [ ] Update `docs/architecture/mcp/mcp-system.md`
- [ ] Create this document
- [ ] Create user guide
- [ ] Create developer guide
- [ ] Create FAQ
- [ ] Create troubleshooting guide

---

## Appendix C: Troubleshooting Guide

### Issue: MCP Assistant Not Showing Up

**Symptoms**:
- MCP Assistant not in Control Panel
- No MCP Assistant tools available

**Diagnosis**:
```bash
# Check YAML exists
ls mcp-configs/mcp-assistant/

# Check if marked as core
grep "is_core" mcp-configs/mcp-assistant/mcp-assistant.yaml

# Check generated config
jq '.mcpServers["mcp-assistant"]' mcp_config_advanced.json
```

**Solution**:
```bash
# Regenerate config
bash src/scripts/mcp-orc-cli.sh generate-mcp-config

# Restart services
docker-compose restart
```

### Issue: Cannot Create User Server

**Symptoms**:
- Error: "Permission denied"
- Error: "Path not writable"

**Diagnosis**:
```bash
# Check volume mount
docker exec mcpo ls -la /app/mcp-configs-user

# Check ownership
docker exec mcpo id
```

**Solution**:
```bash
# Fix permissions
chmod 755 mcp-configs-user/
chown -R 1000:1000 mcp-configs-user/

# Restart mcpo
docker-compose restart mcpo
```

### Issue: User Server Not Appearing in Config

**Symptoms**:
- Server created but not in generated JSON
- Server not toggleable in UI

**Diagnosis**:
```bash
# Check YAML syntax
cat mcp-configs-user/my-server/my-server.yaml | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)"

# Check fragment syntax
cat mcp-configs-user/my-server/my-server.fragment | jq .

# Check user_installed flag
grep "user_installed" mcp-configs-user/my-server/my-server.yaml
```

**Solution**:
```bash
# Fix YAML/fragment syntax
# Ensure user_installed: true
# Regenerate config
bash src/scripts/mcp-orc-cli.sh generate-mcp-config
```

### Issue: Environment Variables Not Working

**Symptoms**:
- User server starts but can't connect to service
- Error: "Missing API key"

**Diagnosis**:
```bash
# Check fragment has env object
jq '.env' mcp-configs-user/my-server/my-server.fragment

# Check required_env_vars is empty
grep "required_env_vars" mcp-configs-user/my-server/my-server.yaml
```

**Solution**:
- User-installed servers must have env vars in fragment
- Ensure `required_env_vars: []` in YAML
- Add all vars to fragment's `env` object

---

## Conclusion

This implementation plan provides a comprehensive roadmap for adding User-Installed MCP Servers to the Portico system. The MCP Assistant Core Server will empower users to extend the system with any MCP server from the ecosystem through natural conversation, while maintaining security, separation of concerns, and ease of use.

Key achievements:
1. ✅ **Conversational Installation** - No manual config editing required
2. ✅ **Separation of Concerns** - System vs User servers physically separated
3. ✅ **Zero .env Pollution** - Environment variables embedded in fragments
4. ✅ **Full CRUD Control** - Users manage their own servers
5. ✅ **Safe Debugging** - Read-only access to system configs
6. ✅ **Core Service** - Always available, never disabled

Next steps: Begin Phase 1 implementation.
