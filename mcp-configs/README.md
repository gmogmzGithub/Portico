# MCP Server Configuration Framework

This directory contains the configuration files for MCP (Model Context Protocol) servers used in the Portico system.

## Overview

Each MCP server is defined by three core files organized in its own dedicated subdirectory:
1. **`.yaml`** - Server metadata and configuration requirements
2. **`.fragment`** - JSON fragment for the MCP configuration
3. **`.md`** - Interactive setup instructions with custom tags

The system dynamically discovers servers, presents them in an interactive menu, and guides users through configuration.

## Directory Structure

```
mcp-configs/
├── README.md              # This documentation file
│
├── gitlab-mcp/            # GitLab MCP server
│   ├── gitlab-mcp.yaml      # Server configuration
│   ├── gitlab-mcp.md        # Setup instructions
│   └── gitlab-mcp.fragment  # JSON fragment for MCP config
│
├── glean/                 # Glean MCP server
│   ├── glean.yaml
│   ├── glean.md
│   └── glean.fragment
│
├── google_workspace/      # Google Workspace MCP server
│   ├── google_workspace.yaml
│   ├── google_workspace.md
│   └── google_workspace.fragment
│
├── mcp-atlassian/         # Atlassian (Jira/Confluence) MCP server
│   ├── mcp-atlassian.yaml
│   ├── mcp-atlassian.md
│   └── mcp-atlassian.fragment
│
├── slack/                 # Slack MCP server
│   ├── slack.yaml
│   ├── slack.md
│   ├── slack.fragment
│   ├── rebuild-slack-mcp-server.sh
│   ├── patches/oauth-token-file-ingress.patch
│   ├── slack-mcp-server-linux-arm64  # Platform-specific binary (arm64)
│   └── slack-mcp-server-linux-amd64  # Platform-specific binary (amd64)
```

The bundled Slack binaries are built from `korotovsky/slack-mcp-server` with
an Portico patch that lets the server read the OAuth user token from
`SLACK_MCP_OAUTH_ACCESS_TOKEN_FILE`. Upstream only reads token values from
environment variables, so rebuild these binaries with:

```bash
bash mcp-configs/slack/rebuild-slack-mcp-server.sh
```

## How It Works

1. **Discovery**: The Electron app (`electron-app/src/services/main.js`) scans subdirectories for `.yaml` files to discover available servers
2. **Setup Wizard**: Servers are presented in the Guided Setup Wizard UI (`electron-app/src/guided-setup.html`)
3. **Configuration**: Selected servers are configured through the interactive UI using their `.md` files
4. **Generation**: `src/scripts/mcp-orc-cli.sh generate-mcp-config` builds the final `mcp_config_advanced.json` based on toggle states and environment variables

## Adding a New MCP Server

To add a new MCP server to this project, follow these steps:

### Step 1: Create Server Directory

Create a new subdirectory in `mcp-configs/` with your server ID as the directory name:

```bash
mkdir mcp-configs/your-server-id
```

### Step 2: Create Required Files

Create the following three files in your server's directory:

#### 1. Server Metadata (`your-server-id/your-server-id.yaml`)

```yaml
name: "Your Server Name"
id: "your-server-id"
display_name: "📝 Display Name"
experimental: false  # Set to true for experimental servers
description: "Brief description of what this server does"
use_cases:
  - "Use case 1"
  - "Use case 2"

required_env_vars:
  - name: SERVER_API_KEY
    placeholder: "your-api-key-placeholder"
    description: "Description of this variable"
    sensitive: true  # Set to true for secrets
    default: ""      # Optional default value

create_dirs:
  - ~/.your-server/  # Host directory ensured on app launch and before every
                     # MCP configuration regeneration (service restarts,
                     # server restarts/toggles, tool saves), like mkdir -p

runtime_files:
  - source: ~/.your-server/config.yaml
    filename: config.yaml
  - source: ~/.your-server/credentials.toml
    target: /root/.your-server/credentials.toml
    sensitive: true  # Import through Keychain/runtime-secret cache + Docker secrets

# `create_dirs` is host-side setup only. It does not create container paths.
# Directories are re-ensured on every initialization pass and before every
# configuration regeneration, so a deleted directory reappears on the next
# restart or server operation.
# `runtime_files[].target` is an exact container file path. `sensitive: true`
# prevents a direct host bind mount: the file is imported into Keychain and
# delivered to the container through the secret broker. The source file is
# never modified — edit it to rotate the credential (the changed file
# re-imports automatically on the next resolve).

# Note: Fragment files are automatically discovered using the pattern:
# {server_id}.fragment and the config key defaults to the server id
```

