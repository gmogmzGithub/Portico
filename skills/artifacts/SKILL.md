---
name: artifacts
description: Create and manage live web application previews from Agent VMs. Use when building frontend apps, prototypes, or any web-based projects that need live preview.
license: Proprietary
compatibility: Portico
metadata:
  author: Dionny Santiago
  version: "1.0"
  priority: high
  triggers:
    - "create artifact"
    - "make artifact"
    - "build artifact"
    - "make an artifact"
    - "artifact preview"
    - "preview app"
    - "live preview"
    - "web preview"
    - "show artifact"
    - "open artifact"
    - "version artifact"
    - "react app"
    - "vite"
    - "frontend"
    - "web app"
    - "preview the app"
    - "show the app"
    - "edit file"
    - "modify code"
    - "find files"
    - "search code"
    - "uploaded project"
    - "zip file"
    - "extract zip"
required_mcp_servers:
  - "server:agent-vm"
  - "server:artifacts"
---

# Artifacts Skill

Create, manage, and preview live web applications from Agent VMs. This skill enables a seamless workflow for building and viewing frontend applications.

---

## CRITICAL: Always Set Up Build Toolchain for Uploaded Projects

When a user uploads a project (zip file), **NEVER serve pre-built static files directly**. Users upload projects to **iterate on them**, so always set up the build toolchain.

### Why Pre-Built Files Don't Work
- **Static files can't be updated** - Changes to source files have no effect
- **CSS hacks break styling** - Injecting CSS into index.html conflicts with component systems
- **No iteration path** - User is stuck with what they uploaded

### The Correct Workflow for Uploaded Projects

1. **Extract the project** to `/work/app` (or similar subdirectory)
2. **Check for package.json** - If it exists, this is a Node.js project
3. **Run `npm install`** to set up dependencies
4. **Start with dev server** (e.g., `npm run dev -- --host`), NOT `python -m http.server`
5. **Edit source files** (`.tsx`, `.jsx`, etc.) and the dev server will auto-reload

### How to Identify Project Type

| Sign | Project Type | Start Command |
|------|--------------|---------------|
| `package.json` with Vite | Vite/React | `npm run dev -- --host` |
| `package.json` with Next.js | Next.js | `npm run dev` |
| `"name": "prototype-studio-app"` | Prototype Studio | **See special workflow below** |
| `build-manifest.json` + source files | Pre-built but has sources | Run `npm install`, then `npm run dev -- --host` |
| Only HTML/CSS/JS (no package.json) | Static site | `python -m http.server 5173` |

### Prototype Studio Projects (esbuild-based) - SPECIAL HANDLING REQUIRED

Prototype Studio exports use **esbuild for production builds** but have **NO dev server**. You MUST set one up!

**How to identify Prototype Studio projects:**
- `package.json` with `"name": "prototype-studio-app"`
- Scripts include `"build": "node build.mjs"` but **NO `"dev"` script**
- Uses `@portico/ifl-components`, `@portico/ifl-themes`, etc.
- Has `build/` directory with pre-compiled assets

**The CORRECT Workflow for Prototype Studio:**

```
1. Extract to /work/app:
   agent_vm_unzip_file(vm_id, "/work/prototype.zip", "/work/app", strip_components=0)

2. Install dependencies:
   agent_vm_bash(vm_id, "cd /work/app && npm install")

3. Add a dev server script (Prototype Studio doesn't include one!):
   agent_vm_bash(vm_id, "cd /work/app && npm pkg set scripts.dev='npx vite --host'")

4. Add vite.config.js for proper React/Emotion support:
   agent_vm_create_file(vm_id, "/work/app/vite.config.js", content below)

5. Install Vite as dev dependency:
   agent_vm_bash(vm_id, "cd /work/app && npm install -D vite @vitejs/plugin-react")

6. Create artifact with dev server:
   artifacts_create_artifact(
     vm_id="...", chat_id="...", name="Prototype",
     start_command="npm run dev",
     container_port=5173,
     working_directory="/work/app"
   )
```

**vite.config.js content:**
```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 }
});
```

