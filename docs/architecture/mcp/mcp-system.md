# MCP Server Configuration System

## Table of Contents
1. [Overview](#overview)
2. [User Perspective](#user-perspective)
3. [Technical Architecture](#technical-architecture)
4. [Core MCP Servers](#core-mcp-servers)
5. [Configuration Workflow](#configuration-workflow)
6. [File Structure](#file-structure)
7. [System Components](#system-components)

---

## Overview

The MCP (Model Context Protocol) Server Configuration System is a modular framework that allows users to enable, configure, and manage external integrations (MCP servers) within the Portico application. The system provides both a guided setup wizard and a control panel interface for managing these servers.

**Key Features:**
- Declarative YAML-based server definitions
- Automatic discovery of available servers
- Environment variable-based configuration
- Toggle-based enable/disable mechanism
- Support for Docker and Host deployment types
- **Three-tier MCPO architecture** for chat session preservation
- **Core servers** that are always enabled and cannot be disabled
- **User-Installed servers** managed via the MCP Assistant
- **Partial MCP restart** that preserves active chat sessions
- Interactive guided setup wizard
- Conversational server installation and management

**See Also:**
- [User-Installed MCP Servers Implementation Plan](mcp-user-installed.md)

---

## User Perspective

### What are MCP Servers?

MCP servers are external integrations that extend the AI chat system's capabilities by connecting to various services like:

**System-Delivered Servers:**
- **Glean** - Internal knowledge base search
- **Slack** - Message reading and posting
- **Google Workspace** - Gmail, Drive, Calendar integration
- **Atlassian** - Jira and Confluence access
- **GitLab** - Repository management
- **Time** - Timezone and date utilities
- **Chrome DevTools** - Browser automation and inspection

**Core Servers (Always Enabled):**
- **Subagents** - Task delegation to specialized models
- **MCP Assistant** - Conversational installation and management of User-Installed servers

**User-Installed Servers:**
- Any MCP server from the ecosystem installed via conversation with MCP Assistant
- Examples: Filesystem, PostgreSQL, custom APIs, and more

### How Users Interact with MCP Servers

#### 1. Discovery and Configuration
Users encounter MCP servers through:
- **Guided Setup Wizard** - Interactive first-run configuration
- **Control Panel** - The main management interface showing all configured and available servers

#### 2. Configuration Requirements
Each server may require:
- **Environment Variables** - API keys, tokens, instance URLs
- **Approval** - Some servers require managerial approval (e.g., Glean)
- **OAuth Flow** - Interactive authentication (e.g., Google Workspace)

Example environment variables:
```bash
GLEAN_API_TOKEN=your_token_here
GLEAN_INSTANCE=portico
```

Slack is configured through the OAuth flow; do not provide Slack user tokens as
environment variables.

#### 3. Enabling/Disabling Servers
Users can toggle servers on/off through:
- **Toggle Switches** in the Control Panel
- Changes are saved to `mcp_toggles.json`
- Requires service restart to take effect
- **Core servers cannot be disabled** (see Core MCP Servers section)

#### 4. Deployment Types

##### Docker Deployment (Default)
- Servers run inside the Docker container
- Path: `/app/mcp-servers/` or `/app/internal-mcp/`
- Included in `mcp_config_advanced.json`
- Examples: Slack, Glean, Google Workspace, Atlassian, Subagents

##### Host Deployment
- Servers run directly on the host machine
- Used for tools requiring host-level access (browser automation)
- Included in `mcp_config_host_sideload.json`
- Example: Chrome DevTools

**HOST Mode Requirements:**

For HOST-based MCP servers to function, all of the following components must be installed:
- `Node.js` - JavaScript runtime
- `npx` - Node package executor

**HOST Mode Detection:**

The installer automatically detects HOST mode support and creates a `HOST_MODE` file at the project root:
- `HOST_MODE` = `TRUE` - Node.js and npx requirements are met
- `HOST_MODE` = `FALSE` - One or more components missing or failed to install

You can check your installation's HOST mode status:
```bash
cat HOST_MODE
# Output: TRUE (all components working) or FALSE (something missing)
```

If HOST mode is not supported, Docker-based MCP servers will continue to work normally. Only HOST-based servers such as Chrome DevTools will be unavailable.

**Visual Indicators:**
- Docker badge: Blue "DOCKER" label
- Host badge: Purple "HOST" label
- Core badge: Light grey "CORE" label
- Missing Setup badge: Orange "MISSING SETUP" label (shown when HOST dependencies are not installed)

**Guided Setup Behavior for HOST Servers:**

When `HOST_MODE` is `FALSE`, the guided setup wizard will:
1. Display a warning message under "Choose which servers you want to configure."
2. Show HOST servers with a "Missing Setup" badge (orange)
3. Prevent HOST servers from being selected
4. Provide instructions to contact #help-portico on Slack for assistance
5. HOST servers will be greyed out and non-interactive
6. "Select All" button will not select HOST servers

**Control Panel Behavior for HOST Servers:**

When `HOST_MODE` is `FALSE`, the Control Panel will:
1. Display a warning banner below the "Setup Wizard" button
2. Show HOST servers with a "Missing Setup" badge (orange)
3. Disable toggle switches for HOST servers (greyed out, non-interactive)
4. Prevent HOST servers from being enabled
5. Display clear guidance to contact #help-portico on Slack

---

## Core MCP Servers

### What are Core Servers?

Core MCP servers are essential services that:
- **Always remain enabled** regardless of toggle state
- **Cannot be disabled by users**
- **Appear first** in the server list
- Display a distinctive light grey "CORE" badge

### Current Core Servers

- **Subagents** - Internal task delegation system that allows the AI to spawn specialized sub-agents for complex tasks
- **MCP Assistant** - Conversational interface for installing and managing User-Installed MCP servers with full CRUD capabilities

### Why Core Servers?

Some MCP servers provide fundamental capabilities that the system depends on. Marking them as core ensures:
1. Critical functionality remains available
2. Users don't accidentally disable essential features
3. Clear visual distinction from optional integrations

### Visual Identification

#### Control Panel

Core servers are identified by:
- **CORE badge** in light grey next to the server name
- **Disabled toggle switch** (greyed out, non-interactive)
- **First position** in the server list
- **CORE badge in tooltip** when hovering over the MCP badge

#### Guided Setup Wizard

Core servers in the guided setup are identified by:
- **CORE badge** in light grey on the server card
- **First position** in the server grid
- **Always pre-selected** (cannot be deselected)

---

## MCP Server Debugging

### Debug Interface Access

Each enabled MCP server has a built-in debugging interface accessible through the Control Plane:

1. **Access Debug Interface**
   - Navigate to Control Plane tab
   - Find the MCP server in the configuration list
   - Click the bug icon (🐛) button next to the toggle switch
   - A new tab "MCP Debugger ({server_name})" opens with the debug interface

2. **Debug Interface Features**
   - View all available MCP tools provided by the server
   - Interactive API documentation (FastAPI/Swagger UI)
   - Test tool invocations directly
   - View server configuration and metadata

3. **Debug URLs by Server Type**
   - **Core servers**: `http://localhost:8766/{server_id}/docs`
   - **Docker servers**: `http://localhost:8765/{server_id}/docs`
   - **Host servers**: `http://localhost:8890/{server_id}/docs`

### Multiple Debugger Tabs

The system supports multiple debugger tabs open simultaneously:
- Each tab is independent and loads its own server's debug interface
- Tab label shows server name for easy identification
- Close button (×) in tab closes the specific debugger

### Closing Debugger Tabs

To close a debugger tab:
1. Click the × button inside the tab
2. If you're on that tab, you'll automatically switch to Control Plane
3. Multiple debugger tabs can be closed independently

### Port Routing

The debug interface automatically routes to the correct MCPO instance based on server type:

| Server Type | MCPO Instance | Port | Example |
|-------------|---------------|------|---------|
| Core | Core MCPO | 8766 | `http://localhost:8766/mcp-assistant/docs` |
| Docker | Regular MCPO | 8765 | `http://localhost:8765/glean/docs` |
| Host | Host MCPO | 8890 | `http://localhost:8890/chrome-devtools/docs` |

### Troubleshooting Debugger

**Debug interface won't load:**
1. Check that the server is enabled (toggle is ON)
2. Verify the corresponding MCPO service is running:
   - Core: Check `mcpo-core` in Service Status
   - Docker: Check `Docker MCPO` in Service Status
   - Host: Check `Host MCPO` in Service Status
3. Try accessing the URL directly in your browser
4. Check service logs for errors

**Button not appearing:**
- Debug buttons only appear for enabled MCP servers
- Disabled servers do not show the debug button

---

## User-Installed MCP Servers

### Overview

User-Installed MCP Servers represent a new category of MCP servers that users can install and manage through conversational interaction with the **MCP Assistant** Core Server. This capability enables users to extend the system with any MCP server from the ecosystem without requiring manual configuration or technical expertise.

### Key Differences from System-Delivered Servers

| Aspect | System-Delivered | User-Installed |
|--------|------------------|----------------|
| **Location** | `mcp-configs/` | `mcp-configs-user/` |
| **Managed By** | System administrators | End users via MCP Assistant |
| **Environment Variables** | Stored in `.env` file | Embedded in fragment file |
| **Setup Documentation** | `.md` file for guided wizard | No `.md` file needed |
| **Access via MCP Assistant** | Read-only (debugging) | Full CRUD |
| **YAML Flag** | `user_installed: false` | `user_installed: true` |
| **Toggleable** | Yes (except Core) | Yes |

### MCP Assistant Core Server

The MCP Assistant is a Core MCP Server that provides tools for managing User-Installed servers:

**Available Tools:** 8 tools
1. `list_mcp_servers` - List all/system/user servers
2. `get_system_mcp_config` - Read system server config (debugging)
3. `create_user_mcp_server` - Create new user-installed server
4. `read_user_mcp_server` - Read user server config
5. `update_user_mcp_server` - Update user server config
6. `delete_user_mcp_server` - Delete user server
7. `validate_mcp_fragment` - Validate fragment JSON
8. **`restart_mcp_infrastructure`** - Automatically restart MCP services to load new servers

**Docker vs Host Deployment Guidance:**

The MCP Assistant provides clear guidance to the LLM:
- **Docker**: Use for servers connecting to external APIs/services (PostgreSQL over network, Slack, REST APIs)
- **Host**: REQUIRED for servers needing host-level access (filesystem operations, browser automation, local tools)

**Example Usage (with Auto-Restart):**
```
User: "Install the filesystem MCP server"
AI: [Recognizes filesystem access requires HOST deployment]
AI: "I'll install the filesystem server as a HOST server."
AI: [Uses create_user_mcp_server to create server]
AI: "Server created! Now restarting MCP infrastructure..."
AI: [Uses restart_mcp_infrastructure - waits ~1 minute]
AI: "✅ Filesystem server is active and ready to use!"
```

**Important - Three-Tier MCPO Architecture**:

The system uses three separate MCPO instances for optimal performance:

1. **Core MCPO** (port 8766) - Core servers (MCP Assistant, Subagents)
   - Config: `mcp_config_core.json`
   - **Never restarts** during MCP infrastructure reload
   - Preserves active chat sessions

2. **Regular MCPO** (port 8765) - Regular + user servers
   - Config: `mcp_config_advanced.json`
   - Restarts when new servers installed
   - <1 minute restart time

3. **Host MCPO** (port 8890) - Host servers
   - Config: `mcp_config_host_sideload.json`
   - Restarts when new servers installed

### Environment Variable Strategy

**CRITICAL DIFFERENCE:** User-installed servers embed environment variables directly in the fragment file to avoid polluting the shared `.env` file.

**System-Delivered Example:**
```yaml
# YAML defines required vars
required_env_vars:
  - name: GLEAN_API_TOKEN
    description: "API Token"
```
```json
// Fragment references them (injected from .env)
{
  "command": "npx",
  "args": ["-y", "@gleanwork/mcp-server@latest"]
}
```

**User-Installed Example:**
```yaml
# YAML has no required vars
required_env_vars: []
```
```json
// Fragment includes inline env vars
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem"],
  "env": {
    "FILESYSTEM_ROOT": "/home/user/documents",
    "FILESYSTEM_READONLY": "false"
  }
}
```

### Visual Indicators

**Guided Setup Wizard:**
- User-installed servers show "USER" badge (teal/cyan)
- Always appear after system-delivered servers

**Control Panel:**
- User-installed servers show "USER" badge
- Manageable via MCP Assistant tools

### Security Considerations

- **Path Validation:** Server IDs validated to prevent traversal attacks
- **Resource Limits:** Maximum 50 user-installed servers
- **File Size Limits:** 1MB icon, 10KB YAML/fragment
- **Read-Only System Configs:** MCP Assistant cannot modify system-delivered servers
- **Command Validation:** Fragment commands inspected for dangerous characters

### Complete Documentation

For comprehensive implementation details, see [User-Installed MCP Servers Implementation Plan](mcp-user-installed.md).

---

## Technical Architecture

### Core Concepts

#### 1. Configuration State
The system maintains three sources of truth:
- **YAML files** (`mcp-configs/*/\*.yaml`) - Server metadata and requirements
- **Environment file** (`.env`) - API keys and configuration values
- **Toggle state** (`mcp_toggles.json`) - Enabled/disabled state per server

#### 2. Configuration Flow

```
YAML Definitions → Environment Check → Toggle Check → Fragment Assembly → JSON Generation
     ↓                    ↓                  ↓               ↓                  ↓
Server metadata    Is configured?    Is enabled?      JSON fragment      Final config
```

#### 3. File Organization

```
├── mcp-configs/                    # System-delivered server definitions
│   ├── glean/
│   │   ├── glean.yaml             # Server metadata (user_installed: false)
│   │   ├── glean.fragment         # JSON configuration fragment
│   │   ├── glean.md               # Setup instructions
│   │   └── glean.png              # Icon (optional)
│   ├── run-sub-agent/
│   │   ├── run-sub-agent.yaml     # Core server with is_core: true
│   │   ├── run-sub-agent.fragment
│   │   └── run-sub-agent.md
│   ├── mcp-assistant/              # NEW: MCP Assistant core server
│   │   ├── mcp-assistant.yaml     # is_core: true, user_installed: false
│   │   ├── mcp-assistant.fragment
│   │   └── mcp-assistant.md
│   └── ...
│
├── mcp-configs-user/               # NEW: User-installed servers
│   ├── filesystem-server/
│   │   ├── filesystem-server.yaml # user_installed: true
│   │   ├── filesystem-server.fragment  # Contains inline env vars
│   │   └── filesystem-server.png  # Optional icon (no .md file)
│   └── ...
│
├── .env                            # Environment variables (system servers only)
├── mcp_toggles.json               # Enable/disable state (both types)
├── mcp_config_advanced.json       # Generated Docker config (both types)
├── mcp_config_host_sideload.json  # Generated Host config (both types)
└── src/scripts/mcp-orc-cli.sh generate-mcp-config # Enhanced configuration generator
```

---

## Configuration Workflow

### Step 1: Server Discovery

The system scans `mcp-configs/` for subdirectories containing YAML files.

**Discovery Logic** (`electron-app/src/services/main.js`):
```javascript
// Read all subdirectories in mcp-configs
for (const dirent of subdirs) {
  if (dirent.isDirectory()) {
    const serverDir = dirent.name;
    const yamlPath = path.join(mcpConfigsPath, serverDir, `${serverDir}.yaml`);

    // Read YAML to get metadata
    const serverData = parseYaml(yamlContent);

    // Check if configured
    const isConfigured = checkServerConfigured(serverData, configData.env);

    // Check if core
    const isCore = serverData.is_core === true;

    servers.push({
      id: serverData.id,
      name: serverData.display_name,
      deploymentType: serverData.deployment_type || 'docker',
      isCore: isCore,
      isConfigured: isConfigured,
      // ... other properties
    });
  }
}
```

### Step 2: Configuration Validation

**Environment Variable Check** (`src/scripts/mcp-orc-cli.sh generate-mcp-config:93-118`):
```bash
is_server_configured() {
    local server_dir="$1"
    local yaml_file="${MCP_CONFIGS_DIR}/${server_dir}/${server_dir}.yaml"

    # Extract required environment variables from YAML
    local required_vars=$(grep -A 50 "required_env_vars:" "$yaml_file" |
                         grep "name:" |
                         sed 's/.*name: *//')

    # If no required variables, server is configured
    if [ -z "$required_vars" ]; then
        return 0
    fi

    # Check each required variable
    for var in $required_vars; do
        if ! is_env_configured "$var"; then
            return 1
        fi
    done

    return 0
}
```

### Step 3: Core Server Check

**Core Check** (`src/scripts/mcp-orc-cli.sh generate-mcp-config:45-57`):
```bash
is_server_core() {
    local yaml_file="$1"

    # Extract is_core from YAML, default to false
    local is_core=$(grep "^is_core:" "$yaml_file" 2>/dev/null | sed 's/.*: *//' | tr -d '"' | tr -d "'")

    if [ "$is_core" = "true" ]; then
        return 0  # Server is core
    fi

    return 1  # Server is not core
}
```

### Step 4: Toggle State Check

**Toggle Check** (`src/scripts/mcp-orc-cli.sh generate-mcp-config:60-83`):
```bash
is_server_enabled() {
    local server_id="$1"
    local yaml_file="${MCP_CONFIGS_DIR}/${server_id}/${server_id}.yaml"

    # Core servers are ALWAYS enabled, regardless of toggle state
    if [ -f "$yaml_file" ] && is_server_core "$yaml_file"; then
        return 0
    fi

    local toggles_file="${PROJECT_ROOT}/mcp_toggles.json"

    # If toggles file doesn't exist, assume all servers are enabled
    if [ ! -f "$toggles_file" ]; then
        return 0
    fi

    # Check if server is explicitly disabled (false) in toggles
    if jq -e ".\"$server_id\" == false" "$toggles_file" >/dev/null 2>&1; then
        return 1  # Server is disabled
    fi

    return 0  # Server is enabled or not specified (default to enabled)
}
```

### Step 5: JSON Generation

The `mcp-orc-cli generate-mcp-config` script builds **three output files** based on core status and deployment type:

**Core Configuration** (`mcp_config_core.json`) - NEW!:
```json
{
  "mcpServers": {
    "mcp-assistant": {
      "command": "uv",
      "args": ["run", "--directory", "/app/internal-mcp/mcp-assistant", "mcp-assistant-server"]
    },
    "run-sub-agent": {
      "command": "uv",
      "args": ["run", "--directory", "/app/internal-mcp/run-sub-agent", "run-sub-agent-server"]
    }
  }
}
```

**Docker Configuration** (`mcp_config_advanced.json`):
```json
{
  "mcpServers": {
    "run-sub-agent": {
      "command": "uv",
      "args": ["run", "--directory", "/app/internal-mcp/run-sub-agent", "run-sub-agent-server"]
    },
    "glean": {
      "command": "npx",
      "args": ["-y", "@gleanwork/mcp-server@latest"]
    }
  }
}
```

**Host Configuration** (`mcp_config_host_sideload.json`):
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "__portico_managed_node_package__",
      "args": []
    }
  }
}
```

---

## File Structure

### YAML Configuration File

**Location:** `mcp-configs/{server-id}/{server-id}.yaml`

**Structure:**
```yaml
name: "Human-readable Server Name"
id: "server-id"                      # Must match directory name
display_name: "Display Name"         # Shown in UI (can include emoji)
deployment_type: "docker"            # "docker" or "host"
experimental: false                  # Show only with --experimental flag
is_core: false                       # Mark as core server (always enabled)
user_installed: false                # NEW: true for user-installed, false for system-delivered
description: "Brief description"
use_cases:
  - "Use case 1"
  - "Use case 2"

required_env_vars:                   # For system-delivered servers (from .env)
  - name: SERVER_API_TOKEN           # For user-installed: must be empty []
    placeholder: "your_api_token"
    description: "API Token"
    sensitive: true                  # Mask in UI
    default: ""                      # Optional default value

tool_call_timeout: 60                # Optional tool call timeout (seconds)
retryable_tools:                     # Optional; empty/absent means no tool retries
  - originalReadToolName             # Case-sensitive original MCP name, before renaming
tool_rename_mapping:                 # Optional tool renames (original -> display)
  OriginalToolName: "Human Readable Tool Name"
```

`retryable_tools` is a conservative opt-in policy owned by MCP ORC. An
allowlisted tool receives at most one retry for configured timeouts, closed or
reset connections, broken pipes, and HTTP 408/502/503/504 responses. The v1
backoff uses full jitter from 500–2000 ms. Authorization, permission, input,
cancellation, 409, 422, and 429 failures are never retried. Unknown names are
reported in server status and remain non-retryable; empty or duplicate YAML
entries fail configuration generation.

Three distinct consecutive timeout/transport failures in a rolling five-minute
window open the server circuit. New calls fail with HTTP 503 while active calls
drain, after which ORC reconnects and re-lists tools. A targeted container
restart is requested through the operation coordinator only if that reconnect
fails for a non-authorization reason. Automatic restart requests use a stable
per-server request ID, so the coordinator's 15-minute retention window prevents
restart cascades while manual restarts remain independent.

**Example System-Delivered Core Server** (`mcp-configs/run-sub-agent/run-sub-agent.yaml`):
```yaml
name: "Subagents MCP Server"
id: "run-sub-agent"
display_name: "Subagents"
deployment_type: "docker"
experimental: false
is_core: true                        # Marks this as a core server
user_installed: false                # System-delivered server
description: "Invoke subagents for task delegation, verification, and hierarchical workflows"
use_cases:
  - "Delegate specialized tasks to domain-specific models"
  - "Parallel processing with multiple models"

required_env_vars: []                # No configuration needed
```

**Example User-Installed Server** (`mcp-configs-user/filesystem-server/filesystem-server.yaml`):
```yaml
name: "Filesystem MCP Server"
id: "filesystem-server"
display_name: "Filesystem"
deployment_type: "host"              # MUST be "host" for filesystem access
experimental: false
is_core: false
user_installed: true                 # User-installed server
description: "Provides read/write access to local filesystem"
use_cases:
  - "Reading files from disk"
  - "Writing files to disk"
  - "Searching file contents"

required_env_vars: []                # Empty - env vars embedded in fragment
```

### Fragment File

**Location:** `mcp-configs/{server-id}/{server-id}.fragment`

**Purpose:** JSON snippet inserted into final configuration

**Docker Example** (`mcp-configs/run-sub-agent/run-sub-agent.fragment`):
```json
{
  "command": "uv",
  "args": [
    "run",
    "--directory",
    "/app/internal-mcp/run-sub-agent",
    "run-sub-agent-server"
  ]
}
```

**Host Example - System-Delivered** (`mcp-configs/chrome-devtools/chrome-devtools.fragment`):
```json
{
  "command": "__portico_managed_node_package__",
  "args": [],
  "managed_node_package": {
    "schema_version": 1,
    "server_id": "chrome-devtools",
    "package_manager": "npm",
    "requested_spec": "chrome-devtools-mcp@1.7.0",
    "package_name": "chrome-devtools-mcp",
    "requested_range": "1.7.0",
    "runtime_args": ["--autoConnect"],
    "bin": "chrome-devtools-mcp"
  }
}
```

**User-Installed Example - Host Server** (`mcp-configs-user/filesystem-server/filesystem-server.fragment`):
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

**Important Notes:**
1. User-installed fragments MUST include all environment variables inline because they cannot use the `.env` file
2. Filesystem servers MUST use `deployment_type: "host"` and `command: "uvx"` (not "npx")
3. Host servers require direct access to the host machine and run outside Docker containers

### Toggle State File

**Location:** `mcp_toggles.json`

**Structure:**
```json
{
  "mcp-atlassian": true,
  "gitlab-mcp": false,
  "glean": true,
  "google_workspace": true,
  "slack": true,
  "time": true,
  "run-sub-agent": false,
  "chrome-devtools": true
}
```

**Behavior:**
- `true` or missing = Enabled
- `false` = Disabled
- **Core servers ignore toggle state** and are always enabled
- Modified by Electron UI toggle switches
- Read by `mcp-orc-cli generate-mcp-config` during config generation

---

## System Components

### 1. Configuration Generator Script

**File:** `src/scripts/mcp-orc-cli.sh generate-mcp-config`

**Responsibilities:**
- Scan `mcp-configs/` directory
- Validate environment variables
- Check toggle state (except for core servers)
- Route servers to Docker or Host configs
- Generate JSON configuration files
- Validate JSON syntax

**Key Functions:**
```bash
is_env_configured()      # Check if env var is set and valid
is_server_core()         # Check if server has is_core: true
is_server_enabled()      # Check toggle state (core servers always return true)
is_server_configured()   # Validate required env vars
get_deployment_type()    # Extract deployment_type from YAML
process_fragment()       # Read and validate fragment JSON
```

**Output Files:** 3 files (NEW!)
- `mcp_config_core.json` - Core Docker servers (never restart)
- `mcp_config_advanced.json` - Regular Docker servers + user servers
- `mcp_config_host_sideload.json` - Host servers

**Core Server Output:**
```bash
# When processing a core server:
echo -e "${GREEN}  ✓ $server_name is CORE (always enabled, ${deployment_type})${NC}"
```

### 2. Electron UI Manager (Control Panel)

**File:** `electron-app/src/services/renderer.js`

**Responsibilities:**
- Display server list with configuration status
- Render toggle switches (disabled for core servers and unsupported HOST servers)
- Render debug buttons for enabled MCP servers
- Show deployment type badges
- Show CORE badge for core servers
- Show Missing Setup badge for unsupported HOST servers
- HOST_MODE detection and warning display
- Handle toggle state changes
- Manage MCP debugger tab creation and removal
- Route debug interfaces to correct MCPO port (8766/8765/8890)
- Sort servers (core servers first)
- Prompt for service restart after changes

**HOST Mode Detection** (lines 360-377):
```javascript
async function checkHostModeSupport() {
  try {
    const response = await fetch('/HOST_MODE');
    if (response.ok) {
      const content = await response.text();
      state.hostModeSupported = content.trim() === 'TRUE';
      console.log('HOST_MODE supported:', state.hostModeSupported);
    } else {
      state.hostModeSupported = false;
    }
  } catch (error) {
    console.log('HOST_MODE file not accessible, assuming not supported');
    state.hostModeSupported = false;
  }
}
```

**HOST Warning Banner** (lines 949-973):
```javascript
const hasHostServers = configuredServers.some(s => (s.deploymentType || 'docker') === 'host');
if (!state.hostModeSupported && hasHostServers) {
  const warningDiv = document.createElement('div');
  warningDiv.id = 'host-warning-control-panel';
  warningDiv.className = 'host-warning-control-panel';
  warningDiv.innerHTML = `
    <div class="host-warning-icon">⚠️</div>
    <div class="host-warning-content">
      <strong>Host MCP Server Setup Required:</strong> The necessary dependencies needed to run
      <span class="deployment-badge deployment-badge-host">Host</span> MCP servers are not installed.
      These servers will be unavailable. For help, please ask in
      <span class="slack-channel-inline">#help-portico</span> on Slack.
    </div>
  `;
  mcpPanel.parentNode.insertBefore(warningDiv, list);
}
```

**HOST Server Rendering** (lines 977-1008):
```javascript
const deploymentType = server.deploymentType || 'docker';
const isHostServer = deploymentType === 'host';
const isHostDisabled = isHostServer && !state.hostModeSupported;
const isEnabled = server.isCore || (isHostDisabled ? false : state.toggles[server.id] !== false);

// Add Missing Setup badge for disabled HOST servers
const missingSetupBadge = isHostDisabled
  ? '<span class="deployment-badge deployment-badge-missing" title="HOST mode dependencies not installed">Missing Setup</span>'
  : '';
```

**Disabled Toggle for HOST Servers** (lines 1021-1027):
```javascript
<label class="toggle-switch ${server.isCore || isHostDisabled ? 'toggle-disabled' : ''}">
  <input type="checkbox"
         class="mcp-toggle-checkbox"
         data-server-id="${server.id}"
         ${isEnabled ? 'checked' : ''}
         ${server.isCore || isHostDisabled ? 'disabled' : ''}>
  <span class="toggle-slider ${server.isCore || isHostDisabled ? 'toggle-slider-disabled' : ''}"></span>
</label>
```

**Toggle Safety Check** (lines 380-407):
```javascript
function toggleMcpServer(serverId, enabled) {
  const server = state.servers.find(s => s.id === serverId);

  if (server && server.isCore) {
    return;
  }

  // Check if it's a HOST server when HOST_MODE is not supported
  const deploymentType = server?.deploymentType || 'docker';
  const isHostServer = deploymentType === 'host';
  const isHostDisabled = isHostServer && !state.hostModeSupported;

  if (isHostDisabled) {
    return;  // Cannot toggle HOST servers when HOST_MODE is not supported
  }

  state.toggles[serverId] = enabled;
  state.togglesModified = true;
  showSaveButton();
  // ...
}
```

### 3. Guided Setup Wizard

**File:** `electron-app/src/guided-setup.html`

**Responsibilities:**
- Interactive server selection during first-run setup
- HOST_MODE detection and warning display
- Core server visual identification
- Prevent selection of unsupported HOST servers
- Sort servers (core first, then alphabetically)
- Display appropriate badges (CORE, HOST, Missing Setup)

**HOST Mode Detection** (lines 1774-1783):
```javascript
// Check HOST_MODE support
try {
  const hostModePath = path.join(PROJECT_ROOT, 'HOST_MODE');
  const hostModeContent = await fs.readFile(hostModePath, 'utf-8');
  setupState.hostModeSupported = hostModeContent.trim() === 'TRUE';
  console.log('HOST_MODE supported:', setupState.hostModeSupported);
} catch (err) {
  console.log('HOST_MODE file not found, assuming not supported');
  setupState.hostModeSupported = false;
}
```

**Server Sorting** (lines 1743-1755):
```javascript
// Sort servers: core first, then non-experimental, then by name
setupState.mcpServers.sort((a, b) => {
  // Core servers always first
  if (a.isCore && !b.isCore) return -1;
  if (!a.isCore && b.isCore) return 1;

  // Then non-experimental before experimental
  if (a.experimental !== b.experimental) {
    return a.experimental ? 1 : -1;
  }

  // Finally sort alphabetically
  return a.name.localeCompare(b.name);
});
```

**HOST Server Handling** (lines 1950-1956):
```javascript
const deploymentType = server.deploymentType || 'docker';
const isHostServer = deploymentType === 'host';
const isHostDisabled = isHostServer && !setupState.hostModeSupported;

// Mark as host-disabled if needed
if (isHostDisabled) {
  card.classList.add('host-disabled');
}
```

**Badge Rendering** (lines 2018-2024):
```javascript
${server.isCore ? '<span class="server-badge deployment-core">CORE</span>' : ''}
<span class="server-badge ${deploymentBadgeClass}">${deploymentBadgeText}</span>
${server.experimental ? '<span class="server-badge experimental">Experimental</span>' : ''}
${isHostDisabled ? '<span class="server-badge missing-setup">Missing Setup</span>' : ''}
${!hasRequiredVars && !isHostDisabled ? '<span class="server-badge">No Config Needed</span>' : ''}
${isConfigured && hasRequiredVars && !isHostDisabled ? '<span class="server-badge configured">Configured</span>' : ''}
```

**Warning Message** (lines 1915-1928):
```javascript
if (!setupState.hostModeSupported) {
  const warningDiv = document.createElement('div');
  warningDiv.className = 'host-warning';
  warningDiv.innerHTML = `
    <div class="host-warning-icon">⚠️</div>
    <div class="host-warning-content">
      <strong>Host MCP Server Setup Required:</strong> The necessary dependencies needed to run
      <span class="server-badge deployment-host">Host</span> MCP servers are not installed.
      These servers will be unavailable. For help, please ask in
      <a href="#" class="slack-channel">#help-portico</a> on Slack.
    </div>
  `;
  subtitleElement.parentNode.insertBefore(warningDiv, subtitleElement.nextSibling);
}
```

**Core Server Display Logic** (lines 888-900):
```javascript
// Sort configured servers: core first, then alphabetically
configuredServers.sort((a, b) => {
  if (a.isCore && !b.isCore) return -1;
  if (!a.isCore && b.isCore) return 1;
  return (a.display_name || a.name).localeCompare(b.display_name || b.name);
});

// Determine if enabled (core servers always enabled)
const isEnabled = server.isCore || state.toggles[server.id] !== false;
```

**Core Badge Rendering** (lines 919-921):
```javascript
const coreBadge = server.isCore
  ? '<span class="deployment-badge deployment-badge-core" title="Core server - always enabled">CORE</span>'
  : '';
```

**Disabled Toggle for Core Servers** (lines 933-939):
```javascript
<label class="toggle-switch ${server.isCore ? 'toggle-disabled' : ''}">
  <input type="checkbox"
         class="mcp-toggle-checkbox"
         data-server-id="${server.id}"
         ${isEnabled ? 'checked' : ''}
         ${server.isCore ? 'disabled' : ''}>
  <span class="toggle-slider ${server.isCore ? 'toggle-slider-disabled' : ''}"></span>
</label>
```

**Toggle Safety Check** (lines 344-350):
```javascript
function toggleMcpServer(serverId, enabled) {
  // Find the server to check if it's core
  const server = state.servers.find(s => s.id === serverId);
  if (server && server.isCore) {
    // Should never happen due to disabled attribute, but safety check
    return;
  }
  // ... rest of function
}
```

### 4. MCP Badge

**Location:** Header of Control Panel

**Features:**
- Shows count of enabled servers (including core servers)
- Hover tooltip displays server list with CORE badges
- Updates dynamically when toggles change

**Update Logic** (lines 1004-1046):
```javascript
function updateMcpBadge(configuredServers) {
  const badgeCount = document.querySelector('.mcp-badge-count');
  const tooltipContent = document.getElementById('mcp-tooltip-content');

  if (badgeCount) {
    badgeCount.textContent = configuredServers.length;
  }

  if (tooltipContent) {
    tooltipContent.innerHTML = configuredServers.map(server => {
      const coreBadge = server.isCore ? '<span class="tooltip-core-badge">CORE</span>' : '';
      return `
        <div class="tooltip-server">
          <span class="tooltip-server-name">${server.name}</span>
          ${coreBadge}
        </div>
      `;
    }).join('');
  }
}
```

**Badge Count Always Includes Core** (lines 880, 993):
```javascript
// Early return case
const enabledServers = configuredServers.filter(s => s.isCore || state.toggles[s.id] !== false);

// Normal case
const enabledServers = configuredServers.filter(s => s.isCore || state.toggles[s.id] !== false);
```

### 5. CSS Styling

**File:** `electron-app/src/styles.css` (Control Panel)

**File:** `electron-app/src/guided-setup.html` (Guided Setup)

**Core Badge Styles** (lines 922-927):
```css
/* Core badge - light grey */
.deployment-badge-core {
  background: rgba(148, 163, 184, 0.15);
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.3);
}
```

**Disabled Toggle Styles** (lines 975-988):
```css
/* Disabled toggle switch for core servers */
.toggle-switch.toggle-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-switch.toggle-disabled .toggle-slider {
  cursor: not-allowed;
}

.toggle-slider-disabled {
  cursor: not-allowed !important;
  opacity: 0.7;
}
```

**Tooltip Core Badge** (lines 237-250):
```css
/* Core badge in tooltip */
.tooltip-core-badge {
  display: inline-block;
  padding: 0.125rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  margin-left: 0.5rem;
  background: rgba(148, 163, 184, 0.2);
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.4);
}
```

**Guided Setup Core Badge** (guided-setup.html lines 323-330):
```css
.server-badge.deployment-core {
  background: rgba(148, 163, 184, 0.15);
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.3);
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.025em;
}
```

**Missing Setup Badge - Guided Setup** (guided-setup.html lines 332-339):
```css
.server-badge.missing-setup {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.025em;
}
```

**Missing Setup Badge - Control Panel** (styles.css lines 945-949):
```css
.deployment-badge-missing {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}
```

**HOST Warning Styles - Guided Setup** (guided-setup.html lines 1354-1408):
```css
.host-warning {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  padding: 12px 16px;
  margin: 10px 0 20px 0;
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.server-card.host-disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.server-card.host-disabled:hover {
  transform: none;
  box-shadow: none;
  border-color: #414868;
  background: #1a1b26;
}
```

**HOST Warning Styles - Control Panel** (styles.css lines 1022-1059):
```css
.host-warning-control-panel {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.host-warning-icon {
  font-size: 1.25rem;
  flex-shrink: 0;
  margin-top: -2px;
}

.slack-channel-inline {
  color: #7aa2f7;
  font-weight: 600;
  background: rgba(122, 162, 247, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.75rem;
}
```

---

## Key Relationships

### Configured vs Enabled vs Core

| State | Description | Can Toggle? | Included in Config? |
|-------|-------------|-------------|---------------------|
| **Configured & Core** | Has env vars set + is_core: true | No (always on) | Always |
| **Configured & Enabled** | Has env vars set + toggle: true | Yes | Yes |
| **Configured & Disabled** | Has env vars set + toggle: false | Yes | No |
| **Not Configured** | Missing env vars (system-delivered only) | N/A | No |
| **User-Installed** | user_installed: true (env in fragment) | Yes | If enabled |
| **HOST & Unsupported** | deployment_type: host + HOST_MODE: FALSE | No (disabled UI) | No |

### Server Type Matrix

| Aspect | System-Delivered | User-Installed |
|--------|------------------|----------------|
| **Location** | `mcp-configs/` | `mcp-configs-user/` |
| **Env Vars** | From `.env` file | Embedded in fragment |
| **Setup Docs** | `.md` file included | No `.md` file |
| **MCP Assistant** | Read-only access | Full CRUD |
| **YAML Flag** | `user_installed: false` | `user_installed: true` |
| **Badge Color** | - | Teal/Cyan |
| **Can be Core?** | Yes | No |

### Docker vs Host Deployment

| Aspect | Docker | Host |
|--------|--------|------|
| **Location** | Inside container | On host machine |
| **Config File** | `mcp_config_advanced.json` | `mcp_config_host_sideload.json` |
| **Path** | `/app/mcp-servers/` | Host filesystem |
| **Use Case** | Most servers | Tools needing host access |
| **Examples** | Subagents, Slack, Glean | Chrome DevTools |
| **Badge Color** | Blue | Purple |
| **Can be Core?** | Yes | Yes |
| **Can be User-Installed?** | Yes | Yes |

### Configuration Generation Flow

```
User Action (Toggle Switch)
         ↓
Save to mcp_toggles.json
         ↓
User Restarts Services
         ↓
mcp-orc-cli generate-mcp-config runs
         ↓
├─→ Reads YAML files
├─→ Checks is_core flag
├─→ Checks .env for required vars
├─→ Checks mcp_toggles.json (except core servers)
├─→ Reads fragment files
└─→ Generates JSON configs
         ↓
Docker Compose starts with new config
         ↓
MCP servers available in chat
```

---

## Adding a New MCP Server

### Standard Server

1. Create directory: `mcp-configs/my-server/`
2. Create YAML: `my-server.yaml` with metadata
3. Create fragment: `my-server.fragment` with MCP config
4. Create docs: `my-server.md` with setup instructions
5. Optional: Add icon `my-server.png`
6. Add environment variables to `.env` if needed
7. Run `bash src/scripts/mcp-orc-cli.sh generate-mcp-config`
8. Restart services

### Core Server

Follow the same steps as above, but add to the YAML:
```yaml
is_core: true
```

This will:
- Make the server always enabled
- Disable the toggle switch in the UI
- Display the CORE badge
- Sort the server first in the list
- Include it in configs regardless of `mcp_toggles.json`

---

## System Behavior Summary

### When HOST_MODE = TRUE (All Dependencies Installed)
- **Guided Setup**: HOST servers can be selected and configured normally
- **Control Panel**: HOST servers can be toggled on/off normally
- **Config Generator**: HOST servers included in `mcp_config_host_sideload.json`
- **Loading Screen**: "Starting host MCP proxy" task runs normally
- **Health Check**: Attempts to discover tools from both Docker and HOST MCP servers

### When HOST_MODE = FALSE (Dependencies Missing)
- **Guided Setup**:
  - Warning banner displayed
  - HOST servers show "Missing Setup" badge
  - HOST servers cannot be selected
  - "Select All" skips HOST servers
- **Control Panel**:
  - Warning banner displayed below "Setup Wizard" button
  - HOST servers show "Missing Setup" badge
  - Toggle switches disabled for HOST servers
  - Cannot enable/disable HOST servers
- **Config Generator**:
  - Skips HOST servers entirely
  - Generates empty `mcp_config_host_sideload.json`: `{"mcpServers": {}}`
  - Logs: "⏭ {server} is a HOST server but HOST_MODE is not supported - skipping"
- **Loading Screen**:
  - "Starting host MCP proxy" task skipped (orange icon ⏭)
  - Logs: "⏭️ Skipping host MCP proxy (HOST mode not supported)"
- **Health Check**:
  - Only attempts to discover tools from Docker MCP server (mcpo:8000)
  - Skips host.docker.internal:8890 entirely
  - Logs: "⏭️ HOST_MODE is not supported - skipping host MCP server discovery"

---

## Troubleshooting

### Server Not Appearing

1. Check directory structure matches: `mcp-configs/server-id/server-id.yaml`
2. Verify YAML syntax is valid
3. Check console logs in Electron DevTools
4. Ensure `id` in YAML matches directory name

### HOST Server Showing "Missing Setup" Badge

This indicates that your installation does not have the required HOST mode dependencies:

**Symptoms in Guided Setup:**
- HOST servers appear greyed out with "Missing Setup" badge
- Cannot select HOST servers in guided setup
- Warning message appears: "Host MCP Server Setup Required"

**Symptoms in Control Panel:**
- HOST servers show "Missing Setup" badge (orange)
- Toggle switches for HOST servers are disabled (greyed out)
- Warning banner appears below "Setup Wizard" button
- Cannot enable/disable HOST servers

**Solution:**
1. Contact #help-portico on Slack for assistance
2. Or manually install dependencies and re-run installer (see HOST-Based Server Not Working section)

### Server Disabled Despite Toggle On

1. Check `mcp_toggles.json` - should be `true` or missing
2. Verify required environment variables are set in `.env`
3. Run `bash src/scripts/mcp-orc-cli.sh generate-mcp-config` manually
4. Check output for error messages
5. Restart services after changes

### Core Server Not Working

1. Verify `is_core: true` in YAML file
2. Check that fragment file exists and is valid JSON
3. Run config generator and look for "CORE (always enabled)" message
4. Verify server appears in generated config file
5. Check Docker/Host logs for runtime errors

### HOST-Based Server Not Working

1. Check `HOST_MODE` file in project root - should contain `TRUE`
2. If `HOST_MODE` is `FALSE`, install missing components:
   ```bash
   # Install Node.js (macOS)
   brew install node
   ```
3. Re-run the installer to update HOST_MODE status:
   ```bash
   bash install_v2.sh --skip-deps --no-launch
   ```
4. Verify all components are available:
   ```bash
   which node && which npx
   cat HOST_MODE  # Should show TRUE if everything succeeded
   ```
5. Check `mcp_config_host_sideload.json` for server configuration
6. Restart services after fixing HOST mode support

---

## File Paths Reference

```
├── .env                                    # Environment variables (system servers only)
├── mcp_toggles.json                        # Toggle state (both types)
├── mcp_config_core.json                   # NEW: Core servers (never restart)
├── mcp_config_advanced.json               # Generated Docker config (regular + user)
├── mcp_config_host_sideload.json          # Generated Host config
├── HOST_MODE                               # HOST mode support indicator (TRUE/FALSE)
│
├── mcp-configs/                            # System-delivered server definitions
│   ├── {server-id}/
│   │   ├── {server-id}.yaml               # Metadata (user_installed: false)
│   │   ├── {server-id}.fragment           # JSON snippet
│   │   ├── {server-id}.md                 # Setup instructions
│   │   ├── {server-id}.png                # Icon (optional)
│   │   └── {server-id}-binary             # Binary (optional)
│
├── mcp-configs-user/                       # NEW: User-installed servers
│   ├── {server-id}/
│   │   ├── {server-id}.yaml               # Metadata (user_installed: true)
│   │   ├── {server-id}.fragment           # JSON with inline env vars
│   │   └── {server-id}.png                # Icon (optional, no .md file)
│
├── src/core-mcp-rust/                           # NEW: Internal MCP implementations
│   ├── run-sub-agent/                     # Subagent server
│   └── mcp-assistant/                      # MCP Assistant server
│       ├── src/
│       │   └── mcp_assistant_server/
│       │       ├── server.py              # Main MCP server
│       │       ├── tools.py               # Tool definitions
│       │       ├── file_ops.py            # File operations
│       │       └── validation.py          # YAML/JSON validation
│       ├── pyproject.toml
│       └── README.md
│
├── src/scripts/
│   └── mcp-orc-cli generate-mcp-config            # Enhanced config generator
│
├── docs/architecture/mcp/
│   ├── mcp-system.md                      # This documentation
│   └── mcp-user-installed.md              # User-Installed implementation plan
│
└── electron-app/
    ├── scripts/                            # Build/update helpers
    └── src/
        ├── services/
        │   ├── main.js                     # Electron main process
        │   ├── preload.js                  # IPC bridge
        │   ├── renderer.js                 # UI logic
        │   └── manager.js                  # Service management
        ├── guided-setup.html               # Setup wizard UI
        ├── index.html                      # Control panel UI
        └── styles.css                      # Styling (with badges)
```

---

## Critical Architecture: Three-Tier MCPO System

### Overview

The Portico system uses a **three-tier MCPO architecture** to enable seamless MCP server management while preserving active chat sessions.

### MCPO Instances

#### 1. Core MCPO (Port 8766)
- **Purpose**: Run Core MCP servers that must never restart
- **Config**: `mcp_config_core.json`
- **Servers**: MCP Assistant, Subagents
- **Restart Behavior**: **NEVER** (except full system restart)
- **Why**: Preserves active chat sessions and tool context

#### 2. Regular MCPO (Port 8765)
- **Purpose**: Run regular and user-installed MCP servers
- **Config**: `mcp_config_advanced.json`
- **Servers**: Glean, Slack, Google Workspace, Atlassian, Time, user servers
- **Restart Behavior**: Restarts during MCP infrastructure reload
- **Why**: Enables dynamic server installation without disrupting core functionality

#### 3. Host MCPO (Port 8890)
- **Purpose**: Run HOST deployment servers
- **Config**: `mcp_config_host_sideload.json`
- **Servers**: Chrome DevTools and user-installed host servers
- **Restart Behavior**: Restarts during MCP infrastructure reload
- **Why**: Provides host-level access for filesystem/browser automation

### Restart Behaviors

#### Full System Restart (UI "Restart Services" Button)
**What Restarts**: ALL services (llm-gateway, mcpo-core, mcpo, open-webui, redis, health-check)
**Duration**: 2-3 minutes
**Impact**: Chat sessions lost, page refresh required
**When to Use**: Troubleshooting, major configuration changes

#### Partial MCP Restart (MCP Assistant Tool)
**What Restarts**: ONLY mcpo, host-mcpo, health-check
**What Stays Running**: mcpo-core, llm-gateway, open-webui, redis
**Duration**: <1 minute
**Impact**: **Chat sessions preserved**, no page refresh
**When to Use**: Installing/updating user MCP servers

### Session Preservation

**Before Core MCPO Architecture**:
```
User installs new server → Full restart → Chat session lost → Must refresh
```

**After Core MCPO Architecture**:
```
User installs new server → Partial restart → Chat session preserved → Continues seamlessly
```

**Key Benefit**: Users can install MCP servers mid-conversation and continue using MCP Assistant without interruption!

### Implementation Files

- `docker-compose.yml` - mcpo-core + mcpo services
- `src/scripts/mcp-orc-cli.sh generate-mcp-config` - 3-file generation
- `src/scripts/docker-compose.sh` - mcpo-core status
- `src/mcp-orc-rust/crates/health-check/src/app.rs` - Both MCPO discovery
- `bootstrap.sh` - mcp-configs-user preservation
- `electron-app/src/services/main.js` - Partial restart API

### Bootstrap Protection

During nuclear wipes (`bootstrap.sh`), the following are **always preserved**:
- `.env` - Environment variables
- `open-webui-data` - User conversations and data
- `mcp_config_host_sideload.json` - Host MCP configuration
- **`mcp-configs-user/`** - User-installed MCP servers

This ensures user-installed servers survive updates and reinstalls!

---

## See Also

- **[`mcp-user-installed.md`](mcp-user-installed.md)** — User-Installed MCP Servers implementation plan.
- **[`scheduled-task-runtime.md`](scheduled-task-runtime.md)** — Scheduled task runtime, sub-agent dispatch, and scope binding.
- **[`integrations/`](integrations/)** — Notes on individual MCP integrations (e.g. n8n).
