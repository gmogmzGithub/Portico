"""
Server Pool Manager for Artifact Versioning

DEPRECATED: This module is replaced by VMPoolManager.
See src/managers/vm_pool_manager.py for the new implementation.

The old architecture tried to run multiple servers on different ports
inside a single VM, which caused port collision issues. The new
architecture uses one VM per artifact version instead.

This file is kept for backwards compatibility but should not be used
for new implementations.

---

Old Description:
Manages a FIFO pool of running version servers per Agent VM.
Each VM can run up to MAX_SERVERS_PER_VM concurrent servers,
each serving a different artifact version.

Key concepts:
- Each server runs on a unique internal port (5173-5177)
- When pool is full, oldest server is evicted (FIFO)
- Evicted ports are released but never reused globally
- Hot switching: versions in pool switch instantly
- Cold switching: versions not in pool restore from snapshot

Usage:
    pool_manager = ServerPoolManager(redis_client, vm_manager, port_allocator)

    # Add a new version server
    server = await pool_manager.add_server(vm_id, version=2, snapshot_path="...", artifact_id="...")

    # Check if version is running
    server = pool_manager.get_server_for_version(vm_id, version=2)

    # Get all running servers
    servers = pool_manager.get_pool(vm_id)
"""
import warnings

warnings.warn(
    "server_pool_manager is deprecated, use vm_pool_manager instead",
    DeprecationWarning,
    stacklevel=2,
)

import os
import json
import logging
import time
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, field

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

logger = logging.getLogger(__name__)

LOG_PREFIX = "[ServerPool]"


@dataclass
class RunningServer:
    """
    Represents a running version server in the pool.

    Each server hosts a specific version of an artifact
    and runs on a unique internal port within the VM.
    """
    version: int                    # Artifact version number
    host_port: int                  # Host port (accessible from Electron)
    internal_port: int              # Container port (inside the VM)
    snapshot_path: str              # Path to the snapshot this version runs from
    started_at: float               # Timestamp when server was started
    pid: Optional[int] = None       # Process ID of the server (for killing)
    start_command: str = ""         # Command used to start the server

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "host_port": self.host_port,
            "internal_port": self.internal_port,
            "snapshot_path": self.snapshot_path,
            "started_at": self.started_at,
            "pid": self.pid,
            "start_command": self.start_command,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RunningServer":
        return cls(
            version=data["version"],
            host_port=data["host_port"],
            internal_port=data["internal_port"],
            snapshot_path=data["snapshot_path"],
            started_at=data["started_at"],
            pid=data.get("pid"),
            start_command=data.get("start_command", ""),
        )


