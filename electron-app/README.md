# Portico - Guided Setup Tool

A sleek, modern Electron application that provides a graphical interface for configuring Portico. This tool replaces the command-line setup process with an intuitive step-by-step wizard.

## Features

- 🎨 **Modern UI**: Beautiful, dark-themed interface with smooth animations
- 🚀 **Step-by-Step Wizard**: Guided process for configuring environment variables and MCP servers
- 🔐 **Secure**: Passwords and API keys are masked and stored securely
- 🔄 **Auto-detection**: Automatically detects your username and existing configurations
- 📦 **Standalone**: Can be packaged as a standalone executable (no Node.js required)
- 🐳 **Docker Build**: Can be built using Docker without any local Node.js installation

## Quick Start

### Option 1: Using Docker (No Node.js Required)

If you don't have Node.js installed, you can build and run the app entirely through Docker:

```bash
# Build the application using Docker
./src/scripts/build-with-docker.sh mac   # For macOS
./src/scripts/build-with-docker.sh win    # For Windows
./src/scripts/build-with-docker.sh linux  # For Linux
./src/scripts/build-with-docker.sh all    # For all platforms

# The built application will be in the dist/ directory
# For macOS: Open the .dmg file
# For Windows: Run the .exe installer
# For Linux: Run the .AppImage file
```

### Option 2: Using Node.js (For Development)

If you have Node.js installed:

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Build for your platform
npm run build:mac    # For macOS
npm run build:win    # For Windows
npm run build:linux  # For Linux
npm run build:all    # For all platforms
```

## Building Standalone Executables

The application can be built as a standalone executable that includes the Node.js runtime, so end users don't need Node.js installed.

### Using Docker Build Script

The easiest way to build standalone executables is using the Docker build script:

```bash
# Make the script executable (first time only)
chmod +x src/scripts/build-with-docker.sh

# Build for your target platform
./src/scripts/build-with-docker.sh mac    # Creates .dmg and .zip for macOS
./src/scripts/build-with-docker.sh win    # Creates .exe installer for Windows
./src/scripts/build-with-docker.sh linux  # Creates .AppImage and .deb for Linux
```

### Build Outputs

After building, you'll find the following in the `dist/` directory:

- **macOS**: 
  - `.dmg` - Disk image installer
  - `.zip` - Compressed application bundle
- **Windows**:
  - `.exe` - NSIS installer
  - `-portable.exe` - Portable executable (no installation required)
- **Linux**:
  - `.AppImage` - Universal Linux package
  - `.deb` - Debian/Ubuntu package

## How It Works

The setup tool guides users through four main steps:

### Step 1: Environment Configuration
- Automatically detects the user's Portico username
- Configures basic environment variables
- Sets up redaction and token budget settings

### Step 2: API Key Setup
- Provides instructions for obtaining an Portico LLM API key
- Opens the API key page in the browser
- Securely stores the API key

### Step 3: MCP Server Selection
- Displays available MCP servers (Glean, Slack, Jira, GitLab, etc.)
- Shows configuration status for each server
- Allows configuration of individual servers with guided prompts
- Filters for configured/unconfigured servers

### Step 4: Review and Launch
- Reviews all configuration settings
- Checks Docker status
- Saves configuration to `.env` and `mcp_config_advanced.json`
- Optionally starts Docker containers

## Architecture

The application uses Electron's multi-process architecture:

- **Main Process** (`src/services/main.js`): Handles file I/O, system operations, and window management
- **Renderer Process** (`src/services/renderer.js`, `src/services/manager.js`): Manages the UI and user interactions
- **Preload Script** (`src/services/preload.js`): Provides secure bridge between main and renderer processes

### File Structure

```
electron-app/
├── package.json           # Node.js dependencies and build config
├── Dockerfile.build       # Docker build configuration
├── docker-compose.dev.yml # Docker development environment
├── src/
│   ├── scripts/            # Shell helpers for building and updates
│   │   ├── build-with-docker.sh
│   │   ├── launch-silent.sh
│   │   ├── launch-with-logging.sh
│   │   ├── update-in-app-nexus.sh
│   │   ├── update-nexus.sh
│   │   └── update-wrapper-nexus.sh
│   ├── services/           # Application logic
│   │   ├── main.js             # Electron main process
│   │   ├── preload.js          # Preload script for security
│   │   ├── renderer.js         # Control panel logic
│   │   ├── manager.js          # Manager functionality
│   │   ├── logger.js           # Logging helper
│   │   ├── main-logger-integration.js # Logger bootstrap helper
│   │   └── oauth-modal-shared.js      # OAuth utilities
│   ├── index.html            # Main control panel UI
│   ├── loading.html          # Loading screen
│   ├── chat.html             # Chat window
│   ├── guided-setup.html     # Guided setup wizard
│   ├── log-viewer.html       # Log viewer
│   ├── welcome.html          # Welcome screen
│   ├── oauth-modal-shared.html # Shared OAuth modal
│   └── styles.css            # Control panel styling
├── assets/               # Icons and resources (created during build)
└── dist/                 # Built applications (created after build)
```

## Configuration Files

The tool manages two main configuration files:

### `.env` File
Contains environment variables including:
- `PORTICO_USER_ID` - Your Portico username
- `PORTICO_LLM_API_KEY` - API key for Portico's LLM service
- `PORTICO_REDACT_ALLOW` - Redaction settings
- MCP server credentials (API tokens, etc.)

### `mcp_config_advanced.json`
Contains MCP server configurations assembled from:
- Server metadata (YAML files)
- Configuration fragments
- User-provided credentials

## Development

### Prerequisites for Development
- Node.js 18+ (for local development)
- Docker (for Docker-based builds)
- Git

### Running in Development Mode

```bash
# Install dependencies
npm install