#### 2. MCP Fragment (`your-server-id/your-server-id.fragment`)

```json
{
  "command": "/app/mcp-servers/your-server-binary",
  "args": [
    "--transport",
    "stdio"
  ]
}
```

#### 3. Setup Instructions (`your-server-id/your-server-id.md`)

Create an interactive setup guide using Markdown with custom tags and colors:

```markdown
# Your Server Configuration

Brief introduction about the server.

<browser-open url="https://example.com/setup" />

<new-chat prompt="Help me set up Your Server" label="Set up in chat" />

## Setup Steps

1. Navigate to the <CYAN>API Settings</CYAN> page
2. Look for <GREEN>API Key</GREEN> section
3. <YELLOW>Important:</YELLOW> Keep your key secure

<user-confirm prompt="Press Enter when ready..." />

<user-input 
  var="SERVER_API_KEY" 
  prompt="Enter your API key:"
  validate="^[A-Za-z0-9]+$"
  error="Invalid API key format"
  mask="true" />

<success message="Configuration complete!" />
```

### Step 3: Add Platform-Specific Binaries (if needed)

If your server requires platform-specific binaries, add them to your server's directory:

```bash
cp your-server-binary mcp-configs/your-server-id/
```

## Custom Tags Reference

The following tags are supported in `.md` setup files and are processed by the
runtime configuration modal and/or first-run Guided Setup:

**Available Tags:**
- `<browser-open>` - Opens a URL in the browser
- `<new-chat>` - Opens a new Portico tab and submits a prompt
- `<user-confirm>` - Waits for user confirmation  
- `<user-input>` - Prompts for and validates user input
- `<cleanup-vars>` - Removes deprecated environment variables
- `<success>` - Shows a success message
- `<exit-if-no>` - Exits configuration if user answers no
- `<clear>` - Clears the terminal screen
- Color tags: `<RED>`, `<GREEN>`, `<YELLOW>`, `<BLUE>`, `<CYAN>`, `<BOLD>`

### `<browser-open>`
Opens a URL in the user's browser.
```xml
<browser-open url="https://example.com" />
```

### `<new-chat>`
In the running app, opens a new chat tab and automatically submits the required
`prompt` after the user clicks the generated button. The optional `label`
defaults to `Open new chat`. First-run Guided Setup keeps the surrounding text
but omits this runtime-only control because chat is not available yet.
```xml
<new-chat prompt="Help me set up Your Server" label="Set up in chat" />
```

### `<user-confirm>`
Pauses for user confirmation.
```xml
<user-confirm prompt="Press Enter to continue..." />
```

### `<user-input>`
Prompts for user input and validates it. Supports setting multiple variables to the same value.
```xml
<!-- Single variable -->
<user-input 
  var="ENV_VAR_NAME" 
  prompt="Enter value:"
  validate="regex-pattern"
  error="Error message"
  mask="true" />

<!-- Multiple variables (comma-separated) -->
<user-input 
  var="CONFLUENCE_API_TOKEN,JIRA_API_TOKEN" 
  prompt="Enter your Atlassian API token:"
  validate=".+"
  error="Token cannot be empty" />
```

### `<cleanup-vars>`
Removes deprecated environment variables.
```xml
<cleanup-vars remove="OLD_VAR1,OLD_VAR2" />
```

### `<success>`
Shows a success message.
```xml
<success message="Setup complete!" />
```

### `<exit-if-no>`
Prompts the user with a yes/no question. If they answer no, exits the configuration.
```xml
<exit-if-no prompt="Have you been approved? If not, we'll ask you the next time you restart." />
```

### `<clear>`
Clears the terminal screen.
```xml
<clear />
```

### Color Tags

You can use color tags in your `.md` setup files to make text more visually distinctive. The format is `<COLOR>text</COLOR>`.

#### Available Colors
- `<RED>text</RED>` - Red text for errors or critical information
- `<GREEN>text</GREEN>` - Green text for success messages
- `<YELLOW>text</YELLOW>` - Yellow text for warnings
- `<BLUE>text</BLUE>` - Blue text for information
- `<CYAN>text</CYAN>` - Cyan text for highlights
- `<BOLD>text</BOLD>` - Bold text for emphasis

