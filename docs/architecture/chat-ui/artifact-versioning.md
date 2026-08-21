# Artifact Versioning System Architecture

## Overview

The artifact versioning system supports a **VM pool model** where each artifact version gets its own isolated VM container, with up to 5 VMs per artifact (FIFO eviction), instant version switching for "hot" versions in the pool, and proper multi-artifact window management in the Electron app.

---

## Architecture Principles

1. **One VM Per Version**: Each artifact version gets its own isolated VM - no port conflicts possible
2. **VM Pool (FIFO)**: Each artifact maintains a pool of up to 5 VMs, one per version
3. **Auto-Create VMs**: Artifact tools automatically create/manage VMs - LLM does not need to provide `vm_id`
4. **Hot vs Cold Switching**: Versions in pool switch instantly; cold versions restore from snapshot in a new VM
5. **Per-Artifact Windows**: Each preview window tracks exactly one artifact's state
6. **Multiple Artifacts Per Chat**: A chat can have multiple artifacts, each with its own VM pool

---

## Part 1: Backend Changes

### 1.1 New Class: VMPoolManager

**File:** `src/managers/vm_pool_manager.py` (NEW)

Replaces the server pool concept with VM pool concept. Each artifact version gets its own isolated VM.

```python
@dataclass
class PooledVM:
    vm_id: str
    artifact_id: str
    version: int
    host_port: int
    snapshot_id: str
    created_at: float
    status: str  # "running", "stopped"

class VMPoolManager:
    MAX_VMS_PER_ARTIFACT = 5

    def __init__(self, redis_client, vm_manager, port_allocator, snapshot_manager):
        self.redis = redis_client
        self.vm_manager = vm_manager
        self.port_allocator = port_allocator
        self.snapshot_manager = snapshot_manager

    def get_pool(self, artifact_id: str) -> List[PooledVM]:
        """Get all VMs in pool for artifact (oldest first)."""

    def get_vm_for_version(self, artifact_id: str, version: int) -> Optional[PooledVM]:
        """Get existing VM for version if in pool (hot switch)."""

    async def create_vm_for_version(
        self,
        artifact_id: str,
        version: int,
        snapshot_id: str,
        start_command: str,
        container_port: int,
        workspace_path: str
    ) -> PooledVM:
        """
        Create new VM for artifact version.
        1. Evict oldest if pool full
        2. Create new VM
        3. Restore snapshot to VM
        4. Start server in VM
        5. Add to pool
        """

    async def evict_oldest(self, artifact_id: str) -> Optional[PooledVM]:
        """Stop and destroy oldest VM in pool."""

    async def switch_to_version(self, artifact_id: str, version: int) -> PooledVM:
        """
        Switch to version.
        - If in pool: return existing VM (hot)
        - If not in pool: create new VM (cold)
        """
```

**Redis Schema:**
```
artifact_vm_pool:{artifact_id} -> JSON array of PooledVM (oldest first for FIFO)
```

### 1.2 Remove ServerPoolManager

**File:** `src/managers/server_pool_manager.py`

Mark as deprecated or delete. The VMPoolManager replaces its functionality.

### 1.3 PortAllocator Changes

**File:** `src/managers/port_allocator.py`

Add per-artifact port allocation (ports are never reused after eviction):

```python
# New Redis keys
ARTIFACT_PORTS_PREFIX = "artifact_ports:"           # artifact_id -> Set of allocated ports
EVICTED_PORTS_KEY = "artifact_ports:evicted"  # Set of evicted ports (never reuse)

# New methods
def allocate_port_for_artifact(self, artifact_id: str) -> Optional[int]
def mark_port_evicted(self, port: int)
def release_artifact_ports(self, artifact_id: str) -> int
def get_artifact_ports(self, artifact_id: str) -> List[int]
```

### 1.4 ArtifactManager Changes

**File:** `src/managers/artifact_manager.py`

#### Remove VM Binding Concept
- Remove `bound_vm_id` field from Artifact dataclass
- Remove `bind_vm_to_artifact()`, `get_bound_artifact()`, `get_bound_vm()`

#### Add VMPoolManager Integration
```python
def init_vm_pool(self, vm_pool_manager: VMPoolManager):
    self.vm_pool = vm_pool_manager
```

#### Modified create_artifact()
```python
async def create_artifact(
    self,
    chat_id: str,
    name: str,
    start_command: str,
    container_port: int,
    description: str = "",
    version_note: str = ""
) -> Dict:
    """
    1. Generate artifact_id
    2. Create artifact record
    3. Create VM via VMPoolManager (auto)
    4. Return artifact info with vm_id, host_port
    """
```
Remove `vm_id` parameter - VM is created automatically.