class ServerPoolManager:
    """
    Manages FIFO pool of running version servers per Agent VM.

    Each VM can run up to MAX_SERVERS_PER_VM concurrent servers.
    When the pool is full, the oldest server is evicted to make room.
    """

    # Maximum servers per VM
    MAX_SERVERS_PER_VM = 5

    # Internal ports used by version servers (container-side)
    # These map to dynamically allocated host ports
    INTERNAL_PORTS = [5173, 5174, 5175, 5176, 5177]

    # Redis key prefixes
    POOL_KEY_PREFIX = "vm_server_pool:"  # vm_id -> JSON array of servers
    VM_PORTS_KEY_PREFIX = "vm_allocated_ports:"  # vm_id -> JSON dict of internal->host port mappings

    def __init__(
        self,
        redis_client=None,
        vm_manager=None,
        port_allocator=None,
        snapshot_manager=None,
    ):
        """
        Initialize the ServerPoolManager.

        Args:
            redis_client: Redis client for persistence
            vm_manager: AgentVMManager for executing commands in VMs
            port_allocator: PortAllocator for host port allocation
            snapshot_manager: SnapshotManager for restoring version snapshots
        """
        self.redis_client = redis_client
        if self.redis_client is None and REDIS_AVAILABLE:
            try:
                self.redis_client = redis.Redis(
                    host=os.environ.get("REDIS_HOST", "redis"),
                    port=int(os.environ.get("REDIS_PORT", 6379)),
                    db=0,
                    decode_responses=True,
                    socket_connect_timeout=5,
                )
                self.redis_client.ping()
                logger.info(f"{LOG_PREFIX} Connected to Redis")
            except Exception as e:
                logger.warning(f"{LOG_PREFIX} Could not connect to Redis: {e}")
                self.redis_client = None

        self.vm_manager = vm_manager
        self.port_allocator = port_allocator
        self.snapshot_manager = snapshot_manager

        # In-memory fallback if Redis unavailable
        self._local_pools: Dict[str, List[RunningServer]] = {}
        self._local_port_mappings: Dict[str, Dict[int, int]] = {}  # vm_id -> {internal: host}

    # =========================================================================
    # Pool Management
    # =========================================================================

    def get_pool(self, vm_id: str) -> List[RunningServer]:
        """
        Get all running servers for a VM.

        Returns servers in FIFO order: oldest at index 0.
        """
        if self.redis_client:
            try:
                key = f"{self.POOL_KEY_PREFIX}{vm_id}"
                data = self.redis_client.get(key)
                if data:
                    servers = json.loads(data)
                    return [RunningServer.from_dict(s) for s in servers]
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get pool from Redis: {e}")

        return list(self._local_pools.get(vm_id, []))

    def _save_pool(self, vm_id: str, pool: List[RunningServer]):
        """Save pool to Redis and local cache."""
        self._local_pools[vm_id] = pool

        if self.redis_client:
            try:
                key = f"{self.POOL_KEY_PREFIX}{vm_id}"
                data = json.dumps([s.to_dict() for s in pool])
                self.redis_client.set(key, data)
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to save pool to Redis: {e}")

    def get_server_for_version(self, vm_id: str, version: int) -> Optional[RunningServer]:
        """
        Check if a version is currently running in the pool.

        Returns the server info if found, None otherwise.
        """
        pool = self.get_pool(vm_id)
        for server in pool:
            if server.version == version:
                return server
        return None

    def get_pool_size(self, vm_id: str) -> int:
        """Get current number of running servers in the pool."""
        return len(self.get_pool(vm_id))

    def is_pool_full(self, vm_id: str) -> bool:
        """Check if the pool is at capacity."""
        return self.get_pool_size(vm_id) >= self.MAX_SERVERS_PER_VM

    # =========================================================================
    # Port Management
    # =========================================================================

    def get_vm_port_mappings(self, vm_id: str) -> Dict[int, int]:
        """
        Get the internal->host port mappings for a VM.

        Returns dict like {5173: 10001, 5174: 10002, ...}
        """
        if self.redis_client:
            try:
                key = f"{self.VM_PORTS_KEY_PREFIX}{vm_id}"
                data = self.redis_client.get(key)
                if data:
                    return {int(k): v for k, v in json.loads(data).items()}
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get port mappings from Redis: {e}")

        return dict(self._local_port_mappings.get(vm_id, {}))

    def _save_vm_port_mappings(self, vm_id: str, mappings: Dict[int, int]):
        """Save VM port mappings to Redis and local cache."""
        self._local_port_mappings[vm_id] = mappings

        if self.redis_client:
            try:
                key = f"{self.VM_PORTS_KEY_PREFIX}{vm_id}"
                self.redis_client.set(key, json.dumps(mappings))
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to save port mappings to Redis: {e}")

    def allocate_ports_for_vm(self, vm_id: str) -> Dict[int, int]:
        """
        Pre-allocate host ports for all internal ports.

        Call this when creating an artifact VM to set up the 5 port mappings.
        Returns dict like {5173: 10001, 5174: 10002, ...}
        """
        existing = self.get_vm_port_mappings(vm_id)
        if existing:
            logger.info(f"{LOG_PREFIX} VM {vm_id} already has port mappings")
            return existing

        if not self.port_allocator:
            logger.error(f"{LOG_PREFIX} No port allocator available")
            return {}

        mappings = {}
        for internal_port in self.INTERNAL_PORTS:
            host_port = self.port_allocator.allocate_port_for_vm(vm_id)
            if host_port:
                mappings[internal_port] = host_port
                logger.info(f"{LOG_PREFIX} Allocated {internal_port} -> {host_port} for VM {vm_id}")
            else:
                logger.error(f"{LOG_PREFIX} Failed to allocate host port for internal port {internal_port}")
                break

        if mappings:
            self._save_vm_port_mappings(vm_id, mappings)

        return mappings

    def get_available_internal_port(self, vm_id: str) -> Optional[int]:
        """
        Get an available internal port for a new server.

        Returns the first internal port not currently in use by a running server.
        """
        pool = self.get_pool(vm_id)
        used_ports = {s.internal_port for s in pool}

        for port in self.INTERNAL_PORTS:
            if port not in used_ports:
                return port

        return None

    def get_host_port_for_internal(self, vm_id: str, internal_port: int) -> Optional[int]:
        """Get the host port mapped to an internal port."""
        mappings = self.get_vm_port_mappings(vm_id)
        return mappings.get(internal_port)

    # =========================================================================
    # Server Lifecycle
    # =========================================================================

    async def add_server(
        self,
        vm_id: str,
        version: int,
        snapshot_path: str,
        artifact_id: str,
        start_command: str,
        working_directory: str = "/work",
    ) -> Tuple[Optional[RunningServer], Optional[int]]:
        """
        Add a new version server to the pool.

        If pool is full, evicts the oldest server first (FIFO).
        Restores the snapshot and starts the server.

        Args:
            vm_id: The Agent VM ID
            version: Artifact version number
            snapshot_path: Path to the version's snapshot
            artifact_id: The artifact ID (for context)
            start_command: Command to start the server (e.g., "npm run dev")
            working_directory: Working directory for the server

        Returns:
            Tuple of (RunningServer info or None, evicted_version or None)
        """
        logger.info(f"{LOG_PREFIX} Adding server for version {version} to VM {vm_id}")

        # Check if version already running
        existing = self.get_server_for_version(vm_id, version)
        if existing:
            logger.info(f"{LOG_PREFIX} Version {version} already running on port {existing.host_port}")
            return (existing, None)

        pool = self.get_pool(vm_id)

        # Evict oldest if at capacity
        evicted = None
        evicted_version = None
        if len(pool) >= self.MAX_SERVERS_PER_VM:
            evicted = await self._evict_oldest(vm_id, pool)
            if evicted:
                evicted_version = evicted.version
                logger.info(f"{LOG_PREFIX} Evicted version {evicted.version} to make room")

        # Get available internal port
        internal_port = self.get_available_internal_port(vm_id)
        if not internal_port:
            logger.error(f"{LOG_PREFIX} No available internal port for VM {vm_id}")
            return (None, evicted_version)

        # Get host port for this internal port
        host_port = self.get_host_port_for_internal(vm_id, internal_port)
        if not host_port:
            logger.error(f"{LOG_PREFIX} No host port mapped for internal port {internal_port}")
            return (None, evicted_version)

        # Restore snapshot to a version-specific directory
        version_dir = f"{working_directory}/v{version}"
        if self.snapshot_manager:
            try:
                await self._restore_snapshot_to_directory(
                    vm_id, snapshot_path, version_dir
                )
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to restore snapshot: {e}")
                return (None, evicted_version)

        # Start the server on the internal port
        pid = await self._start_server_process(
            vm_id=vm_id,
            working_directory=version_dir,
            start_command=start_command,
            internal_port=internal_port,
        )

        if not pid:
            logger.error(f"{LOG_PREFIX} Failed to start server for version {version}")
            return (None, evicted_version)

        # Create server entry
        server = RunningServer(
            version=version,
            host_port=host_port,
            internal_port=internal_port,
            snapshot_path=snapshot_path,
            started_at=time.time(),
            pid=pid,
            start_command=start_command,
        )

        # Add to pool (append = newest at end)
        pool = self.get_pool(vm_id)  # Re-fetch in case of concurrent modifications
        pool.append(server)
        self._save_pool(vm_id, pool)

        logger.info(
            f"{LOG_PREFIX} Started version {version} server: "
            f"internal={internal_port}, host={host_port}, pid={pid}"
        )

        return (server, evicted_version)

    async def _evict_oldest(
        self, vm_id: str, pool: List[RunningServer]
    ) -> Optional[RunningServer]:
        """
        Evict the oldest server from the pool (FIFO).

        Stops the server process and releases resources.
        Note: Port is NOT made available for reuse (per spec).
        """
        if not pool:
            return None

        oldest = pool.pop(0)  # FIFO: remove from front

        # Stop the server process
        await self._stop_server_process(vm_id, oldest.pid, oldest.internal_port)

        # Mark port as evicted (never reuse)
        if self.port_allocator:
            self.port_allocator.mark_port_evicted(oldest.host_port)

        # Save updated pool
        self._save_pool(vm_id, pool)

        logger.info(
            f"{LOG_PREFIX} Evicted version {oldest.version} "
            f"(was on port {oldest.host_port})"
        )

        return oldest

    async def remove_server(self, vm_id: str, version: int) -> bool:
        """
        Remove a specific version server from the pool.

        Returns True if server was found and removed.
        """
        pool = self.get_pool(vm_id)

        for i, server in enumerate(pool):
            if server.version == version:
                # Stop the server
                await self._stop_server_process(vm_id, server.pid, server.internal_port)

                # Remove from pool
                pool.pop(i)
                self._save_pool(vm_id, pool)

                logger.info(f"{LOG_PREFIX} Removed version {version} from pool")
                return True

        return False

    async def clear_pool(self, vm_id: str):
        """Stop all servers and clear the pool for a VM."""
        pool = self.get_pool(vm_id)

        for server in pool:
            await self._stop_server_process(vm_id, server.pid, server.internal_port)

        self._save_pool(vm_id, [])
        logger.info(f"{LOG_PREFIX} Cleared pool for VM {vm_id}")

    # =========================================================================
    # Internal Process Management
    # =========================================================================

    async def _restore_snapshot_to_directory(
        self, vm_id: str, snapshot_path: str, target_dir: str
    ):
        """
        Restore a snapshot to a specific directory in the VM.

        Creates the directory and extracts the snapshot there.
        """
        if not self.vm_manager:
            raise RuntimeError("No VM manager available")

        # Create target directory
        result = self.vm_manager.execute_bash(
            vm_id,
            f"mkdir -p {target_dir}",
            timeout_seconds=10,
        )
        if not result.success:
            raise RuntimeError(f"Failed to create directory: {result.stderr}")

        # Use snapshot manager to restore
        if self.snapshot_manager:
            # The snapshot manager handles extracting to the VM's workspace
            # We need to restore to a subdirectory
            restore_result = self.snapshot_manager.restore_snapshot(
                vm_id=vm_id,
                snapshot_path=snapshot_path,
                target_directory=target_dir,
            )
            if not restore_result:
                raise RuntimeError(f"Snapshot restore failed for {snapshot_path}")

    async def _start_server_process(
        self,
        vm_id: str,
        working_directory: str,
        start_command: str,
        internal_port: int,
    ) -> Optional[int]:
        """
        Start a server process in the VM.

        Uses nohup to keep the process running and returns the PID.
        The server is configured to listen on the specified internal port.
        """
        if not self.vm_manager:
            logger.error(f"{LOG_PREFIX} No VM manager available")
            return None

        # Modify start command to use the specific port
        # Common patterns: npm (--port), python http.server (port arg), vite (--port)
        port_command = self._inject_port_into_command(start_command, internal_port)

        # Start server with nohup, capture PID
        # Use a unique log file per port to avoid conflicts
        log_file = f"/tmp/server_{internal_port}.log"
        pid_file = f"/tmp/server_{internal_port}.pid"

        bash_command = (
            f"cd {working_directory} && "
            f"nohup {port_command} > {log_file} 2>&1 & "
            f"echo $! > {pid_file} && cat {pid_file}"
        )

        result = self.vm_manager.execute_bash(
            vm_id,
            bash_command,
            timeout_seconds=30,
        )

        if not result.success:
            logger.error(f"{LOG_PREFIX} Failed to start server: {result.stderr}")
            return None

        # Parse PID from output
        try:
            pid = int(result.stdout.strip())
            logger.info(f"{LOG_PREFIX} Started server with PID {pid}")
            return pid
        except ValueError:
            logger.error(f"{LOG_PREFIX} Could not parse PID from: {result.stdout}")
            return None

    def _inject_port_into_command(self, command: str, port: int) -> str:
        """
        Modify the start command to use a specific port.

        Handles common patterns:
        - npm/vite: adds --port
        - python http.server: replaces port number
        - Generic: adds PORT env var
        """
        command = command.strip()

        # Python http.server: "python -m http.server 5173" -> replace port
        if "http.server" in command:
            # Replace the port number at the end
            parts = command.split()
            if parts[-1].isdigit():
                parts[-1] = str(port)
                return " ".join(parts)
            else:
                return f"{command} {port}"

        # npm/vite/etc: add --port flag if not present
        if "npm" in command or "vite" in command or "dev" in command:
            if "--port" not in command:
                return f"{command} --port {port}"
            else:
                # Replace existing port
                import re
                return re.sub(r"--port\s+\d+", f"--port {port}", command)

        # Generic: prepend PORT environment variable
        return f"PORT={port} {command}"

    async def _stop_server_process(
        self, vm_id: str, pid: Optional[int], internal_port: int
    ):
        """
        Stop a server process by PID or by port.

        Tries PID first, then falls back to killing by port.
        """
        if not self.vm_manager:
            return

        if pid:
            # Try killing by PID
            result = self.vm_manager.execute_bash(
                vm_id,
                f"kill -9 {pid} 2>/dev/null || true",
                timeout_seconds=10,
            )
            if result.success:
                logger.info(f"{LOG_PREFIX} Killed process {pid}")
                return

        # Fallback: kill by port
        result = self.vm_manager.execute_bash(
            vm_id,
            f"fuser -k {internal_port}/tcp 2>/dev/null || true",
            timeout_seconds=10,
        )
        logger.info(f"{LOG_PREFIX} Killed processes on port {internal_port}")

    # =========================================================================
    # Utility Methods
    # =========================================================================

    def get_running_versions(self, vm_id: str) -> Dict[int, int]:
        """
        Get all running versions and their host ports.

        Returns dict like {1: 10001, 2: 10002}
        """
        pool = self.get_pool(vm_id)
        return {s.version: s.host_port for s in pool}

    def is_version_running(self, vm_id: str, version: int) -> bool:
        """Check if a specific version is currently running."""
        return self.get_server_for_version(vm_id, version) is not None

    def get_pool_info(self, vm_id: str) -> Dict[str, Any]:
        """
        Get summary info about the pool.

        Useful for debugging and UI display.
        """
        pool = self.get_pool(vm_id)
        return {
            "vm_id": vm_id,
            "pool_size": len(pool),
            "max_size": self.MAX_SERVERS_PER_VM,
            "running_versions": [
                {
                    "version": s.version,
                    "host_port": s.host_port,
                    "started_at": s.started_at,
                }
                for s in pool
            ],
            "oldest_version": pool[0].version if pool else None,
            "newest_version": pool[-1].version if pool else None,
        }


# Singleton instance
_server_pool_manager: Optional[ServerPoolManager] = None


def get_server_pool_manager() -> ServerPoolManager:
    """Get the singleton ServerPoolManager instance."""
    global _server_pool_manager
    if _server_pool_manager is None:
        _server_pool_manager = ServerPoolManager()
    return _server_pool_manager


def init_server_pool_manager(
    redis_client=None,
    vm_manager=None,
    port_allocator=None,
    snapshot_manager=None,
) -> ServerPoolManager:
    """Initialize the ServerPoolManager with dependencies."""
    global _server_pool_manager
    _server_pool_manager = ServerPoolManager(
        redis_client=redis_client,
        vm_manager=vm_manager,
        port_allocator=port_allocator,
        snapshot_manager=snapshot_manager,
    )
    return _server_pool_manager
