"""
VM Pool Manager for Artifact Versioning

Manages a FIFO pool of running VMs per artifact.
Each artifact can have up to MAX_VMS_PER_ARTIFACT concurrent VMs,
with each VM serving a different artifact version.

Key concepts:
- One VM per (artifact_id, version) tuple - no port collisions
- Each VM has its own host port mapping
- When pool is full, oldest VM is evicted (FIFO)
- Hot switching: versions in pool switch instantly
- Cold switching: versions not in pool create new VM from snapshot

This replaces ServerPoolManager which tried to run multiple servers
in a single VM (causing port collision issues).

Usage:
    pool_manager = VMPoolManager(redis_client, vm_manager, port_allocator, snapshot_manager)

    # Create VM for a version
    pooled_vm = await pool_manager.create_vm_for_version(
        artifact_id="...",
        version=2,
        snapshot_path="...",
        start_command="npm run dev",
        container_port=5173,
        chat_id="...",
    )

    # Check if version is running
    pooled_vm = pool_manager.get_vm_for_version(artifact_id, version=2)

    # Get all running VMs for artifact
    vms = pool_manager.get_pool(artifact_id)
"""

import os
import json
import logging
import time
import asyncio
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

logger = logging.getLogger(__name__)

LOG_PREFIX = "[VMPool]"


