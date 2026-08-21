"""
Script Executor for Portico
Manages ephemeral Docker container lifecycle for skill script execution.

Scripts are executed in isolated containers with:
- Read-only skill directory mount
- Read-write workspace mount
- Network disabled
- Memory/CPU limits
- Timeout enforcement

Dependencies are automatically discovered from script imports for logging.
The single Agent VM image carries the supported docs/data/runtime packages.
"""

import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import List, Dict, Optional, Any, Set
from dataclasses import dataclass, field

try:
    import docker
    from docker.errors import ContainerError, ImageNotFound, APIError
    DOCKER_AVAILABLE = True
except ImportError:
    DOCKER_AVAILABLE = False

from .agent_vm_image import (
    build_info_to_agent_vm_image_refs,
    extract_build_number,
    get_agent_vm_local_build_command,
)
from .workspace_manager import get_workspace_manager, WorkspaceManager

logger = logging.getLogger(__name__)

# Harbor registry configuration
HARBOR_REGISTRY = "harbor.example.invalid"
HARBOR_PROJECT = "portico"
AGENT_VM_IMAGE_NAME = "agent-vm"


# Mapping of import names to pip package names
IMPORT_TO_PACKAGE = {
    'PIL': 'pillow',
    'cv2': 'opencv-python',
    'yaml': 'pyyaml',
    'pypdf': 'pypdf',
    'pdfplumber': 'pdfplumber',
    'reportlab': 'reportlab',
    'pdf2image': 'pdf2image',
    'fitz': 'pymupdf',
    'PyPDF2': 'pypdf2',
    'docx': 'python-docx',
    'openpyxl': 'openpyxl',
    'pandas': 'pandas',
    'numpy': 'numpy',
    'requests': 'requests',
    'bs4': 'beautifulsoup4',
    'lxml': 'lxml',
    'magic': 'python-magic',
    'chardet': 'chardet',
}

# Python standard library modules (should not be installed)
STDLIB_MODULES = {
    'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio', 'atexit',
    'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins',
    'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code',
    'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
    'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
    'copyreg', 'cProfile', 'csv', 'ctypes', 'curses',
    'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis',
    'doctest',
    'email', 'encodings', 'enum', 'errno',
    'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch',
    'fractions', 'ftplib', 'functools',
    'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp',
    'gzip',
    'hashlib', 'heapq', 'hmac', 'html', 'http',
    'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io',
    'ipaddress', 'itertools',
    'json',
    'keyword',
    'lib2to3', 'linecache', 'locale', 'logging', 'lzma',
    'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap',
    'modulefinder', 'multiprocessing',
    'netrc', 'nis', 'nntplib', 'numbers',
    'operator', 'optparse', 'os', 'ossaudiodev',
    'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil',
    'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint',
    'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr',
    'pydoc',
    'queue', 'quopri',
    'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter',
    'runpy',
    'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex',
    'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr',
    'socket', 'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat',
    'statistics', 'string', 'stringprep', 'struct', 'subprocess',
    'sunau', 'symtable', 'sys', 'sysconfig', 'syslog',
    'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'test',
    'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token',
    'tokenize', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle',
    'turtledemo', 'types', 'typing',
    'unicodedata', 'unittest', 'urllib', 'uu', 'uuid',
    'venv',
    'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound',
    'wsgiref',
    'xdrlib', 'xml', 'xmlrpc',
    'zipapp', 'zipfile', 'zipimport', 'zlib',
}


@dataclass
class ScriptResult:
    """Result of a script execution."""
    success: bool
    exit_code: int
    stdout: str
    stderr: str
    output_files: List[str] = field(default_factory=list)
    execution_time: float = 0.0
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "success": self.success,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "output_files": self.output_files,
            "execution_time": self.execution_time,
            "error_message": self.error_message,
        }