#### Modified create_version()
```python
async def create_version(
    self,
    artifact_id: str,
    version_note: str = ""
) -> Dict:
    """
    1. Get artifact and its start_command/container_port
    2. Create snapshot of current workspace
    3. Create new VM via VMPoolManager
    4. Start server in new VM
    5. Update artifact current_version
    6. Return version info with new host_port
    """
```

#### Modified switch_artifact_version()
```python
async def switch_artifact_version(
    self,
    artifact_id: str,
    version: int
) -> Dict:
    """
    1. Check if version in pool (hot switch)
    2. If not, create new VM (cold switch, may evict oldest)
    3. Update artifact current_version and host_port
    4. Return switch result with from_pool flag
    """
```

#### New get_running_versions()
```python
def get_running_versions(self, artifact_id: str) -> Dict[int, int]:
    """Returns {version: host_port} for all running versions in the VM pool."""
```

### 1.5 Artifact Data Model Changes

**File:** `src/managers/artifact_manager.py` - Artifact dataclass

Remove `bound_vm_id` field (VMs are now managed per-version in the pool):
```python
@dataclass
class Artifact:
    # ... existing fields ...
    # REMOVED: bound_vm_id: Optional[str] = None
```

### 1.6 MCP Tool Changes

**File:** `src/core-mcp-rust/artifacts/src/artifacts_server/tools.py`

#### Remove vm_id from create_artifact
```python
# BEFORE
@tool()
async def create_artifact(
    vm_id: str,
    chat_id: str,
    name: str,
    ...
)

# AFTER
@tool()
async def create_artifact(
    chat_id: str,
    name: str,
    start_command: str,
    container_port: int,
    description: str = "",
    version_note: str = ""
)
```

#### Update get_managers() to init VMPoolManager
```python
def get_managers():
    global _artifact_manager, _vm_manager, _port_allocator, _snapshot_manager, _vm_pool_manager

    if _artifact_manager is None:
        # ... existing imports ...
        from managers.vm_pool_manager import VMPoolManager

        _vm_manager = get_agent_vm_manager()
        _port_allocator = get_port_allocator()
        _snapshot_manager = get_snapshot_manager(vm_manager=_vm_manager)

        # Initialize VM pool manager
        _vm_pool_manager = VMPoolManager(
            redis_client=None,  # auto-connect
            vm_manager=_vm_manager,
            port_allocator=_port_allocator,
            snapshot_manager=_snapshot_manager,
        )

        _artifact_manager = get_artifact_manager(...)
        _artifact_manager.init_vm_pool(_vm_pool_manager)
```

#### Update create_artifact response:
```json
{
  "success": true,
  "artifact_id": "...",
  "vm_id": "...",
  "host_port": 17640,
  "status": "running",
  "message": "Artifact created with dedicated VM"
}
```

#### Update create_artifact_version response:
```json
{
  "success": true,
  "version": 2,
  "vm_id": "...",
  "host_port": 17641,
  "from_pool": false,
  "evicted_version": null,
  "message": "Version 2 created with dedicated VM on port 17641"
}
```

#### Update switch_artifact_version response:
```json
{
  "success": true,
  "version": 3,
  "vm_id": "...",
  "host_port": 17642,
  "from_pool": true,
  "evicted_version": null,
  "message": "Switched to version 3 (hot)"
}
```

#### New tool: get_artifact_running_versions
```json
{
  "success": true,
  "artifact_id": "...",
  "running_versions": [
    {"version": 1, "vm_id": "...", "host_port": 17640, "created_at": 1704067200},
    {"version": 2, "vm_id": "...", "host_port": 17641, "created_at": 1704067300}
  ],
  "pool_capacity": 5,
  "pool_used": 2
}
```

---

## Part 2: Electron Changes

### 2.1 New IPC Handlers

**File:** `electron-app/src/services/ipc.js`

```javascript
// Get running versions for an artifact
ipcMain.handle('artifact-get-running-versions', async (event, { artifactId }) => {...})

// Ping servers to check health (for green indicators)
ipcMain.handle('artifact-ping-servers', async (event, { ports }) => {...})

// Open artifact (with smart window management)
ipcMain.handle('artifact-open-smart', async (event, { artifactId, chatId }) => {
  // 1. Check if window already exists for this artifact -> focus it
  // 2. Check if side panel is empty -> open there
  // 3. Otherwise -> open new detached window
})
```