**Quick Preview (read-only, no edits):**
If user explicitly says "just show me" or "quick preview", you MAY serve pre-built files:
```
artifacts_create_artifact(
  start_command="python -m http.server 5173",
  working_directory="/work/app/build"
)
```
But WARN: "This is a static preview. To make changes, I'll need to set up the dev server."

### NEVER Do This:
- Serve pre-built `assets/main.js` with `python -m http.server` when user wants to iterate
- Inject `<style>` tags into index.html to override styles
- Skip npm install to save time (build will fail later)
- Assume `npm run dev` exists - Prototype Studio projects DON'T have it by default!

---

## CRITICAL: Never Create New Artifacts for Modifications

When a user asks to modify an **existing artifact**, you MUST:
1. Use `agent_vm_edit_file` to make changes in the artifact's running VM
2. Call `artifacts_create_artifact_version` to snapshot and deploy

**DO NOT create a new artifact with `artifacts_create_artifact`!**

### Why This Matters
- **New artifacts lose history** - User can't undo changes
- **Wastes resources** - Creates unnecessary VMs
- **Confuses users** - Multiple artifacts for the same project

### How to Know If Artifact Exists
- Check conversation history for previous `artifacts_create_artifact` calls
- Look for artifact_id in recent tool responses
- If user says "change the header" or "update the button", they mean the existing artifact

### Signs You Should Use `artifacts_create_artifact_version`:
- User says "change", "modify", "update", "add", "remove", "fix"
- User references something they already previewed
- Conversation has a running artifact

### The ONLY Time to Create New Artifact:
- User explicitly says "create a NEW artifact" or "start fresh"
- Building something completely different from existing artifact
- User uploaded a new zip file for a completely different project

---

## IMPORTANT: Simplified Workflow (3 Steps)

For web app previews, you only need **3 steps**:

```
1. agent_vm_create     → Create a development VM
2. agent_vm_create_files → Create all your files in /work (HTML, CSS, JS)
3. artifacts_create_artifact     → Snapshots /work, starts the preview in an Agent VM Docker container, opens preview
```

**That's it!** The preview panel opens automatically.

### New Architecture Note (Workspace Snapshot + Agent VM Runtime)
Artifacts snapshot the chat workspace mounted at `/work` and run previews inside Agent VM Docker containers. When you call `artifacts_create_artifact`, the system:
1. Snapshots the selected development VM's verified `/work` mount when `vm_id` is provided, otherwise the resolved chat workspace root
2. Stores artifact internals outside the visible chat workspace
3. Starts and validates the server in an Agent VM Docker container before reporting the preview as running

This means:
- **No port conflicts** between versions - each version runs in its own container
- **Development VM stays available** for continued work
- **vm_id is optional** - if provided, files are snapshotted from that VM's `/work`; if omitted, the current chat workspace is snapshotted

---

## Working with Uploaded Projects

When users upload a zip file containing an existing project (React, Vite, etc.):

### Auto-Extraction
Zip files are **automatically extracted** when uploaded. For `my-react-app.zip`:
- Original zip: `/work/my-react-app.zip`
- Extracted to: `/work/my-react-app/`

### File Auto-Sync (No Manual Copy Needed!)

When you create a VM with `agent_vm_create`, uploaded files are **automatically synced** to the VM:
- **Zip files**: `/work/{filename}.zip` AND auto-extracted to `/work/{filename}/`
- **Other files**: `/work/{filename}`

Files are already there. Just use them directly:
- `agent_vm_list_files(vm_id, "/work")` to see what's available
- `agent_vm_unzip_file` only if you need to re-extract to a different location (e.g., `/work/app`)

### Workflow: Uploaded Project → Preview

