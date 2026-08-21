"""
Artifact Snapshot Manager for Portico

Manages versioned snapshots of artifact state from Agent VMs.
Snapshots capture the workspace state at a point in time, enabling
version history and rollback capabilities.

Features:
- Create snapshots from running VMs
- Restore snapshots to VMs
- List available versions
- Efficient storage with exclusions (node_modules, .git, etc.)

Usage:
    manager = get_snapshot_manager()
    snapshot = manager.create_snapshot(
        vm_id="abc-123",
        artifact_id="def-456",
        version=1,
        version_note="Initial version"
    )
    # Later...
    manager.restore_snapshot(artifact_id="def-456", version=1, vm_id="ghi-789")
"""

import os
import json
import logging
import shutil
import tarfile
import time
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
from pathlib import Path

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

logger = logging.getLogger(__name__)

# Prefix for all artifacts-related logging
LOG_PREFIX = "[Artifacts]"


@dataclass
class ArtifactSnapshot:
    """Information about an artifact snapshot."""
    artifact_id: str
    version: int
    snapshot_path: str
    created_at: float
    file_count: int
    total_size: int  # bytes
    version_note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "artifact_id": self.artifact_id,
            "version": self.version,
            "snapshot_path": self.snapshot_path,
            "created_at": self.created_at,
            "file_count": self.file_count,
            "total_size": self.total_size,
            "version_note": self.version_note,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ArtifactSnapshot":
        """Create ArtifactSnapshot from dictionary."""
        return cls(
            artifact_id=data["artifact_id"],
            version=data["version"],
            snapshot_path=data["snapshot_path"],
            created_at=data["created_at"],
            file_count=data["file_count"],
            total_size=data["total_size"],
            version_note=data.get("version_note", ""),
        )


