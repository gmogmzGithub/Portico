"""
Artifact Manager for Portico

Central business logic layer for managing artifacts - web applications
running in Agent VMs that can be viewed in the Electron app.

Features:
- Create artifacts from running VMs
- Version management with snapshots
- Start/stop artifact servers
- Communicate with Electron for panel display
- Track artifact state in Redis

Usage:
    manager = get_artifact_manager()
    artifact = await manager.create_artifact(
        vm_id="abc-123",
        chat_id="chat-456",
        name="Calculator App",
        start_command="npm run dev",
        container_port=5173
    )
    await manager.open_artifact(artifact.artifact_id)
"""

import os
import json
import logging
import time
import asyncio
import aiohttp
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field
from enum import Enum

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

logger = logging.getLogger(__name__)

# Prefix for all artifacts-related logging
LOG_PREFIX = "[Artifacts]"


class ArtifactStatus(str, Enum):
    """Artifact lifecycle states."""
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    ERROR = "error"


@dataclass
class ArtifactVersion:
    """Information about an artifact version."""
    version: int
    created_at: float
    snapshot_path: str
    version_note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "created_at": self.created_at,
            "snapshot_path": self.snapshot_path,
            "version_note": self.version_note,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ArtifactVersion":
        return cls(
            version=data["version"],
            created_at=data["created_at"],
            snapshot_path=data["snapshot_path"],
            version_note=data.get("version_note", ""),
        )


@dataclass
class Artifact:
    """Complete artifact information."""
    artifact_id: str
    chat_id: str
    name: str
    description: str
    created_at: float

    # Server configuration
    start_command: str
    working_directory: str
    container_port: int

    # State
    current_version: int  # Currently displayed version (UI state, changes with version switching)
    host_port: Optional[int] = None
    running_vm_id: Optional[str] = None
    bound_vm_id: Optional[str] = None  # The VM permanently bound to this artifact
    status: ArtifactStatus = ArtifactStatus.STOPPED
    error_message: Optional[str] = None

    # Versions
    versions: List[ArtifactVersion] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "chat_id": self.chat_id,
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
            "start_command": self.start_command,
            "working_directory": self.working_directory,
            "container_port": self.container_port,
            "current_version": self.current_version,
            "host_port": self.host_port,
            "running_vm_id": self.running_vm_id,
            "bound_vm_id": self.bound_vm_id,
            "status": self.status.value if isinstance(self.status, ArtifactStatus) else self.status,
            "error_message": self.error_message,
            "versions": [v.to_dict() for v in self.versions],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Artifact":
        return cls(
            artifact_id=data["artifact_id"],
            chat_id=data["chat_id"],
            name=data["name"],
            description=data.get("description", ""),
            created_at=data["created_at"],
            start_command=data["start_command"],
            working_directory=data.get("working_directory", "/work"),
            container_port=data["container_port"],
            current_version=data.get("current_version", 1),
            host_port=data.get("host_port"),
            running_vm_id=data.get("running_vm_id"),
            bound_vm_id=data.get("bound_vm_id"),
            status=ArtifactStatus(data.get("status", "stopped")),
            error_message=data.get("error_message"),
            versions=[ArtifactVersion.from_dict(v) for v in data.get("versions", [])],
        )

    @property
    def preview_url(self) -> Optional[str]:
        """Get the localhost preview URL if artifact is running."""
        if self.host_port and self.status == ArtifactStatus.RUNNING:
            return f"http://localhost:{self.host_port}"
        return None