```
User uploads "my-react-app.zip"

1. Create VM:
   agent_vm_create(chat_id="abc-123")
   → vm_id: "def-456"

2. Explore structure:
   agent_vm_find_files(vm_id="def-456", pattern="**/*.{jsx,tsx}")
   → Lists all React component files

3. Search for patterns:
   agent_vm_grep(vm_id="def-456", pattern="useState")
   → Shows all useState occurrences with file:line

4. Read target file:
   agent_vm_read_file(vm_id="def-456", path="/work/my-react-app/src/App.jsx")
   → File content displayed (required before editing!)

5. Make targeted edit:
   agent_vm_edit_file(
     vm_id="def-456",
     file_path="/work/my-react-app/src/App.jsx",
     old_string="const [count, setCount] = useState(0)",
     new_string="const [count, setCount] = useState(10)"
   )
   → Edit applied successfully

6. Install dependencies & create artifact:
   agent_vm_bash(vm_id="def-456", command="cd /work/my-react-app && npm install")
   artifacts_create_artifact(
     vm_id="def-456",
     chat_id="abc-123",
     name="My React App",
     start_command="npm run dev -- --host",
     container_port=5173,
     working_directory="/work/my-react-app"
   )
   → Preview panel opens!
```

---

## CRITICAL: Working with Pre-Built/Compiled Projects

When you encounter a project with pre-compiled assets (like `assets/main.js` bundles), you **MUST** use the proper build toolchain. **NEVER** try to hack around it with CSS overrides or HTML injection.

### How to Identify Pre-Built Projects

Look for these signs:
- `build-manifest.json` or similar build output metadata
- Compiled JavaScript bundles in `assets/` or `dist/` folders
- Source files (`.tsx`, `.jsx`) that don't match what's being served
- The preview shows React/Vue/etc. but changes to source files have no effect

### The WRONG Approach (DO NOT DO THIS)

```
❌ WRONG: "This is a pre-built bundle. Let me inject CSS overrides into index.html..."
❌ WRONG: Adding <style> tags to override compiled component styles
❌ WRONG: Using !important CSS hacks to change appearance
❌ WRONG: Editing index.html to work around the build system
```

**Why this fails:** CSS hacks break the component styling system, cause visual glitches, and don't actually modify the source code. The screenshot shows what happens - broken layouts, incorrect colors, and unpredictable behavior.

### The RIGHT Approach (ALWAYS DO THIS)

**Prototype Studio projects include the full build toolchain.** Always rebuild properly:

```
✅ CORRECT Workflow:

1. Edit the SOURCE files (App.tsx, components/*.tsx, etc.):
   agent_vm_read_file(vm_id="...", path="/work/app/App.tsx")
   agent_vm_edit_file(vm_id="...", file_path="/work/app/App.tsx", old_string="...", new_string="...")

2. Rebuild the project:
   agent_vm_bash(vm_id="<dev_vm_id>", command="cd /work/app && npm run build")

3. Create a new version to see the changes:
   artifacts_create_artifact_version(artifact_id="...", chat_id="...", source_vm_id="<dev_vm_id>", version_note="Updated header")
```

### For Prototype Studio Projects Specifically

Prototype Studio exports include everything needed to rebuild:
- Full `node_modules` (or can run `npm install`)
- Build scripts in `package.json`
- Vite/webpack configuration

**Always run `npm run build` after editing source files!**

### Example: Changing a Header Style (Correct Way)

```
User: "Make the Portico header bigger and blue"

1. Read the source file:
   agent_vm_read_file(vm_id="abc-123", path="/work/app/App.tsx")

2. Edit the component (not the HTML!):
   agent_vm_edit_file(
     vm_id="abc-123",
     file_path="/work/app/App.tsx",
     old_string="<Heading level={1} sx={{ margin: 0, fontSize: 'text.size.xlarge' }}>",
     new_string="<Heading level={1} sx={{ margin: 0, fontSize: '2rem', color: 'white', backgroundColor: '#2164f3', padding: 4 }}>"
   )

3. Rebuild:
   agent_vm_bash(vm_id="abc-123", command="cd /work/app && npm run build")

4. Create version to see changes:
   artifacts_create_artifact_version(artifact_id="xyz-789", chat_id="...", source_vm_id="abc-123", version_note="Blue header")
```

---

## Iterating on Existing Artifacts (IMPORTANT)

When a user asks to modify an **existing artifact**, you MUST:

1. **Make code changes** using `agent_vm_read_file` + `agent_vm_edit_file` on your **DEVELOPMENT VM** (the VM from `agent_vm_create`)
2. **Create a new version** using `artifacts_create_artifact_version` with your development VM's ID