class ScriptExecutor:
    """
    Executes skill scripts in isolated Docker containers.

    Each execution:
    1. Validates the script path and skill activation
    2. Parses script imports to report preinstalled dependencies
    3. Creates an ephemeral container with appropriate mounts
    4. Runs the script via uvx with discovered dependencies
    5. Captures stdout/stderr and lists output files
    6. Destroys the container

    Security features:
    - Network disabled
    - Memory limit (512MB)
    - CPU quota (1 core)
    - Read-only skill mount
    - Timeout enforcement
    """

    # Container resource limits
    MEMORY_LIMIT = "512m"
    CPU_PERIOD = 100000
    CPU_QUOTA = 100000  # 1 core
    DEFAULT_TIMEOUT = 300  # 5 minutes

    def __init__(
        self,
        workspace_manager: Optional[WorkspaceManager] = None,
        skills_base_dir: str = None
    ):
        """
        Initialize the ScriptExecutor.

        Args:
            workspace_manager: WorkspaceManager instance (or use singleton)
            skills_base_dir: Base directory containing skills
        """
        if not DOCKER_AVAILABLE:
            raise RuntimeError("docker package not available. Install with: pip install docker")

        self.workspace_manager = workspace_manager or get_workspace_manager()

        if skills_base_dir is None:
            # Try container path first, then local development path
            if os.path.exists("/app/skills"):
                skills_base_dir = "/app"
            else:
                # Local development
                skills_base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

        self.skills_base_dir = skills_base_dir
        self.docker_client = docker.from_env()

        # For Docker-in-Docker: get host project root for volume mounts
        # The Docker daemon on the host needs HOST paths, not container paths
        self.host_project_root = os.environ.get("HOST_PROJECT_ROOT")
        if self.host_project_root:
            logger.info(f"Docker-in-Docker mode: HOST_PROJECT_ROOT={self.host_project_root}")
        else:
            logger.info("Direct mode: no HOST_PROJECT_ROOT, using local paths")

        self._build_number = extract_build_number(self._get_build_info_paths())
        self._resolved_image_name: Optional[str] = None

        logger.info(f"ScriptExecutor initialized with skills_base_dir: {skills_base_dir}")
        if self._build_number:
            logger.info(f"Release build detected for ScriptExecutor: {self._build_number}")
        else:
            logger.info("Dev build or missing build-info.json for ScriptExecutor")

    @property
    def IMAGE_NAME(self) -> str:
        """Get the default Agent VM image name used for basic execution."""
        try:
            return self._resolve_image_name()
        except docker.errors.ImageNotFound:
            return f"{AGENT_VM_IMAGE_NAME}:latest"

    def _get_build_info_paths(self) -> List[str]:
        """Return the build-info.json locations relevant to this executor."""
        return [
            "/app/electron-app/build-info.json",  # Container path
            os.path.join(self.skills_base_dir, "electron-app", "build-info.json"),  # Relative path
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
        """Ensure an image exists locally, pulling it when it lives in Harbor."""
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

    def execute_script(
        self,
        skill_name: str,
        script_name: str,
        chat_id: str,
        args: List[str] = None,
        timeout_seconds: int = None,
        env_vars: Dict[str, str] = None,
    ) -> ScriptResult:
        """
        Execute a skill script in an isolated container.

        Args:
            skill_name: Name of the skill containing the script
            script_name: Script filename (e.g., 'scripts/check_fillable.py')
            chat_id: Chat session ID for workspace isolation
            args: Command line arguments to pass to the script
            timeout_seconds: Execution timeout (default 300s)
            env_vars: Additional environment variables

        Returns:
            ScriptResult with execution details
        """
        start_time = time.time()
        args = args or []
        timeout_seconds = timeout_seconds or self.DEFAULT_TIMEOUT
        env_vars = env_vars or {}

        # Validate and get script path
        script_path = self._get_script_path(skill_name, script_name)
        if not script_path:
            return ScriptResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message=f"Script not found: {skill_name}/{script_name}"
            )

        # Get skill directory
        skill_dir = self._get_skill_dir(skill_name)
        if not skill_dir:
            return ScriptResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message=f"Skill directory not found: {skill_name}"
            )

        # Ensure the shared chat workspace exists.
        shared_workspace_path = self.workspace_manager.ensure_workspace(chat_id)

        # Create per-run scratch space for temporary files. The chat workspace
        # itself is mounted at /work, matching persistent Agent VMs.
        scratch_parent = os.path.join(self.workspace_manager.base_dir, ".scratch")
        os.makedirs(scratch_parent, exist_ok=True)
        scratch_path = tempfile.mkdtemp(prefix="skill-run-", dir=scratch_parent)

        # Read script content and discover dependencies
        try:
            with open(script_path, 'r', encoding='utf-8') as f:
                script_content = f.read()
            dependencies = self._extract_dependencies(script_content)
            logger.info(f"Discovered dependencies for {script_name}: {dependencies}")
        except Exception as e:
            return ScriptResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message=f"Failed to read script: {e}"
            )

        # Build command - dependencies are PRE-INSTALLED in agent-vm image for security
        # This allows network_disabled=True (complete isolation at runtime)
        # Script path inside container: /skill/scripts/script_name.py
        container_script_path = f"/skill/{script_name}"

        # Replace shared workspace paths in args
        processed_args = self._process_args(args, chat_id)

        # Simple python command - no uvx needed since deps are pre-installed
        # NOTE: If you add new skills with new dependencies, add them to Dockerfile.agent-vm
        cmd = f"python {container_script_path} {' '.join(processed_args)}"

        if dependencies:
            logger.info(f"Script uses: {dependencies} (pre-installed in agent-vm image)")

        logger.info(f"Executing in container: {cmd}")

        # Convert container paths to host paths for Docker volume mounts
        # (needed for Docker-in-Docker scenarios)
        host_skill_dir = self._container_to_host_path(skill_dir)
        host_shared_workspace_path = self._container_to_host_path(shared_workspace_path)
        host_scratch_path = self._container_to_host_path(scratch_path)

        logger.info(
            "Volume mounts: "
            f"skill={host_skill_dir} -> /skill, "
            f"workspace={host_shared_workspace_path} -> /work, "
            f"scratch={host_scratch_path} -> /tmp/skill-run"
        )

        # Execute in container
        container = None
        try:
            image_name = self._resolve_image_name()
            container = self.docker_client.containers.run(
                image=image_name,
                command=["bash", "-c", cmd],
                volumes={
                    host_skill_dir: {"bind": "/skill", "mode": "ro"},
                    host_shared_workspace_path: {"bind": "/work", "mode": "rw"},
                    host_scratch_path: {"bind": "/tmp/skill-run", "mode": "rw"},
                },
                working_dir="/work",
                environment=env_vars,
                network_disabled=True,
                mem_limit=self.MEMORY_LIMIT,
                cpu_period=self.CPU_PERIOD,
                cpu_quota=self.CPU_QUOTA,
                remove=False,  # We'll remove manually after getting logs
                detach=True,
            )

            # Wait for container to finish
            result = container.wait(timeout=timeout_seconds)
            exit_code = result.get("StatusCode", -1)

            # Get logs
            stdout = container.logs(stdout=True, stderr=False).decode('utf-8', errors='replace')
            stderr = container.logs(stdout=False, stderr=True).decode('utf-8', errors='replace')

        except docker.errors.ContainerError as e:
            execution_time = time.time() - start_time
            return ScriptResult(
                success=False,
                exit_code=e.exit_status,
                stdout=e.stderr.decode('utf-8', errors='replace') if e.stderr else "",
                stderr=str(e),
                execution_time=execution_time,
                error_message=f"Container error: {e}"
            )
        except docker.errors.ImageNotFound:
            return ScriptResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                error_message=(
                    f"Docker image not found for Agent VM. {self._build_help_message()}"
                ),
            )
        except Exception as e:
            execution_time = time.time() - start_time
            logger.error(f"Container execution failed: {e}")
            return ScriptResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=str(e),
                execution_time=execution_time,
                error_message=f"Execution failed: {e}"
            )
        finally:
            # Always clean up container
            if container:
                try:
                    container.remove(force=True)
                except Exception as e:
                    logger.warning(f"Failed to remove container: {e}")
            try:
                shutil.rmtree(scratch_path, ignore_errors=True)
            except Exception as e:
                logger.warning(f"Failed to remove scratch workspace {scratch_path}: {e}")

        execution_time = time.time() - start_time

        return ScriptResult(
            success=exit_code == 0,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            execution_time=execution_time,
        )

    def _container_to_host_path(self, container_path: str) -> str:
        """
        Convert a container path to a host path for Docker volume mounts.

        In Docker-in-Docker scenarios, the Docker daemon on the host needs
        host filesystem paths, not container paths. This method converts
        paths like /app/skills/pdf to {HOST_PROJECT_ROOT}/skills/pdf.

        Args:
            container_path: Path inside this container (e.g., /app/skills/pdf)

        Returns:
            Host path for Docker volume mount
        """
        if not self.host_project_root:
            # No Docker-in-Docker, use paths as-is
            return container_path

        # Map container paths to relative paths, then to host paths
        # /app/skills/pdf -> skills/pdf -> {HOST_PROJECT_ROOT}/skills/pdf
        # /app/workspaces/xxx -> workspaces/xxx -> {HOST_PROJECT_ROOT}/workspaces/xxx
        path_mappings = {
            "/app/skills": "skills",
            "/app/skills-user": "skills-user",
            "/app/skills-marketplace": "skills-marketplace",
            "/app/workspaces": "workspaces",
        }

        for container_prefix, relative_path in path_mappings.items():
            if container_path.startswith(container_prefix):
                suffix = container_path[len(container_prefix):]
                host_path = os.path.join(self.host_project_root, relative_path + suffix)
                logger.debug(f"Path conversion: {container_path} -> {host_path}")
                return host_path

        # No mapping found, return original (might work for local dev)
        logger.warning(f"No host path mapping for: {container_path}")
        return container_path

    def _get_skill_dir(self, skill_name: str) -> Optional[str]:
        """
        Get the canonical directory path for a skill.

        Args:
            skill_name: Canonical skill ID (e.g., "pdf" or "marketplace/pdf")

        Returns:
            Absolute path to skill directory, or None if not found
        """
        try:
            from .skill_manager import get_skill_manager

            skill_manager = get_skill_manager(base_dir=self.skills_base_dir)
            skill_dir = skill_manager.resolve_skill_path(skill_name)
            if skill_dir and os.path.isdir(skill_dir):
                return skill_dir
        except Exception as e:
            logger.error(f"Failed to resolve skill directory for '{skill_name}': {e}")

        return None

    def _get_script_path(self, skill_name: str, script_name: str) -> Optional[str]:
        """
        Get the full path to a script file.

        Args:
            skill_name: Name of the skill
            script_name: Script path relative to skill dir (e.g., 'scripts/check.py')

        Returns:
            Absolute path to script, or None if not found or invalid
        """
        skill_dir = self._get_skill_dir(skill_name)
        if not skill_dir:
            return None

        # Normalize and validate the script path
        script_path = os.path.normpath(os.path.join(skill_dir, script_name))

        # Security: ensure script is within skill directory
        if not script_path.startswith(skill_dir):
            logger.error(f"Path traversal attempt detected: {script_name}")
            return None

        # Check script exists
        if not os.path.isfile(script_path):
            logger.error(f"Script not found: {script_path}")
            return None

        # Check it's a Python script
        if not script_path.endswith('.py'):
            logger.error(f"Only Python scripts supported: {script_path}")
            return None

        return script_path

    def _extract_dependencies(self, script_content: str) -> List[str]:
        """
        Extract pip package names from script import statements.

        Args:
            script_content: Python script content

        Returns:
            List of pip package names to install
        """
        # Find all import statements
        import_pattern = r'^(?:from|import)\s+(\w+)'
        imports = re.findall(import_pattern, script_content, re.MULTILINE)

        # Convert to unique set of packages
        packages: Set[str] = set()
        for imp in imports:
            # Skip standard library
            if imp in STDLIB_MODULES:
                continue

            # Map to pip package name
            package = IMPORT_TO_PACKAGE.get(imp, imp)
            packages.add(package)

        return sorted(list(packages))

    def _process_args(self, args: List[str], chat_id: str) -> List[str]:
        """
        Process command arguments, replacing workspace paths.

        Args:
            args: Original arguments
            chat_id: Chat session ID

        Returns:
            Processed arguments with container paths
        """
        processed = []
        workspace_path = self.workspace_manager.get_workspace_path(chat_id)

        for arg in args:
            # Replace absolute shared workspace paths with the mounted container path.
            if workspace_path in arg:
                arg = arg.replace(workspace_path, "/work")
            processed.append(arg)

        return processed

    def ensure_image_exists(self) -> bool:
        """
        Check if the Agent VM image exists, attempting Harbor pull if needed.

        Returns:
            True if image is available, False otherwise
        """
        try:
            image_name = self._resolve_image_name()
            logger.info(f"Image {image_name} found for Agent VM")
            return True
        except docker.errors.ImageNotFound:
            logger.warning(
                f"No Agent VM image available. {self._build_help_message()}"
            )
            return False


# Singleton instance for use across the application
_script_executor_instance: Optional[ScriptExecutor] = None


def get_script_executor(
    workspace_manager: Optional[WorkspaceManager] = None,
    skills_base_dir: str = None
) -> ScriptExecutor:
    """
    Get or create the singleton ScriptExecutor instance.

    Args:
        workspace_manager: WorkspaceManager instance (only used on first call)
        skills_base_dir: Skills base directory (only used on first call)

    Returns:
        ScriptExecutor instance
    """
    global _script_executor_instance

    if _script_executor_instance is None:
        _script_executor_instance = ScriptExecutor(workspace_manager, skills_base_dir)

    return _script_executor_instance


def reset_script_executor() -> None:
    """Reset the singleton instance (mainly for testing)."""
    global _script_executor_instance
    _script_executor_instance = None