Note: Color tags are processed in the `execute_setup_markdown` function and work consistently across all terminal types.

#### Limitations
- **Single-line only**: Color tags only work within a single line. Multi-line color blocks are not supported.
- **Complete tags required**: Both opening `<COLOR>` and closing `</COLOR>` tags must be on the same line.

#### Usage Examples
```markdown
1. Check for <RED>critical errors</RED> in the response
2. Look for <GREEN>success indicators</GREEN> in the output
3. Be aware of <YELLOW>warnings</YELLOW> that may appear

## <CYAN>Configuration Status</CYAN>

- **Bold markdown** and <RED>colored text</RED> can be used together
- You can make <RED>**bold red text**</RED> for extra emphasis
- Use <GREEN>green text</GREEN> to indicate successful configuration
```

## File Types Explained

### `.yaml` Files
Server configuration metadata including:
- Server ID and display information
- Description and use cases
- Required environment variables
- Experimental status

### `.md` Files
Interactive setup instructions with special tags for:
- User input prompts
- Browser navigation
- Environment variable management
- Terminal control (clearing screen)
- Success messaging

### `.fragment` Files
JSON fragments that get assembled into the final MCP configuration. Fragment files follow the naming pattern `{server_id}.fragment`.

### Binary Files
Platform-specific executables required by certain servers (e.g., Slack).

## Server Visibility

- **Standard servers**: Shown by default in the Guided Setup Wizard and Control Panel
- **Experimental servers**: Only shown when experimental mode is enabled

Set `experimental: true` in the YAML file to mark a server as experimental.

## System Integration

The Electron app and configuration scripts automatically:
- Discover servers by scanning subdirectories for `.yaml` files
- Load configuration from `{server_id}/{server_id}.yaml`
- Present setup from `{server_id}/{server_id}.md` in the Guided Setup Wizard
- Assemble fragments from `{server_id}/{server_id}.fragment`
- Use server ID as the config key in the MCP configuration

## Testing Your Configuration

1. Create your server directory: `mkdir mcp-configs/your-server-id`
2. Add your three required files to the directory
3. Run `bash src/scripts/mcp-orc-cli.sh generate-mcp-config` to regenerate configuration
4. Launch the Electron app - your server should appear in the Guided Setup Wizard
5. Configure it through the UI and test the setup flow

## Current Servers

- **glean** - Glean search server (requires `GLEAN_API_TOKEN`)
- **slack** - Slack integration (configured through OAuth; no Slack token env var)
- **mcp-atlassian** - Jira/Confluence integration (requires `CONFLUENCE_API_TOKEN` or `JIRA_API_TOKEN`)
- **gitlab-mcp** - GitLab integration (requires `GITLAB_PERSONAL_ACCESS_TOKEN`)
- **google_workspace** - Google Workspace integration (requires OAuth credentials)

## Examples

See the existing server configurations for examples:
- `slack/` - OAuth-based authentication with binary
- `glean/` - API token with approval workflow
- `mcp-atlassian/` - Multiple related services
- `gitlab-mcp/` - Personal access token
- `google_workspace/` - OAuth2 with complex setup

## Tips for Writing Setup Instructions

1. **Provide clear prompts**: Make sure users understand what they need to do at each step
2. **Validate input**: Use regex patterns to validate API keys and other critical inputs
3. **Handle secrets securely**: Use `mask="true"` for password/token inputs
4. **Clean up old variables**: Use `<cleanup-vars>` if migrating from old configurations
5. **Use color tags effectively**: Apply `<RED>`, `<GREEN>`, `<YELLOW>`, `<BLUE>`, `<CYAN>`, `<BOLD>` tags to highlight important information
6. **Clear screen when needed**: Use `<clear />` to clear the terminal for better readability
7. **Test thoroughly**: Run through the entire setup flow to ensure it works smoothly

## Troubleshooting

If your server doesn't appear in the menu:
1. Check that all three required files exist in the server directory
2. Verify the YAML file has valid syntax
3. Ensure the server ID in the YAML matches the directory name
4. Check that file names follow the pattern: `{server_id}.{extension}`

If configuration fails:
1. Check that environment variables are being set correctly
2. Verify the fragment JSON is valid
3. Ensure any required binaries are present and executable
4. Review the setup instructions for proper tag syntax