**CRITICAL: Always use your development VM for edits, NOT the artifact's internal VM.**
- Artifact tools (`artifacts_create_artifact`, `artifacts_create_artifact_version`, etc.) do NOT return VM IDs
- You only ever work with ONE VM: the development VM from `agent_vm_create`
- Artifact VMs are internal implementation details - you never interact with them directly

### Workflow: Modifying an Existing Artifact

```
User: "Add a dark mode toggle to my calculator app"
(Artifact already exists from earlier in the conversation)

1. Make the code changes (use YOUR DEVELOPMENT VM - the one from agent_vm_create):
   agent_vm_read_file(vm_id="<dev_vm_id>", path="style.css")
   agent_vm_edit_file(vm_id="<dev_vm_id>", file_path="style.css", old_string="...", new_string="...")
   agent_vm_read_file(vm_id="<dev_vm_id>", path="script.js")
   agent_vm_edit_file(vm_id="<dev_vm_id>", file_path="script.js", old_string="...", new_string="...")

2. Create a new version from your development VM:
   artifacts_create_artifact_version(
     artifact_id="ghi-789",
     chat_id="abc-123",
     source_vm_id="<dev_vm_id>",  # YOUR development VM!
     version_note="Added dark mode toggle"
   )
   → Version 2 created!
   → Preview automatically switches to new port showing updated code
```

### How Versions Work (New Architecture)
- **Each version is an immutable snapshot** - creating v2 preserves v1's files
- **The selected version is materialized for preview** - switching restores that snapshot into the artifact runtime workspace
- **The preview server restarts in an Agent VM Docker container** - the Electron preview updates only after the server is reachable

**Note:** The preview only updates when you create a new version. Code changes in the VM are not visible until `artifacts_create_artifact_version` is called.

### Why Create Versions?
- **Undo capability**: User can restore previous versions if they don't like the changes
- **Change history**: Each version documents what was modified
- **Safety net**: Never lose working code when experimenting

### Signs You Should Create a Version:
- User says "change", "modify", "update", "add", "remove", "fix" for an existing artifact
- User asks for new features on something they already previewed
- User wants to iterate on their app

---

## Edit Workflow (Read-Edit Pattern)

For making changes to existing files, use the **read-edit pattern**:

```
1. Read the file first (REQUIRED):
   agent_vm_read_file(vm_id="def-456", path="src/App.jsx")
   → File content displayed

2. Make targeted edit:
   agent_vm_edit_file(
     vm_id="def-456",
     file_path="src/App.jsx",
     old_string="<Button>Click me</Button>",
     new_string="<Button variant='primary'>Click me!</Button>"
   )
   → Edit applied successfully

3. Create version to apply changes and refresh preview:
   artifacts_create_artifact_version(artifact_id="...", chat_id="...", source_vm_id="<dev_vm_id>", version_note="Updated button style")
   → Preview now shows the updated button!
```

### Benefits of agent_vm_edit_file over agent_vm_create_file:
- No need to rewrite entire file
- Preserves formatting and structure
- Clear diff of what changed
- Less error-prone for large files
- Enforces read-before-edit safety

### DO NOT:
- Create extra download copies - the same chat workspace is already mounted at `/work`
- Call `artifacts_open_artifact` separately - `artifacts_create_artifact` auto-opens the panel
- Manually call `skills_activate_skill` or `mcp_assistant_activate_integration` - handled automatically
- Use multiple `agent_vm_create_file` calls - use `agent_vm_create_files` instead
- **Inject CSS hacks into index.html** to override compiled styles - this breaks layouts!
- **Skip the build step** for React/Vite/compiled projects - always run `npm run build`

### Example (Simple Calculator):
```
1. agent_vm_create(chat_id="abc-123")
   → vm_id: "def-456"

2. agent_vm_create_files(vm_id="def-456", files=[
     {path: "index.html", content: "<!DOCTYPE html>..."},
     {path: "style.css", content: "body {...}"},
     {path: "script.js", content: "function calculate() {...}"}
   ])
   → All 3 files created

3. artifacts_create_artifact(
     vm_id="def-456",
     chat_id="abc-123",
     name="Calculator",
     start_command="python -m http.server 5173",
     container_port=5173
   )
   → Preview panel opens automatically!
```