class ArtifactManager:
    """
    Manages artifact lifecycle and coordinates with other managers.

    This is the central business logic layer that:
    - Creates artifacts from running VMs
    - Manages artifact versions via SnapshotManager
    - Allocates ports via PortAllocator
    - Starts/stops artifact servers in VMs
    - Communicates with Electron to display artifacts
    """

    # Redis keys
    ARTIFACT_PREFIX = "artifact:"  # artifact_id -> artifact data
    CHAT_ARTIFACTS_PREFIX = "chat_artifacts:"  # chat_id -> set of artifact_ids
    VM_BINDING_PREFIX = "artifact_vm_binding:"  # vm_id -> artifact_id (VM-artifact marriage)
    ARTIFACT_VM_PREFIX = "artifact_bound_vm:"  # artifact_id -> vm_id (reverse lookup)

    # Electron API endpoint (running on host)
    ELECTRON_API_URL = "http://host.docker.internal:9876"

    def __init__(
        self,
        redis_client=None,
        vm_manager=None,
        port_allocator=None,
        snapshot_manager=None,
    ):
        """
        Initialize the ArtifactManager.

        Args:
            redis_client: Redis client for persistence
            vm_manager: AgentVMManager instance
            port_allocator: PortAllocator instance
            snapshot_manager: SnapshotManager instance
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
                logger.info(f"{LOG_PREFIX} ArtifactManager connected to Redis")
            except Exception as e:
                logger.warning(f"{LOG_PREFIX} ArtifactManager could not connect to Redis: {e}")
                self.redis_client = None

        self.vm_manager = vm_manager
        self.port_allocator = port_allocator
        self.snapshot_manager = snapshot_manager

        # In-memory cache for artifacts (fallback if Redis unavailable)
        self._artifacts: Dict[str, Artifact] = {}
        self._chat_artifacts: Dict[str, set] = {}

        # VM binding cache
        self._vm_to_artifact: Dict[str, str] = {}  # vm_id -> artifact_id
        self._artifact_to_vm: Dict[str, str] = {}  # artifact_id -> vm_id

        # Server pool manager (legacy, set via init_server_pool)
        self.server_pool = None

        # VM pool manager (new architecture - one VM per version)
        self.vm_pool = None

        # Version creation locks (per-artifact to prevent race conditions)
        self._version_locks: Dict[str, asyncio.Lock] = {}
        self._locks_lock = asyncio.Lock()  # Protect _version_locks dict

        logger.info(f"{LOG_PREFIX} ArtifactManager initialized")

    def init_server_pool(self, server_pool_manager):
        """Initialize the server pool manager for version server management (legacy)."""
        self.server_pool = server_pool_manager
        logger.info(f"{LOG_PREFIX} Server pool manager initialized (legacy)")

    def init_vm_pool(self, vm_pool_manager):
        """Initialize the VM pool manager for version VM management (new architecture)."""
        self.vm_pool = vm_pool_manager
        logger.info(f"{LOG_PREFIX} VM pool manager initialized")

    async def _get_version_lock(self, artifact_id: str) -> asyncio.Lock:
        """Get or create an AsyncIO lock for an artifact's version operations."""
        async with self._locks_lock:
            if artifact_id not in self._version_locks:
                self._version_locks[artifact_id] = asyncio.Lock()
            return self._version_locks[artifact_id]

    def _validate_version_uniqueness(self, artifact: Artifact, new_version: int) -> bool:
        """Validate that new_version doesn't already exist in artifact.versions."""
        existing_versions = {v.version for v in artifact.versions}
        if new_version in existing_versions:
            logger.error(
                f"{LOG_PREFIX} Duplicate version {new_version} detected for "
                f"artifact {artifact.artifact_id}! Cross-process race condition."
            )
            return False
        return True

    async def _cleanup_failed_version_vm(
        self,
        artifact_id: str,
        version: int,
        vm_id: Optional[str] = None,
    ):
        """Clean up VM when version creation fails after VM was created."""
        if vm_id and self.vm_pool:
            try:
                await self.vm_pool.remove_vm(artifact_id, version)
                logger.info(f"{LOG_PREFIX} Cleaned up failed VM {vm_id}")
            except Exception as e:
                logger.error(f"{LOG_PREFIX} VM cleanup failed: {e}")

    def _get_redis_key(self, artifact_id: str) -> str:
        """Get Redis key for artifact."""
        return f"{self.ARTIFACT_PREFIX}{artifact_id}"

    def _get_chat_key(self, chat_id: str) -> str:
        """Get Redis key for chat's artifacts."""
        return f"{self.CHAT_ARTIFACTS_PREFIX}{chat_id}"

    def _get_artifact_metadata_path(self, artifact_id: str) -> Optional[str]:
        """Get path to artifact metadata.json file on disk."""
        if not self.snapshot_manager:
            return None
        artifact_dir = os.path.join(self.snapshot_manager.snapshots_base_dir, artifact_id)
        return os.path.join(artifact_dir, "metadata.json")

    def _persist_artifact_to_disk(self, artifact: Artifact) -> bool:
        """
        Persist artifact metadata to disk alongside snapshots.

        This ensures artifact metadata survives Redis restarts/eviction.
        The metadata.json file is stored in the artifact's snapshot directory.
        """
        metadata_path = self._get_artifact_metadata_path(artifact.artifact_id)
        if not metadata_path:
            return False

        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(metadata_path), exist_ok=True)

            # Write metadata
            with open(metadata_path, 'w') as f:
                json.dump(artifact.to_dict(), f, indent=2)

            logger.debug(f"{LOG_PREFIX} Persisted artifact metadata to disk: {metadata_path}")
            return True
        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to persist artifact to disk: {e}")
            return False

    def _recover_artifact_from_disk(self, artifact_id: str) -> Optional[Artifact]:
        """
        Recover artifact metadata from disk if Redis data is lost.

        This enables artifact recovery after Redis restart/eviction.
        """
        metadata_path = self._get_artifact_metadata_path(artifact_id)
        if not metadata_path or not os.path.exists(metadata_path):
            return None

        try:
            with open(metadata_path, 'r') as f:
                data = json.load(f)

            artifact = Artifact.from_dict(data)

            # Reset runtime state (VM may not exist anymore)
            artifact.running_vm_id = None
            artifact.status = ArtifactStatus.STOPPED

            logger.info(f"{LOG_PREFIX} Recovered artifact from disk: {artifact_id}")
            return artifact
        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to recover artifact from disk: {e}")
            return None

    def _scan_disk_for_chat_artifacts(self, chat_id: str) -> List[str]:
        """
        Scan disk for artifacts belonging to a chat when Redis data is lost.

        Searches all artifact metadata.json files on disk for matching chat_id.
        """
        if not self.snapshot_manager:
            return []

        artifact_ids = []
        snapshots_dir = self.snapshot_manager.snapshots_base_dir

        if not os.path.exists(snapshots_dir):
            return []

        try:
            for artifact_id in os.listdir(snapshots_dir):
                metadata_path = os.path.join(snapshots_dir, artifact_id, "metadata.json")
                if os.path.exists(metadata_path):
                    try:
                        with open(metadata_path, 'r') as f:
                            data = json.load(f)
                        if data.get("chat_id") == chat_id:
                            artifact_ids.append(artifact_id)
                    except Exception:
                        continue
        except Exception as e:
            logger.error(f"{LOG_PREFIX} Error scanning disk for artifacts: {e}")

        return artifact_ids

    # =========================================================================
    # VM Binding (Marriage between VM and Artifact)
    # =========================================================================

    def bind_vm_to_artifact(self, vm_id: str, artifact_id: str) -> bool:
        """
        Bind a VM to an artifact permanently.

        Once bound, the VM can only serve this artifact. This is
        the "marriage" that ensures clean state management.

        Args:
            vm_id: The Agent VM identifier
            artifact_id: The artifact identifier

        Returns:
            True if binding succeeded, False if VM already bound to different artifact
        """
        # Check if VM is already bound to a different artifact
        existing = self.get_bound_artifact(vm_id)
        if existing and existing != artifact_id:
            logger.error(
                f"{LOG_PREFIX} VM {vm_id} already bound to artifact {existing}, "
                f"cannot bind to {artifact_id}"
            )
            return False

        if existing == artifact_id:
            logger.info(f"{LOG_PREFIX} VM {vm_id} already bound to artifact {artifact_id}")
            return True

        # Store the binding
        self._vm_to_artifact[vm_id] = artifact_id
        self._artifact_to_vm[artifact_id] = vm_id

        if self.redis_client:
            try:
                pipe = self.redis_client.pipeline()
                pipe.set(f"{self.VM_BINDING_PREFIX}{vm_id}", artifact_id)
                pipe.set(f"{self.ARTIFACT_VM_PREFIX}{artifact_id}", vm_id)
                pipe.execute()
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to store VM binding in Redis: {e}")

        # Update artifact record
        artifact = self._get_artifact(artifact_id)
        if artifact and artifact.bound_vm_id != vm_id:
            artifact.bound_vm_id = vm_id
            self._store_artifact(artifact)

        logger.info(f"{LOG_PREFIX} Bound VM {vm_id} to artifact {artifact_id}")
        return True

    def get_bound_artifact(self, vm_id: str) -> Optional[str]:
        """
        Get the artifact ID bound to this VM.

        Args:
            vm_id: The Agent VM identifier

        Returns:
            Artifact ID if bound, None otherwise
        """
        # Check local cache first
        if vm_id in self._vm_to_artifact:
            return self._vm_to_artifact[vm_id]

        # Check Redis
        if self.redis_client:
            try:
                artifact_id = self.redis_client.get(f"{self.VM_BINDING_PREFIX}{vm_id}")
                if artifact_id:
                    # Update local cache
                    self._vm_to_artifact[vm_id] = artifact_id
                    return artifact_id
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get VM binding from Redis: {e}")

        return None

    def get_bound_vm(self, artifact_id: str) -> Optional[str]:
        """
        Get the VM ID bound to this artifact.

        Args:
            artifact_id: The artifact identifier

        Returns:
            VM ID if bound, None otherwise
        """
        # Check local cache first
        if artifact_id in self._artifact_to_vm:
            return self._artifact_to_vm[artifact_id]

        # Check Redis
        if self.redis_client:
            try:
                vm_id = self.redis_client.get(f"{self.ARTIFACT_VM_PREFIX}{artifact_id}")
                if vm_id:
                    # Update local cache
                    self._artifact_to_vm[artifact_id] = vm_id
                    return vm_id
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get artifact VM from Redis: {e}")

        # Fallback: check artifact record
        artifact = self._get_artifact(artifact_id)
        if artifact and artifact.bound_vm_id:
            self._artifact_to_vm[artifact_id] = artifact.bound_vm_id
            return artifact.bound_vm_id

        return None

    def unbind_vm(self, vm_id: str) -> bool:
        """
        Remove VM binding (when VM is destroyed).

        Args:
            vm_id: The Agent VM identifier

        Returns:
            True if unbinding succeeded
        """
        artifact_id = self.get_bound_artifact(vm_id)
        if not artifact_id:
            return True  # Not bound

        # Remove from local cache
        self._vm_to_artifact.pop(vm_id, None)
        self._artifact_to_vm.pop(artifact_id, None)

        # Remove from Redis
        if self.redis_client:
            try:
                pipe = self.redis_client.pipeline()
                pipe.delete(f"{self.VM_BINDING_PREFIX}{vm_id}")
                pipe.delete(f"{self.ARTIFACT_VM_PREFIX}{artifact_id}")
                pipe.execute()
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to remove VM binding from Redis: {e}")

        logger.info(f"{LOG_PREFIX} Unbound VM {vm_id} from artifact {artifact_id}")
        return True

    def is_vm_bound(self, vm_id: str) -> bool:
        """Check if a VM is bound to any artifact."""
        return self.get_bound_artifact(vm_id) is not None

    # =========================================================================
    # Running Versions (for UI indicators)
    # =========================================================================

    def get_running_versions(self, artifact_id: str) -> Dict[int, int]:
        """
        Get all running version servers for an artifact.

        Returns a dict mapping version number to host port.
        Useful for showing "hot" versions in the UI.

        Args:
            artifact_id: The artifact identifier

        Returns:
            Dict like {1: 10001, 2: 10002} for running versions
        """
        # New architecture: use VM pool (one VM per version)
        if self.vm_pool:
            return self.vm_pool.get_running_versions(artifact_id)

        # Legacy fallback: use server pool (multiple servers per VM)
        if self.server_pool:
            vm_id = self.get_bound_vm(artifact_id)
            if vm_id:
                return self.server_pool.get_running_versions(vm_id)

        return {}

    def _store_artifact(self, artifact: Artifact) -> bool:
        """Store artifact in Redis, local cache, AND disk for persistence."""
        logger.info(f"{LOG_PREFIX} Storing artifact {artifact.artifact_id} for chat {artifact.chat_id}")

        # Always update local cache
        self._artifacts[artifact.artifact_id] = artifact
        if artifact.chat_id not in self._chat_artifacts:
            self._chat_artifacts[artifact.chat_id] = set()
        self._chat_artifacts[artifact.chat_id].add(artifact.artifact_id)
        logger.info(f"{LOG_PREFIX} Local cache now has {len(self._chat_artifacts[artifact.chat_id])} artifacts for chat {artifact.chat_id}")

        # Persist to disk (survives Redis restart/eviction)
        self._persist_artifact_to_disk(artifact)

        if self.redis_client:
            try:
                key = self._get_redis_key(artifact.artifact_id)
                chat_key = self._get_chat_key(artifact.chat_id)

                pipe = self.redis_client.pipeline()
                pipe.set(key, json.dumps(artifact.to_dict()))
                pipe.sadd(chat_key, artifact.artifact_id)
                pipe.execute()
                return True
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to store artifact in Redis: {e}")
                return False
        return True

    def _get_artifact(self, artifact_id: str) -> Optional[Artifact]:
        """Get artifact from Redis, local cache, or recover from disk."""
        # Try Redis first
        if self.redis_client:
            try:
                key = self._get_redis_key(artifact_id)
                data = self.redis_client.get(key)
                if data:
                    return Artifact.from_dict(json.loads(data))
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to get artifact from Redis: {e}")

        # Try local cache
        artifact = self._artifacts.get(artifact_id)
        if artifact:
            return artifact

        # Try disk recovery (handles Redis restart/eviction)
        artifact = self._recover_artifact_from_disk(artifact_id)
        if artifact:
            # Re-populate Redis and local cache
            self._store_artifact(artifact)
            return artifact

        return None

    def _delete_artifact(self, artifact_id: str) -> bool:
        """Delete artifact from storage."""
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            return False

        # Remove from local cache
        self._artifacts.pop(artifact_id, None)
        if artifact.chat_id in self._chat_artifacts:
            self._chat_artifacts[artifact.chat_id].discard(artifact_id)

        if self.redis_client:
            try:
                key = self._get_redis_key(artifact_id)
                chat_key = self._get_chat_key(artifact.chat_id)

                pipe = self.redis_client.pipeline()
                pipe.delete(key)
                pipe.srem(chat_key, artifact_id)
                pipe.execute()
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to delete artifact from Redis: {e}")
                return False

        return True

    async def create_artifact(
        self,
        chat_id: str,
        name: str,
        start_command: str,
        container_port: int = 5173,
        description: str = "",
        working_directory: str = "/work",
        version_note: str = "Initial version",
        vm_id: str = None,  # Optional - for legacy compatibility, auto-creates if not provided
    ) -> Artifact:
        """
        Create an artifact with a dedicated VM.

        NEW ARCHITECTURE: Automatically creates a VM for the artifact.
        The vm_id parameter is optional for backwards compatibility.

        This captures the current state as version 1, creates a VM with
        networking enabled, starts the server, and prepares the artifact
        for viewing.

        Args:
            chat_id: Chat session ID
            name: Display name for the artifact
            start_command: Command to start the server (e.g., "npm run dev")
            container_port: Port the server runs on inside the container
            description: Optional description
            working_directory: Working directory for start_command
            version_note: Note for initial version
            vm_id: Optional source VM GUID (legacy - for backwards compatibility)

        Returns:
            Created Artifact with auto-created VM

        Raises:
            RuntimeError: If creation fails
        """
        import uuid

        if not self.vm_manager:
            logger.error(f"{LOG_PREFIX} VM manager not configured")
            raise RuntimeError("VM manager not configured")
        if not self.port_allocator:
            logger.error(f"{LOG_PREFIX} Port allocator not configured")
            raise RuntimeError("Port allocator not configured")

        artifact_id = str(uuid.uuid4())
        now = time.time()

        # Use VM pool manager if available (new architecture)
        if self.vm_pool:
            logger.info(f"{LOG_PREFIX} Creating artifact {artifact_id} with dedicated VM (new architecture)")

            # Create initial version entry (will be populated with snapshot path)
            initial_version = ArtifactVersion(
                version=1,
                created_at=now,
                snapshot_path="",
                version_note=version_note,
            )

            # If we have a source vm_id, create snapshot from it first
            if vm_id and self.snapshot_manager:
                # Verify source VM exists
                vm_info = self.vm_manager._get_vm_info(vm_id)
                if vm_info:
                    snapshot = self.snapshot_manager.create_snapshot(
                        vm_id=vm_id,
                        artifact_id=artifact_id,
                        version=1,
                        version_note=version_note,
                    )
                    if snapshot:
                        initial_version.snapshot_path = snapshot.snapshot_path

            # Create VM for this version using VMPoolManager
            pooled_vm, _ = await self.vm_pool.create_vm_for_version(
                artifact_id=artifact_id,
                version=1,
                snapshot_path=initial_version.snapshot_path,
                start_command=start_command,
                container_port=container_port,
                chat_id=chat_id,
                working_directory=working_directory,
                source_vm_id=vm_id,  # Copy node_modules from source VM if available
            )

            if not pooled_vm:
                logger.error(f"{LOG_PREFIX} Failed to create VM for artifact {artifact_id}")
                raise RuntimeError("Failed to create VM for artifact")

            artifact = Artifact(
                artifact_id=artifact_id,
                chat_id=chat_id,
                name=name,
                description=description,
                created_at=now,
                start_command=start_command,
                working_directory=working_directory,
                container_port=container_port,
                current_version=1,
                host_port=pooled_vm.host_port,
                running_vm_id=pooled_vm.vm_id,  # Already running!
                bound_vm_id=pooled_vm.vm_id,
                status=ArtifactStatus.RUNNING,  # Running immediately
                versions=[initial_version],
            )

            self._store_artifact(artifact)
            logger.info(
                f"{LOG_PREFIX} Artifact created: {artifact_id}, VM {pooled_vm.vm_id}, "
                f"port {pooled_vm.host_port}, status=running"
            )

            return artifact

        # Legacy path: require vm_id parameter
        if not vm_id:
            logger.error(f"{LOG_PREFIX} vm_id required when VM pool not available")
            raise RuntimeError("vm_id is required (VM pool manager not configured)")

        # Verify VM exists
        vm_info = self.vm_manager._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"{LOG_PREFIX} VM not found: {vm_id}")
            raise RuntimeError(f"VM not found: {vm_id}")

        logger.info(f"{LOG_PREFIX} Creating artifact {artifact_id} from VM {vm_id} (legacy)")

        # Allocate a host port
        host_port = self.port_allocator.allocate_port(artifact_id)
        if not host_port:
            logger.error(f"{LOG_PREFIX} No available ports for artifact {artifact_id}")
            raise RuntimeError("No available ports for artifact")

        # Create initial version snapshot
        initial_version = ArtifactVersion(
            version=1,
            created_at=now,
            snapshot_path="",  # Will be set by snapshot manager
            version_note=version_note,
        )

        if self.snapshot_manager:
            snapshot = self.snapshot_manager.create_snapshot(
                vm_id=vm_id,
                artifact_id=artifact_id,
                version=1,
                version_note=version_note,
            )
            if snapshot:
                initial_version.snapshot_path = snapshot.snapshot_path

        artifact = Artifact(
            artifact_id=artifact_id,
            chat_id=chat_id,
            name=name,
            description=description,
            created_at=now,
            start_command=start_command,
            working_directory=working_directory,
            container_port=container_port,
            current_version=1,
            host_port=host_port,
            running_vm_id=None,  # Not running yet
            bound_vm_id=vm_id,  # Bind this VM to the artifact
            status=ArtifactStatus.STOPPED,
            versions=[initial_version],
        )

        # Bind VM to artifact (marriage)
        self.bind_vm_to_artifact(vm_id, artifact_id)

        self._store_artifact(artifact)
        logger.info(f"{LOG_PREFIX} Artifact created: {artifact_id}, port {host_port}, bound to VM {vm_id}")

        return artifact

    async def create_version(
        self,
        artifact_id: str,
        chat_id: str,
        version_note: str = "",
        source_vm_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Create a new version of an artifact from a VM state.

        IMPORTANT: New version number is calculated from MAX existing version,
        not from current_version (which tracks displayed version for UI).

        NEW ARCHITECTURE: Creates a snapshot and starts a new VM for this version.
        Each version gets its own dedicated VM (no port collisions).

        Uses per-artifact AsyncIO lock to prevent race conditions when multiple
        concurrent requests try to create versions simultaneously.

        Args:
            artifact_id: Artifact ID
            chat_id: Chat ID (for verification)
            version_note: Description of this version
            source_vm_id: VM ID to snapshot from (typically development VM).
                         If not provided, falls back to artifact's running VM.

        Returns:
            Dict with version info, host_port, and vm_id, or None on failure
        """
        # Acquire lock for this artifact to prevent concurrent version creation race conditions
        lock = await self._get_version_lock(artifact_id)

        async with lock:
            logger.info(f"{LOG_PREFIX} Version lock acquired for artifact {artifact_id}")

            # 1. Load artifact
            artifact = self._get_artifact(artifact_id)
            if not artifact:
                logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
                return None

            if artifact.chat_id != chat_id:
                logger.error(f"{LOG_PREFIX} Chat ID mismatch for artifact {artifact_id}")
                return None

            # Determine which VM to snapshot from
            # source_vm_id takes priority (typically the development VM)
            # Falls back to artifact's running VM if not provided
            snapshot_source_vm = source_vm_id or artifact.running_vm_id
            if not snapshot_source_vm:
                logger.error(f"{LOG_PREFIX} No source VM available for artifact {artifact_id}")
                return None

            # 2. Calculate version number (safe - lock held)
            # Calculate from maximum existing version, not current_version
            # This prevents duplicate version numbers when user switches versions before creating new ones
            max_version = max([v.version for v in artifact.versions]) if artifact.versions else 0
            new_version = max_version + 1
            logger.info(
                f"{LOG_PREFIX} Version calculation for {artifact_id}: "
                f"current_version={artifact.current_version}, "
                f"max_version={max_version}, "
                f"new_version={new_version}, "
                f"existing_versions={[v.version for v in artifact.versions]}"
            )
            now = time.time()

            # Truncate version_note if too long (max 50 chars)
            if version_note and len(version_note) > 50:
                version_note = version_note[:47] + "..."

            # 3. Create version object (NOT persisted yet)
            version = ArtifactVersion(
                version=new_version,
                created_at=now,
                snapshot_path="",
                version_note=version_note,
            )

            # 4. Create snapshot from source VM (development VM or artifact's running VM)
            if self.snapshot_manager:
                snapshot = self.snapshot_manager.create_snapshot(
                    vm_id=snapshot_source_vm,
                    artifact_id=artifact_id,
                    version=new_version,
                    version_note=version_note,
                )
                if snapshot:
                    version.snapshot_path = snapshot.snapshot_path
                else:
                    logger.error(f"{LOG_PREFIX} Failed to create snapshot for artifact {artifact_id}")
                    return None

            new_host_port = artifact.host_port  # Default to current port
            evicted_version = None
            new_vm_id = artifact.running_vm_id

            # 5. Create VM (may fail - version NOT persisted yet!)
            # NEW ARCHITECTURE: Use VM pool (one VM per version)
            if self.vm_pool:
                try:
                    pooled_vm, evicted_version = await self.vm_pool.create_vm_for_version(
                        artifact_id=artifact_id,
                        version=new_version,
                        snapshot_path=version.snapshot_path,
                        start_command=artifact.start_command,
                        container_port=artifact.container_port,
                        chat_id=chat_id,
                        working_directory=artifact.working_directory,
                        source_vm_id=snapshot_source_vm,  # Copy node_modules for faster builds
                    )
                    if not pooled_vm:
                        logger.error(f"{LOG_PREFIX} Failed to create VM for version {new_version}")
                        # CLEAN FAILURE: Version never persisted, no cleanup needed
                        return None

                    new_host_port = pooled_vm.host_port
                    new_vm_id = pooled_vm.vm_id
                    logger.info(
                        f"{LOG_PREFIX} Created VM {new_vm_id} for version {new_version} "
                        f"on port {new_host_port}"
                    )
                    if evicted_version:
                        logger.info(
                            f"{LOG_PREFIX} Evicted version {evicted_version} to make room"
                        )
                except Exception as e:
                    logger.error(
                        f"{LOG_PREFIX} Failed to create VM for version {new_version}: {e}"
                    )
                    # CLEAN FAILURE: Version never persisted, no cleanup needed
                    return None

            # LEGACY: Use server pool (multiple servers per VM)
            elif self.server_pool and artifact.running_vm_id:
                try:
                    server, evicted_version = await self.server_pool.add_server(
                        vm_id=artifact.running_vm_id,
                        version=new_version,
                        snapshot_path=version.snapshot_path,
                        artifact_id=artifact_id,
                        start_command=artifact.start_command,
                        working_directory=artifact.working_directory,
                    )
                    if server:
                        new_host_port = server.host_port
                        logger.info(
                            f"{LOG_PREFIX} Started server for version {new_version} "
                            f"on port {new_host_port}"
                        )
                        if evicted_version:
                            logger.info(
                                f"{LOG_PREFIX} Evicted version {evicted_version} to make room"
                            )
                except Exception as e:
                    logger.warning(
                        f"{LOG_PREFIX} Failed to add server to pool for version {new_version}: {e}"
                    )
                    # Continue without pool - version is still created

            # 6. VM succeeded - re-fetch artifact for cross-process safety
            artifact_fresh = self._get_artifact(artifact_id)
            if not artifact_fresh:
                logger.error(f"{LOG_PREFIX} Artifact vanished during version creation: {artifact_id}")
                # Cleanup VM if it was created
                await self._cleanup_failed_version_vm(artifact_id, new_version, new_vm_id)
                return None

            # 7. CRITICAL FIX: Recalculate version from fresh artifact data
            # This ensures we always use the maximum version from the LATEST artifact state,
            # preventing duplicate versions when user switches to an older version before creating new ones
            max_version_fresh = max([v.version for v in artifact_fresh.versions]) if artifact_fresh.versions else 0
            correct_new_version = max_version_fresh + 1

            if correct_new_version != new_version:
                logger.warning(
                    f"{LOG_PREFIX} Version recalculation needed for {artifact_id}: "
                    f"originally calculated {new_version}, but fresh max is {max_version_fresh}, "
                    f"using {correct_new_version} instead"
                )
                # Update the version object with the correct version number
                new_version = correct_new_version
                version.version = correct_new_version

            # 8. Validate version uniqueness (catches cross-process race conditions)
            if not self._validate_version_uniqueness(artifact_fresh, new_version):
                # Duplicate detected - cleanup VM if it was created
                await self._cleanup_failed_version_vm(artifact_id, new_version, new_vm_id)
                return None

            # 9. Append version ONLY after VM creation succeeds
            artifact_fresh.versions.append(version)
            artifact_fresh.current_version = new_version
            artifact_fresh.host_port = new_host_port
            artifact_fresh.running_vm_id = new_vm_id

            # 9. Persist ONCE at the end
            self._store_artifact(artifact_fresh)

            logger.info(f"{LOG_PREFIX} Created version {new_version} for artifact {artifact_id}")

            return {
                "success": True,
                "version": new_version,
                "vm_id": new_vm_id,
                "host_port": new_host_port,
                "snapshot_path": version.snapshot_path,
                "version_note": version_note,
                "created_at": now,
                "evicted_version": evicted_version,
            }
        # Lock automatically released here

    async def start_artifact(
        self,
        artifact_id: str,
        version: Optional[int] = None,
        chat_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Start an artifact server.

        Creates a new VM with networking, restores the snapshot (if versioned),
        starts the server, and returns the preview URL.

        Args:
            artifact_id: Artifact ID
            version: Version to start (default: current version)
            chat_id: Chat ID (for verification if provided)

        Returns:
            Dict with preview_url and other info
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found for start: {artifact_id}")
            raise RuntimeError(f"Artifact not found: {artifact_id}")

        if chat_id and artifact.chat_id != chat_id:
            logger.error(f"{LOG_PREFIX} Unauthorized access to artifact {artifact_id}")
            raise RuntimeError("Unauthorized: chat ID mismatch")

        if artifact.status == ArtifactStatus.RUNNING:
            # Verify the VM container actually exists (may have been cleaned up or host restarted)
            if artifact.running_vm_id and self.vm_manager.vm_container_exists(artifact.running_vm_id):
                return {
                    "artifact_id": artifact_id,
                    "preview_url": artifact.preview_url,
                    "status": "already_running",
                }
            else:
                # Container was removed - need to recreate
                logger.info(f"{LOG_PREFIX} VM container gone for artifact {artifact_id}, recreating...")
                artifact.status = ArtifactStatus.STOPPED
                artifact.running_vm_id = None
                artifact.host_port = None  # Force new port allocation
                # Continue with normal start logic below...

        # Reset artifacts in error state - clear stale port/VM info to allow fresh start
        if artifact.status == ArtifactStatus.ERROR:
            logger.info(f"{LOG_PREFIX} Artifact {artifact_id} was in error state, resetting for fresh start")
            artifact.status = ArtifactStatus.STOPPED
            artifact.running_vm_id = None
            artifact.host_port = None  # Force new port allocation
            artifact.error_message = None

        version = version or artifact.current_version

        logger.info(f"{LOG_PREFIX} Starting artifact {artifact_id} version {version}")

        artifact.status = ArtifactStatus.STARTING
        self._store_artifact(artifact)

        try:
            # Verify port is available, allocate new one if needed (handles stale ports from old chats)
            if not artifact.host_port or (self.port_allocator and not self.port_allocator.is_port_available(artifact.host_port)):
                if artifact.host_port:
                    logger.info(f"{LOG_PREFIX} Port {artifact.host_port} no longer available, allocating new port")
                new_port = self.port_allocator.allocate_port(artifact.artifact_id) if self.port_allocator else None
                if not new_port:
                    raise RuntimeError("Failed to allocate port for artifact")
                artifact.host_port = new_port
                self._store_artifact(artifact)

            # Create a new VM with networking enabled
            port_mappings = {artifact.container_port: artifact.host_port}
            vm_info = self.vm_manager.create_vm(
                chat_id=artifact.chat_id,
                timeout_hours=4,
                enable_networking=True,
                port_mappings=port_mappings,
            )

            artifact.running_vm_id = vm_info.vm_id

            # Restore snapshot if not version 1 or if snapshot exists
            if self.snapshot_manager and version > 0:
                snapshot = self.snapshot_manager.get_snapshot(artifact_id, version)
                if snapshot and snapshot.snapshot_path:
                    self.snapshot_manager.restore_snapshot(
                        artifact_id=artifact_id,
                        version=version,
                        vm_id=vm_info.vm_id,
                    )

            # Start the server
            result = self.vm_manager.execute_bash(
                vm_info.vm_id,
                f"cd {artifact.working_directory} && nohup {artifact.start_command} > /tmp/server.log 2>&1 &",
            )

            if not result.success:
                logger.error(f"{LOG_PREFIX} Failed to start server for artifact {artifact_id}: {result.stderr}")
                raise RuntimeError(f"Failed to start server: {result.stderr}")

            # Wait a moment for server to start
            await asyncio.sleep(2)

            artifact.status = ArtifactStatus.RUNNING
            artifact.error_message = None
            self._store_artifact(artifact)

            preview_url = f"http://localhost:{artifact.host_port}"

            logger.info(f"{LOG_PREFIX} Artifact {artifact_id} started at {preview_url}")

            return {
                "artifact_id": artifact_id,
                "preview_url": preview_url,
                "vm_id": vm_info.vm_id,
                "status": "running",
            }

        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to start artifact {artifact_id}: {e}")
            artifact.status = ArtifactStatus.ERROR
            artifact.error_message = str(e)
            self._store_artifact(artifact)
            raise

    async def stop_artifact(self, artifact_id: str) -> bool:
        """
        Stop an artifact server.

        Args:
            artifact_id: Artifact ID

        Returns:
            True if stopped successfully
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
            return False

        if artifact.status != ArtifactStatus.RUNNING:
            logger.info(f"{LOG_PREFIX} Artifact {artifact_id} is not running")
            return True

        logger.info(f"{LOG_PREFIX} Stopping artifact {artifact_id}")

        # Destroy the VM
        if artifact.running_vm_id and self.vm_manager:
            self.vm_manager.destroy_vm(artifact.running_vm_id, artifact.chat_id)

        artifact.running_vm_id = None
        artifact.status = ArtifactStatus.STOPPED
        self._store_artifact(artifact)

        return True

    async def open_in_electron(
        self,
        artifact_id: str,
        version: Optional[int] = None,
        detached: bool = False,
    ) -> bool:
        """
        Signal Electron to open the artifact panel.

        Args:
            artifact_id: Artifact ID
            version: Version to view (will start server if needed)
            detached: Open in separate window

        Returns:
            True if signal sent successfully
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
            return False

        # Start artifact if not running
        if artifact.status != ArtifactStatus.RUNNING:
            await self.start_artifact(artifact_id, version=version)
            artifact = self._get_artifact(artifact_id)

        if not artifact.preview_url:
            logger.error(f"{LOG_PREFIX} No preview URL for artifact {artifact_id}")
            return False

        # Send signal to Electron
        try:
            async with aiohttp.ClientSession() as session:
                payload = {
                    "artifact_id": artifact_id,
                    "chat_id": artifact.chat_id,
                    "preview_url": artifact.preview_url,
                    "name": artifact.name,
                    "version": version or artifact.current_version,
                    "detached": detached,
                }

                async with session.post(
                    f"{self.ELECTRON_API_URL}/api/artifact/open",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as response:
                    if response.status == 200:
                        logger.info(f"{LOG_PREFIX} Opened artifact {artifact_id} in Electron")
                        return True
                    else:
                        logger.error(f"{LOG_PREFIX} Electron API returned {response.status}")
                        return False

        except Exception as e:
            logger.warning(f"{LOG_PREFIX} Could not signal Electron (may not be running): {e}")
            # Still return true since artifact is running
            return True

    async def close_in_electron(self, artifact_id: str) -> bool:
        """
        Signal Electron to close the artifact panel.

        Args:
            artifact_id: Artifact ID

        Returns:
            True if signal sent successfully
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.ELECTRON_API_URL}/api/artifact/close",
                    json={"artifact_id": artifact_id},
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as response:
                    return response.status == 200
        except Exception as e:
            logger.warning(f"{LOG_PREFIX} Could not signal Electron: {e}")
            return False

    async def notify_version_changed(
        self,
        artifact_id: str,
        version: int,
        host_port: Optional[int] = None,
    ) -> bool:
        """
        Signal Electron that an artifact version has changed.

        Args:
            artifact_id: Artifact ID
            version: New version number
            host_port: Optional new host port (for pool-based version switching)

        Returns:
            True if signal sent successfully
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
            return False

        # Use provided host_port or fall back to artifact's current port
        port_to_use = host_port if host_port else artifact.host_port
        preview_url = f"http://localhost:{port_to_use}" if port_to_use else artifact.preview_url

        try:
            async with aiohttp.ClientSession() as session:
                payload = {
                    "artifact_id": artifact_id,
                    "version": version,
                    "preview_url": preview_url,
                    "host_port": port_to_use,
                }

                async with session.post(
                    f"{self.ELECTRON_API_URL}/api/artifact/version-changed",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as response:
                    if response.status == 200:
                        logger.info(f"{LOG_PREFIX} Notified Electron of version {version} for artifact {artifact_id}")
                        return True
                    else:
                        logger.error(f"{LOG_PREFIX} Electron API returned {response.status}")
                        return False

        except Exception as e:
            logger.warning(f"{LOG_PREFIX} Could not notify Electron of version change: {e}")
            # Still return true - don't fail if Electron not running
            return True

    async def restart_artifact_server(self, artifact_id: str) -> bool:
        """
        Restart the server process for a running artifact.

        This is needed after creating a new version so the preview
        shows the updated content instead of stale cached files.

        Args:
            artifact_id: Artifact ID

        Returns:
            True if server restarted successfully
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
            return False

        if artifact.status != ArtifactStatus.RUNNING:
            logger.warning(f"{LOG_PREFIX} Artifact {artifact_id} is not running, cannot restart")
            return False

        if not artifact.running_vm_id:
            logger.error(f"{LOG_PREFIX} No running VM for artifact {artifact_id}")
            return False

        try:
            # Kill the old server process
            # Use pkill with the start_command pattern to find and kill it
            kill_cmd = f"pkill -f '{artifact.start_command}' || true"
            self.vm_manager.execute_bash(artifact.running_vm_id, kill_cmd)

            # Wait for process to die
            await asyncio.sleep(1)

            # Restart the server
            start_cmd = f"cd {artifact.working_directory} && nohup {artifact.start_command} > /tmp/server.log 2>&1 &"
            self.vm_manager.execute_bash(artifact.running_vm_id, start_cmd)

            # Wait for server to start
            await asyncio.sleep(2)

            logger.info(f"{LOG_PREFIX} Restarted server for artifact {artifact_id}")
            return True

        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to restart server for artifact {artifact_id}: {e}")
            return False

    async def switch_artifact_version(self, artifact_id: str, version: int) -> Dict[str, Any]:
        """
        Switch a running artifact to a different version.

        Supports hot/cold switching:
        - HOT: If version is already running in the VM pool, return existing port instantly
        - COLD: If version not in pool, create new VM, restore snapshot (may evict oldest)

        Args:
            artifact_id: Artifact ID
            version: Version to switch to

        Returns:
            Dict with success status, host_port, vm_id, from_pool flag, and evicted_version
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
            return {"success": False, "error": "Artifact not found"}

        if artifact.status != ArtifactStatus.RUNNING:
            logger.warning(f"{LOG_PREFIX} Artifact {artifact_id} is not running")
            return {"success": False, "error": "Artifact is not running"}

        if not artifact.running_vm_id:
            logger.error(f"{LOG_PREFIX} No running VM for artifact {artifact_id}")
            return {"success": False, "error": "No running VM"}

        # Check if version exists
        version_info = None
        for v in artifact.versions:
            if v.version == version:
                version_info = v
                break

        if not version_info:
            logger.error(f"{LOG_PREFIX} Version {version} not found for artifact {artifact_id}")
            return {"success": False, "error": f"Version {version} not found"}

        logger.info(f"{LOG_PREFIX} Switching artifact {artifact_id} to version {version}")

        try:
            # NEW ARCHITECTURE: Use VM pool (one VM per version)
            if self.vm_pool:
                # Check if version is already in the VM pool (HOT switch)
                existing_vm = self.vm_pool.get_vm_for_version(artifact_id, version)
                if existing_vm:
                    # HOT SWITCH: Version is already running in its own VM
                    logger.info(f"{LOG_PREFIX} HOT SWITCH: Version {version} already running on port {existing_vm.host_port}")

                    artifact.current_version = version
                    artifact.host_port = existing_vm.host_port
                    artifact.running_vm_id = existing_vm.vm_id
                    self._store_artifact(artifact)

                    return {
                        "success": True,
                        "artifact_id": artifact_id,
                        "version": version,
                        "vm_id": existing_vm.vm_id,
                        "host_port": existing_vm.host_port,
                        "preview_url": f"http://localhost:{existing_vm.host_port}",
                        "from_pool": True,
                        "evicted_version": None,
                    }

                # COLD SWITCH: Create new VM for this version
                logger.info(f"{LOG_PREFIX} COLD SWITCH: Version {version} not in pool, creating new VM")

                pooled_vm, from_pool, evicted_version = await self.vm_pool.switch_to_version(
                    artifact_id=artifact_id,
                    version=version,
                    snapshot_path=version_info.snapshot_path,
                    start_command=artifact.start_command,
                    container_port=artifact.container_port,
                    chat_id=artifact.chat_id,
                    working_directory=artifact.working_directory,
                )

                if pooled_vm:
                    artifact.current_version = version
                    artifact.host_port = pooled_vm.host_port
                    artifact.running_vm_id = pooled_vm.vm_id
                    self._store_artifact(artifact)

                    logger.info(
                        f"{LOG_PREFIX} COLD SWITCH complete: artifact {artifact_id} now on version {version}, "
                        f"VM {pooled_vm.vm_id}, port {pooled_vm.host_port}"
                    )

                    return {
                        "success": True,
                        "artifact_id": artifact_id,
                        "version": version,
                        "vm_id": pooled_vm.vm_id,
                        "host_port": pooled_vm.host_port,
                        "preview_url": f"http://localhost:{pooled_vm.host_port}",
                        "from_pool": from_pool,
                        "evicted_version": evicted_version,
                    }
                else:
                    logger.error(f"{LOG_PREFIX} Failed to create VM for version {version}")
                    return {"success": False, "error": "Failed to create VM for version"}

            # LEGACY: Use server pool (multiple servers per VM)
            vm_id = artifact.running_vm_id

            if self.server_pool:
                existing_server = self.server_pool.get_server_for_version(vm_id, version)
                if existing_server:
                    # HOT SWITCH: Version is already running
                    logger.info(f"{LOG_PREFIX} HOT SWITCH (legacy): Version {version} already running on port {existing_server.host_port}")

                    artifact.current_version = version
                    artifact.host_port = existing_server.host_port
                    self._store_artifact(artifact)

                    return {
                        "success": True,
                        "artifact_id": artifact_id,
                        "version": version,
                        "host_port": existing_server.host_port,
                        "preview_url": f"http://localhost:{existing_server.host_port}",
                        "from_pool": True,
                        "evicted_version": None,
                    }

            # COLD SWITCH (legacy)
            logger.info(f"{LOG_PREFIX} COLD SWITCH (legacy): Version {version} not in pool")

            snapshot_path = None
            if self.snapshot_manager:
                snapshot = self.snapshot_manager.get_snapshot(artifact_id, version)
                if snapshot and snapshot.snapshot_path:
                    snapshot_path = snapshot.snapshot_path
                else:
                    logger.error(f"{LOG_PREFIX} No snapshot found for version {version}")
                    return {"success": False, "error": f"No snapshot for version {version}"}

            evicted_version = None
            new_host_port = artifact.host_port

            if self.server_pool:
                server, evicted_version = await self.server_pool.add_server(
                    vm_id=vm_id,
                    version=version,
                    snapshot_path=snapshot_path,
                    artifact_id=artifact_id,
                    start_command=artifact.start_command,
                    working_directory=artifact.working_directory,
                )

                if server:
                    new_host_port = server.host_port
                    pool = self.server_pool.get_pool(vm_id)
                    logger.info(f"{LOG_PREFIX} Server pool now has {len(pool)} servers")
                    if evicted_version:
                        logger.info(f"{LOG_PREFIX} Evicted version {evicted_version} to make room")
                else:
                    logger.error(f"{LOG_PREFIX} Failed to add server to pool")
                    return {"success": False, "error": "Failed to start server for version"}
            else:
                # No pool manager fallback
                kill_cmd = f"pkill -f '{artifact.start_command}' || true"
                self.vm_manager.execute_bash(vm_id, kill_cmd)
                await asyncio.sleep(1)

                if self.snapshot_manager:
                    self.snapshot_manager.restore_snapshot(
                        artifact_id=artifact_id,
                        version=version,
                        vm_id=vm_id,
                    )
                    logger.info(f"{LOG_PREFIX} Restored snapshot for version {version}")

                start_cmd = f"cd {artifact.working_directory} && nohup {artifact.start_command} > /tmp/server.log 2>&1 &"
                self.vm_manager.execute_bash(vm_id, start_cmd)
                await asyncio.sleep(2)

            artifact.current_version = version
            artifact.host_port = new_host_port
            self._store_artifact(artifact)

            logger.info(f"{LOG_PREFIX} COLD SWITCH complete: artifact {artifact_id} now on version {version}, port {new_host_port}")

            return {
                "success": True,
                "artifact_id": artifact_id,
                "version": version,
                "host_port": new_host_port,
                "preview_url": f"http://localhost:{new_host_port}",
                "from_pool": False,
                "evicted_version": evicted_version,
            }

        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to switch version: {e}")
            return {"success": False, "error": str(e)}

    def get_artifact(self, artifact_id: str) -> Optional[Artifact]:
        """Get artifact by ID."""
        return self._get_artifact(artifact_id)

    def list_artifacts(
        self,
        chat_id: str,
        include_all_versions: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        List all artifacts for a chat.

        Args:
            chat_id: Chat session ID
            include_all_versions: Include full version history

        Returns:
            List of artifact dictionaries
        """
        logger.info(f"{LOG_PREFIX} list_artifacts called for chat_id: {chat_id}")
        artifacts = []

        if self.redis_client:
            try:
                chat_key = self._get_chat_key(chat_id)
                logger.info(f"{LOG_PREFIX} Looking up Redis key: {chat_key}")
                artifact_ids = self.redis_client.smembers(chat_key)
                logger.info(f"{LOG_PREFIX} Found {len(artifact_ids) if artifact_ids else 0} artifact IDs in Redis: {artifact_ids}")

                for artifact_id in artifact_ids:
                    artifact = self._get_artifact(artifact_id)
                    if artifact:
                        data = artifact.to_dict()
                        if not include_all_versions:
                            data["versions"] = [v for v in data["versions"]
                                               if v["version"] == artifact.current_version]
                        artifacts.append(data)

            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to list artifacts from Redis: {e}")

        # Fallback to local cache
        if not artifacts:
            logger.info(f"{LOG_PREFIX} Checking local cache for chat_id: {chat_id}")
            logger.info(f"{LOG_PREFIX} Local cache has chats: {list(self._chat_artifacts.keys())}")
            for artifact_id in self._chat_artifacts.get(chat_id, set()):
                artifact = self._artifacts.get(artifact_id)
                if artifact:
                    data = artifact.to_dict()
                    if not include_all_versions:
                        data["versions"] = [v for v in data["versions"]
                                           if v["version"] == artifact.current_version]
                    artifacts.append(data)

        # Final fallback: scan disk for artifacts (handles Redis restart/eviction)
        if not artifacts:
            logger.info(f"{LOG_PREFIX} Scanning disk for artifacts for chat_id: {chat_id}")
            disk_artifact_ids = self._scan_disk_for_chat_artifacts(chat_id)
            logger.info(f"{LOG_PREFIX} Found {len(disk_artifact_ids)} artifacts on disk: {disk_artifact_ids}")

            for artifact_id in disk_artifact_ids:
                artifact = self._get_artifact(artifact_id)  # This will recover and cache
                if artifact:
                    data = artifact.to_dict()
                    if not include_all_versions:
                        data["versions"] = [v for v in data["versions"]
                                           if v["version"] == artifact.current_version]
                    artifacts.append(data)

        logger.info(f"{LOG_PREFIX} Returning {len(artifacts)} artifacts")
        return sorted(artifacts, key=lambda a: a["created_at"], reverse=True)

    async def delete_artifact(
        self,
        artifact_id: str,
        chat_id: str,
    ) -> bool:
        """
        Delete an artifact and all its resources.

        Args:
            artifact_id: Artifact ID
            chat_id: Chat ID (for verification)

        Returns:
            True if deleted successfully
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
            return False

        if artifact.chat_id != chat_id:
            logger.error(f"{LOG_PREFIX} Unauthorized: chat ID mismatch")
            return False

        logger.info(f"{LOG_PREFIX} Deleting artifact {artifact_id}")

        # Stop if running
        if artifact.status == ArtifactStatus.RUNNING:
            await self.stop_artifact(artifact_id)

        # Release port
        if self.port_allocator and artifact.host_port:
            self.port_allocator.release_port(artifact.host_port)

        # Delete snapshots
        if self.snapshot_manager:
            self.snapshot_manager.delete_all_snapshots(artifact_id)

        # Delete artifact record
        self._delete_artifact(artifact_id)

        # Close in Electron
        await self.close_in_electron(artifact_id)

        logger.info(f"{LOG_PREFIX} Artifact {artifact_id} deleted")
        return True

    async def restore_version(
        self,
        artifact_id: str,
        version: int,
        chat_id: str,
    ) -> bool:
        """
        Restore an artifact to a specific version.

        Args:
            artifact_id: Artifact ID
            version: Version to restore
            chat_id: Chat ID (for verification)

        Returns:
            True if restored successfully
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            logger.error(f"{LOG_PREFIX} Artifact not found: {artifact_id}")
            return False

        if artifact.chat_id != chat_id:
            logger.error(f"{LOG_PREFIX} Unauthorized: chat ID mismatch")
            return False

        # Find the version
        target_version = None
        for v in artifact.versions:
            if v.version == version:
                target_version = v
                break

        if not target_version:
            logger.error(f"{LOG_PREFIX} Version {version} not found for artifact {artifact_id}")
            return False

        # Stop if running
        was_running = artifact.status == ArtifactStatus.RUNNING
        if was_running:
            await self.stop_artifact(artifact_id)

        artifact.current_version = version
        self._store_artifact(artifact)

        # Restart with the new version if it was running
        if was_running:
            await self.start_artifact(artifact_id, version=version)
            await self.open_in_electron(artifact_id, version=version)

        logger.info(f"{LOG_PREFIX} Restored artifact {artifact_id} to version {version}")
        return True

    def get_artifact_status(self, artifact_id: str) -> Dict[str, Any]:
        """
        Get detailed status of an artifact.

        Args:
            artifact_id: Artifact ID

        Returns:
            Status dictionary
        """
        artifact = self._get_artifact(artifact_id)
        if not artifact:
            return {"error": "Artifact not found"}

        return {
            "artifact_id": artifact_id,
            "name": artifact.name,
            "status": artifact.status.value,
            "preview_url": artifact.preview_url,
            "current_version": artifact.current_version,
            "total_versions": len(artifact.versions),
            "running_vm_id": artifact.running_vm_id,
            "host_port": artifact.host_port,
            "error_message": artifact.error_message,
        }


# Singleton instance
_artifact_manager_instance: Optional[ArtifactManager] = None


def get_artifact_manager(
    redis_client=None,
    vm_manager=None,
    port_allocator=None,
    snapshot_manager=None,
) -> ArtifactManager:
    """
    Get or create the singleton ArtifactManager instance.

    Args:
        redis_client: Redis client (only used on first call)
        vm_manager: AgentVMManager (only used on first call)
        port_allocator: PortAllocator (only used on first call)
        snapshot_manager: SnapshotManager (only used on first call)

    Returns:
        ArtifactManager instance
    """
    global _artifact_manager_instance

    if _artifact_manager_instance is None:
        _artifact_manager_instance = ArtifactManager(
            redis_client=redis_client,
            vm_manager=vm_manager,
            port_allocator=port_allocator,
            snapshot_manager=snapshot_manager,
        )

    return _artifact_manager_instance


def reset_artifact_manager() -> None:
    """Reset the singleton instance (mainly for testing)."""
    global _artifact_manager_instance
    _artifact_manager_instance = None