class SnapshotManager:
    """
    Manages artifact snapshots for versioning.

    Snapshots are stored as tar archives in the artifact-snapshots directory.
    Metadata is stored in Redis for persistence.
    """

    # Default base directory for snapshots
    DEFAULT_SNAPSHOTS_BASE = "/app/artifact-snapshots"

    # Patterns to exclude from snapshots (save space and time)
    # NOTE: We intentionally do NOT exclude 'build' or 'dist' because
    # pre-built artifacts (e.g., from Prototype Studio) need these directories.
    EXCLUDE_PATTERNS = [
        "node_modules",
        ".git",
        ".next",
        ".nuxt",
        "__pycache__",
        ".cache",
        ".vite",
        "*.pyc",
        "*.pyo",
        ".DS_Store",
        "Thumbs.db",
        ".env.local",
        ".env.*.local",
        "coverage",
        ".nyc_output",
    ]

    # Redis keys
    SNAPSHOT_PREFIX = "artifact_snapshot:"  # artifact_id:version -> snapshot data
    ARTIFACT_VERSIONS_PREFIX = "artifact_versions:"  # artifact_id -> set of versions

    def __init__(
        self,
        redis_client=None,
        snapshots_base_dir: str = None,
        vm_manager=None,
    ):
        """
        Initialize the SnapshotManager.

        Args:
            redis_client: Redis client for metadata persistence
            snapshots_base_dir: Base directory for snapshot storage
            vm_manager: AgentVMManager instance for accessing VMs
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
                logger.info(f"{LOG_PREFIX} SnapshotManager connected to Redis")
            except Exception as e:
                logger.warning(f"{LOG_PREFIX} SnapshotManager could not connect to Redis: {e}")
                self.redis_client = None

        # Initialize snapshot base directory
        if snapshots_base_dir is None:
            if os.path.exists("/app/artifact-snapshots"):
                snapshots_base_dir = "/app/artifact-snapshots"
            elif os.path.exists("/app"):
                snapshots_base_dir = "/app/artifact-snapshots"
                os.makedirs(snapshots_base_dir, exist_ok=True)
            else:
                # Local development
                project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                snapshots_base_dir = os.path.join(project_root, "artifact-snapshots")
                os.makedirs(snapshots_base_dir, exist_ok=True)

        self.snapshots_base_dir = snapshots_base_dir
        self.vm_manager = vm_manager

        logger.info(f"{LOG_PREFIX} SnapshotManager initialized with snapshots_base_dir: {snapshots_base_dir}")

    def _get_snapshot_dir(self, artifact_id: str) -> str:
        """Get the directory for an artifact's snapshots."""
        return os.path.join(self.snapshots_base_dir, artifact_id)

    def _get_snapshot_path(self, artifact_id: str, version: int) -> str:
        """Get the path for a specific snapshot file."""
        return os.path.join(self._get_snapshot_dir(artifact_id), f"v{version}.tar.gz")

    def _get_redis_key(self, artifact_id: str, version: int) -> str:
        """Get Redis key for snapshot metadata."""
        return f"{self.SNAPSHOT_PREFIX}{artifact_id}:{version}"

    def _get_versions_key(self, artifact_id: str) -> str:
        """Get Redis key for artifact's version set."""
        return f"{self.ARTIFACT_VERSIONS_PREFIX}{artifact_id}"

    def _should_exclude(self, name: str) -> bool:
        """Check if a file/directory should be excluded from snapshot."""
        for pattern in self.EXCLUDE_PATTERNS:
            if pattern.startswith("*"):
                if name.endswith(pattern[1:]):
                    return True
            elif name == pattern:
                return True
        return False

    def _store_snapshot_metadata(self, snapshot: ArtifactSnapshot) -> bool:
        """Store snapshot metadata in Redis."""
        if not self.redis_client:
            logger.warning(f"{LOG_PREFIX} Redis not available, snapshot metadata not persisted")
            return False

        try:
            key = self._get_redis_key(snapshot.artifact_id, snapshot.version)
            versions_key = self._get_versions_key(snapshot.artifact_id)

            pipe = self.redis_client.pipeline()
            pipe.set(key, json.dumps(snapshot.to_dict()))
            pipe.sadd(versions_key, snapshot.version)
            pipe.execute()

            return True
        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to store snapshot metadata: {e}")
            return False

    def _get_snapshot_metadata(self, artifact_id: str, version: int) -> Optional[ArtifactSnapshot]:
        """Get snapshot metadata from Redis."""
        if not self.redis_client:
            return None

        try:
            key = self._get_redis_key(artifact_id, version)
            data = self.redis_client.get(key)
            if data:
                return ArtifactSnapshot.from_dict(json.loads(data))
        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to get snapshot metadata: {e}")
        return None

    def _delete_snapshot_metadata(self, artifact_id: str, version: int) -> bool:
        """Delete snapshot metadata from Redis."""
        if not self.redis_client:
            return False

        try:
            key = self._get_redis_key(artifact_id, version)
            versions_key = self._get_versions_key(artifact_id)

            pipe = self.redis_client.pipeline()
            pipe.delete(key)
            pipe.srem(versions_key, version)
            pipe.execute()

            return True
        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to delete snapshot metadata: {e}")
            return False

    def create_snapshot(
        self,
        vm_id: str,
        artifact_id: str,
        version: int,
        version_note: str = "",
        source_path: str = "/work",
    ) -> Optional[ArtifactSnapshot]:
        """
        Create a snapshot of the VM workspace state.

        Args:
            vm_id: VM GUID to snapshot
            artifact_id: Artifact this snapshot belongs to
            version: Version number for this snapshot
            version_note: Optional description of this version
            source_path: Path inside VM to snapshot (default /work)

        Returns:
            ArtifactSnapshot with metadata, or None on failure
        """
        if not self.vm_manager:
            logger.error(f"{LOG_PREFIX} VM manager not set, cannot create snapshot")
            return None

        logger.info(f"{LOG_PREFIX} Creating snapshot for artifact {artifact_id}, version {version} from VM {vm_id}")

        # Get VM info
        vm_info = self.vm_manager._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"{LOG_PREFIX} VM not found: {vm_id}")
            return None

        # Create snapshot directory
        snapshot_dir = self._get_snapshot_dir(artifact_id)
        os.makedirs(snapshot_dir, exist_ok=True)

        snapshot_path = self._get_snapshot_path(artifact_id, version)

        try:
            # Get the workspace path from the VM (it's mounted from host)
            # Each VM has its own isolated workspace directory
            chat_id = vm_info.chat_id
            workspace_base = self.vm_manager.workspaces_base_dir
            workspace_path = os.path.join(workspace_base, chat_id, "agents", vm_id)

            logger.info(f"{LOG_PREFIX} Snapshot will read from host workspace: {workspace_path}")

            if not os.path.exists(workspace_path):
                logger.error(f"{LOG_PREFIX} Workspace path not found: {workspace_path}")
                return None

            # CRITICAL FIX: Sync container filesystem to host before creating snapshot
            # The bind mount may not have flushed file writes from put_archive() yet
            try:
                container = self.vm_manager.docker_client.containers.get(vm_info.container_id)
                if container.status == "running":
                    # Execute sync inside container to flush any pending writes
                    result = container.exec_run(["sync"], timeout=10)
                    logger.info(f"{LOG_PREFIX} Executed sync in container {vm_info.container_id[:12]}")

                    # Also read the source files directly from container to verify
                    # This helps debug if bind mount sync is the issue
                    try:
                        bits, stat = container.get_archive(source_path)
                        logger.info(f"{LOG_PREFIX} Container {source_path} exists with stat: {stat}")
                    except Exception as e:
                        logger.warning(f"{LOG_PREFIX} Could not verify container path {source_path}: {e}")
            except Exception as e:
                logger.warning(f"{LOG_PREFIX} Could not sync container before snapshot: {e}")

            file_count = 0
            total_size = 0

            # Create tar archive with filtering
            with tarfile.open(snapshot_path, "w:gz") as tar:
                for root, dirs, files in os.walk(workspace_path):
                    # Filter out excluded directories
                    dirs[:] = [d for d in dirs if not self._should_exclude(d)]

                    for file in files:
                        if self._should_exclude(file):
                            continue

                        file_path = os.path.join(root, file)
                        rel_path = os.path.relpath(file_path, workspace_path)

                        try:
                            tar.add(file_path, arcname=rel_path)
                            file_count += 1
                            file_size = os.path.getsize(file_path)
                            total_size += file_size

                            # Debug logging for key files (TSX, JS source files)
                            if rel_path.endswith(('.tsx', '.ts', '.jsx', '.js')) and not rel_path.startswith('assets/'):
                                try:
                                    with open(file_path, 'r', encoding='utf-8') as f:
                                        content_preview = f.read(500)
                                    logger.info(
                                        f"{LOG_PREFIX} Captured {rel_path} ({file_size} bytes): "
                                        f"{content_preview[:200].replace(chr(10), ' ')[:200]}..."
                                    )
                                except Exception:
                                    pass
                        except Exception as e:
                            logger.warning(f"{LOG_PREFIX} Could not add file to snapshot: {file_path}: {e}")

            snapshot = ArtifactSnapshot(
                artifact_id=artifact_id,
                version=version,
                snapshot_path=snapshot_path,
                created_at=time.time(),
                file_count=file_count,
                total_size=total_size,
                version_note=version_note,
            )

            self._store_snapshot_metadata(snapshot)
            logger.info(
                f"{LOG_PREFIX} Snapshot created: {snapshot_path} "
                f"({file_count} files, {total_size/1024:.1f} KB)"
            )

            return snapshot

        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to create snapshot: {e}")
            # Clean up partial snapshot
            if os.path.exists(snapshot_path):
                os.remove(snapshot_path)
            return None

    def restore_snapshot(
        self,
        artifact_id: str,
        version: int,
        vm_id: str,
        target_path: str = "/work",
        clear_target: bool = True,
    ) -> bool:
        """
        Restore a snapshot to a VM.

        Args:
            artifact_id: Artifact ID
            version: Version to restore
            vm_id: Target VM GUID
            target_path: Path inside VM to restore to (default /work)
            clear_target: Clear target directory before restore (default True)

        Returns:
            True if restored successfully, False otherwise
        """
        if not self.vm_manager:
            logger.error(f"{LOG_PREFIX} VM manager not set, cannot restore snapshot")
            return False

        snapshot = self._get_snapshot_metadata(artifact_id, version)
        if not snapshot:
            logger.error(f"{LOG_PREFIX} Snapshot not found: {artifact_id} v{version}")
            return False

        if not os.path.exists(snapshot.snapshot_path):
            logger.error(f"{LOG_PREFIX} Snapshot file not found: {snapshot.snapshot_path}")
            return False

        logger.info(f"{LOG_PREFIX} Restoring snapshot {artifact_id} v{version} to VM {vm_id}")

        vm_info = self.vm_manager._get_vm_info(vm_id)
        if not vm_info:
            logger.error(f"{LOG_PREFIX} VM not found: {vm_id}")
            return False

        try:
            # Get the workspace path (each VM has isolated workspace)
            chat_id = vm_info.chat_id
            workspace_base = self.vm_manager.workspaces_base_dir
            workspace_path = os.path.join(workspace_base, chat_id, "agents", vm_id)

            # Ensure workspace directory exists
            os.makedirs(workspace_path, exist_ok=True)

            # Clear target if requested
            if clear_target:
                for item in os.listdir(workspace_path):
                    item_path = os.path.join(workspace_path, item)
                    if os.path.isdir(item_path):
                        shutil.rmtree(item_path)
                    else:
                        os.remove(item_path)

            # Extract snapshot
            with tarfile.open(snapshot.snapshot_path, "r:gz") as tar:
                tar.extractall(workspace_path)

            logger.info(f"{LOG_PREFIX} Snapshot restored successfully to VM {vm_id}")
            return True

        except Exception as e:
            logger.error(f"{LOG_PREFIX} Failed to restore snapshot: {e}")
            return False

    def list_snapshots(self, artifact_id: str) -> List[ArtifactSnapshot]:
        """
        List all snapshots for an artifact.

        Args:
            artifact_id: Artifact ID

        Returns:
            List of ArtifactSnapshot objects, sorted by version descending
        """
        snapshots = []

        if self.redis_client:
            try:
                versions_key = self._get_versions_key(artifact_id)
                versions = self.redis_client.smembers(versions_key)

                for version in versions:
                    snapshot = self._get_snapshot_metadata(artifact_id, int(version))
                    if snapshot:
                        snapshots.append(snapshot)

            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to list snapshots from Redis: {e}")

        # Fall back to filesystem if no Redis or no results
        if not snapshots:
            snapshot_dir = self._get_snapshot_dir(artifact_id)
            if os.path.exists(snapshot_dir):
                for filename in os.listdir(snapshot_dir):
                    if filename.startswith("v") and filename.endswith(".tar.gz"):
                        try:
                            version = int(filename[1:-7])  # Extract version from "v1.tar.gz"
                            snapshot_path = os.path.join(snapshot_dir, filename)
                            stat = os.stat(snapshot_path)

                            snapshots.append(ArtifactSnapshot(
                                artifact_id=artifact_id,
                                version=version,
                                snapshot_path=snapshot_path,
                                created_at=stat.st_mtime,
                                file_count=0,  # Unknown from filesystem
                                total_size=stat.st_size,
                            ))
                        except ValueError:
                            continue

        # Sort by version descending (newest first)
        snapshots.sort(key=lambda s: s.version, reverse=True)
        return snapshots

    def get_snapshot(self, artifact_id: str, version: int) -> Optional[ArtifactSnapshot]:
        """
        Get a specific snapshot.

        Args:
            artifact_id: Artifact ID
            version: Version number

        Returns:
            ArtifactSnapshot or None if not found
        """
        return self._get_snapshot_metadata(artifact_id, version)

    def delete_snapshot(self, artifact_id: str, version: int) -> bool:
        """
        Delete a specific snapshot.

        Args:
            artifact_id: Artifact ID
            version: Version number

        Returns:
            True if deleted, False otherwise
        """
        snapshot_path = self._get_snapshot_path(artifact_id, version)

        # Delete file
        if os.path.exists(snapshot_path):
            try:
                os.remove(snapshot_path)
                logger.info(f"{LOG_PREFIX} Deleted snapshot file: {snapshot_path}")
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to delete snapshot file: {e}")
                return False

        # Delete metadata
        self._delete_snapshot_metadata(artifact_id, version)

        return True

    def delete_all_snapshots(self, artifact_id: str) -> int:
        """
        Delete all snapshots for an artifact.

        Args:
            artifact_id: Artifact ID

        Returns:
            Number of snapshots deleted
        """
        snapshots = self.list_snapshots(artifact_id)
        deleted = 0

        for snapshot in snapshots:
            if self.delete_snapshot(artifact_id, snapshot.version):
                deleted += 1

        # Remove the artifact's snapshot directory if empty
        snapshot_dir = self._get_snapshot_dir(artifact_id)
        if os.path.exists(snapshot_dir):
            try:
                os.rmdir(snapshot_dir)
            except OSError:
                pass  # Directory not empty

        # Clean up Redis version set
        if self.redis_client:
            try:
                versions_key = self._get_versions_key(artifact_id)
                self.redis_client.delete(versions_key)
            except Exception as e:
                logger.error(f"{LOG_PREFIX} Failed to clean up Redis version set: {e}")

        logger.info(f"{LOG_PREFIX} Deleted {deleted} snapshots for artifact {artifact_id}")
        return deleted

    def get_latest_version(self, artifact_id: str) -> int:
        """
        Get the latest version number for an artifact.

        Args:
            artifact_id: Artifact ID

        Returns:
            Latest version number, or 0 if no snapshots exist
        """
        snapshots = self.list_snapshots(artifact_id)
        if snapshots:
            return snapshots[0].version  # Already sorted by version desc
        return 0

    def get_total_size(self, artifact_id: str) -> int:
        """
        Get total size of all snapshots for an artifact.

        Args:
            artifact_id: Artifact ID

        Returns:
            Total size in bytes
        """
        snapshots = self.list_snapshots(artifact_id)
        return sum(s.total_size for s in snapshots)


# Singleton instance
_snapshot_manager_instance: Optional[SnapshotManager] = None


def get_snapshot_manager(
    redis_client=None,
    snapshots_base_dir: str = None,
    vm_manager=None,
) -> SnapshotManager:
    """
    Get or create the singleton SnapshotManager instance.

    Args:
        redis_client: Redis client (only used on first call)
        snapshots_base_dir: Base directory for snapshots (only used on first call)
        vm_manager: AgentVMManager instance (only used on first call)

    Returns:
        SnapshotManager instance
    """
    global _snapshot_manager_instance

    if _snapshot_manager_instance is None:
        _snapshot_manager_instance = SnapshotManager(
            redis_client=redis_client,
            snapshots_base_dir=snapshots_base_dir,
            vm_manager=vm_manager,
        )

    return _snapshot_manager_instance


def reset_snapshot_manager() -> None:
    """Reset the singleton instance (mainly for testing)."""
    global _snapshot_manager_instance
    _snapshot_manager_instance = None