---

## Overview

Artifacts allow you to:
- Build web applications in an Agent VM
- Create live preview windows in the Electron app
- Run each artifact preview in an Agent VM Docker container with isolated ports
- Switch or restore versions by materializing immutable workspace snapshots
- Detach previews to separate windows

## Prerequisites

Before using artifacts, ensure you have:
1. A web application ready to serve (files in a VM or ready to create)
2. Both `agent-vm` and `artifacts` MCP servers enabled (auto-enabled when this skill is activated)

**Note:** You no longer need to pre-create a VM just to host artifacts. The `artifacts_create_artifact` tool runs the preview in an Agent VM Docker container. You typically still use a development VM to write and validate files first.

## Complete Workflow

### Step 1: Create a Development VM

```
Use agent_vm_create to create a VM for building your application.
This is your "workspace" for writing code.
```

### Step 2: Build Your Application

Inside the VM, install dependencies and set up your project:

```bash
# Example for a Vite React app
cd /work
npm create vite@latest my-app -- --template react
cd my-app
npm install
```

### Step 3: Create the Artifact

Once your application is ready to preview, create an artifact:

```
Use artifacts_create_artifact with:
- vm_id: (Optional) The development VM GUID - files will be copied from here
- chat_id: Current chat session ID
- name: Display name (e.g., "My Calculator App")
- start_command: Command to start the server (e.g., "npm run dev -- --host")
- container_port: Port the server runs on (default 5173 for Vite)
- working_directory: Directory inside /work where the command should run
```

**Important**: The `--host` flag is often needed to allow external access to the dev server.

### Step 4: View and Interact

The artifact will automatically:
1. Snapshot files from your development VM's `/work` when `vm_id` is provided, otherwise the resolved chat workspace root
2. Materialize the selected version into internal artifact storage outside the visible chat workspace
3. Allocate a host port (10000-19999 range)
4. Start the server in an Agent VM Docker container via remote execution
5. Open the preview panel in Electron

### Step 5: Create Versions (Optional)

After making changes in your development VM, save a new version:

```
Use artifacts_create_artifact_version with:
- artifact_id: The artifact ID
- chat_id: Current chat session ID
- source_vm_id: Your development VM ID
- version_note: Description of changes
```

**New Architecture**: Artifact versions are immutable workspace snapshots. Switching or restoring a version materializes that snapshot and restarts the preview server inside an Agent VM Docker container.
- Older versions are evicted when 6th is created (FIFO)

### Step 6: Switch Versions (Optional)

Switch to a different version:

```
Use artifacts_switch_artifact_version with:
- artifact_id: The artifact ID
- version: Version number to switch to
```

**Hot vs Cold Switching**:
- **Hot (in pool)**: If version's VM is still running, switch is instant
- **Cold (evicted)**: If version was evicted, new VM is created from snapshot

## Common Start Commands

| Framework | Start Command |
|-----------|---------------|
| Vite (React/Vue) | `npm run dev -- --host` |
| Create React App | `npm start` |
| Next.js | `npm run dev` |
| Angular | `ng serve --host 0.0.0.0` |
| Vue CLI | `npm run serve -- --host 0.0.0.0` |
| Python HTTP | `python -m http.server 5173` |
| Node HTTP | `npx http-server -p 5173` |

## Available Tools

### agent_vm_create_files (Recommended)
Create multiple files in the VM in a single operation. More efficient than multiple `agent_vm_create_file` calls.

**Parameters:**
- `vm_id` (required): VM GUID
- `files` (required): Array of file objects, each with:
  - `path`: File path (relative to /work or absolute)
  - `content`: File content as string

**Example:**
```json
{
  "vm_id": "def-456",
  "files": [
    {"path": "index.html", "content": "<!DOCTYPE html>..."},
    {"path": "style.css", "content": "body { margin: 0; }"},
    {"path": "app.js", "content": "console.log('Hello');"}
  ]
}
```

### agent_vm_read_files
Read multiple files from the VM in a single operation. More efficient than multiple `agent_vm_read_file` calls. Also registers files for the read-before-edit safeguard.