# Start the application in development mode
npm start
```

### Testing Configuration Loading

The app automatically loads configuration from the parent directory's files:
- `../system-env-presets.yaml` - System-level environment variable presets
- `../.env` - Actual environment configuration (created from presets)
- `../mcp-configs/*/` - MCP server configurations (including preset_env_vars)

### Building for Distribution

```bash
# Build for current platform
npm run build

# Build for specific platform
npm run build:mac
npm run build:win
npm run build:linux

# Build for all platforms
npm run build:all
```

## Docker-Only Workflow

For users who prefer not to install Node.js, everything can be done through Docker:

### 1. Build the Application

```bash
# Uses Docker to build without local Node.js
./src/scripts/build-with-docker.sh mac
```

### 2. Run the Built Application

After building, the standalone application will be in the `dist/` directory:

- **macOS**: Double-click the `.dmg` file and drag to Applications
- **Windows**: Run the `.exe` installer
- **Linux**: Make the `.AppImage` executable and run it

```bash
# Linux example
chmod +x dist/*.AppImage
./dist/*.AppImage
```

## Troubleshooting

### Docker Build Issues

If the Docker build fails:

1. Ensure Docker is installed and running
2. Check available disk space
3. Try clearing Docker cache: `docker system prune`

### Missing Icons

The build script automatically creates placeholder icons if they don't exist. For production use, replace these with proper icons:

- `assets/icon.png` - 512x512 PNG for Linux
- `assets/icon.icns` - macOS icon file
- `assets/icon.ico` - Windows icon file

### Permission Issues on Linux

If you get permission errors when running the AppImage:

```bash
chmod +x Portico-Setup-*.AppImage
```

### Electron Security Warnings

The app uses context isolation and disables node integration in the renderer for security. All file system operations are handled through IPC calls to the main process.

## Security Considerations

- API keys and tokens are never logged or displayed in plain text
- All sensitive inputs use password fields with masking
- Configuration files are saved with appropriate permissions
- IPC communication uses a secure preload script pattern
- No remote code execution or eval() usage

## Contributing

To contribute to this tool:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly on your target platform
5. Submit a pull request

## License

MIT License - See the parent project's LICENSE file for details.

## Support

For issues or questions:
- Check the parent project's documentation
- Review existing MCP server configurations in `../mcp-configs/`
- Consult the Portico wiki article
