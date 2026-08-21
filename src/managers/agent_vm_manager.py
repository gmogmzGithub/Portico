"""
Agent VM Manager for Portico
Manages long-lived Docker containers for persistent agent VM execution.

Unlike ephemeral ScriptExecutor containers, these VMs:
- Persist across multiple operations within a chat session
- Support interactive bash, file, and Python operations
- Have ownership verification (only creating chat can operate)
- Auto-cleanup after configurable timeout

Security features:
- Network disabled (no external access)
- Memory limit (1GB)
- CPU limit (2 cores)
- Ownership verification via chat_id
- Timeout enforcement (default 4h, max 24h)
"""

import os
import json
import logging
import shlex
import time
import tarfile
import io
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field
from pathlib import Path

try:
    import docker
    from docker.errors import ContainerError, ImageNotFound, APIError, NotFound
    DOCKER_AVAILABLE = True
except ImportError:
    DOCKER_AVAILABLE = False

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

from .agent_vm_image import (
    build_info_to_agent_vm_image_refs,
    extract_build_number,
    get_agent_vm_local_build_command,
)

logger = logging.getLogger(__name__)

# Harbor registry configuration (same as script_executor)
HARBOR_REGISTRY = "harbor.example.invalid"
HARBOR_PROJECT = "portico"
AGENT_VM_IMAGE_NAME = "agent-vm"


def _positive_int_env(name: str, default: int) -> int:
    """Read a positive integer from the environment with safe fallback."""
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


@dataclass
class VMInfo:
    """Information about a running agent VM."""
    vm_id: str  # Unique GUID for this VM (returned to LLM)
    container_id: str
    chat_id: str  # Owner chat session (for ownership verification)
    created_at: float
    last_activity: float
    timeout_hours: float
    status: str  # 'running', 'stopped', 'error'
    sharing_key: Optional[str] = None  # Workspace sharing key (None = isolated by vm_id)
    network_enabled: bool = False  # Whether networking is enabled (for artifacts)
    port_mappings: Dict[int, int] = field(default_factory=dict)  # container_port -> host_port
    # Set from the /work bind-mount source; never recompute from chat_id/vm_id.
    work_bind_source: Optional[str] = None
    # True only when work_bind_source came from the actual /work bind source.
    work_bind_source_verified: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "vm_id": self.vm_id,
            "container_id": self.container_id,
            "chat_id": self.chat_id,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "timeout_hours": self.timeout_hours,
            "status": self.status,
            "sharing_key": self.sharing_key,
            "network_enabled": self.network_enabled,
            "port_mappings": self.port_mappings,
            "work_bind_source": self.work_bind_source,
            "work_bind_source_verified": self.work_bind_source_verified,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "VMInfo":
        """Create VMInfo from dictionary."""
        return cls(
            vm_id=data["vm_id"],
            container_id=data["container_id"],
            chat_id=data["chat_id"],
            created_at=data["created_at"],
            last_activity=data["last_activity"],
            timeout_hours=data["timeout_hours"],
            status=data["status"],
            sharing_key=data.get("sharing_key"),  # Optional for backwards compatibility
            network_enabled=data.get("network_enabled", False),
            port_mappings=data.get("port_mappings", {}),
            work_bind_source=data.get("work_bind_source"),
            work_bind_source_verified=data.get("work_bind_source_verified", False),
        )


@dataclass
class ExecResult:
    """Result of executing a command in a VM."""
    success: bool
    exit_code: int
    stdout: str
    stderr: str
    execution_time: float = 0.0
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "success": self.success,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "execution_time": self.execution_time,
            "error_message": self.error_message,
        }