**Parameters:**
- `vm_id` (required): VM GUID
- `paths` (required): Array of file paths to read

**Example:**
```json
{
  "vm_id": "def-456",
  "paths": ["src/App.jsx", "src/index.css", "package.json"]
}
```

**Response:**
```json
{
  "success": true,
  "total": 3,
  "read_count": 3,
  "read": [
    {"path": "/work/src/App.jsx", "content": "import React..."},
    {"path": "/work/src/index.css", "content": "body {...}"},
    {"path": "/work/package.json", "content": "{...}"}
  ],
  "failed_count": 0,
  "failed": [],
  "message": "All 3 files read successfully"
}
```

### agent_vm_edit_file
Edit files using precise string replacement. **Requires reading the file first.**

**Parameters:**
- `vm_id` (required): VM GUID
- `file_path` (required): Path to file
- `old_string` (required): Exact text to replace (must be unique unless replace_all)
- `new_string` (required): Replacement text
- `replace_all` (default: false): Replace all occurrences

**Important:** You must call `agent_vm_read_file` first! The system enforces this.

**Example:**
```json
{
  "vm_id": "def-456",
  "file_path": "src/App.jsx",
  "old_string": "<h1>Hello</h1>",
  "new_string": "<h1>Hello World!</h1>"
}
```

### agent_vm_edit_files
Edit multiple files in a single operation. More efficient than multiple `agent_vm_edit_file` calls. **Each file must have been read first** (via `agent_vm_read_file` or `agent_vm_read_files`).

**Parameters:**
- `vm_id` (required): VM GUID
- `edits` (required): Array of edit operations, each with:
  - `file_path`: Path to file
  - `old_string`: Text to find and replace
  - `new_string`: Replacement text
  - `replace_all` (default: false): Replace all occurrences

**Example:**
```json
{
  "vm_id": "def-456",
  "edits": [
    {
      "file_path": "src/App.jsx",
      "old_string": "<h1>Hello</h1>",
      "new_string": "<h1>Hello World!</h1>"
    },
    {
      "file_path": "src/index.css",
      "old_string": "color: black",
      "new_string": "color: blue"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "total": 2,
  "edited_count": 2,
  "edited": [
    {"path": "/work/src/App.jsx", "replacements_made": 1},
    {"path": "/work/src/index.css", "replacements_made": 1}
  ],
  "failed_count": 0,
  "failed": [],
  "message": "All 2 edits applied successfully"
}
```

### agent_vm_find_files
Find files by glob pattern. Great for exploring uploaded projects.

**Parameters:**
- `vm_id` (required): VM GUID
- `pattern` (required): Glob pattern (e.g., `**/*.jsx`, `src/**/*.ts`)
- `path` (default: /work): Directory to search
- `max_results` (default: 100): Limit results

**Example:**
```json
{
  "vm_id": "def-456",
  "pattern": "**/*.{js,jsx,ts,tsx}"
}
```

**Response:**
```json
{
  "success": true,
  "files": ["/work/src/App.jsx", "/work/src/index.js"],
  "count": 2
}
```

### agent_vm_grep
Search file contents with regex patterns (like grep).

**Parameters:**
- `vm_id` (required): VM GUID
- `pattern` (required): Regex pattern
- `path` (default: /work): Directory to search
- `file_pattern`: Filter by file type (e.g., `*.jsx`)
- `case_insensitive` (default: false)
- `context_lines` (default: 0): Lines of context around match
- `max_results` (default: 50)
- `output_mode` (default: content): `content`, `files`, or `count`

**Example:**
```json
{
  "vm_id": "def-456",
  "pattern": "function.*handleClick",
  "file_pattern": "*.jsx"
}
```

**Response (content mode):**
```json
{
  "success": true,
  "matches": [
    "/work/src/App.jsx:15:  function handleClick() {",
    "/work/src/Button.jsx:8:  function handleClick(e) {"
  ],
  "count": 2
}
```

### agent_vm_unzip_file
Manually extract zip files. Note: Uploaded zips are auto-extracted, but this is useful for re-extraction or custom destinations.