### 2.2 Preload API

**File:** `electron-app/src/services/preload.js`

```javascript
artifacts: {
  // ... existing ...
  getRunningVersions: (artifactId) => ipcRenderer.invoke('artifact-get-running-versions', { artifactId }),
  pingServers: (ports) => ipcRenderer.invoke('artifact-ping-servers', { ports }),
  openSmart: (artifactId, chatId) => ipcRenderer.invoke('artifact-open-smart', { artifactId, chatId }),
}
```

### 2.3 Artifact Panel Enhancements

**File:** `electron-app/src/renderer/components/artifact-panel.js`

```javascript
class ArtifactPanel {
  constructor() {
    // ... existing ...
    this.runningVersions = new Map();  // version -> {host_port, isRunning}
    this.healthCheckInterval = null;
  }

  async open(...) {
    // ... existing ...
    await this.fetchRunningVersions();
    this.startHealthChecks();
  }

  async fetchRunningVersions() {
    // Call getRunningVersions API, populate this.runningVersions
  }

  startHealthChecks() {
    // Every 5 seconds: ping all ports, update isRunning status
    this.healthCheckInterval = setInterval(async () => {
      const ports = [...this.runningVersions.values()].map(v => v.host_port);
      const health = await window.electronAPI.artifacts.pingServers(ports);
      // Update indicators
    }, 5000);
  }

  updateVersionIndicators() {
    // Add green dot for running versions, gray circle for stopped
  }

  close() {
    this.stopHealthChecks();
    // ... existing ...
  }
}
```

### 2.4 Artifact Indicator Multi-Artifact Support

**File:** `electron-app/src/renderer/components/artifact-indicator.js`

Update the menu to handle multiple artifacts per chat:

```javascript
handleArtifactClick(artifact) {
  // Smart window management:
  // 1. If window exists for artifact -> focus it
  // 2. If side panel empty -> open there
  // 3. Else -> open new detached window
  window.electronAPI.artifacts.openSmart(artifact.artifact_id, artifact.chat_id);
}
```

### 2.5 Window Management State

**File:** `electron-app/src/services/shared-state.js`

```javascript
// Track which artifact each window is showing
// Map<windowId, artifactId>
const windowArtifactMap = new Map();

// Track server health per artifact
// Map<artifactId, { versions: Map<version, {host_port, isRunning}> }>
const artifactServerState = new Map();
```

### 2.6 CSS for Running Indicators

**File:** `electron-app/src/styles.css`

```css
#artifact-version-select option.version-running {
  color: #22c55e;  /* Green */
}
#artifact-version-select option.version-stopped {
  color: #9ca3af;  /* Gray */
}
```

---

## Part 3: Data Flow

### Artifact Creation
```
1. LLM calls create_artifact(chat_id, name, start_command, container_port, ...)
   NOTE: vm_id is NOT provided - it's auto-created
2. ArtifactManager generates artifact_id
3. VMPoolManager.create_vm_for_version() called:
   a. Creates new VM
   b. Mounts workspace
   c. Allocates host port
   d. Starts server
   e. Adds VM to pool
4. Returns {artifact_id, vm_id, host_port, status: "running"}
5. Electron receives artifact-created signal with host_port
```

### New Version Creation
```
1. LLM calls create_artifact_version(artifact_id, version_note)
2. ArtifactManager creates snapshot of current workspace
3. VMPoolManager.create_vm_for_version() called:
   a. Evicts oldest VM if pool full (5 VMs)
   b. Creates new VM
   c. Restores snapshot to new VM
   d. Starts server on new VM (different container = no port collision!)
   e. Allocates new host port
   f. Adds VM to pool
4. Returns {version, vm_id, host_port, evicted_version}
5. Backend signals Electron: artifact-version-changed with new host_port
6. Electron updates preview to new port
7. Electron refreshes version list with running indicators
```

### Version Switching (Hot - in pool)
```
1. User selects version from dropdown
2. Electron calls switch_artifact_version(artifact_id, version)
3. VMPoolManager finds existing VM for version -> instant
4. Backend returns {version, vm_id, host_port, from_pool: true}
5. Electron switches preview to existing port (instant!)
```