class AgentVMManager:
    """
    Manages long-lived Docker containers for agent VMs.

    Key differences from ephemeral ScriptExecutor:
    - VMs persist across multiple tool calls
    - VMs are identified by unique vm_id (GUID), owned by chat_id
    - Multiple VMs can be created per chat session
    - Timeout-based auto-cleanup
    - State stored in Redis for persistence

    Usage:
        manager = get_agent_vm_manager()
        # Create VM returns a unique vm_id
        vm_info = manager.create_vm(chat_id="abc-123", timeout_hours=4)
        vm_id = vm_info.vm_id  # GUID like "550e8400-e29b-41d4-a716-446655440000"

        # All subsequent operations use vm_id
        result = manager.execute_bash(vm_id, command="ls -la")
        manager.destroy_vm(vm_id, requester_chat_id="abc-123")
    """

    # Container resource limits - more generous for persistent work
    MEMORY_LIMIT = "1g"
    CPU_PERIOD = 100000
    CPU_QUOTA = 200000  # 2 cores
    DEFAULT_TIMEOUT_HOURS = 4
    MAX_TIMEOUT_HOURS = 24

    # Docker network for networked VMs (artifacts)
    DOCKER_NETWORK = "portico-network"

    # Global VM limit - automatically clean up oldest VMs when creating new ones
    MAX_GLOBAL_VMS = _positive_int_env("AGENT_VM_MAX_GLOBAL_VMS", 15)
    MAX_SYNC_CLEANUP_PER_CREATE = _positive_int_env(
        "AGENT_VM_MAX_SYNC_CLEANUP_PER_CREATE", 8
    )

    # Redis keys
    VM_INFO_PREFIX = "agent_vm_info:"
    FILE_READS_PREFIX = "agent_vm_file_reads:"

    # Container naming
    CONTAINER_PREFIX = "agent-vm-"

    def __init__(
        self,
        redis_client=None,
        workspaces_base_dir: str = None,
    ):
        """
        Initialize the AgentVMManager.

        Args:
            redis_client: Redis client for VM registry persistence
            workspaces_base_dir: Base directory for workspaces
        """
        if not DOCKER_AVAILABLE:
            raise RuntimeError("docker package not available. Install with: pip install docker")

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
                logger.info("AgentVMManager connected to Redis")
            except Exception as e:
                logger.warning(f"AgentVMManager could not connect to Redis: {e}")
                self.redis_client = None

        # Initialize workspace base directory
        if workspaces_base_dir is None:
            if os.path.exists("/app/workspaces"):
                workspaces_base_dir = "/app/workspaces"
            else:
                # Local development
                project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                workspaces_base_dir = os.path.join(project_root, "workspaces")

        self.workspaces_base_dir = workspaces_base_dir
        self.docker_client = docker.from_env(timeout=120)

        # For Docker-in-Docker: get host project root for volume mounts
        self.host_project_root = os.environ.get("HOST_PROJECT_ROOT")
        if self.host_project_root:
            logger.info(f"Docker-in-Docker mode: HOST_PROJECT_ROOT={self.host_project_root}")

        self._build_number = extract_build_number(self._get_build_info_paths())
        self._resolved_image_name: Optional[str] = None

        logger.info(f"AgentVMManager initialized with workspaces_base_dir: {workspaces_base_dir}")
        if self._build_number:
            logger.info(f"Release build detected for AgentVMManager: {self._build_number}")
        else:
            logger.info("Dev build or missing build-info.json for AgentVMManager")

    @property
    def IMAGE_NAME(self) -> str:
        """Get the default Agent VM image name used for basic persistent VMs."""
        try:
            return self._resolve_image_name()
        except docker.errors.ImageNotFound:
            return f"{AGENT_VM_IMAGE_NAME}:latest"

    def _get_build_info_paths(self) -> List[str]:
        """Return build-info.json locations that apply to the VM manager."""
        return [
            "/app/electron-app/build-info.json",
            os.path.join(os.path.dirname(self.workspaces_base_dir), "electron-app", "build-info.json"),
        ]

    def _candidate_image_names(self) -> List[str]:
        """Return candidate image references for the published Agent VM image."""
        return build_info_to_agent_vm_image_refs(
            self._build_number,
            HARBOR_REGISTRY,
            HARBOR_PROJECT,
            AGENT_VM_IMAGE_NAME,
        )

    def _image_exists_or_pull(self, image_name: str) -> bool:
        """Ensure an image exists locally, pulling Harbor images when needed."""
        try:
            self.docker_client.images.get(image_name)
            return True
        except docker.errors.ImageNotFound:
            if HARBOR_REGISTRY not in image_name:
                return False

            try:
                logger.info(f"Image {image_name} not found locally, attempting Harbor pull")
                self.docker_client.images.pull(image_name)
                return True
            except Exception as e:
                logger.warning(f"Failed to pull {image_name}: {e}")
                return False

    def _resolve_image_name(self) -> str:
        """Resolve the best available image reference for the Agent VM image."""
        cached = self._resolved_image_name
        if cached and self._image_exists_or_pull(cached):
            return cached

        for image_name in self._candidate_image_names():
            if self._image_exists_or_pull(image_name):
                self._resolved_image_name = image_name
                logger.info(f"Using Agent VM image {image_name}")
                return image_name

        raise docker.errors.ImageNotFound("No Agent VM image available")

    def _build_help_message(self) -> str:
        """Build a concise help message for missing Agent VM images."""
        return f"Build it with: {get_agent_vm_local_build_command(AGENT_VM_IMAGE_NAME)}"

    def _container_to_host_path(self, container_path: str) -> str:
        """Convert container path to host path for Docker volume mounts."""
        if not self.host_project_root:
            return container_path

        path_mappings = {
            "/app/workspaces": "workspaces",
        }

        for container_prefix, relative_path in path_mappings.items():
            if container_path.startswith(container_prefix):
                suffix = container_path[len(container_prefix):]
                host_path = os.path.join(self.host_project_root, relative_path + suffix)
                logger.debug(f"Path conversion: {container_path} -> {host_path}")
                return host_path

        return container_path

    def _run_with_timeout(self, fn, timeout_seconds: int):
        """Run a callable with a hard timeout using a thread pool.

        Used to enforce timeouts on Docker SDK calls that don't support
        native timeout parameters (e.g., containers.run with image pull).

        Args:
            fn: Zero-argument callable to execute
            timeout_seconds: Maximum seconds to wait

        Returns:
            The return value of fn()

        Raises:
            RuntimeError: If the operation times out
        """
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(fn)
            try:
                return future.result(timeout=timeout_seconds)
            except FuturesTimeoutError:
                raise RuntimeError(
                    f"Docker operation timed out after {timeout_seconds}s. "
                    f"Docker daemon may be unresponsive or an image pull is stalled. "
                    f"Try restarting Docker Desktop."
                )

    def _get_container_name(self, vm_id: str) -> str:
        """Generate container name from vm_id."""
        # Sanitize vm_id for use in container name
        safe_id = "".join(c if c.isalnum() or c in "-_" else "-" for c in vm_id)
        return f"{self.CONTAINER_PREFIX}{safe_id}"

    def _get_redis_key(self, vm_id: str) -> str:
        """Get Redis key for VM info."""
        return f"{self.VM_INFO_PREFIX}{vm_id}"

    def _store_vm_info(self, vm_info: VMInfo) -> bool:
        """Store VM info in Redis."""
        if not self.redis_client:
            logger.warning("Redis not available, VM info not persisted")
            return False

        try:
            key = self._get_redis_key(vm_info.vm_id)
            self.redis_client.set(key, json.dumps(vm_info.to_dict()))
            return True
        except Exception as e:
            logger.error(f"Failed to store VM info in Redis: {e}")
            return False

    def _get_vm_info(self, vm_id: str) -> Optional[VMInfo]:
        """Get VM info from Redis by vm_id."""
        if not self.redis_client:
            return None

        try:
            key = self._get_redis_key(vm_id)
            data = self.redis_client.get(key)
            if data:
                return VMInfo.from_dict(json.loads(data))
        except Exception as e:
            logger.error(f"Failed to get VM info from Redis: {e}")
        return None

    def _delete_vm_info(self, vm_id: str) -> bool:
        """Delete VM info from Redis."""
        if not self.redis_client:
            return False

        try:
            key = self._get_redis_key(vm_id)
            self.redis_client.delete(key)
            return True
        except Exception as e:
            logger.error(f"Failed to delete VM info from Redis: {e}")
            return False

    def vm_container_exists(self, vm_id: str) -> bool:
        """
        Check if the Docker container for a VM actually exists.

        This method checks the actual Docker daemon, not just Redis.
        Handles the case where Redis says a VM exists but the container
        was removed (e.g., after host restart or manual cleanup).

        Args:
            vm_id: The VM GUID to check

        Returns:
            True if the container exists and is in a valid state
        """
        if not self.docker_client:
            return False

        try:
            container_name = self._get_container_name(vm_id)
            container = self.docker_client.containers.get(container_name)
            # Container exists - check if it's in a valid state
            return container.status in ("running", "created", "paused")
        except NotFound:
            # Container doesn't exist - clean up stale Redis entry
            self._delete_vm_info(vm_id)
            return False
        except Exception as e:
            logger.error(f"Error checking if VM container exists: {e}")
            return False

    def _enforce_global_vm_limit(self) -> int:
        """
        Enforce global VM limit by removing oldest VMs when at or over limit.

        Called BEFORE creating a new VM to ensure we don't exceed MAX_GLOBAL_VMS.
        Uses Docker container creation timestamps to determine age (oldest first).

        Returns:
            Number of VMs cleaned up
        """
        if not self.docker_client:
            return 0

        try:
            # Get all agent-vm containers (running or stopped)
            containers = self.docker_client.containers.list(
                all=True,
                filters={"name": self.CONTAINER_PREFIX}
            )

            current_count = len(containers)
            if current_count < self.MAX_GLOBAL_VMS:
                return 0  # Under limit, nothing to clean

            # Prefer removing non-running containers first, then oldest running VMs.
            containers.sort(
                key=lambda c: (
                    0 if getattr(c, "status", "") != "running" else 1,
                    c.attrs["Created"],
                )
            )

            # Remove enough to make room for the new VM, but bound synchronous
            # cleanup so a large stale backlog does not turn a single VM create
            # into a massive, slow purge.
            to_remove_count = min(
                current_count - self.MAX_GLOBAL_VMS + 1,
                self.MAX_SYNC_CLEANUP_PER_CREATE,
            )
            containers_to_remove = containers[:to_remove_count]

            cleaned = 0
            for container in containers_to_remove:
                vm_id = container.name.replace(self.CONTAINER_PREFIX, "", 1)
                logger.info(f"[Cleanup] Removing old VM to enforce {self.MAX_GLOBAL_VMS} VM limit: {vm_id}")
                try:
                    container.remove(force=True)
                    # Clean up Redis entry
                    self.clear_file_reads(vm_id)
                    self._delete_vm_info(vm_id)
                    cleaned += 1
                except Exception as e:
                    logger.error(f"[Cleanup] Failed to remove VM {vm_id}: {e}")

            if cleaned > 0:
                logger.info(f"[Cleanup] Removed {cleaned} old VM(s) to enforce {self.MAX_GLOBAL_VMS} VM limit")
            deferred = current_count - self.MAX_GLOBAL_VMS + 1 - cleaned
            if deferred > 0:
                logger.info(
                    f"[Cleanup] Deferred cleanup for {deferred} additional VM(s); "
                    "background sweeper will continue draining the backlog"
                )

            return cleaned

        except Exception as e:
            logger.error(f"[Cleanup] Error enforcing VM limit: {e}")
            return 0

    # --- File Read Tracking (for read-before-edit safeguard) ---

    def _normalize_file_path(self, path: str) -> str:
        """Normalize file path for consistent tracking."""
        if not path.startswith("/"):
            path = f"/work/{path}"
        return os.path.normpath(path)

    def _get_file_reads_key(self, vm_id: str) -> str:
        """Get Redis key for file reads tracking."""
        return f"{self.FILE_READS_PREFIX}{vm_id}"

    def register_file_read(self, vm_id: str, file_path: str) -> bool:
        """
        Register that a file was read in a VM session.

        Args:
            vm_id: VM GUID
            file_path: Path to file that was read

        Returns:
            True if registered successfully (or Redis unavailable)
        """
        if not self.redis_client:
            return True  # Allow if Redis unavailable

        try:
            normalized = self._normalize_file_path(file_path)
            key = self._get_file_reads_key(vm_id)

            # Get VM TTL for consistent expiry
            vm_info = self._get_vm_info(vm_id)
            if vm_info:
                ttl_seconds = int((vm_info.timeout_hours + 1) * 3600)
                self.redis_client.sadd(key, normalized)
                self.redis_client.expire(key, ttl_seconds)
                logger.debug(f"Registered file read: vm={vm_id}, path={normalized}")
            return True
        except Exception as e:
            logger.error(f"Failed to register file read: {e}")
            return True  # Don't block on tracking failure

    def has_file_been_read(self, vm_id: str, file_path: str) -> bool:
        """
        Check if a file was previously read in this VM session.

        Args:
            vm_id: VM GUID
            file_path: Path to file to check

        Returns:
            True if file was read, or if Redis unavailable (fail-open)
        """
        if not self.redis_client:
            return True  # Allow if Redis unavailable (fail-open)

        try:
            normalized = self._normalize_file_path(file_path)
            key = self._get_file_reads_key(vm_id)
            return bool(self.redis_client.sismember(key, normalized))
        except Exception as e:
            logger.error(f"Failed to check file read status: {e}")
            return True  # Allow on error (fail-open)

    def clear_file_reads(self, vm_id: str) -> bool:
        """
        Clear file read tracking for a VM.

        Args:
            vm_id: VM GUID

        Returns:
            True if cleared successfully
        """
        if not self.redis_client:
            return True

        try:
            key = self._get_file_reads_key(vm_id)
            self.redis_client.delete(key)
            logger.debug(f"Cleared file read tracking for vm={vm_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to clear file reads: {e}")
            return False

    # --- End File Read Tracking ---

    def _update_last_activity(self, vm_id: str) -> bool:
        """Update last activity timestamp for a VM."""
        vm_info = self._get_vm_info(vm_id)
        if vm_info:
            vm_info.last_activity = time.time()
            return self._store_vm_info(vm_info)
        return False

    def _verify_ownership(self, vm_id: str, requester_chat_id: str) -> bool:
        """
        Verify that the requester owns the VM.

        Security: Prevents one chat from operating on another chat's VM.
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return False
        return vm_info.chat_id == requester_chat_id

    def create_vm(
        self,
        chat_id: str,
        timeout_hours: float = None,
        sharing_key: Optional[str] = None,
        enable_networking: bool = False,
        port_mappings: Dict[int, int] = None,
    ) -> VMInfo:
        """
        Create a persistent VM for a chat session.

        A chat can create multiple VMs. Each VM gets a unique vm_id (GUID)
        that must be used for all subsequent operations.

        Each VM gets its own isolated workspace directory. This prevents
        file collisions when multiple VMs are created in the same chat
        (e.g., for multiple artifacts).

        Args:
            chat_id: Chat session ID (becomes VM owner)
            timeout_hours: VM timeout in hours (default 4, max 24)
            sharing_key: Deprecated - ignored. Each VM has isolated workspace.
            enable_networking: Enable network access for this VM (default False).
                When True, the VM can access the internet (npm install, etc.) and expose ports.
                Required for npm install, artifact web servers, and any network operations.
            port_mappings: Dict mapping container ports to host ports.
                Example: {5173: 10001} maps container port 5173 to host port 10001.
                Only used when enable_networking=True.
                All ports are bound to 127.0.0.1 only for security.
        Returns:
            VMInfo with vm_id GUID and container details

        Raises:
            RuntimeError: If VM creation fails
        """
        # Generate unique VM ID
        vm_id = str(uuid.uuid4())

        # Validate timeout
        timeout_hours = timeout_hours or self.DEFAULT_TIMEOUT_HOURS
        if timeout_hours > self.MAX_TIMEOUT_HOURS:
            timeout_hours = self.MAX_TIMEOUT_HOURS
            logger.warning(f"Timeout clamped to max {self.MAX_TIMEOUT_HOURS} hours")

        chat_workspace_path = os.path.join(self.workspaces_base_dir, chat_id)
        os.makedirs(chat_workspace_path, exist_ok=True)

        # Convert to host paths for Docker volume mounts.
        host_workspace_path = self._container_to_host_path(chat_workspace_path)

        container_name = self._get_container_name(vm_id)

        port_mappings = port_mappings or {}
        if port_mappings and not enable_networking:
            raise ValueError("Port mappings require enable_networking=True")

        # Process port mappings for Docker
        docker_ports = None
        if enable_networking and port_mappings:
            # Format: {container_port/protocol: (host_ip, host_port)}
            # Bind only to localhost for security
            docker_ports = {
                f"{container_port}/tcp": ("127.0.0.1", host_port)
                for container_port, host_port in port_mappings.items()
            }
            logger.info(f"Port mappings: {port_mappings}")

        logger.info(f"Creating persistent VM for chat {chat_id}, vm_id={vm_id}")
        logger.info(f"Container name: {container_name}")
        logger.info(
            "[AgentVM] Workspace mounts: "
            f"chat ({host_workspace_path} -> /work:rw)"
        )
        logger.info(f"Networking: {'enabled' if enable_networking else 'disabled'}")

        # Enforce global VM limit before creating new VM
        self._enforce_global_vm_limit()

        try:
            image_name = self._resolve_image_name()

            # Wrap in timeout to prevent indefinite hangs (e.g., stalled image pull,
            # unresponsive Docker daemon). 240s is well within the 300s nginx proxy timeout.
            def _create_container():
                return self.docker_client.containers.run(
                    image=image_name,
                    name=container_name,
                    command=[
                        "sh",
                        "-lc",
                        "rm -rf /workspace 2>/dev/null || true; ln -s /work /workspace 2>/dev/null || true; tail -f /dev/null",
                    ],
                    volumes={
                        host_workspace_path: {"bind": "/work", "mode": "rw"},
                    },
                    working_dir="/work",
                    network=self.DOCKER_NETWORK if enable_networking else None,
                    network_disabled=not enable_networking,
                    ports=docker_ports,
                    mem_limit=self.MEMORY_LIMIT,
                    cpu_period=self.CPU_PERIOD,
                    cpu_quota=self.CPU_QUOTA,
                    detach=True,
                )

            container = self._run_with_timeout(_create_container, timeout_seconds=240)

            now = time.time()
            vm_info = VMInfo(
                vm_id=vm_id,
                container_id=container.id,
                chat_id=chat_id,
                created_at=now,
                last_activity=now,
                timeout_hours=timeout_hours,
                status="running",
                sharing_key=sharing_key,
                network_enabled=enable_networking,
                port_mappings=port_mappings,
                work_bind_source=host_workspace_path,
                work_bind_source_verified=True,
            )

            self._store_vm_info(vm_info)
            logger.info(f"VM created successfully: vm_id={vm_id}, container={container.id[:12]}")

            return vm_info

        except ImageNotFound:
            raise RuntimeError(
                f"Docker image not found for Agent VM. {self._build_help_message()}"
            )
        except Exception as e:
            logger.error(f"Failed to create VM: {e}")
            raise RuntimeError(f"Failed to create VM: {e}")

    def destroy_vm(self, vm_id: str, requester_chat_id: str) -> bool:
        """
        Destroy a persistent VM.

        Security: Only the chat that created the VM can destroy it.

        Args:
            vm_id: VM GUID to destroy
            requester_chat_id: Chat session ID making the request (must match owner)

        Returns:
            True if destroyed, False if not found or unauthorized
        """
        # Security: verify ownership
        if not self._verify_ownership(vm_id, requester_chat_id):
            logger.warning(
                f"Unauthorized VM destroy attempt: vm_id={vm_id}, requester={requester_chat_id}"
            )
            return False

        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            logger.info(f"No VM found with vm_id={vm_id}")
            return False

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
            container.remove(force=True)
            logger.info(f"VM destroyed: vm_id={vm_id}, container={vm_info.container_id[:12]}")
        except NotFound:
            logger.info(f"Container already removed for vm_id={vm_id}")
        except Exception as e:
            logger.error(f"Failed to remove container: {e}")

        # Intentionally preserve the host workspace directory so files remain
        # recoverable after VM expiry or container cleanup.
        # Clear file read tracking for this VM
        self.clear_file_reads(vm_id)
        self._delete_vm_info(vm_id)
        return True

    def get_vm_status(self, vm_id: str) -> Optional[VMInfo]:
        """
        Get VM status by vm_id.

        Args:
            vm_id: VM GUID from create_agent_vm

        Returns:
            VMInfo if VM exists, None otherwise
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return None

        # Verify container is actually running
        try:
            container = self.docker_client.containers.get(vm_info.container_id)
            vm_info.status = container.status
        except NotFound:
            vm_info.status = "not_found"
            self._delete_vm_info(vm_id)
            return None

        return vm_info

    def execute_bash(
        self,
        vm_id: str,
        command: str,
        timeout_seconds: int = 60,
    ) -> ExecResult:
        """
        Execute a bash command in the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            command: Bash command to execute
            timeout_seconds: Execution timeout (default 60s)

        Returns:
            ExecResult with stdout, stderr, exit code
        """
        start_time = time.time()

        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return ExecResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message=f"No VM found with vm_id={vm_id}. Create one first with create_agent_vm.",
            )

        try:
            container = self.docker_client.containers.get(vm_info.container_id)

            if container.status != "running":
                return ExecResult(
                    success=False,
                    exit_code=-1,
                    stdout="",
                    stderr="",
                    error_message=f"VM is not running (status: {container.status})",
                )

            # Execute command
            exit_code, output = container.exec_run(
                cmd=["bash", "-c", command],
                workdir="/work",
                demux=True,
            )

            stdout = output[0].decode('utf-8', errors='replace') if output[0] else ""
            stderr = output[1].decode('utf-8', errors='replace') if output[1] else ""

            self._update_last_activity(vm_id)

            return ExecResult(
                success=exit_code == 0,
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
                execution_time=time.time() - start_time,
            )

        except NotFound:
            self._delete_vm_info(vm_id)
            return ExecResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message="VM container not found. It may have been cleaned up.",
            )
        except Exception as e:
            return ExecResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=str(e),
                execution_time=time.time() - start_time,
                error_message=f"Execution failed: {e}",
            )

    def execute_python(
        self,
        vm_id: str,
        script_content: str,
        args: List[str] = None,
        timeout_seconds: int = 300,
    ) -> ExecResult:
        """
        Execute Python script content in the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            script_content: Python script content to execute
            args: Command line arguments
            timeout_seconds: Execution timeout

        Returns:
            ExecResult with stdout, stderr, exit code
        """
        start_time = time.time()
        args = args or []

        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return ExecResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message=f"No VM found with vm_id={vm_id}. Create one first.",
            )

        try:
            container = self.docker_client.containers.get(vm_info.container_id)

            if container.status != "running":
                return ExecResult(
                    success=False,
                    exit_code=-1,
                    stdout="",
                    stderr="",
                    error_message=f"VM is not running (status: {container.status})",
                )

            # Write script to temp file in container
            script_path = "/tmp/script.py"
            self._write_file_to_container(container, script_path, script_content.encode('utf-8'))

            # Execute script
            cmd = f"python {script_path} {' '.join(args)}"
            exit_code, output = container.exec_run(
                cmd=["bash", "-c", cmd],
                workdir="/work",
                demux=True,
            )

            stdout = output[0].decode('utf-8', errors='replace') if output[0] else ""
            stderr = output[1].decode('utf-8', errors='replace') if output[1] else ""

            self._update_last_activity(vm_id)

            return ExecResult(
                success=exit_code == 0,
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
                execution_time=time.time() - start_time,
            )

        except NotFound:
            self._delete_vm_info(vm_id)
            return ExecResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message="VM container not found.",
            )
        except Exception as e:
            return ExecResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=str(e),
                execution_time=time.time() - start_time,
                error_message=f"Execution failed: {e}",
            )

    def create_file(
        self,
        vm_id: str,
        file_path: str,
        content: bytes,
    ) -> bool:
        """
        Create a file in the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            file_path: Path inside VM (relative to /work or absolute)
            content: File content as bytes

        Returns:
            True if created successfully
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"No VM found with vm_id={vm_id}")
            return False

        try:
            container = self.docker_client.containers.get(vm_info.container_id)

            # Ensure path is within /work or /tmp
            if not file_path.startswith("/"):
                file_path = f"/work/{file_path}"

            if not (file_path.startswith("/work/") or file_path.startswith("/tmp/")):
                logger.error(f"File path must be within /work or /tmp: {file_path}")
                return False

            self._write_file_to_container(container, file_path, content)
            self._update_last_activity(vm_id)
            return True

        except NotFound:
            self._delete_vm_info(vm_id)
            return False
        except Exception as e:
            logger.error(f"Failed to create file in VM: {e}")
            return False

    def create_files_batch(
        self,
        vm_id: str,
        files: List[Dict[str, str]],
    ) -> Dict[str, Any]:
        """
        Create multiple files in the VM in a single operation.

        This is more efficient than calling create_file multiple times,
        especially for web app projects with multiple files (HTML, CSS, JS).

        Args:
            vm_id: VM GUID from create_agent_vm
            files: List of file specs, each with:
                   - path: Path inside VM (relative to /work or absolute)
                   - content: File content as string

        Returns:
            Dict with:
                - success: Overall success (True if all files created)
                - created: List of successfully created file paths
                - failed: List of failed file paths with error messages
                - total: Total number of files attempted
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"No VM found with vm_id={vm_id}")
            return {
                "success": False,
                "created": [],
                "failed": [{"path": f["path"], "error": "VM not found"} for f in files],
                "total": len(files),
            }

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
        except NotFound:
            self._delete_vm_info(vm_id)
            return {
                "success": False,
                "created": [],
                "failed": [{"path": f["path"], "error": "Container not found"} for f in files],
                "total": len(files),
            }

        created = []
        failed = []

        for file_spec in files:
            file_path = file_spec.get("path", "")
            content = file_spec.get("content", "")

            try:
                # Ensure path is within /work or /tmp
                if not file_path.startswith("/"):
                    file_path = f"/work/{file_path}"

                if not (file_path.startswith("/work/") or file_path.startswith("/tmp/")):
                    failed.append({"path": file_path, "error": "Path must be within /work or /tmp"})
                    continue

                # Convert content to bytes if it's a string
                if isinstance(content, str):
                    content_bytes = content.encode("utf-8")
                else:
                    content_bytes = content

                self._write_file_to_container(container, file_path, content_bytes)
                created.append(file_path)
                logger.debug(f"Created file in VM: {file_path}")

            except Exception as e:
                failed.append({"path": file_path, "error": str(e)})
                logger.error(f"Failed to create file {file_path} in VM: {e}")

        self._update_last_activity(vm_id)

        return {
            "success": len(failed) == 0,
            "created": created,
            "failed": failed,
            "total": len(files),
        }

    def _write_file_to_container(self, container, file_path: str, content: bytes):
        """Write content to a file inside a container using tar."""
        # Create parent directories
        parent_dir = os.path.dirname(file_path)
        container.exec_run(["mkdir", "-p", parent_dir])

        # Create tar archive with the file
        tar_stream = io.BytesIO()
        with tarfile.open(fileobj=tar_stream, mode='w') as tar:
            file_data = io.BytesIO(content)
            info = tarfile.TarInfo(name=os.path.basename(file_path))
            info.size = len(content)
            tar.addfile(info, file_data)
        tar_stream.seek(0)

        # Put tar archive into container
        container.put_archive(parent_dir, tar_stream)

    def read_file(
        self,
        vm_id: str,
        file_path: str,
    ) -> Optional[bytes]:
        """
        Read a file from the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            file_path: Path inside VM

        Returns:
            File content as bytes, or None if not found
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"No VM found with vm_id={vm_id}")
            return None

        try:
            container = self.docker_client.containers.get(vm_info.container_id)

            # Ensure path is within /work
            if not file_path.startswith("/"):
                file_path = f"/work/{file_path}"

            # Get file via archive
            bits, stat = container.get_archive(file_path)

            # Extract from tar
            tar_stream = io.BytesIO()
            for chunk in bits:
                tar_stream.write(chunk)
            tar_stream.seek(0)

            with tarfile.open(fileobj=tar_stream, mode='r') as tar:
                member = tar.next()
                if member:
                    f = tar.extractfile(member)
                    if f:
                        self._update_last_activity(vm_id)
                        # Register this file as read (for read-before-edit safeguard)
                        self.register_file_read(vm_id, file_path)
                        return f.read()

            return None

        except NotFound:
            return None
        except Exception as e:
            logger.error(f"Failed to read file from VM: {e}")
            return None

    def read_files_batch(
        self,
        vm_id: str,
        paths: List[str],
    ) -> Dict[str, Any]:
        """
        Read multiple files from the VM in a single operation.

        More efficient than calling read_file multiple times,
        especially for bulk file operations.

        Args:
            vm_id: VM GUID from create_agent_vm
            paths: List of file paths to read (relative to /work or absolute)

        Returns:
            Dict with:
                - success: Overall success (True if all files read)
                - read: List of successfully read files with {path, content}
                - failed: List of failed files with {path, error}
                - total: Total number of files attempted
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"No VM found with vm_id={vm_id}")
            return {
                "success": False,
                "read": [],
                "failed": [{"path": p, "error": "VM not found"} for p in paths],
                "total": len(paths),
            }

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
        except NotFound:
            self._delete_vm_info(vm_id)
            return {
                "success": False,
                "read": [],
                "failed": [{"path": p, "error": "Container not found"} for p in paths],
                "total": len(paths),
            }

        read_files = []
        failed = []

        for file_path in paths:
            try:
                # Normalize path
                original_path = file_path
                if not file_path.startswith("/"):
                    file_path = f"/work/{file_path}"

                # Security: validate path is within allowed directories
                if not (file_path.startswith("/work/") or file_path.startswith("/tmp/")):
                    failed.append({"path": original_path, "error": "Path must be within /work or /tmp"})
                    continue

                # Get file via archive
                bits, stat = container.get_archive(file_path)

                # Extract from tar
                tar_stream = io.BytesIO()
                for chunk in bits:
                    tar_stream.write(chunk)
                tar_stream.seek(0)

                with tarfile.open(fileobj=tar_stream, mode='r') as tar:
                    member = tar.next()
                    if member and not member.isdir():
                        f = tar.extractfile(member)
                        if f:
                            content_bytes = f.read()
                            try:
                                content = content_bytes.decode('utf-8')
                                # Register this file as read (for read-before-edit safeguard)
                                self.register_file_read(vm_id, file_path)
                                read_files.append({"path": file_path, "content": content})
                            except UnicodeDecodeError:
                                failed.append({"path": original_path, "error": "File appears to be binary or uses unsupported encoding"})
                        else:
                            failed.append({"path": original_path, "error": "Failed to extract file content"})
                    elif member and member.isdir():
                        failed.append({"path": original_path, "error": "Path is a directory, not a file"})
                    else:
                        failed.append({"path": original_path, "error": "Failed to read file from archive"})

            except NotFound:
                failed.append({"path": original_path, "error": f"File not found: {file_path}"})
            except Exception as e:
                failed.append({"path": original_path, "error": str(e)})
                logger.error(f"Failed to read file {file_path} from VM: {e}")

        self._update_last_activity(vm_id)

        return {
            "success": len(failed) == 0,
            "read": read_files,
            "failed": failed,
            "total": len(paths),
        }

    def edit_file(
        self,
        vm_id: str,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> Dict[str, Any]:
        """
        Edit a file in the VM using string replacement.

        Args:
            vm_id: VM GUID from create_agent_vm
            file_path: Path inside VM (relative to /work or absolute)
            old_string: Text to find and replace (must not be empty)
            new_string: Replacement text (can be empty for deletion)
            replace_all: If True, replace all occurrences; if False, require unique match

        Returns:
            Dict with success status, file_path, replacements_made, and message/error
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return {
                "success": False,
                "error": f"No VM found with vm_id={vm_id}. Create one first with create_agent_vm."
            }

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
        except NotFound:
            self._delete_vm_info(vm_id)
            return {
                "success": False,
                "error": "VM container not found. It may have been cleaned up."
            }

        if container.status != "running":
            return {
                "success": False,
                "error": f"VM is not running (status: {container.status})"
            }

        # Normalize file path
        if not file_path.startswith("/"):
            file_path = f"/work/{file_path}"

        # Security: validate path is within allowed directories
        if not (file_path.startswith("/work/") or file_path.startswith("/tmp/")):
            return {
                "success": False,
                "error": f"File path must be within /work or /tmp: {file_path}",
                "hint": "Use paths like 'myfile.js' or '/work/src/app.py'"
            }

        # Additional security: prevent path traversal
        normalized_path = os.path.normpath(file_path)
        if ".." in normalized_path or not (
            normalized_path.startswith("/work/") or normalized_path.startswith("/tmp/")
        ):
            return {
                "success": False,
                "error": "Invalid file path: path traversal detected",
                "hint": "File paths cannot contain '..' or escape the allowed directories"
            }

        # Read the file
        try:
            bits, stat = container.get_archive(file_path)
        except NotFound:
            return {
                "success": False,
                "error": f"File not found: {file_path}",
                "hint": "Use vm_list_files to see available files, or vm_create_file to create new files."
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to read file: {str(e)}"
            }

        # Extract file content from tar
        try:
            tar_stream = io.BytesIO()
            for chunk in bits:
                tar_stream.write(chunk)
            tar_stream.seek(0)

            with tarfile.open(fileobj=tar_stream, mode='r') as tar:
                member = tar.next()
                if not member:
                    return {
                        "success": False,
                        "error": "Failed to extract file from archive"
                    }

                # Check if it's a directory
                if member.isdir():
                    return {
                        "success": False,
                        "error": f"Path is a directory, not a file: {file_path}",
                        "hint": "Use vm_list_files to explore directory contents."
                    }

                f = tar.extractfile(member)
                if not f:
                    return {
                        "success": False,
                        "error": "Failed to read file content"
                    }
                content_bytes = f.read()
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to process file archive: {str(e)}"
            }

        # Decode content as UTF-8
        try:
            content = content_bytes.decode('utf-8')
        except UnicodeDecodeError:
            return {
                "success": False,
                "error": "File appears to be binary or uses unsupported encoding",
                "hint": "vm_edit_file only supports text files with UTF-8 encoding."
            }

        # Count occurrences of old_string
        occurrence_count = content.count(old_string)

        if occurrence_count == 0:
            return {
                "success": False,
                "error": "old_string not found in file",
                "file_path": file_path,
                "old_string_preview": old_string[:100] + ("..." if len(old_string) > 100 else ""),
                "hint": "Make sure the old_string exactly matches the text in the file, including whitespace and line endings."
            }

        if not replace_all and occurrence_count > 1:
            return {
                "success": False,
                "error": f"old_string found {occurrence_count} times, but replace_all is False",
                "file_path": file_path,
                "occurrence_count": occurrence_count,
                "hint": "Set replace_all=True to replace all occurrences, or provide a more specific old_string that appears exactly once."
            }

        # Perform the replacement
        if replace_all:
            new_content = content.replace(old_string, new_string)
            replacements_made = occurrence_count
        else:
            # Replace only the first (and only) occurrence
            new_content = content.replace(old_string, new_string, 1)
            replacements_made = 1

        # Encode back to UTF-8
        new_content_bytes = new_content.encode('utf-8')

        # Write the modified file back
        try:
            self._write_file_to_container(container, file_path, new_content_bytes)
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to write modified file: {str(e)}"
            }

        self._update_last_activity(vm_id)

        return {
            "success": True,
            "file_path": file_path,
            "replacements_made": replacements_made,
            "message": f"Successfully edited file. {'All ' if replace_all else ''}{replacements_made} replacement(s) made."
        }

    def edit_files_batch(
        self,
        vm_id: str,
        edits: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Edit multiple files in the VM in a single operation.

        Each file must have been read first (via read_file or read_files_batch)
        to satisfy the read-before-edit safeguard.

        Args:
            vm_id: VM GUID from create_agent_vm
            edits: List of edit specs, each with:
                   - file_path: Path inside VM (relative to /work or absolute)
                   - old_string: Text to find and replace
                   - new_string: Replacement text
                   - replace_all: Optional bool, default False

        Returns:
            Dict with:
                - success: Overall success (True if all edits succeeded)
                - edited: List of successfully edited files with {path, replacements_made}
                - failed: List of failed edits with {path, error}
                - total: Total number of edits attempted
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"No VM found with vm_id={vm_id}")
            return {
                "success": False,
                "edited": [],
                "failed": [{"path": e.get("file_path", "unknown"), "error": "VM not found"} for e in edits],
                "total": len(edits),
            }

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
        except NotFound:
            self._delete_vm_info(vm_id)
            return {
                "success": False,
                "edited": [],
                "failed": [{"path": e.get("file_path", "unknown"), "error": "Container not found"} for e in edits],
                "total": len(edits),
            }

        if container.status != "running":
            return {
                "success": False,
                "edited": [],
                "failed": [{"path": e.get("file_path", "unknown"), "error": f"VM is not running (status: {container.status})"} for e in edits],
                "total": len(edits),
            }

        edited_files = []
        failed = []

        for edit_spec in edits:
            file_path = edit_spec.get("file_path", "")
            old_string = edit_spec.get("old_string", "")
            new_string = edit_spec.get("new_string", "")
            replace_all = edit_spec.get("replace_all", False)
            original_path = file_path

            try:
                # Normalize path
                if not file_path.startswith("/"):
                    file_path = f"/work/{file_path}"

                # Security: validate path is within allowed directories
                if not (file_path.startswith("/work/") or file_path.startswith("/tmp/")):
                    failed.append({"path": original_path, "error": "Path must be within /work or /tmp"})
                    continue

                # Additional security: prevent path traversal
                normalized_path = os.path.normpath(file_path)
                if ".." in normalized_path or not (
                    normalized_path.startswith("/work/") or normalized_path.startswith("/tmp/")
                ):
                    failed.append({"path": original_path, "error": "Invalid file path: path traversal detected"})
                    continue

                # Check read-before-edit safeguard
                if not self.has_file_been_read(vm_id, file_path):
                    failed.append({
                        "path": original_path,
                        "error": "File must be read before editing. Use vm_read_file or vm_read_files_batch first."
                    })
                    continue

                # Read the file
                try:
                    bits, stat = container.get_archive(file_path)
                except NotFound:
                    failed.append({"path": original_path, "error": f"File not found: {file_path}"})
                    continue

                # Extract file content from tar
                tar_stream = io.BytesIO()
                for chunk in bits:
                    tar_stream.write(chunk)
                tar_stream.seek(0)

                with tarfile.open(fileobj=tar_stream, mode='r') as tar:
                    member = tar.next()
                    if not member:
                        failed.append({"path": original_path, "error": "Failed to extract file from archive"})
                        continue
                    if member.isdir():
                        failed.append({"path": original_path, "error": "Path is a directory, not a file"})
                        continue
                    f = tar.extractfile(member)
                    if not f:
                        failed.append({"path": original_path, "error": "Failed to read file content"})
                        continue
                    content_bytes = f.read()

                # Decode content as UTF-8
                try:
                    content = content_bytes.decode('utf-8')
                except UnicodeDecodeError:
                    failed.append({"path": original_path, "error": "File appears to be binary or uses unsupported encoding"})
                    continue

                # Count occurrences of old_string
                occurrence_count = content.count(old_string)

                if occurrence_count == 0:
                    failed.append({
                        "path": original_path,
                        "error": "old_string not found in file",
                        "old_string_preview": old_string[:100] + ("..." if len(old_string) > 100 else "")
                    })
                    continue

                if not replace_all and occurrence_count > 1:
                    failed.append({
                        "path": original_path,
                        "error": f"old_string found {occurrence_count} times, but replace_all is False",
                        "occurrence_count": occurrence_count
                    })
                    continue

                # Perform the replacement
                if replace_all:
                    new_content = content.replace(old_string, new_string)
                    replacements_made = occurrence_count
                else:
                    new_content = content.replace(old_string, new_string, 1)
                    replacements_made = 1

                # Write the modified file back
                new_content_bytes = new_content.encode('utf-8')
                self._write_file_to_container(container, file_path, new_content_bytes)

                edited_files.append({"path": file_path, "replacements_made": replacements_made})

            except Exception as e:
                failed.append({"path": original_path, "error": str(e)})
                logger.error(f"Failed to edit file {file_path} in VM: {e}")

        self._update_last_activity(vm_id)

        return {
            "success": len(failed) == 0,
            "edited": edited_files,
            "failed": failed,
            "total": len(edits),
        }

    def unzip_file(
        self,
        vm_id: str,
        zip_path: str,
        dest_path: str = "/work",
        strip_components: int = 0,
    ) -> Dict[str, Any]:
        """
        Extract a zip file in the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            zip_path: Path to zip file inside VM
            dest_path: Destination directory for extraction
            strip_components: Number of leading path components to strip

        Returns:
            Dict with success, files extracted count, and message
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return {"success": False, "error": f"No VM found with vm_id={vm_id}"}

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
        except NotFound:
            self._delete_vm_info(vm_id)
            return {"success": False, "error": "VM container not found"}

        if container.status != "running":
            return {"success": False, "error": f"VM is not running (status: {container.status})"}

        # Normalize paths
        if not zip_path.startswith("/"):
            zip_path = f"/work/{zip_path}"
        if not dest_path.startswith("/"):
            dest_path = f"/work/{dest_path}"

        # Security: validate paths
        if not (zip_path.startswith("/work/") or zip_path.startswith("/tmp/")):
            return {"success": False, "error": "Zip path must be within /work or /tmp"}
        if not (dest_path.startswith("/work/") or dest_path.startswith("/tmp/")):
            return {"success": False, "error": "Destination must be within /work or /tmp"}

        # Build unzip command
        if strip_components > 0:
            # Use Python zipfile for strip_components (unzip doesn't support it directly)
            cmd = f'''python3 -c "
import zipfile
import os
with zipfile.ZipFile('{zip_path}', 'r') as z:
    for info in z.infolist():
        parts = info.filename.split('/')
        if len(parts) > {strip_components}:
            new_path = '/'.join(parts[{strip_components}:])
            if new_path:
                info.filename = new_path
                z.extract(info, '{dest_path}')
"'''
        else:
            cmd = f"unzip -o -q '{zip_path}' -d '{dest_path}'"

        # Execute extraction
        result = self.execute_bash(vm_id, cmd, timeout_seconds=120)

        if result.success or result.exit_code == 0:
            # Count extracted files
            count_result = self.execute_bash(
                vm_id,
                f"find '{dest_path}' -type f | wc -l",
                timeout_seconds=30
            )
            file_count = count_result.stdout.strip() if count_result.success else "unknown"

            # Get top-level contents (files and directories separately)
            top_level_files = []
            top_level_directories = []
            ls_result = self.execute_bash(
                vm_id,
                f"ls -la '{dest_path}' | tail -n +2",  # Skip 'total' line
                timeout_seconds=30
            )
            if ls_result.success and ls_result.stdout.strip():
                for line in ls_result.stdout.strip().split("\n"):
                    if line.strip():
                        parts = line.split()
                        if len(parts) >= 9:
                            name = " ".join(parts[8:])
                            if name not in (".", ".."):
                                if parts[0].startswith("d"):
                                    top_level_directories.append(name)
                                else:
                                    top_level_files.append(name)

            self._update_last_activity(vm_id)
            return {
                "success": True,
                "zip_path": zip_path,
                "dest_path": dest_path,
                "files_extracted": file_count,
                "top_level_files": top_level_files,
                "top_level_directories": top_level_directories,
                "message": f"Successfully extracted {file_count} files to {dest_path}"
            }
        else:
            return {
                "success": False,
                "error": f"Extraction failed: {result.stderr or result.stdout}",
                "exit_code": result.exit_code
            }

    def find_files(
        self,
        vm_id: str,
        pattern: str,
        path: str = "/work",
        max_results: int = 100,
    ) -> Dict[str, Any]:
        """
        Find files by glob pattern in the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            pattern: Glob pattern to match (e.g., '**/*.js')
            path: Directory to search in
            max_results: Maximum number of results

        Returns:
            Dict with success, files list, and count
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return {"success": False, "error": f"No VM found with vm_id={vm_id}"}

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
        except NotFound:
            self._delete_vm_info(vm_id)
            return {"success": False, "error": "VM container not found"}

        if container.status != "running":
            return {"success": False, "error": f"VM is not running (status: {container.status})"}

        # Normalize path
        if not path.startswith("/"):
            path = f"/work/{path}"

        # Use Python glob for pattern matching, sort by mtime
        cmd = f'''python3 -c "
import glob
import os
matches = sorted(
    glob.glob('{path}/{pattern}', recursive=True),
    key=lambda f: os.path.getmtime(f) if os.path.isfile(f) else 0,
    reverse=True
)[:{max_results}]
for m in matches:
    if os.path.isfile(m):
        print(m)
"'''

        result = self.execute_bash(vm_id, cmd, timeout_seconds=60)

        if result.success or result.exit_code == 0:
            files = [f for f in result.stdout.strip().split('\n') if f]
            self._update_last_activity(vm_id)
            return {
                "success": True,
                "pattern": pattern,
                "path": path,
                "files": files,
                "count": len(files),
                "truncated": len(files) >= max_results
            }
        else:
            return {
                "success": False,
                "error": result.stderr or result.stdout or "Find failed"
            }

    def search_files(
        self,
        vm_id: str,
        pattern: str,
        path: str = "/work",
        file_pattern: str = None,
        case_insensitive: bool = False,
        context_lines: int = 0,
        max_results: int = 50,
        output_mode: str = "content",
    ) -> Dict[str, Any]:
        """
        Search file contents with grep in the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            pattern: Regex pattern to search for
            path: File or directory to search in
            file_pattern: Glob pattern to filter files
            case_insensitive: Case insensitive search
            context_lines: Number of context lines
            max_results: Maximum number of results
            output_mode: 'content', 'files', or 'count'

        Returns:
            Dict with success and search results
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return {"success": False, "error": f"No VM found with vm_id={vm_id}"}

        try:
            container = self.docker_client.containers.get(vm_info.container_id)
        except NotFound:
            self._delete_vm_info(vm_id)
            return {"success": False, "error": "VM container not found"}

        if container.status != "running":
            return {"success": False, "error": f"VM is not running (status: {container.status})"}

        # Normalize path
        if not path.startswith("/"):
            path = f"/work/{path}"

        # Check for ripgrep first (faster), fallback to grep
        check_rg = self.execute_bash(vm_id, "which rg 2>/dev/null", timeout_seconds=5)
        use_rg = check_rg.exit_code == 0

        if use_rg:
            # ripgrep command
            cmd_parts = ["rg", "-n"]  # -n for line numbers
            if case_insensitive:
                cmd_parts.append("-i")
            if context_lines > 0:
                cmd_parts.append(f"-C {context_lines}")
            if file_pattern:
                cmd_parts.append(f"--glob '{file_pattern}'")
            if output_mode == "files":
                cmd_parts.append("-l")
            elif output_mode == "count":
                cmd_parts.append("-c")
            cmd_parts.append(f"-m {max_results}")
            cmd_parts.append(f"'{pattern}'")
            cmd_parts.append(f"'{path}'")
            cmd = " ".join(cmd_parts)
        else:
            # grep fallback
            cmd_parts = ["grep", "-r", "-n"]
            if case_insensitive:
                cmd_parts.append("-i")
            if context_lines > 0:
                cmd_parts.append(f"-C {context_lines}")
            if output_mode == "files":
                cmd_parts.append("-l")
            elif output_mode == "count":
                cmd_parts.append("-c")
            if file_pattern:
                cmd_parts.append(f"--include='{file_pattern}'")
            cmd_parts.append(f"'{pattern}'")
            cmd_parts.append(f"'{path}'")
            cmd = " ".join(cmd_parts) + f" 2>/dev/null | head -n {max_results}"

        result = self.execute_bash(vm_id, cmd, timeout_seconds=60)

        # grep/rg returns exit code 1 if no matches (not an error)
        if result.exit_code in [0, 1]:
            output = result.stdout.strip()
            self._update_last_activity(vm_id)

            if output_mode == "files":
                files = [f for f in output.split('\n') if f]
                return {
                    "success": True,
                    "pattern": pattern,
                    "files": files,
                    "count": len(files)
                }
            elif output_mode == "count":
                counts = {}
                total = 0
                for line in output.split('\n'):
                    if ':' in line:
                        file_path, count = line.rsplit(':', 1)
                        try:
                            count_int = int(count)
                            counts[file_path] = count_int
                            total += count_int
                        except ValueError:
                            pass
                return {
                    "success": True,
                    "pattern": pattern,
                    "counts": counts,
                    "total": total
                }
            else:  # content mode
                lines = output.split('\n') if output else []
                return {
                    "success": True,
                    "pattern": pattern,
                    "matches": lines[:max_results],
                    "count": len(lines),
                    "truncated": len(lines) >= max_results
                }
        else:
            return {
                "success": False,
                "error": result.stderr or "Search failed"
            }

    def delete_file(
        self,
        vm_id: str,
        file_path: str,
    ) -> bool:
        """
        Delete a file from the VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            file_path: Path inside VM

        Returns:
            True if deleted successfully
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return False

        try:
            container = self.docker_client.containers.get(vm_info.container_id)

            if not file_path.startswith("/"):
                file_path = f"/work/{file_path}"

            exit_code, _ = container.exec_run(["rm", "-f", file_path])
            self._update_last_activity(vm_id)
            return exit_code == 0

        except NotFound:
            self._delete_vm_info(vm_id)
            return False
        except Exception as e:
            logger.error(f"Failed to delete file from VM: {e}")
            return False

    def list_files(
        self,
        vm_id: str,
        directory: str = "/work",
    ) -> Dict[str, Any]:
        """
        List files in a VM directory.

        Args:
            vm_id: VM GUID from create_agent_vm
            directory: Directory path inside VM

        Returns:
            Dict with files, directories, and metadata
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return {"success": False, "error": f"No VM found with vm_id={vm_id}"}

        try:
            container = self.docker_client.containers.get(vm_info.container_id)

            if not directory.startswith("/"):
                directory = f"/work/{directory}"

            exit_code, output = container.exec_run(
                cmd=["ls", "-la", directory],
                demux=True,
            )

            if exit_code != 0:
                return {"success": False, "error": f"Directory not found: {directory}"}

            stdout = output[0].decode('utf-8', errors='replace') if output[0] else ""
            self._update_last_activity(vm_id)

            # Parse ls output - separate files and directories
            files = []
            directories = []
            for line in stdout.strip().split("\n")[1:]:  # Skip "total" line
                if line.strip():
                    parts = line.split()
                    if len(parts) >= 9:
                        name = " ".join(parts[8:])
                        if name not in (".", ".."):
                            if parts[0].startswith("d"):
                                directories.append(name)
                            else:
                                files.append(name)

            return {
                "success": True,
                "directory": directory,
                "files": files,
                "directories": directories,
                "total_count": len(files) + len(directories)
            }

        except NotFound:
            self._delete_vm_info(vm_id)
            return {"success": False, "error": "VM container not found"}
        except Exception as e:
            logger.error(f"Failed to list files in VM: {e}")
            return {"success": False, "error": str(e)}

    def copy_from_workspace(
        self,
        vm_id: str,
        workspace_path: str,
        vm_path: str,
    ) -> bool:
        """
        Copy a file from workspace to VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            workspace_path: Path relative to the shared chat workspace root
            vm_path: Destination path in VM

        Returns:
            True if copied successfully
        """
        source = f"/work/{workspace_path}" if not workspace_path.startswith("/") else workspace_path
        dest = f"/work/{vm_path}" if not vm_path.startswith("/") else vm_path

        command = f"cp -r {shlex.quote(source)} {shlex.quote(dest)}"
        result = self.execute_bash(vm_id, command)
        return result.success

    def copy_to_workspace(
        self,
        vm_id: str,
        vm_path: str,
        workspace_path: str,
    ) -> bool:
        """
        Copy a file from VM to workspace.

        Args:
            vm_id: VM GUID from create_agent_vm
            vm_path: Source path in VM
            workspace_path: Destination relative to the shared chat workspace root

        Returns:
            True if copied successfully
        """
        source = f"/work/{vm_path}" if not vm_path.startswith("/") else vm_path
        dest = f"/work/{workspace_path}" if not workspace_path.startswith("/") else workspace_path

        command = f"cp -r {shlex.quote(source)} {shlex.quote(dest)}"
        result = self.execute_bash(vm_id, command)
        return result.success

    def get_port_mappings(self, vm_id: str) -> Dict[int, int]:
        """
        Get the port mappings for a VM.

        Args:
            vm_id: VM GUID from create_agent_vm

        Returns:
            Dict mapping container ports to host ports
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return {}
        return vm_info.port_mappings.copy()

    def is_network_enabled(self, vm_id: str) -> bool:
        """
        Check if networking is enabled for a VM.

        Args:
            vm_id: VM GUID from create_agent_vm

        Returns:
            True if networking is enabled, False otherwise
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return False
        return vm_info.network_enabled

    def get_host_port(self, vm_id: str, container_port: int) -> Optional[int]:
        """
        Get the host port mapped to a container port.

        Args:
            vm_id: VM GUID from create_agent_vm
            container_port: Port inside the container

        Returns:
            Host port if mapped, None otherwise
        """
        vm_info = self._get_vm_info(vm_id)
        if not vm_info:
            return None
        return vm_info.port_mappings.get(container_port)

    def get_preview_url(self, vm_id: str, container_port: int = 5173) -> Optional[str]:
        """
        Get the localhost preview URL for an artifact running in a VM.

        Args:
            vm_id: VM GUID from create_agent_vm
            container_port: Port the web server is running on inside container (default 5173 for Vite)

        Returns:
            URL like "http://localhost:10001" or None if port not mapped
        """
        host_port = self.get_host_port(vm_id, container_port)
        if host_port:
            return f"http://localhost:{host_port}"
        return None

    def cleanup_expired_vms(self) -> int:
        """
        Clean up VMs that have exceeded their timeout.

        Returns:
            Number of VMs cleaned up
        """
        if not self.redis_client:
            logger.warning("Cannot cleanup VMs: Redis not available")
            return 0

        cleaned = 0
        now = time.time()

        try:
            # Scan for all VM info keys
            cursor = 0
            while True:
                cursor, keys = self.redis_client.scan(
                    cursor=cursor,
                    match=f"{self.VM_INFO_PREFIX}*",
                    count=100,
                )

                for key in keys:
                    try:
                        data = self.redis_client.get(key)
                        if not data:
                            continue

                        vm_info = VMInfo.from_dict(json.loads(data))
                        timeout_seconds = vm_info.timeout_hours * 3600
                        age = now - vm_info.last_activity

                        if age > timeout_seconds:
                            logger.info(
                                f"Cleaning up expired VM: vm_id={vm_info.vm_id} "
                                f"(age: {age/3600:.1f}h, timeout: {vm_info.timeout_hours}h)"
                            )
                            # Use vm_id for destroy, chat_id for ownership verification
                            self.destroy_vm(vm_info.vm_id, vm_info.chat_id)
                            cleaned += 1

                    except Exception as e:
                        logger.error(f"Error processing VM key {key}: {e}")

                if cursor == 0:
                    break

        except Exception as e:
            logger.error(f"Error during VM cleanup: {e}")

        try:
            containers = self.docker_client.containers.list(
                all=True,
                filters={"name": self.CONTAINER_PREFIX},
            )
            for container in containers:
                vm_id = container.name.replace(self.CONTAINER_PREFIX, "", 1)
                if self._get_vm_info(vm_id):
                    continue

                logger.info(
                    f"Cleaning up orphaned VM container without Redis metadata: vm_id={vm_id}"
                )
                try:
                    container.remove(force=True)
                    self.clear_file_reads(vm_id)
                    self._delete_vm_info(vm_id)
                    cleaned += 1
                except Exception as e:
                    logger.error(f"Failed to remove orphaned VM {vm_id}: {e}")
        except Exception as e:
            logger.error(f"Error reconciling orphaned VM containers: {e}")

        if cleaned > 0:
            logger.info(f"Cleaned up {cleaned} expired VM(s)")

        return cleaned


# Singleton instance
_agent_vm_manager_instance: Optional[AgentVMManager] = None


def get_agent_vm_manager(
    redis_client=None,
    workspaces_base_dir: str = None,
) -> AgentVMManager:
    """
    Get or create the singleton AgentVMManager instance.

    Args:
        redis_client: Redis client (only used on first call)
        workspaces_base_dir: Workspaces base directory (only used on first call)

    Returns:
        AgentVMManager instance
    """
    global _agent_vm_manager_instance

    if _agent_vm_manager_instance is None:
        _agent_vm_manager_instance = AgentVMManager(redis_client, workspaces_base_dir)

    return _agent_vm_manager_instance


def reset_agent_vm_manager() -> None:
    """Reset the singleton instance (mainly for testing)."""
    global _agent_vm_manager_instance
    _agent_vm_manager_instance = None