**Parameters:**
- `vm_id` (required): VM GUID
- `zip_path` (required): Path to zip file
- `dest_path` (required): Extraction destination - **MUST be a subdirectory** like `/work/app` or `/work/myproject`, NOT just `/work`
- `strip_components` (default: 0): Remove leading path components (like tar)

**IMPORTANT:** The `dest_path` must be a specific subdirectory within `/work` or `/tmp`. Using just `/work` will fail with "Destination must be within /work or /tmp". Always specify a subdirectory like `/work/app`.

**Example (correct - uses subdirectory):**
```json
{
  "vm_id": "def-456",
  "zip_path": "/work/project.zip",
  "dest_path": "/work/app",
  "strip_components": 1
}
```

**Example (WRONG - will fail):**
```json
{
  "vm_id": "def-456",
  "zip_path": "/work/project.zip",
  "dest_path": "/work"
}
```

### artifacts_create_artifact
Create an artifact preview from the chat `/work` workspace. The system snapshots the selected workspace, materializes it into internal artifact storage, and starts the server in an Agent VM Docker container.

**Parameters:**
- `chat_id` (required): Chat session ID
- `name` (required): Display name
- `start_command` (required): Server start command
- `container_port` (default: 5173): Server port
- `description`: Optional description
- `working_directory` (default: /work): Working directory
- `version_note`: Initial version note
- `vm_id` (optional): Source Agent VM to snapshot from. If omitted, the current chat workspace is snapshotted.

**Returns:**
- `artifact_id`: The new artifact ID
- `host_port`: Port for preview access
- `status`: "running" only after the preview server is reachable

### artifacts_create_artifact_version
Snapshot current state as a new version and restart the preview in an Agent VM Docker container.

**Parameters:**
- `artifact_id` (required): Artifact ID
- `chat_id` (required): Chat session ID
- `source_vm_id` (required): Development Agent VM ID to snapshot
- `version_note`: Description of changes

**Returns:**
- `version`: New version number
- `host_port`: Port for preview access
- `status`: "running" only after the preview server is reachable

### artifacts_open_artifact
Open artifact in Electron panel.

**Parameters:**
- `artifact_id` (required): Artifact ID
- `version`: Specific version to view
- `detached` (default: false): Open in separate window

### artifacts_list_artifacts
List all artifacts for a chat.

**Parameters:**
- `chat_id` (required): Chat session ID
- `include_all_versions`: Include full version history

### artifacts_get_artifact_status
Get detailed artifact status.

**Parameters:**
- `artifact_id` (required): Artifact ID

### artifacts_close_artifact
Close panel and stop server.

**Parameters:**
- `artifact_id` (required): Artifact ID

### artifacts_delete_artifact
Permanently delete artifact and all versions.

**Parameters:**
- `artifact_id` (required): Artifact ID
- `chat_id` (required): Chat session ID
- `confirm` (required): Must be true

### artifacts_restore_artifact_version
Restore to a previous version.

**Parameters:**
- `artifact_id` (required): Artifact ID
- `version` (required): Version number
- `chat_id` (required): Chat session ID

### download_artifact
Export artifact as zip to workspace.

**Parameters:**
- `artifact_id` (required): Artifact ID
- `chat_id` (required): Chat session ID
- `version`: Version to export

## Best Practices

1. **Use descriptive names**: "Calculator App v1" is better than "test"
2. **Create version to see changes**: After modifying files in an existing artifact, call `artifacts_create_artifact_version` to refresh the preview with your changes
3. **Use SHORT version notes**: Keep notes under 50 characters (e.g., "Added dark mode", "Fixed layout"). Long notes get truncated.
4. **Close when done**: Always close artifacts when finished to stop the preview container and release ports
5. **Test before creating**: Make sure the app runs in the VM before creating an artifact
6. **Use agent_vm_edit_file for iterations**: Instead of recreating files with `agent_vm_create_file`, use `agent_vm_edit_file` for precise changes
7. **Always read before edit**: `agent_vm_read_file` must be called before `agent_vm_edit_file` (enforced by the system)
8. **Explore before modifying**: Use `agent_vm_find_files` and `agent_vm_grep` to understand project structure before making changes
9. **Uploaded zips are auto-extracted**: Files appear in `/work/{zip_name}/` automatically - no need to manually unzip
10. **Create versions for user-requested changes**: When a user asks to modify an existing artifact, always create a new version after making the changes
11. **ALWAYS rebuild compiled projects**: For React/Vite/Prototype Studio projects, run `npm run build` after editing source files. NEVER inject CSS hacks into index.html - it breaks the styling system!
12. **Use subdirectories for agent_vm_unzip_file**: The `dest_path` must be a subdirectory like `/work/app`, not just `/work`

