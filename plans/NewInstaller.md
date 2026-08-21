# Prerequisites Screen Implementation Plan

## Overview

Add a new "Prerequisites" screen to the guided setup wizard that handles first-run system setup. This enables DMG distribution where users drag-to-install and double-click to run, without manually running `bootstrap.sh`.

**CRITICAL DESIGN PRINCIPLE**: The existing `bootstrap.sh` and `install_v2.sh` scripts are battle-tested (6+ months in production). Instead of rewriting their logic in JavaScript, we will:
1. **Create new cherry-picked shell scripts** that extract specific functionality from the existing scripts
2. **Have the Electron app invoke these shell scripts** via spawn/exec
3. **Only implement Docker image pulling in JavaScript** for the enhanced GUI progress bars
4. **Never modify the existing bootstrap.sh or install_v2.sh** - they remain untouched for the update path

## New Stage Flow

```
welcome → prerequisites → welcome-user → server-selection → oauth → configuration → finalize → success
         ^^^^^^^^^^^^
         NEW STAGE
```

## User-Facing Phases

The Prerequisites screen will show 4 distinct phases with progress:

| Phase | Label Shown to User | What Happens |
|-------|---------------------|--------------|
| 1 | "Downloading auxiliary data..." | Shell script: download from Nexus, prepare managed dir, extract |
| 2 | "Installing third party software..." | Shell script: Homebrew, jq, Node.js, uv/uvx, Playwright |
| 3 | "Preparing Portico workspace..." | Shell script: OrbStack; **JavaScript: Docker pulls with GUI** |
| 4 | "Setting up host mode..." | Shell script: HOST_MODE check |

## Architecture: Shell Scripts + Electron Orchestration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Electron Main Process                                │
│                    prerequisites-service.js                                  │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  Phase 1: spawn('bash', ['prereq-download.sh', buildNumber])         │  │
│   │  Phase 2: spawn('bash', ['prereq-dependencies.sh'])                  │  │
│   │  Phase 3: spawn('bash', ['prereq-docker-setup.sh']) +                │  │
│   │           JavaScript Docker pull with progress parsing               │  │
│   │  Phase 4: spawn('bash', ['prereq-host-mode.sh'])                     │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   Stream stdout/stderr to renderer for logs                                  │
│   Parse specific output markers for progress updates                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Shell Scripts to Create (Cherry-Picked from Existing)

### 1. `/src/scripts/prereq-download.sh` (NEW)
Cherry-pick from `bootstrap.sh`:
- Lines 109-336: Determine build version from Nexus (using passed build number)
- Lines 337-687: Prepare managed directory (nuclear cleanup with backup/restore)
- Lines 697-815: Download and extract
- Lines 817-1032: Restore preserved files
- Lines 1088-1126: Create build-info.json in managed dir

**Input**: Build number from bundled build-info.json
**Output**: Managed directory prepared with all files

### 2. `/src/scripts/prereq-dependencies.sh` (NEW)
Cherry-pick from `install_v2.sh`:
- Lines 207-258: install_homebrew()
- Lines 632-712: install_jq() / install_jq_linux()
- Lines 828-902: install_node_and_npm()
- Lines 733-825: install_uv()

**Output markers for progress**: `[PREREQ:STEP:homebrew]`, `[PREREQ:STEP:jq]`, etc.

### 3. `/src/scripts/prereq-docker-setup.sh` (NEW)
Cherry-pick from `install_v2.sh`:
- Lines 904-963: install_orbstack()
- Lines 261-363: configure_orbstack_resources()

**Note**: Does NOT include docker image pulling - that's handled in JavaScript

### 4. `/src/scripts/prereq-host-mode.sh` (NEW)
Cherry-pick from `install_v2.sh`:
- Lines 966-1046: check_host_mode_support()

**Output**: Writes HOST_MODE file (TRUE/FALSE)

## Files to Create (Electron Side)