### Version Switching (Cold - not in pool)
```
1. User selects version not in pool
2. VMPoolManager.switch_to_version() called:
   a. Evicts oldest VM
   b. Creates new VM
   c. Restores version's snapshot
   d. Starts server
3. Backend returns {version, vm_id, host_port, from_pool: false, evicted_version: N}
4. Electron updates preview to new port
5. Electron updates indicators (evicted version now "cold"/gray)
```

### Health Monitoring
```
Every 5 seconds per artifact window:
1. Get list of ports from runningVersions map
2. Call pingServers(ports)
3. Update isRunning for each version
4. Update UI indicators (green/gray)
5. If a VM dies unexpectedly, show gray indicator
```

---

## Part 4: Files Modified

| File | Changes |
|------|---------|
| `src/managers/vm_pool_manager.py` | **NEW FILE** - VM pool FIFO management (replaces ServerPoolManager) |
| `src/managers/server_pool_manager.py` | **DEPRECATED/REMOVED** - Replaced by VMPoolManager |
| `src/managers/port_allocator.py` | Per-artifact port allocation, evicted port tracking |
| `src/managers/artifact_manager.py` | Remove VM binding, add VMPoolManager, update create/switch (vm_id auto-created) |
| `src/core-mcp-rust/artifacts/src/artifacts_server/tools.py` | Remove vm_id param from create_artifact, init VMPoolManager, updated responses |
| `electron-app/src/services/ipc.js` | New IPC handlers |
| `electron-app/src/services/preload.js` | New API methods |
| `electron-app/src/services/shared-state.js` | Window-artifact mapping |
| `electron-app/src/renderer/components/artifact-panel.js` | Health checks, indicators |
| `electron-app/src/renderer/components/artifact-indicator.js` | Smart window management |
| `electron-app/src/styles.css` | Running indicators CSS |

---

## Test Scenarios

### Test Scenario 1: New Artifact Creation
1. Create artifact via LLM (no vm_id provided)
2. Verify response includes auto-created `vm_id`
3. Verify `host_port` allocated
4. Verify preview shows running app
5. Verify status is "running" not "stopped"

### Test Scenario 2: Version Creation (No Port Collision)
1. Create artifact v1 on port A
2. Modify code and create v2
3. Verify v2 gets **different** port B (new VM)
4. Verify v2 preview shows updated code
5. Verify v1 still running on port A (still in pool)

### Test Scenario 3: VM Pool Eviction (FIFO)
1. Create artifact with v1, v2, v3, v4, v5 (5 VMs in pool)
2. Create v6 -> v1 VM should be evicted (FIFO)
3. Verify v1 VM stopped/destroyed
4. Verify v2-v6 still in pool

### Test Scenario 4: Hot vs Cold Switching
1. Create artifact with v1, v2, v3
2. Switch to v2 -> should be instant (from_pool: true)
3. Switch to v1 -> should be instant (from_pool: true)
4. Create v4, v5, v6 (evicts v1)
5. Switch to v1 -> should be cold (from_pool: false, new VM created)

### Test Scenario 5: Health Monitoring
1. Open artifact panel
2. Verify green indicators for running versions (VMs in pool)
3. Manually stop a VM container
4. Wait 5 seconds -> verify indicator turns gray

### Test Scenario 6: Multi-Artifact
1. Create first artifact -> opens in side panel
2. Create second artifact -> opens in new window (side panel occupied)
3. Click first artifact badge -> focuses side panel
4. Click second artifact badge -> focuses detached window
5. Close side panel -> click first artifact -> opens in side panel again

### Console Log Verification
- `[Artifacts] Created VM {vm_id} for artifact {artifact_id} v{version}`
- `[Artifacts] Pool for {artifact_id}: {n} VMs`
- `[Artifacts] Evicted VM {vm_id} (v{version}) from pool`
- `[Artifacts] Hot switch to v{version} on port {port}`
- `[Artifacts] Cold switch to v{version}, created VM {vm_id}`

---

## Notes

- Each artifact version gets its own isolated VM - no port conflicts possible
- LLM no longer needs to track or provide `vm_id` **for Artifact tools specifically**
- Pool management happens automatically for artifacts
- Ports are allocated per-VM, not per-server-in-VM
- Ports are NEVER reused after eviction (per spec)
- Snapshots work the same way (restore to VM workspace)
- **General VM management unchanged**: LLM can still use `AgentVMManager` tools directly for other purposes
- VMPoolManager is artifact-specific; it uses AgentVMManager under the hood to create/manage VMs
- Health pings use HEAD request to localhost:{port}/
- Each artifact window is independent and tracks its own state