## Troubleshooting

### Artifact won't start
- Check that the start command is correct
- Ensure the server binds to `0.0.0.0` or `--host`
- Verify `npm install` completed successfully
- Check the captured artifact startup error and server log summary

### Preview shows blank page
- Wait a few seconds for the dev server to compile
- Check the captured server log summary
- Try refreshing the preview

### Preview shows broken/weird styling (colors wrong, layout broken)
- **You probably injected CSS into index.html** - this is WRONG!
- CSS hacks conflict with the component styling system (IFL, styled-components, etc.)
- **Fix:** Revert the index.html changes, edit the actual source files (App.tsx, components/*.tsx), then run `npm run build`
- For Prototype Studio projects, always modify the TSX/JSX source and rebuild

### Port conflict
- **New architecture eliminates port conflicts!** Each version gets its own VM
- If you still see issues, check that the artifact VM was created successfully

### Version restore issues
- Snapshots exclude `node_modules` - run `npm install` after cold switch
- Check that the source VM had the files you expected when version was created

### Version switching slow
- **Hot switch (< 1 second)**: Version's VM is still in pool
- **Cold switch (a few seconds)**: VM was evicted, new VM being created from snapshot
- Pool holds max 5 VMs per artifact

## Example Session

### Simple Static Web App (3 steps!)

```
User: Build me a simple calculator app

1. Create Agent VM:
   agent_vm_create(chat_id="abc-123")
   → vm_id: "def-456"

2. Create all files at once:
   agent_vm_create_files(vm_id="def-456", files=[
     {path: "index.html", content: "<!DOCTYPE html><html>...calculator UI..."},
     {path: "style.css", content: "body { font-family: sans-serif; }..."},
     {path: "calculator.js", content: "function calculate() {...}"}
   ])
   → All 3 files created successfully

3. Create artifact (opens preview automatically):
   artifacts_create_artifact(
     vm_id="def-456",        // Snapshot files from dev VM /work
     chat_id="abc-123",
     name="Calculator",
     start_command="python -m http.server 5173",
     container_port=5173
   )
   → Artifact preview container started and validated
   → Files snapshotted from dev VM
   → Preview panel opens with live calculator!
```

### React/Vite App (when npm is needed)

```
User: Build me a React calculator app

1. Create Agent VM:
   agent_vm_create(chat_id="abc-123")
   → vm_id: "def-456"

2. Set up React project:
   agent_vm_bash(vm_id="def-456", command="cd /work && npm create vite@latest calculator -- --template react && cd calculator && npm install")

3. Create/modify component files:
   agent_vm_create_files(vm_id="def-456", files=[
     {path: "calculator/src/Calculator.jsx", content: "..."},
     {path: "calculator/src/Calculator.css", content: "..."}
   ])

4. Create artifact:
   artifacts_create_artifact(
     vm_id="def-456",        // Snapshot files from dev VM /work
     chat_id="abc-123",
     name="React Calculator",
     start_command="npm run dev -- --host",
     container_port=5173,
     working_directory="/work/calculator"
   )
   → Artifact preview container starts from the snapshot
   → Preview panel opens automatically!
```

### Saving Versions (optional)

After making changes in your development VM, save a new version:
```
artifacts_create_artifact_version(
  artifact_id="ghi-789",
  chat_id="abc-123",
  source_vm_id="def-456",
  version_note="Added history feature"
)
→ Version 2 snapshot is created and preview restarts after validation.
→ Version 1 VM still running (hot switchable)
→ Preview switches to new port automatically
```