@dataclass
class PooledVM:
    """
    Represents a VM in the pool serving a specific artifact version.

    Each VM hosts exactly one version of one artifact.
    """
    vm_id: str                      # Agent VM GUID
    artifact_id: str                # The artifact this VM serves
    version: int                    # Artifact version number
    host_port: int                  # Host port (accessible from Electron)
    container_port: int             # Container port (inside the VM)
    snapshot_path: str              # Path to the snapshot this version runs from
    created_at: float               # Timestamp when VM was created
    status: str = "running"         # "running", "stopped", "error"
    start_command: str = ""         # Command used to start the server
    chat_id: str = ""               # Chat that owns this VM

    def to_dict(self) -> Dict[str, Any]:
        return {
            "vm_id": self.vm_id,
            "artifact_id": self.artifact_id,
            "version": self.version,
            "host_port": self.host_port,
            "container_port": self.container_port,
            "snapshot_path": self.snapshot_path,
            "created_at": self.created_at,
            "status": self.status,
            "start_command": self.start_command,
            "chat_id": self.chat_id,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PooledVM":
        return cls(
            vm_id=data["vm_id"],
            artifact_id=data["artifact_id"],
            version=data["version"],
            host_port=data["host_port"],
            container_port=data.get("container_port", 5173),
            snapshot_path=data["snapshot_path"],
            created_at=data["created_at"],
            status=data.get("status", "running"),
            start_command=data.get("start_command", ""),
            chat_id=data.get("chat_id", ""),
        )


class VMPoolManager:
    """
    Manages FIFO pool of VMs per artifact.

    Each artifact can have up to MAX_VMS_PER_ARTIFACT concurrent VMs.
    When the pool is full, the oldest VM is evicted to make room.
    """

    # Maximum VMs per artifact
    MAX_VMS_PER_ARTIFACT = 5

    # Redis key prefix
    POOL_KEY_PREFIX = "artifact_vm_pool:"  # artifact_id -> JSON array of PooledVMs

    def __init__(
        self,
        redis_client=None,
        vm_manager=None,
        port_allocator=None,
        snapshot_manager=None,
    ):
        """
        Initialize the VMPoolManager.

        Args:
            redis_client: Redis client for persistence
            vm_manager: AgentVMManager for creating/managing VMs
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
        self._local_pools: Dict[str, List[PooledVM]] = {}

    # =========================================================================
    # Pool Management
    # =========================================================================

    def get_pool(self, artifact_id: str) -> List[PooledVM]:
        """
        Get all VMs for an artifact.

        Returns VMs in FIFO order: oldest at index 0.
        """
        if self.redis_client:
            try:
                key = f"{self.POOL_KEY_PREFIX}{artifact_id}"
                data = self.redis_client.get(key)
                if data:
                    vms = json.loads(data)
                    return [PooledVM.from_dict(v) for v in vms]
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get pool from Redis: {e}")

        return list(self._local_pools.get(artifact_id, []))

    def _save_pool(self, artifact_id: str, pool: List[PooledVM]):
        """Save pool to Redis and local cache."""
        self._local_pools[artifact_id] = pool

        if self.redis_client:
            try:
                key = f"{self.POOL_KEY_PREFIX}{artifact_id}"
                data = json.dumps([v.to_dict() for v in pool])
                self.redis_client.set(key, data)
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to save pool to Redis: {e}")

    def get_vm_for_version(self, artifact_id: str, version: int) -> Optional[PooledVM]:
        """
        Check if a version is currently running in the pool.

        Returns the VM info if found, None otherwise.
        """
        pool = self.get_pool(artifact_id)
        for vm in pool:
            if vm.version == version:
                return vm
        return None

    def get_pool_size(self, artifact_id: str) -> int:
        """Get current number of running VMs in the pool."""
        return len(self.get_pool(artifact_id))

    def is_pool_full(self, artifact_id: str) -> bool:
        """Check if the pool is at capacity."""
        return self.get_pool_size(artifact_id) >= self.MAX_VMS_PER_ARTIFACT

    # =========================================================================
    # Server Startup Configuration
    # =========================================================================

    # Default health check timeout in seconds
    SERVER_HEALTH_CHECK_TIMEOUT = 30
    # Poll interval for health checks
    SERVER_HEALTH_POLL_INTERVAL = 1.0
    # Longer timeout for npm-based projects (takes longer to compile)
    NPM_STARTUP_TIMEOUT = 45
    # Shorter timeout for static servers (should start quickly)
    STATIC_SERVER_TIMEOUT = 10

    # =========================================================================
    # Health Check
    # =========================================================================

    async def _verify_server_health(
        self,
        vm_id: str,
        container_port: int,
        start_command: str = "",
        max_wait_seconds: int = None,
        poll_interval: float = None,
    ) -> Tuple[bool, str]:
        """
        Verify the server is responding on the expected port.

        Uses curl inside the VM to check if the server responds.
        Polls periodically until timeout.

        Args:
            vm_id: VM GUID to check
            container_port: Port to check inside the container
            start_command: Used to determine appropriate timeout
            max_wait_seconds: Override default timeout
            poll_interval: Override default poll interval

        Returns:
            Tuple of (success, info_message)
            - On success: (True, "Server responding on port {port}")
            - On failure: (False, server_log or error message)
        """
        if not self.vm_manager:
            return (False, "VM manager not available")

        # Determine timeout based on start_command if not specified
        if max_wait_seconds is None:
            if "npm" in start_command or "yarn" in start_command or "pnpm" in start_command:
                max_wait_seconds = self.NPM_STARTUP_TIMEOUT
            elif "python" in start_command or "http.server" in start_command:
                max_wait_seconds = self.STATIC_SERVER_TIMEOUT
            else:
                max_wait_seconds = self.SERVER_HEALTH_CHECK_TIMEOUT

        if poll_interval is None:
            poll_interval = self.SERVER_HEALTH_POLL_INTERVAL

        logger.info(
            f"{LOG_PREFIX} Starting health check for VM {vm_id[:8]}... "
            f"port={container_port}, timeout={max_wait_seconds}s"
        )

        start_time = time.time()
        last_error = ""

        while (time.time() - start_time) < max_wait_seconds:
            try:
                # Use curl to check if server responds
                # -s: silent, -o /dev/null: discard output, -w: write http_code
                # --connect-timeout 2: fail fast on connection issues
                result = self.vm_manager.execute_bash(
                    vm_id,
                    f"curl -s -o /dev/null -w '%{{http_code}}' --connect-timeout 2 http://localhost:{container_port}/",
                    timeout_seconds=5,
                )

                if result.success:
                    http_code = result.stdout.strip()
                    # Accept any 2xx or 3xx response as success
                    if http_code and http_code.isdigit():
                        code = int(http_code)
                        if 200 <= code < 400:
                            elapsed = time.time() - start_time
                            logger.info(
                                f"{LOG_PREFIX} Health check PASSED for VM {vm_id[:8]}: "
                                f"HTTP {code} after {elapsed:.1f}s"
                            )
                            return (True, f"Server responding on port {container_port} (HTTP {code})")

                    # Server returned an error code (4xx, 5xx) or connection refused (000)
                    last_error = f"HTTP {http_code}" if http_code else "no response"

            except Exception as e:
                last_error = str(e)

            # Wait before next poll
            await asyncio.sleep(poll_interval)

        # Health check failed - capture server log for diagnosis
        elapsed = time.time() - start_time
        logger.warning(
            f"{LOG_PREFIX} Health check FAILED for VM {vm_id[:8]}: "
            f"No response after {elapsed:.1f}s (last: {last_error})"
        )

        # Try to get server log
        server_log = ""
        try:
            log_result = self.vm_manager.execute_bash(
                vm_id,
                "cat /tmp/server.log 2>/dev/null | tail -100",
                timeout_seconds=5,
            )
            if log_result.success and log_result.stdout:
                server_log = log_result.stdout.strip()
        except Exception:
            pass

        if server_log:
            return (False, f"Server failed to start. Log:\n{server_log}")
        else:
            return (False, f"Server failed to respond on port {container_port} within {max_wait_seconds}s")

    # =========================================================================
    # VM Lifecycle
    # =========================================================================

    async def create_vm_for_version(
        self,
        artifact_id: str,
        version: int,
        snapshot_path: str,
        start_command: str,
        container_port: int,
        chat_id: str,
        working_directory: str = "/work",
        source_vm_id: str = None,
    ) -> Tuple[Optional[PooledVM], Optional[int]]:
        """
        Create a new VM for an artifact version.

        If pool is full, evicts the oldest VM first (FIFO).
        Creates a new VM, restores the snapshot, copies node_modules for faster
        builds, starts the server, and verifies it's responding.

        Args:
            artifact_id: The artifact ID
            version: Artifact version number
            snapshot_path: Path to the version's snapshot
            start_command: Command to start the server (e.g., "npm run dev")
            container_port: Port the server runs on inside the container
            chat_id: Chat session ID that owns this artifact
            working_directory: Working directory for the server
            source_vm_id: Optional source VM to copy node_modules from (faster builds)

        Returns:
            Tuple of (PooledVM info or None, evicted_version or None)
        """
        logger.info(f"{LOG_PREFIX} Creating VM for artifact {artifact_id} version {version}")

        # Check if version already has a running VM
        existing = self.get_vm_for_version(artifact_id, version)
        if existing:
            logger.info(f"{LOG_PREFIX} Version {version} already running in VM {existing.vm_id}")
            return (existing, None)

        pool = self.get_pool(artifact_id)

        # Evict oldest if at capacity
        evicted_version = None
        if len(pool) >= self.MAX_VMS_PER_ARTIFACT:
            evicted = await self._evict_oldest(artifact_id, pool)
            if evicted:
                evicted_version = evicted.version
                logger.info(f"{LOG_PREFIX} Evicted version {evicted.version} to make room")

        # Allocate a host port
        if not self.port_allocator:
            logger.error(f"{LOG_PREFIX} No port allocator available")
            return (None, evicted_version)

        host_port = self.port_allocator.allocate_port(f"{artifact_id}_v{version}")
        if not host_port:
            logger.error(f"{LOG_PREFIX} No available ports for artifact {artifact_id}")
            return (None, evicted_version)

        # Create new VM with networking enabled and port mapping
        if not self.vm_manager:
            logger.error(f"{LOG_PREFIX} No VM manager available")
            return (None, evicted_version)

        try:
            port_mappings = {container_port: host_port}
            vm_info = self.vm_manager.create_vm(
                chat_id=chat_id,
                timeout_hours=4,
                enable_networking=True,
                port_mappings=port_mappings,
            )

            logger.info(
                f"{LOG_PREFIX} Created VM {vm_info.vm_id} for artifact {artifact_id} v{version}, "
                f"port {container_port} -> {host_port}"
            )

            # Restore snapshot if provided
            if snapshot_path and self.snapshot_manager:
                try:
                    logger.info(f"{LOG_PREFIX} Restoring snapshot {snapshot_path} to VM {vm_info.vm_id}")
                    self.snapshot_manager.restore_snapshot(
                        artifact_id=artifact_id,
                        version=version,
                        vm_id=vm_info.vm_id,
                        target_path=working_directory,
                    )
                except Exception as e:
                    logger.error(f"{LOG_PREFIX} Failed to restore snapshot: {e}")
                    # Continue anyway - the workspace might already have the files

            # Copy node_modules from source VM for faster builds (snapshots exclude node_modules)
            if source_vm_id and self.vm_manager:
                try:
                    # Check if source VM has node_modules
                    check_result = self.vm_manager.execute_bash(
                        source_vm_id,
                        f"test -d {working_directory}/node_modules && echo 'exists'",
                        timeout_seconds=5,
                    )

                    if check_result.success and 'exists' in check_result.stdout:
                        logger.info(f"{LOG_PREFIX} Copying node_modules from source VM {source_vm_id[:8]}...")

                        # Create tar of node_modules in source VM's /tmp
                        tar_result = self.vm_manager.execute_bash(
                            source_vm_id,
                            f"cd {working_directory} && tar -cf /tmp/node_modules.tar node_modules 2>&1",
                            timeout_seconds=180,  # Can be large, may take time
                        )

                        if tar_result.success:
                            # Get tar file from source VM and put it in new VM
                            # Both VMs have isolated /work but we can use docker to transfer via /tmp
                            try:
                                source_container = self.vm_manager.docker_client.containers.get(
                                    self.vm_manager._get_container_name(source_vm_id)
                                )
                                target_container = self.vm_manager.docker_client.containers.get(
                                    self.vm_manager._get_container_name(vm_info.vm_id)
                                )

                                # Get tar from source container
                                bits, _ = source_container.get_archive("/tmp/node_modules.tar")
                                tar_data = b"".join(bits)

                                # Put tar into target container
                                target_container.put_archive("/tmp", tar_data)

                                # Extract in new VM
                                extract_result = self.vm_manager.execute_bash(
                                    vm_info.vm_id,
                                    f"cd {working_directory} && tar -xf /tmp/node_modules.tar && rm -f /tmp/node_modules.tar",
                                    timeout_seconds=120,
                                )

                                if extract_result.success:
                                    logger.info(f"{LOG_PREFIX} node_modules copied successfully to VM {vm_info.vm_id[:8]}")
                                else:
                                    logger.warning(f"{LOG_PREFIX} Failed to extract node_modules: {extract_result.stderr}")
                            except Exception as docker_err:
                                logger.warning(f"{LOG_PREFIX} Failed to transfer node_modules via docker: {docker_err}")
                        else:
                            logger.warning(f"{LOG_PREFIX} Failed to create node_modules tar: {tar_result.stderr}")
                except Exception as e:
                    logger.warning(f"{LOG_PREFIX} Could not copy node_modules: {e}")
                    # Continue anyway - server may need npm install

            # Start the server
            result = self.vm_manager.execute_bash(
                vm_info.vm_id,
                f"cd {working_directory} && nohup {start_command} > /tmp/server.log 2>&1 &",
                timeout_seconds=30,
            )

            if not result.success:
                logger.warning(f"{LOG_PREFIX} Server start command returned: {result.stderr}")
                # Don't fail yet - server might still be starting in background

            # Verify server is actually responding (replaces simple sleep)
            is_healthy, health_info = await self._verify_server_health(
                vm_id=vm_info.vm_id,
                container_port=container_port,
                start_command=start_command,
            )

            if not is_healthy:
                logger.error(f"{LOG_PREFIX} Server health check failed for VM {vm_info.vm_id[:8]}: {health_info[:200]}")
                # Cleanup: destroy VM and release port
                try:
                    self.vm_manager.destroy_vm(vm_info.vm_id, chat_id)
                except Exception as cleanup_err:
                    logger.warning(f"{LOG_PREFIX} Failed to cleanup VM after health check failure: {cleanup_err}")
                self.port_allocator.release_port(host_port)
                return (None, evicted_version)

            # Create pooled VM entry
            pooled_vm = PooledVM(
                vm_id=vm_info.vm_id,
                artifact_id=artifact_id,
                version=version,
                host_port=host_port,
                container_port=container_port,
                snapshot_path=snapshot_path,
                created_at=time.time(),
                status="running",  # Verified by health check
                start_command=start_command,
                chat_id=chat_id,
            )

            # Add to pool (append = newest at end)
            pool = self.get_pool(artifact_id)  # Re-fetch in case of concurrent modifications
            pool.append(pooled_vm)
            self._save_pool(artifact_id, pool)

            logger.info(
                f"{LOG_PREFIX} VM {vm_info.vm_id} started for artifact {artifact_id} v{version} "
                f"on port {host_port}"
            )

            return (pooled_vm, evicted_version)

        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to create VM: {e}")
            # Release the port if we allocated it
            if host_port and self.port_allocator:
                self.port_allocator.release_port(host_port)
            return (None, evicted_version)

    async def _evict_oldest(
        self, artifact_id: str, pool: List[PooledVM]
    ) -> Optional[PooledVM]:
        """
        Evict the oldest VM from the pool (FIFO).

        Stops and destroys the VM.
        """
        if not pool:
            return None

        oldest = pool.pop(0)  # FIFO: remove from front

        # Destroy the VM
        if self.vm_manager:
            try:
                self.vm_manager.destroy_vm(oldest.vm_id, oldest.chat_id)
                logger.info(f"{LOG_PREFIX} Destroyed VM {oldest.vm_id} (version {oldest.version})")
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to destroy VM {oldest.vm_id}: {e}")

        # Release the port
        if self.port_allocator:
            self.port_allocator.release_port(oldest.host_port)

        # Save updated pool
        self._save_pool(artifact_id, pool)

        logger.info(
            f"{LOG_PREFIX} Evicted version {oldest.version} "
            f"(was on port {oldest.host_port})"
        )

        return oldest

    async def switch_to_version(
        self,
        artifact_id: str,
        version: int,
        snapshot_path: str,
        start_command: str,
        container_port: int,
        chat_id: str,
        working_directory: str = "/work",
    ) -> Tuple[Optional[PooledVM], bool, Optional[int]]:
        """
        Switch to a version.

        If version is in pool: return existing VM (hot switch)
        If version not in pool: create new VM (cold switch, may evict oldest)

        Args:
            artifact_id: The artifact ID
            version: Version to switch to
            snapshot_path: Path to version's snapshot (for cold switch)
            start_command: Server start command (for cold switch)
            container_port: Container port (for cold switch)
            chat_id: Chat session ID
            working_directory: Working directory for server

        Returns:
            Tuple of (PooledVM, from_pool, evicted_version)
        """
        # Check if version is already running (hot switch)
        existing = self.get_vm_for_version(artifact_id, version)
        if existing:
            logger.info(f"{LOG_PREFIX} HOT SWITCH: Version {version} already running on port {existing.host_port}")
            return (existing, True, None)

        # Cold switch: create new VM
        logger.info(f"{LOG_PREFIX} COLD SWITCH: Version {version} not in pool, creating new VM")
        pooled_vm, evicted_version = await self.create_vm_for_version(
            artifact_id=artifact_id,
            version=version,
            snapshot_path=snapshot_path,
            start_command=start_command,
            container_port=container_port,
            chat_id=chat_id,
            working_directory=working_directory,
        )

        return (pooled_vm, False, evicted_version)

    async def remove_vm(self, artifact_id: str, version: int) -> bool:
        """
        Remove a specific version's VM from the pool.

        Returns True if VM was found and removed.
        """
        pool = self.get_pool(artifact_id)

        for i, vm in enumerate(pool):
            if vm.version == version:
                # Destroy the VM
                if self.vm_manager:
                    try:
                        self.vm_manager.destroy_vm(vm.vm_id, vm.chat_id)
                    except Exception as e:
                        logger.error(f"{LOG_PREFIX} Failed to destroy VM {vm.vm_id}: {e}")

                # Release port
                if self.port_allocator:
                    self.port_allocator.release_port(vm.host_port)

                # Remove from pool
                pool.pop(i)
                self._save_pool(artifact_id, pool)

                logger.info(f"{LOG_PREFIX} Removed version {version} VM from pool")
                return True

        return False

    async def clear_pool(self, artifact_id: str):
        """Stop all VMs and clear the pool for an artifact."""
        pool = self.get_pool(artifact_id)

        for vm in pool:
            if self.vm_manager:
                try:
                    self.vm_manager.destroy_vm(vm.vm_id, vm.chat_id)
                except Exception as e:
                    logger.error(f"{LOG_PREFIX} Failed to destroy VM {vm.vm_id}: {e}")

            if self.port_allocator:
                self.port_allocator.release_port(vm.host_port)

        self._save_pool(artifact_id, [])
        logger.info(f"{LOG_PREFIX} Cleared pool for artifact {artifact_id}")

    # =========================================================================
    # Utility Methods
    # =========================================================================

    def get_running_versions(self, artifact_id: str) -> Dict[int, int]:
        """
        Get all running versions and their host ports.

        Returns dict like {1: 10001, 2: 10002}
        """
        pool = self.get_pool(artifact_id)
        return {vm.version: vm.host_port for vm in pool}

    def is_version_running(self, artifact_id: str, version: int) -> bool:
        """Check if a specific version is currently running."""
        return self.get_vm_for_version(artifact_id, version) is not None

    def get_pool_info(self, artifact_id: str) -> Dict[str, Any]:
        """
        Get summary info about the pool.

        Useful for debugging and UI display.
        """
        pool = self.get_pool(artifact_id)
        return {
            "artifact_id": artifact_id,
            "pool_size": len(pool),
            "max_size": self.MAX_VMS_PER_ARTIFACT,
            "running_versions": [
                {
                    "version": vm.version,
                    "vm_id": vm.vm_id,
                    "host_port": vm.host_port,
                    "created_at": vm.created_at,
                }
                for vm in pool
            ],
            "oldest_version": pool[0].version if pool else None,
            "newest_version": pool[-1].version if pool else None,
        }


# Singleton instance
_vm_pool_manager: Optional[VMPoolManager] = None


def get_vm_pool_manager() -> VMPoolManager:
    """Get the singleton VMPoolManager instance."""
    global _vm_pool_manager
    if _vm_pool_manager is None:
        _vm_pool_manager = VMPoolManager()
    return _vm_pool_manager


def init_vm_pool_manager(
    redis_client=None,
    vm_manager=None,
    port_allocator=None,
    snapshot_manager=None,
) -> VMPoolManager:
    """Initialize the VMPoolManager with dependencies."""
    global _vm_pool_manager
    _vm_pool_manager = VMPoolManager(
        redis_client=redis_client,
        vm_manager=vm_manager,
        port_allocator=port_allocator,
        snapshot_manager=snapshot_manager,
    )
    return _vm_pool_manager
