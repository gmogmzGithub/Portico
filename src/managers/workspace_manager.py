"""
Workspace Manager for Portico.

Shared chat files live at:
  /app/workspaces/{chat_id}/

Legacy input/ and output/ folders are no longer special. If they already exist
inside a chat workspace, they are treated as ordinary directories.
"""

import logging
import os
import shutil
import time
import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)


@dataclass
class WorkspaceFile:
    """Metadata for a file or directory in a workspace."""

    name: str
    path: str
    size: int
    kind: str  # "file" or "directory"
    modified_time: float

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "name": self.name,
            "path": self.path,
            "size": self.size,
            "kind": self.kind,
            "modified_time": self.modified_time,
        }


class WorkspaceManager:
    """
    Manage shared chat workspaces.

    Agent VMs for the same chat all work directly in the chat workspace root.
    """

    MAX_FILE_SIZE = 500 * 1024 * 1024
    MAX_WORKSPACE_SIZE = 500 * 1024 * 1024
    WORKSPACE_EXPIRY_SECONDS = 7 * 24 * 60 * 60
    ACTIVE_VM_STATUSES = {"created", "restarting", "running", "paused"}

    def __init__(self, base_dir: str = None):
        if base_dir is None:
            if os.path.exists("/app"):
                base_dir = "/app/workspaces"
            else:
                project_root = os.path.dirname(
                    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                )
                base_dir = os.path.join(project_root, "workspaces")

        self.base_dir = base_dir
        self.redis_client = None
        if REDIS_AVAILABLE:
            try:
                self.redis_client = redis.Redis(
                    host=os.environ.get("REDIS_HOST", "redis"),
                    port=int(os.environ.get("REDIS_PORT", 6379)),
                    db=0,
                    decode_responses=True,
                    socket_connect_timeout=1,
                )
            except Exception:
                self.redis_client = None
        os.makedirs(self.base_dir, exist_ok=True)
        logger.info(f"[Skills] WorkspaceManager initialized with base_dir: {base_dir}")

    def get_workspace_path(self, chat_id: str) -> str:
        """Return the shared workspace root for a chat."""
        safe_chat_id = self._sanitize_path_component(chat_id)
        return os.path.join(self.base_dir, safe_chat_id)

    def get_vm_workspaces_root(self, chat_id: str) -> str:
        """Return the chat workspace root used by Agent VMs."""
        return self.get_workspace_path(chat_id)

    def get_workspace_path_for_vm(self, chat_id: str, vm_id: str) -> str:
        """Return the chat workspace root for a VM."""
        return self.get_workspace_path(chat_id)

    def ensure_workspace(self, chat_id: str) -> str:
        """Ensure the shared chat workspace exists."""
        workspace_path = self.get_workspace_path(chat_id)
        os.makedirs(workspace_path, exist_ok=True)
        return workspace_path

    def ensure_workspace_for_vm(self, chat_id: str, vm_id: str) -> str:
        """Ensure the chat workspace exists for a VM."""
        return self.ensure_workspace(chat_id)

    def copy_to_workspace(
        self,
        chat_id: str,
        source_path: str,
        target_name: Optional[str] = None,
        directory: Optional[str] = None,
        target_path: Optional[str] = None,
    ) -> Optional[str]:
        """Copy a file into the shared chat workspace."""
        if not os.path.isfile(source_path):
            logger.error(f"[Skills] Source file not found: {source_path}")
            return None

        file_size = os.path.getsize(source_path)
        if file_size > self.MAX_FILE_SIZE:
            logger.error(
                f"[Skills] File too large ({file_size} bytes), max is {self.MAX_FILE_SIZE}"
            )
            return None

        workspace_path = self.ensure_workspace(chat_id)
        current_size = self._get_directory_size(workspace_path)
        if current_size + file_size > self.MAX_WORKSPACE_SIZE:
            logger.error("[Skills] Workspace would exceed size limit")
            return None

        relative_path = self._build_relative_path(
            filename=target_name or os.path.basename(source_path),
            directory=directory,
            path=target_path,
            allow_empty=False,
        )
        try:
            self._reject_private_shared_path(chat_id, relative_path)
        except ValueError as error:
            logger.error(f"[Skills] {error}")
            return None

        target_full_path = os.path.join(workspace_path, *relative_path.split("/"))
        os.makedirs(os.path.dirname(target_full_path), exist_ok=True)

        try:
            shutil.copy2(source_path, target_full_path)
            return target_full_path
        except Exception as e:
            logger.error(f"[Skills] Failed to copy file: {e}", exc_info=True)
            return None

    def write_to_workspace(
        self,
        chat_id: str,
        filename: Optional[str] = None,
        content: bytes = b"",
        directory: Optional[str] = None,
        path: Optional[str] = None,
    ) -> Optional[str]:
        """Write content into the shared chat workspace."""
        if len(content) > self.MAX_FILE_SIZE:
            logger.error(f"Content too large ({len(content)} bytes), max is {self.MAX_FILE_SIZE}")
            return None

        workspace_path = self.ensure_workspace(chat_id)
        current_size = self._get_directory_size(workspace_path)
        if current_size + len(content) > self.MAX_WORKSPACE_SIZE:
            logger.error("Workspace would exceed size limit")
            return None

        relative_path = self._build_relative_path(
            filename=filename,
            directory=directory,
            path=path,
            allow_empty=False,
        )
        self._reject_private_shared_path(chat_id, relative_path)

        target_path = os.path.join(workspace_path, *relative_path.split("/"))
        os.makedirs(os.path.dirname(target_path), exist_ok=True)

        try:
            with open(target_path, "wb") as file_handle:
                file_handle.write(content)
            logger.info(f"Wrote {len(content)} bytes to {target_path}")
            return target_path
        except Exception as e:
            logger.error(f"Failed to write file: {e}")
            return None

    def list_files(
        self,
        chat_id: str,
        path: str = "",
        recursive: bool = True,
        exclude_agents: bool = True,
    ) -> List[WorkspaceFile]:
        """List files and directories in the shared chat workspace."""
        workspace_path = self.get_workspace_path(chat_id)
        if not os.path.exists(workspace_path):
            return []

        relative_path = self._sanitize_relative_path(path, allow_empty=True)
        target_path = self._resolve_root_relative_path(
            workspace_path,
            relative_path,
            reject_private=False,
            chat_id=chat_id,
        )
        if target_path is None or not os.path.exists(target_path):
            return []

        if os.path.isfile(target_path):
            return [self._make_workspace_entry(workspace_path, target_path)]

        entries: List[WorkspaceFile] = []
        if recursive:
            for current_root, dir_names, file_names in os.walk(target_path):
                dir_names[:] = sorted(dir_names)
                for dir_name in dir_names:
                    entries.append(
                        self._make_workspace_entry(
                            workspace_path,
                            os.path.join(current_root, dir_name),
                        )
                    )
                for file_name in sorted(file_names):
                    entries.append(
                        self._make_workspace_entry(
                            workspace_path,
                            os.path.join(current_root, file_name),
                        )
                    )
        else:
            for name in sorted(os.listdir(target_path)):
                entries.append(
                    self._make_workspace_entry(workspace_path, os.path.join(target_path, name))
                )

        return entries

    def get_file_path(
        self,
        chat_id: str,
        filename: Optional[str] = None,
        directory: Optional[str] = None,
        path: Optional[str] = None,
        allow_reserved: bool = False,
    ) -> Optional[str]:
        """Return the full path for a shared workspace file."""
        workspace_path = self.get_workspace_path(chat_id)
        relative_path = self._build_relative_path(
            filename=filename,
            directory=directory,
            path=path,
            allow_empty=False,
        )
        if not allow_reserved:
            self._reject_private_shared_path(chat_id, relative_path)
        file_path = self._resolve_root_relative_path(
            workspace_path,
            relative_path,
            reject_private=not allow_reserved,
            chat_id=chat_id,
        )
        if file_path and os.path.isfile(file_path):
            return file_path
        return None

    def read_file(
        self,
        chat_id: str,
        filename: Optional[str] = None,
        directory: Optional[str] = None,
        path: Optional[str] = None,
        allow_reserved: bool = False,
    ) -> Optional[bytes]:
        """Read a file from the shared chat workspace."""
        file_path = self.get_file_path(
            chat_id,
            filename=filename,
            directory=directory,
            path=path,
            allow_reserved=allow_reserved,
        )
        if not file_path:
            return None

        try:
            with open(file_path, "rb") as file_handle:
                return file_handle.read()
        except Exception as e:
            logger.error(f"Failed to read file {file_path}: {e}")
            return None

    def delete_workspace(self, chat_id: str) -> bool:
        """Delete an entire shared chat workspace."""
        workspace_path = self.get_workspace_path(chat_id)
        if not os.path.exists(workspace_path):
            return True

        try:
            shutil.rmtree(workspace_path)
            logger.info(f"Deleted workspace for chat {chat_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete workspace: {e}")
            return False

    def cleanup_expired(self, older_than_days: int = 7) -> int:
        """Clean up chat workspaces that have not been modified recently."""
        if not os.path.exists(self.base_dir):
            return 0

        cutoff_time = time.time() - (older_than_days * 24 * 60 * 60)
        deleted_count = 0

        for chat_id in os.listdir(self.base_dir):
            if chat_id.startswith("."):
                continue
            workspace_path = os.path.join(self.base_dir, chat_id)
            if not os.path.isdir(workspace_path):
                continue

            try:
                mtime = self._get_latest_mtime(workspace_path)
                if mtime < cutoff_time:
                    shutil.rmtree(workspace_path)
                    logger.info(f"Cleaned up expired workspace: {chat_id}")
                    deleted_count += 1
            except Exception as e:
                logger.error(f"Error cleaning up workspace {chat_id}: {e}")

        return deleted_count

    def list_files_for_vm(
        self,
        chat_id: str,
        vm_id: str,
        path: str = "",
        recursive: bool = True,
    ) -> List[WorkspaceFile]:
        """List files and directories in the chat workspace used by a VM."""
        workspace_path = self.get_workspace_path_for_vm(chat_id, vm_id)
        if not os.path.exists(workspace_path):
            return []

        relative_path = self._sanitize_relative_path(path, allow_empty=True)
        target_path = self._resolve_root_relative_path(
            workspace_path,
            relative_path,
            reject_private=False,
            chat_id=None,
        )
        if target_path is None or not os.path.exists(target_path):
            return []

        if os.path.isfile(target_path):
            return [self._make_workspace_entry(workspace_path, target_path)]

        entries: List[WorkspaceFile] = []
        if recursive:
            for current_root, dir_names, file_names in os.walk(target_path):
                dir_names[:] = sorted(dir_names)
                for dir_name in dir_names:
                    entries.append(
                        self._make_workspace_entry(
                            workspace_path,
                            os.path.join(current_root, dir_name),
                        )
                    )
                for file_name in sorted(file_names):
                    entries.append(
                        self._make_workspace_entry(
                            workspace_path,
                            os.path.join(current_root, file_name),
                        )
                    )
        else:
            for name in sorted(os.listdir(target_path)):
                entries.append(
                    self._make_workspace_entry(workspace_path, os.path.join(target_path, name))
                )
        return entries

    def write_to_workspace_for_vm(
        self,
        chat_id: str,
        vm_id: str,
        filename: Optional[str] = None,
        content: bytes = b"",
        directory: Optional[str] = None,
        path: Optional[str] = None,
    ) -> Optional[str]:
        """Write content directly to the chat workspace used by a VM."""
        if len(content) > self.MAX_FILE_SIZE:
            logger.error(f"Content too large ({len(content)} bytes), max is {self.MAX_FILE_SIZE}")
            return None

        workspace_path = self.ensure_workspace_for_vm(chat_id, vm_id)
        current_size = self._get_directory_size(workspace_path)
        if current_size + len(content) > self.MAX_WORKSPACE_SIZE:
            logger.error("Workspace would exceed size limit")
            return None

        relative_path = self._build_relative_path(
            filename=filename,
            directory=directory,
            path=path,
            allow_empty=False,
        )
        target_path = os.path.join(workspace_path, *relative_path.split("/"))
        os.makedirs(os.path.dirname(target_path), exist_ok=True)

        try:
            with open(target_path, "wb") as file_handle:
                file_handle.write(content)
            logger.info(f"Wrote {len(content)} bytes to {target_path}")
            return target_path
        except Exception as e:
            logger.error(f"Failed to write file: {e}")
            return None

    def get_file_path_for_vm(
        self,
        chat_id: str,
        vm_id: str,
        filename: Optional[str] = None,
        directory: Optional[str] = None,
        path: Optional[str] = None,
    ) -> Optional[str]:
        """Return the full path for a chat workspace file used by a VM."""
        workspace_path = self.get_workspace_path_for_vm(chat_id, vm_id)
        relative_path = self._build_relative_path(
            filename=filename,
            directory=directory,
            path=path,
            allow_empty=False,
        )
        file_path = self._resolve_root_relative_path(
            workspace_path,
            relative_path,
            reject_private=False,
            chat_id=None,
        )
        if file_path and os.path.isfile(file_path):
            return file_path
        return None

    def _build_relative_path(
        self,
        *,
        filename: Optional[str],
        directory: Optional[str],
        path: Optional[str],
        allow_empty: bool,
    ) -> str:
        if path is not None:
            return self._sanitize_relative_path(path, allow_empty=allow_empty)
        if filename is None:
            raise ValueError("path or filename is required")
        if directory:
            combined = f"{directory}/{filename}"
        else:
            combined = filename
        return self._sanitize_relative_path(combined, allow_empty=allow_empty)

    def _sanitize_path_component(self, name: str) -> str:
        sanitized = name.replace("/", "_").replace("\\", "_").replace("..", "_")
        sanitized = sanitized.replace("\x00", "")
        if len(sanitized) > 255:
            sanitized = sanitized[:255]
        return sanitized

    def _sanitize_relative_path(self, path: Optional[str], allow_empty: bool = False) -> str:
        cleaned = str(path or "").strip().replace("\\", "/")
        parts = [part for part in cleaned.split("/") if part not in ("", ".")]
        if any(part == ".." for part in parts):
            raise ValueError("path traversal is not allowed")
        relative_path = "/".join(parts)
        if not relative_path and not allow_empty:
            raise ValueError("path is required")
        return relative_path

    def _live_vm_ids_for_chat(self, chat_id: str) -> set[str]:
        if not self.redis_client:
            return set()
        try:
            vm_ids = set()
            for key in self.redis_client.scan_iter(match="agent_vm_info:*"):
                raw = self.redis_client.get(key)
                if not raw:
                    continue
                try:
                    payload = raw if isinstance(raw, dict) else json.loads(raw)
                except Exception:
                    continue
                if payload.get("chat_id") != chat_id:
                    continue
                if payload.get("status", "running") not in self.ACTIVE_VM_STATUSES:
                    continue
                vm_id = payload.get("vm_id")
                if isinstance(vm_id, str) and vm_id:
                    vm_ids.add(vm_id)
            return vm_ids
        except Exception:
            return set()

    def _shared_private_root_segment(self, chat_id: str, relative_path: str) -> Optional[str]:
        return None

    def _reject_private_shared_path(self, chat_id: str, relative_path: str) -> None:
        return None

    def _resolve_root_relative_path(
        self,
        root_path: str,
        relative_path: str,
        reject_private: bool,
        chat_id: Optional[str],
    ) -> Optional[str]:
        if reject_private and chat_id:
            self._reject_private_shared_path(chat_id, relative_path)
        if relative_path == "":
            target_path = root_path
        else:
            target_path = os.path.normpath(os.path.join(root_path, relative_path))
        root_real = os.path.realpath(root_path)
        existing_anchor = target_path if os.path.exists(target_path) else os.path.dirname(target_path)
        target_real = os.path.realpath(existing_anchor)
        if os.path.commonpath([root_real, target_real]) != root_real:
            raise ValueError("path traversal is not allowed")
        return target_path

    def _make_workspace_entry(self, root_path: str, target_path: str) -> WorkspaceFile:
        stat = os.stat(target_path)
        relative_path = os.path.relpath(target_path, root_path).replace(os.sep, "/")
        if relative_path == ".":
            relative_path = ""
        return WorkspaceFile(
            name=os.path.basename(target_path),
            path=relative_path,
            size=stat.st_size,
            kind="directory" if os.path.isdir(target_path) else "file",
            modified_time=stat.st_mtime,
        )

    def _get_directory_size(self, path: str) -> int:
        total = 0
        for dirpath, _, filenames in os.walk(path):
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                try:
                    total += os.path.getsize(filepath)
                except OSError:
                    pass
        return total

    def _get_latest_mtime(self, path: str) -> float:
        latest = os.path.getmtime(path)
        for dirpath, _, filenames in os.walk(path):
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                try:
                    mtime = os.path.getmtime(filepath)
                    if mtime > latest:
                        latest = mtime
                except OSError:
                    pass
        return latest


_workspace_manager_instance: Optional[WorkspaceManager] = None


def get_workspace_manager(base_dir: str = None) -> WorkspaceManager:
    """Get or create the singleton WorkspaceManager instance."""
    global _workspace_manager_instance
    if _workspace_manager_instance is None:
        _workspace_manager_instance = WorkspaceManager(base_dir)
    return _workspace_manager_instance


def reset_workspace_manager() -> None:
    """Reset the singleton instance (mainly for testing)."""
    global _workspace_manager_instance
    _workspace_manager_instance = None