### 5. `/electron-app/src/services/prerequisites-service.js` (NEW)
Main process orchestrator - invokes shell scripts and handles Docker pulls:
- `readBundledBuildInfo()` - Read from `process.resourcesPath + '/build-info.json'`
- `runPhase1Download(buildNumber)` - spawn prereq-download.sh
- `runPhase2Dependencies()` - spawn prereq-dependencies.sh
- `runPhase3Docker()` - spawn prereq-docker-setup.sh + **JavaScript Docker pull with GUI**
- `runPhase4HostMode()` - spawn prereq-host-mode.sh
- `pullDockerImagesWithProgress()` - **Custom JavaScript implementation for GUI progress**

### 6. `/electron-app/src/services/guided-setup/screen-prerequisites.js` (NEW)
Renderer-side UI logic:
- Phase card rendering
- Progress bar updates
- Docker pull progress visualization (the nice GUI part)
- Log viewer toggle
- Error handling UI

## Files to Modify

### 3. `/electron-app/src/renderer/views/guided-setup.html`
Add after `stage-welcome`, before `stage-welcome-user`:

```html
<div class="setup-stage" id="stage-prerequisites">
  <h1>Setting Up Your Environment</h1>
  <p class="subtitle">Please wait while we prepare your system</p>

  <!-- Overall Progress Bar -->
  <div class="prerequisites-progress">
    <div class="progress-bar-container">
      <div class="progress-fill" id="prerequisites-overall-progress"></div>
    </div>
    <span class="progress-text" id="prerequisites-progress-text">0%</span>
  </div>

  <!-- Phase Cards -->
  <div class="prerequisites-phases" id="prerequisites-phases">
    <!-- 4 phase cards dynamically populated -->
  </div>

  <!-- Docker Images Progress (shown during phase 3) -->
  <div class="docker-images-section" id="docker-images-section" style="display: none;">
    <!-- Per-image progress bars with %, ETA -->
  </div>

  <!-- Expandable Logs -->
  <details class="prerequisites-logs">
    <summary>Show detailed logs</summary>
    <div class="logs-content" id="prerequisites-logs"></div>
  </details>
</div>
```

### 4. `/electron-app/src/renderer/views/guided-setup.css`
Add styles for:
- Phase cards (pending/active/complete/failed states)
- Modern flat progress bars with shimmer animation
- Docker image progress rows with percentage and ETA
- Expandable logs section

### 5. `/electron-app/src/services/preload.js`
Add new APIs:

```javascript
// Prerequisites operations
prerequisitesStart: () => ipcRenderer.invoke('prerequisites-start'),
prerequisitesGetStatus: () => ipcRenderer.invoke('prerequisites-get-status'),

// Progress event listeners
onPrerequisitesProgress: (callback) => ipcRenderer.on('prerequisites-progress', (e, d) => callback(d)),
onPrerequisitesPhaseStart: (callback) => ipcRenderer.on('prerequisites-phase-start', (e, d) => callback(d)),
onPrerequisitesPhaseComplete: (callback) => ipcRenderer.on('prerequisites-phase-complete', (e, d) => callback(d)),
onPrerequisitesStepUpdate: (callback) => ipcRenderer.on('prerequisites-step-update', (e, d) => callback(d)),
onPrerequisitesDockerPull: (callback) => ipcRenderer.on('prerequisites-docker-pull', (e, d) => callback(d)),
onPrerequisitesLog: (callback) => ipcRenderer.on('prerequisites-log', (e, d) => callback(d)),
onPrerequisitesComplete: (callback) => ipcRenderer.on('prerequisites-complete', (e, d) => callback(d)),
onPrerequisitesError: (callback) => ipcRenderer.on('prerequisites-error', (e, d) => callback(d)),
```

### 6. `/electron-app/src/services/ipc.js`
Add IPC handlers that delegate to prerequisites-service.js

### 7. `/electron-app/src/renderer/views/guided-setup.js`
Update orchestrator:
- Import screen-prerequisites.js
- Handle `stage-prerequisites` in `showStage()`
- Update `startSetup()` to go to prerequisites first

### 8. `/electron-app/src/services/guided-setup/setup-state.js`
Add prerequisites state tracking

### 9. `/electron-app/src/services/guided-setup/setup-progress.js`
Add prerequisites step to progress tracker

## Docker Pull Progress Implementation

Parse Docker pull output to extract layer progress:

```javascript
// Example Docker pull output parsing
// "abc123: Downloading [====>    ] 45.2MB/100MB"
// "def456: Pull complete"

function parseDockerPullProgress(output, images) {
  // Returns: { images: [{name, status, current, total, eta}], overall: % }
}
```

Display as modern flat progress bars:
```
┌─────────────────────────────────────────────────────────────────┐
│  mcpo                                              2m 30s      │
│  [████████████████░░░░░░░░░░░░░░░░░░░░░░░]          45%       │
├─────────────────────────────────────────────────────────────────┤
│  open-webui-patched                                   --       │
│  [████████████████████████████████████████]         100% ✓    │
├─────────────────────────────────────────────────────────────────┤
│  health-check                                      waiting     │
│  [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]           0%       │
└─────────────────────────────────────────────────────────────────┘
```

## Error Handling Strategy

| Error Type | Behavior |
|------------|----------|
| Network failure | Retry button, detailed error message |
| Disk full | Fatal error, clear instructions |
| Optional dep fails | Warning, continue (Homebrew, jq, etc.) |
| Docker pull fails | Retry button for specific image |
| Nexus unreachable | Retry with exponential backoff |

## Critical Implementation Notes

1. **build-info.json location**: `Contents/Resources/build-info.json` inside the .app bundle
   - Access in Electron via: `path.join(process.resourcesPath, 'build-info.json')`
   - CI must copy this file during electron-builder packaging

2. **Nexus download includes FULL managed directory contents**:
   - Same zip as bootstrap.sh downloads (portico-MMDDYYYY-SHA.zip)
   - Contains: docker-compose files, src/scripts, patches, all project files
   - Only user data is preserved/excluded from cleanup

3. **Preserve files during nuclear cleanup** - Same list as bootstrap.sh:
   - .env, open-webui-data, mcp configs, OAuth tokens, skills, workspaces, backup/

4. **Shell script output markers** - Scripts emit markers for progress tracking:
   ```
   [PREREQ:PHASE:1:START]
   [PREREQ:STEP:download:START]
   [PREREQ:STEP:download:COMPLETE]
   [PREREQ:PHASE:1:COMPLETE]
   ```

5. **Docker pull is JavaScript-only** - The only business logic NOT in shell scripts
   - Enables real-time per-layer progress parsing
   - Calculates ETA from download speeds
   - Renders beautiful progress bars

6. **Never modify bootstrap.sh or install_v2.sh** - They remain the update path

7. **OrbStack may require user interaction** - Handle installation prompts

8. **Playwright install can be slow** - Show clear progress/status

## Verification Steps

1. Build DMG with bundled build-info.json
2. Fresh install: drag to Applications, run app
3. Prerequisites screen appears after welcome
4. All 4 phases complete successfully
5. Docker images download with real-time progress bars
6. HOST_MODE file created correctly
7. Proceeds to welcome-user stage
8. **Upgrade path still works** (bootstrap.sh for updates - unchanged)

## Implementation Order

1. **Create cherry-picked shell scripts** (prereq-download.sh, prereq-dependencies.sh, etc.)
2. Create prerequisites-service.js to orchestrate shell scripts
3. Implement Docker pull with progress in JavaScript
4. Add IPC handlers and preload APIs
5. Add HTML stage and CSS styles
6. Implement screen-prerequisites.js renderer logic
7. Update orchestrator navigation
8. Test full flow end-to-end
9. Update CI to bundle build-info.json in .app
