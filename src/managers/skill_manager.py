"""
Skill Manager for Portico
Handles discovery, loading, and management of Agent Skills.

Skills follow the Agent Skills specification (https://agentskills.io):
- Each skill is a directory containing a SKILL.md file
- Metadata lives in SKILL.md frontmatter or a sibling <skill-name>.yaml file
- Optional references/ directory for additional documentation
- Optional scripts/ directory for helper scripts

Three-tier skill sources (priority order):
1. skills/           - System-delivered skills (highest priority, authoritative)
2. skills-user/      - User-created skills (cannot override system skills)
3. skills-marketplace/ - Downloaded from marketplace (managed by app)
"""

import os
import re
import json
import logging
import time
from typing import List, Dict, Optional, Any, Tuple
from pathlib import Path
from dataclasses import dataclass, field, asdict

import yaml

# Redis pub/sub channel for cross-container cache invalidation
SKILL_INVALIDATE_CHANNEL = "skill:invalidate"
OPTIMIZATION_FLAG_ENV_PREFIX = "OWUI_OPT_"
OPTIMIZATION_FLAG_BLOCK_RE = re.compile(
    r"<!--\s*OPT_FLAG:([a-z0-9_]+)\s+START\s*-->\s*(.*?)\s*<!--\s*OPT_FLAG:\1\s+END\s*-->",
    re.DOTALL,
)


logger = logging.getLogger(__name__)
# Ensure INFO level logging for skill manager
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)


@dataclass
class SkillMetadata:
    """Metadata extracted from SKILL.md frontmatter or sibling YAML metadata."""
    name: str
    description: str
    source: str  # 'system', 'marketplace', or 'user'
    path: str  # Full path to skill directory
    license: Optional[str] = None
    compatibility: Optional[str] = None
    priority: str = "medium"  # 'low', 'medium', 'high'
    triggers: List[str] = field(default_factory=list)
    version: Optional[str] = None
    author: Optional[str] = None
    references: List[str] = field(default_factory=list)  # Available reference files
    scripts: List[str] = field(default_factory=list)  # Available executable scripts
    required_mcp_servers: List[str] = field(default_factory=list)  # MCP servers to auto-enable

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)


class SkillManager:
    """
    Manages discovery, loading, and caching of Agent Skills.

    Skills are loaded from three directories in priority order:
    1. skills/ (system-delivered, authoritative)
    2. skills-user/ (user-created)
    3. skills-marketplace/ (downloaded from marketplace)

    Naming rules:
    - system/user skills use the skill folder name (e.g., "pdf")
    - marketplace skills use "{marketplace}/{skill}" (e.g., "anthropic-agent-skills/pdf")

    Collision rules:
    - system skill names are authoritative and block colliding user skills
    - marketplace skills are namespaced and coexist with system/user names
    """

    # Directory names and their source types (in priority order)
    SKILL_DIRECTORIES = [
        ("skills", "system"),
        ("skills-user", "user"),
        ("skills-marketplace", "marketplace"),
    ]

    def __init__(self, base_dir: str = None, redis_client=None):
        """
        Initialize the SkillManager.

        Args:
            base_dir: Base directory containing skills directories.
                      Defaults to project root or /app in container.
            redis_client: Optional Redis client for cross-container cache invalidation.
        """
        if base_dir is None:
            # Try container path first, then local development path
            if os.path.exists("/app/skills"):
                base_dir = "/app"
            else:
                # Local development - use project root
                base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

        self.base_dir = base_dir

        # Existing caches
        self._skills_cache: Dict[str, SkillMetadata] = {}
        self._content_cache: Dict[str, str] = {}
        self._last_discovery_time: float = 0
        self._optimization_flags_cache: Dict[str, bool] = {}
        self._optimization_flags_mtime: float = 0.0

        # NEW: mtime tracking for hot-reload (fallback mechanism)
        self._dir_mtimes: Dict[str, float] = {}           # top-level dirs and skill dirs
        self._skill_file_mtimes: Dict[str, float] = {}    # skill_path -> primary metadata file mtime
        self._content_mtimes: Dict[str, float] = {}       # skill_name -> content cache mtime

        # NEW: Redis pub/sub (primary mechanism for cross-container invalidation)
        self._redis_client = redis_client
        self._cache_invalidated: bool = False
        self._pubsub = None
        self._pubsub_thread = None

        # Start Redis subscriber if Redis is available
        if self._redis_client:
            self._start_redis_subscriber()

        logger.info(f"[Skills] SkillManager initialized with base_dir: {base_dir}, redis: {redis_client is not None}")

    def _optimization_flags_path(self) -> Path:
        return Path(self.base_dir) / "optimization_flags.json"

    def _load_optimization_flags(self) -> Dict[str, bool]:
        path = self._optimization_flags_path()
        try:
            current_mtime = path.stat().st_mtime
        except FileNotFoundError:
            self._optimization_flags_cache = {}
            self._optimization_flags_mtime = 0.0
            return {}

        if self._optimization_flags_cache and current_mtime <= self._optimization_flags_mtime:
            return self._optimization_flags_cache

        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning(f"[Skills] Failed to read optimization flags from {path}: {e}")
            self._optimization_flags_cache = {}
            self._optimization_flags_mtime = current_mtime
            return {}

        flags = (
            {str(key): bool(value) for key, value in raw.items() if isinstance(key, str)}
            if isinstance(raw, dict)
            else {}
        )
        self._optimization_flags_cache = flags
        self._optimization_flags_mtime = current_mtime
        return flags

    def _optimization_flag_enabled(self, flag_name: str, default: bool = True) -> bool:
        env_name = OPTIMIZATION_FLAG_ENV_PREFIX + re.sub(r"[^A-Za-z0-9]+", "_", flag_name).upper()
        raw_env = os.getenv(env_name)
        if raw_env is not None:
            value = raw_env.strip().lower()
            if value in {"1", "true", "yes", "on"}:
                return True
            if value in {"0", "false", "no", "off"}:
                return False
        flags = self._load_optimization_flags()
        return bool(flags.get(flag_name, default))

    def _apply_optimization_flags(self, body: str) -> str:
        filtered = body
        while True:
            def replace(match: re.Match) -> str:
                flag_name = match.group(1)
                inner = match.group(2).strip()
                return inner if self._optimization_flag_enabled(flag_name, default=True) else ""

            updated = OPTIMIZATION_FLAG_BLOCK_RE.sub(replace, filtered)
            if updated == filtered:
                break
            filtered = updated
        return re.sub(r"\n{3,}", "\n\n", filtered).strip()

    # =========================================================================
    # Redis Pub/Sub Methods (Primary hot-reload mechanism)
    # =========================================================================

    def _start_redis_subscriber(self):
        """Start background thread to listen for cache invalidation messages."""
        try:
            self._pubsub = self._redis_client.pubsub()
            self._pubsub.subscribe(**{SKILL_INVALIDATE_CHANNEL: self._handle_invalidation})
            self._pubsub_thread = self._pubsub.run_in_thread(sleep_time=0.1, daemon=True)
            logger.info("[Skills] Hot-reload: Redis subscriber started")
        except Exception as e:
            logger.warning(f"[Skills] Hot-reload: Failed to start Redis subscriber: {e}")

    def _handle_invalidation(self, message):
        """Handle incoming cache invalidation message from Redis."""
        if message['type'] != 'message':
            return
        try:
            data = json.loads(message['data'])
            skill_name = data.get('skill_name', 'unknown')
            event = data.get('event', 'unknown')
            logger.info(f"[Skills] Hot-reload: Received {event} for '{skill_name}' via Redis")
            self._cache_invalidated = True
        except Exception as e:
            logger.warning(f"[Skills] Hot-reload: Error handling message: {e}")

    def publish_invalidation(self, skill_name: str, event: str = "skill_changed"):
        """Publish cache invalidation message to Redis for cross-container notification."""
        if not self._redis_client:
            logger.debug("[Skills] Hot-reload: No Redis client, skipping publish")
            return
        try:
            message = json.dumps({
                "event": event,
                "skill_name": skill_name,
                "timestamp": time.time(),
                "source_container": os.environ.get("HOSTNAME", "unknown")
            })
            self._redis_client.publish(SKILL_INVALIDATE_CHANNEL, message)
            logger.info(f"[Skills] Hot-reload: Published {event} for '{skill_name}'")
        except Exception as e:
            logger.warning(f"[Skills] Hot-reload: Failed to publish: {e}")

    # =========================================================================
    # mtime Checking Methods (Fallback hot-reload mechanism)
    # =========================================================================

    def _is_cache_stale(self) -> bool:
        """Check if cache needs refresh (Redis flag OR mtime changes)."""
        # PRIMARY: Check Redis invalidation flag
        if self._cache_invalidated:
            logger.info("[Skills] Hot-reload: Cache invalidated via Redis")
            self._cache_invalidated = False  # Reset flag
            return True

        # FALLBACK: Check mtimes (catches missed Redis messages)
        return self._check_directories_changed()

    def _check_directories_changed(self) -> bool:
        """Check if any skill directory has changed (new/deleted skills or modified files)."""
        # Check top-level directories (catches new/deleted skills)
        for dir_name, _ in self.SKILL_DIRECTORIES:
            dir_path = Path(self.base_dir) / dir_name
            if self._tracked_directory_changed(dir_name, dir_path, f"directory '{dir_name}'"):
                return True

        # Check tracked absolute directories, including marketplace vendor dirs.
        for cache_key in list(self._dir_mtimes.keys()):
            if not os.path.isabs(cache_key):
                continue
            if self._tracked_directory_changed(
                cache_key,
                Path(cache_key),
                f"tracked directory '{cache_key}'",
            ):
                return True

        # Check individual SKILL.md/sibling YAML metadata files
        for skill_name, metadata in self._skills_cache.items():
            skill_path = Path(metadata.path)

            try:
                metadata_mtime = self._metadata_tracking_mtime(skill_path)
                cached_file_mtime = self._skill_file_mtimes.get(metadata.path, 0)
                if metadata_mtime != cached_file_mtime:
                    logger.info(f"[Skills] Hot-reload: '{skill_name}' metadata changed")
                    return True

            except OSError as e:
                logger.warning(f"[Skills] Hot-reload: OS error checking {skill_name}: {e}")
                return True  # Treat as changed to be safe

        return False

    def _tracked_directory_changed(self, cache_key: str, dir_path: Path, label: str) -> bool:
        """Return True when a tracked directory is missing, newly present, or has a new mtime."""
        cached_mtime = self._dir_mtimes.get(cache_key)
        if not dir_path.exists():
            if cached_mtime is not None:
                logger.info(f"[Skills] Hot-reload: {label} was removed")
                return True
            return False

        try:
            current_mtime = dir_path.stat().st_mtime
        except OSError as e:
            logger.warning(f"[Skills] Hot-reload: OS error checking {label}: {e}")
            return cached_mtime is not None

        if cached_mtime is None or current_mtime != cached_mtime:
            logger.info(f"[Skills] Hot-reload: {label} changed")
            return True

        return False

    def _skill_sibling_yaml_path(self, skill_dir: Path) -> Path:
        """Return the sibling metadata YAML path for a skill directory."""
        return skill_dir / f"{skill_dir.name}.yaml"

    def _metadata_tracking_mtime(self, skill_dir: Path) -> float:
        """Return the newest metadata mtime across SKILL.md and sibling YAML metadata."""
        mtimes = []
        for candidate in (skill_dir / "SKILL.md", self._skill_sibling_yaml_path(skill_dir)):
            if candidate.exists():
                mtimes.append(candidate.stat().st_mtime)
        return max(mtimes, default=0.0)

    def _synthesize_sibling_yaml_triggers(self, sibling_yaml: Dict[str, Any]) -> List[str]:
        """Build trigger hints from sparse sibling metadata."""
        triggers: List[str] = []
        for key in ("topic", "domain"):
            value = sibling_yaml.get(key)
            if isinstance(value, str):
                normalized = value.strip()
                if normalized and normalized not in triggers:
                    triggers.append(normalized)
        return triggers

    def _record_mtimes(self):
        """Record current mtimes for all directories and skill files after discovery."""
        # Record top-level directory mtimes
        for dir_name, _ in self.SKILL_DIRECTORIES:
            dir_path = Path(self.base_dir) / dir_name
            if dir_path.exists():
                self._record_directory_mtime(dir_name, dir_path)
                if dir_name == "skills-marketplace":
                    self._record_marketplace_vendor_mtimes(dir_path)

        # Record skill directory and file mtimes
        for skill_name, metadata in self._skills_cache.items():
            skill_path = Path(metadata.path)
            try:
                self._record_directory_mtime(metadata.path, skill_path)
                metadata_mtime = self._metadata_tracking_mtime(skill_path)
                if metadata_mtime:
                    self._skill_file_mtimes[metadata.path] = metadata_mtime
            except OSError:
                pass

    def _record_directory_mtime(self, cache_key: str, dir_path: Path) -> None:
        """Record a directory mtime under the supplied cache key."""
        try:
            self._dir_mtimes[cache_key] = dir_path.stat().st_mtime
        except OSError:
            pass

    def _record_marketplace_vendor_mtimes(self, marketplace_root: Path) -> None:
        """Track marketplace vendor dirs so new skills under an existing vendor refresh cache."""
        try:
            vendor_dirs = sorted(marketplace_root.iterdir())
        except OSError:
            return

        for vendor_dir in vendor_dirs:
            if not vendor_dir.is_dir() or vendor_dir.name.startswith(('.', '_')):
                continue
            self._record_directory_mtime(str(vendor_dir), vendor_dir)

    # =========================================================================
    # Incremental Refresh Methods
    # =========================================================================

    def _refresh_single_skill(self, skill_name: str) -> Optional[SkillMetadata]:
        """Re-parse a single skill's metadata (catches new refs/scripts)."""
        if skill_name not in self._skills_cache:
            return None

        old_metadata = self._skills_cache[skill_name]
        skill_md_path = Path(old_metadata.path) / "SKILL.md"

        try:
            new_metadata = self._parse_skill_file(
                skill_md_path,
                old_metadata.source,
                skill_name=skill_name,
            )
            if new_metadata:
                self._skills_cache[skill_name] = new_metadata
                # Update mtimes
                skill_path = Path(new_metadata.path)
                self._dir_mtimes[new_metadata.path] = skill_path.stat().st_mtime
                self._skill_file_mtimes[new_metadata.path] = self._metadata_tracking_mtime(skill_path)
                # Clear content cache to force re-read
                self._content_cache.pop(skill_name, None)
                self._content_mtimes.pop(skill_name, None)
                logger.info(f"[Skills] Hot-reload: Refreshed metadata for '{skill_name}'")
                return new_metadata
        except FileNotFoundError:
            # Skill was deleted
            logger.warning(f"[Skills] Hot-reload: Skill '{skill_name}' was deleted")
            self._invalidate_skill(skill_name)
            return None
        except Exception as e:
            logger.error(f"[Skills] Hot-reload: Error refreshing '{skill_name}': {e}")
            return old_metadata

        return old_metadata

    def _invalidate_skill(self, skill_name: str):
        """Remove a skill from all caches."""
        metadata = self._skills_cache.pop(skill_name, None)
        self._content_cache.pop(skill_name, None)
        self._content_mtimes.pop(skill_name, None)
        if metadata:
            self._dir_mtimes.pop(metadata.path, None)
            self._skill_file_mtimes.pop(metadata.path, None)
        logger.info(f"[Skills] Hot-reload: Invalidated skill '{skill_name}'")

    # =========================================================================
    # Core Skill Discovery and Access Methods
    # =========================================================================

    def _contains_hidden_path_parts(self, parts: Tuple[str, ...]) -> bool:
        """Check if a relative path contains hidden/private directory components."""
        return any(part.startswith(('.', '_')) for part in parts)

    def _derive_skill_name(self, skills_path: Path, skill_md_path: Path, source_type: str) -> Optional[str]:
        """
        Derive canonical skill ID from the SKILL.md location.

        Rules:
        - system/user: {skill}/SKILL.md -> "skill"
        - marketplace (flat): {marketplace}/{skill}/SKILL.md -> "marketplace/skill"
        - marketplace (plugin): {marketplace}/{plugin}/{skill}/SKILL.md
          -> "marketplace/plugin/skill", but NEVER past a SKILL.md directory:
          when {marketplace}/{plugin} is itself a skill, the deeper SKILL.md
          is reference material, not a skill (parent-guard).
        """
        relative_parts = skill_md_path.relative_to(skills_path).parts
        dir_parts = relative_parts[:-1]

        if self._contains_hidden_path_parts(dir_parts):
            return None

        if source_type == "marketplace":
            # skills-marketplace/<marketplace>/<skill>/SKILL.md
            if len(relative_parts) == 3:
                marketplace_name, skill_name, _ = relative_parts
                return f"{marketplace_name}/{skill_name}"
            # skills-marketplace/<marketplace>/<plugin>/<skill>/SKILL.md
            if len(relative_parts) == 4:
                marketplace_name, plugin_name, skill_name, _ = relative_parts
                parent_skill_md = skills_path / marketplace_name / plugin_name / "SKILL.md"
                if parent_skill_md.is_file():
                    return None
                return f"{marketplace_name}/{plugin_name}/{skill_name}"
            logger.warning(f"[Skills]       ⚠️ Skipping marketplace SKILL.md with invalid depth: {skill_md_path}")
            return None

        # skills/<skill>/SKILL.md or skills-user/<skill>/SKILL.md
        if len(relative_parts) != 2:
            logger.warning(f"[Skills]       ⚠️ Skipping {source_type} SKILL.md with invalid depth: {skill_md_path}")
            return None

        skill_name, _ = relative_parts
        return skill_name

    def discover_skills(self, force_refresh: bool = False) -> List[SkillMetadata]:
        """
        Scan all skill directories and return list of available skills.

        Skills are discovered in priority order, so system skills are
        authoritative over colliding user skills.

        Hot-reload support: checks for cache staleness via Redis flag or mtime changes.

        Args:
            force_refresh: If True, bypass cache and re-scan directories

        Returns:
            List of SkillMetadata objects for all discovered skills
        """
        logger.info("[Skills] " + "=" * 70)
        logger.info("[Skills] 📚 SKILL_MANAGER: discover_skills()")
        logger.info(f"[Skills]    force_refresh: {force_refresh}")
        logger.info(f"[Skills]    base_dir: {self.base_dir}")
        logger.info(f"[Skills]    Current cache size: {len(self._skills_cache)}")

        # Hot-reload: Check cache staleness (Redis flag OR mtime changes)
        if not force_refresh and self._skills_cache:
            if not self._is_cache_stale():
                logger.info("[Skills]    → Using cached skills (cache is fresh)")
                logger.info("[Skills] " + "=" * 70)
                return list(self._skills_cache.values())
            else:
                logger.info("[Skills]    → Cache stale (hot-reload triggered), refreshing...")

        # Clear all caches for full rescan
        self._skills_cache.clear()
        self._content_cache.clear()
        self._dir_mtimes.clear()
        self._skill_file_mtimes.clear()
        self._content_mtimes.clear()

        logger.info("[Skills]    → Scanning skill directories...")
        discovered: Dict[str, SkillMetadata] = {}

        # Scan directories in priority order
        for dir_name, source_type in self.SKILL_DIRECTORIES:
            skills_path = Path(self.base_dir) / dir_name
            logger.info(f"[Skills]    Scanning [{source_type}]: {skills_path}")

            if not skills_path.exists():
                logger.info(f"[Skills]       ❌ Directory not found, skipping")
                continue

            skill_count = 0
            # Discover SKILL.md files and derive canonical names from expected depth.
            for skill_md_path in sorted(skills_path.rglob("SKILL.md")):
                skill_name = self._derive_skill_name(skills_path, skill_md_path, source_type)
                if not skill_name:
                    continue

                skill_dir = skill_md_path.parent

                try:
                    # Parse SKILL.md
                    metadata = self._parse_skill_file(
                        skill_md_path,
                        source_type,
                        skill_name=skill_name,
                    )

                    if metadata:
                        # Only add if not already discovered (higher priority wins)
                        if metadata.name not in discovered:
                            discovered[metadata.name] = metadata
                            skill_count += 1
                            logger.info(f"[Skills]       ✅ {metadata.name}: triggers={metadata.triggers}, "
                                      f"priority={metadata.priority}, scripts={len(metadata.scripts)}")
                        else:
                            existing = discovered[metadata.name]
                            if existing.source == "system" and metadata.source == "user":
                                logger.info(
                                    f"[Skills]       ⏭️ {metadata.name}: skipped user skill due to system collision "
                                    f"(using {existing.path})"
                                )
                            else:
                                logger.info(
                                    f"[Skills]       ⏭️ {metadata.name}: skipped from {metadata.path} "
                                    f"(already loaded from {existing.path})"
                                )

                except Exception as e:
                    logger.error(f"[Skills]       ❌ Failed to process {skill_dir}: {e}")
                    continue

            logger.info(f"[Skills]       Found {skill_count} skill(s) from {source_type}")

        self._skills_cache = discovered

        # Record mtimes for hot-reload detection
        self._record_mtimes()

        logger.info(f"[Skills]    Total skills discovered: {len(discovered)}")
        for name, meta in discovered.items():
            logger.info(f"[Skills]       - {name} ({meta.source}): {meta.description[:50]}...")
        logger.info("[Skills] " + "=" * 70)

        return list(discovered.values())

    def _parse_skill_file(
        self,
        skill_md_path: Path,
        source_type: str,
        skill_name: Optional[str] = None
    ) -> Optional[SkillMetadata]:
        """
        Parse SKILL.md file and extract metadata from YAML frontmatter or sibling YAML.

        Args:
            skill_md_path: Path to SKILL.md file
            source_type: Source type ('system', 'marketplace', or 'user')
            skill_name: Canonical skill ID derived from directory layout

        Returns:
            SkillMetadata object or None if parsing fails
        """
        try:
            with open(skill_md_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Extract YAML frontmatter or sparse sibling metadata.
            frontmatter_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
            frontmatter = None

            if frontmatter_match:
                frontmatter_yaml = frontmatter_match.group(1)
                frontmatter = yaml.safe_load(frontmatter_yaml)

                if not frontmatter:
                    logger.warning(f"Empty frontmatter in {skill_md_path}")
                    return None
            else:
                sibling_yaml_path = self._skill_sibling_yaml_path(skill_md_path.parent)
                if not sibling_yaml_path.exists():
                    logger.warning(f"No YAML frontmatter found in {skill_md_path}")
                    return None

                with open(sibling_yaml_path, 'r', encoding='utf-8') as sibling_file:
                    sibling_yaml = yaml.safe_load(sibling_file.read())

                if not sibling_yaml:
                    logger.warning(f"Empty sibling metadata in {sibling_yaml_path}")
                    return None
                if not isinstance(sibling_yaml, dict):
                    logger.warning(f"Sibling metadata must be a YAML mapping in {sibling_yaml_path}")
                    return None

                author = sibling_yaml.get('owner')
                if isinstance(author, dict):
                    author = author.get('name')
                elif author is not None and not isinstance(author, str):
                    author = str(author)

                frontmatter = {
                    'name': sibling_yaml.get('skill_name'),
                    'description': sibling_yaml.get('description'),
                    'author': author,
                    'priority': 'medium',
                    'required_mcp_servers': [],
                    'triggers': self._synthesize_sibling_yaml_triggers(sibling_yaml),
                }

            if not isinstance(frontmatter, dict):
                logger.warning(f"Frontmatter must be a YAML mapping in {skill_md_path}")
                return None

            # Validate required fields
            declared_name = frontmatter.get('name')
            description = frontmatter.get('description')

            if not declared_name or not description:
                logger.warning(f"Missing required fields (name, description) in {skill_md_path}")
                return None

            skill_dir = skill_md_path.parent
            expected_leaf_name = skill_dir.name
            if declared_name != expected_leaf_name:
                logger.warning(
                    f"Skill name '{declared_name}' doesn't match directory '{expected_leaf_name}' in {skill_md_path}"
                )

            # Directory-derived canonical skill ID is authoritative.
            if not skill_name:
                skill_name = expected_leaf_name

            # Extract metadata fields (support top-level fallbacks for robustness)
            metadata_block = frontmatter.get('metadata', {})

            # Find available reference files
            references = []
            references_dir = skill_dir / "references"
            if references_dir.exists():
                for ref_file in sorted(references_dir.rglob("*")):
                    if ref_file.is_file() and ref_file.suffix in ('.md', '.txt', '.json', '.yaml'):
                        references.append(str(ref_file.relative_to(skill_dir)).replace(os.sep, "/"))

            # Find available executable scripts
            scripts = []
            scripts_dir = skill_dir / "scripts"
            if scripts_dir.exists():
                for script_file in sorted(scripts_dir.rglob("*.py")):
                    if script_file.is_file():
                        scripts.append(str(script_file.relative_to(skill_dir)).replace(os.sep, "/"))

            # Extract required_mcp_servers (check both metadata block AND top-level frontmatter)
            required_servers = metadata_block.get('required_mcp_servers', [])
            if not required_servers:
                required_servers = frontmatter.get('required_mcp_servers', [])
            if isinstance(required_servers, str):
                required_servers = [required_servers]

            priority = metadata_block.get('priority', frontmatter.get('priority', 'medium'))
            raw_triggers = metadata_block.get('triggers', frontmatter.get('triggers', []))
            triggers = self._normalize_triggers(
                raw_triggers,
                skill_name=skill_name,
                skill_path=skill_md_path,
            )

            version = metadata_block.get('version') or frontmatter.get('version')
            if version is not None:
                version = str(version)
            author = metadata_block.get('author') or frontmatter.get('author')

            return SkillMetadata(
                name=skill_name,
                description=description,
                source=source_type,
                path=str(skill_dir),
                license=frontmatter.get('license'),
                compatibility=frontmatter.get('compatibility'),
                priority=priority,
                triggers=triggers,
                version=version,
                author=author,
                references=references,
                scripts=scripts,
                required_mcp_servers=required_servers,
            )

        except yaml.YAMLError as e:
            logger.error(f"YAML parse error in {skill_md_path}: {e}")
            return None
        except Exception as e:
            logger.error(f"Failed to parse {skill_md_path}: {e}")
            return None

    @staticmethod
    def _normalize_triggers(
        raw_triggers: Any,
        *,
        skill_name: str,
        skill_path: Path,
    ) -> List[str]:
        """Normalize supported trigger metadata without letting bad entries poison discovery."""
        if raw_triggers is None:
            entries: List[Any] = []
        elif isinstance(raw_triggers, list):
            entries = raw_triggers
        else:
            entries = [raw_triggers]

        normalized: List[str] = []
        seen = set()
        ignored_shapes = set()

        def add_trigger(value: Any) -> None:
            if not isinstance(value, str):
                ignored_shapes.add(type(value).__name__)
                return
            trigger = value.strip()
            if not trigger:
                return
            dedupe_key = trigger.casefold()
            if dedupe_key in seen:
                return
            seen.add(dedupe_key)
            normalized.append(trigger)

        for entry in entries:
            if isinstance(entry, str):
                add_trigger(entry)
                continue

            if isinstance(entry, dict) and "keywords" in entry:
                keywords = entry.get("keywords")
                if isinstance(keywords, list):
                    for keyword in keywords:
                        add_trigger(keyword)
                else:
                    add_trigger(keywords)
                continue

            ignored_shapes.add(type(entry).__name__)

        if ignored_shapes:
            logger.warning(
                "[Skills] Ignored unsupported trigger metadata for '%s' in %s (types=%s)",
                skill_name,
                skill_path,
                ",".join(sorted(ignored_shapes)),
            )

        return normalized

    def get_skill_metadata(self, skill_name: str) -> Optional[SkillMetadata]:
        """
        Get metadata for a specific skill by name.

        Hot-reload support: checks for changes before returning cached metadata.

        Args:
            skill_name: Name of the skill

        Returns:
            SkillMetadata object or None if not found
        """
        if not self._skills_cache:
            self.discover_skills()

        if skill_name not in self._skills_cache:
            # Maybe a new skill was created? Do a quick check
            if self._is_cache_stale():
                self.discover_skills(force_refresh=True)
            return self._skills_cache.get(skill_name)

        # Check if this specific skill's files have changed
        metadata = self._skills_cache[skill_name]
        skill_path = Path(metadata.path)

        try:
            skill_dir_mtime = skill_path.stat().st_mtime
            cached_dir_mtime = self._dir_mtimes.get(metadata.path, 0)
            if skill_dir_mtime > cached_dir_mtime:
                # Skill directory changed - re-parse (might have new refs/scripts)
                logger.info(f"[Skills] Hot-reload: '{skill_name}' dir changed, re-parsing")
                return self._refresh_single_skill(skill_name)

            metadata_mtime = self._metadata_tracking_mtime(skill_path)
            cached_metadata_mtime = self._skill_file_mtimes.get(metadata.path, 0)
            if metadata_mtime > cached_metadata_mtime:
                logger.info(f"[Skills] Hot-reload: '{skill_name}' metadata changed, re-parsing")
                return self._refresh_single_skill(skill_name)
        except FileNotFoundError:
            # Skill was deleted
            self._invalidate_skill(skill_name)
            return None

        return metadata

    def get_skill_content(self, skill_name: str) -> Optional[str]:
        """
        Get the full content of a skill's SKILL.md file (body only, not frontmatter).

        Hot-reload support: checks file mtime to detect changes.

        Args:
            skill_name: Name of the skill

        Returns:
            Markdown content after frontmatter, or None if not found
        """
        metadata = self.get_skill_metadata(skill_name)
        if not metadata:
            return None

        skill_md_path = Path(metadata.path) / "SKILL.md"

        # Check if file has changed since last cache
        try:
            current_mtime = skill_md_path.stat().st_mtime
        except FileNotFoundError:
            # Skill was deleted, invalidate
            logger.warning(f"[Skills] Hot-reload: '{skill_name}' deleted, invalidating")
            self._invalidate_skill(skill_name)
            return None

        # Check content cache with mtime validation
        if skill_name in self._content_cache:
            cached_mtime = self._content_mtimes.get(skill_name, 0)
            if current_mtime <= cached_mtime:
                return self._apply_optimization_flags(self._content_cache[skill_name])
            else:
                logger.info(f"[Skills] Hot-reload: '{skill_name}' content changed, reloading")

        # Read fresh content
        try:
            with open(skill_md_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Remove YAML frontmatter, return just the body
            body_match = re.match(r'^---\s*\n.*?\n---\s*\n(.*)$', content, re.DOTALL)

            if body_match:
                body = body_match.group(1).strip()
            else:
                # No frontmatter, return whole content
                body = content.strip()

            # Cache with mtime
            self._content_cache[skill_name] = body
            self._content_mtimes[skill_name] = current_mtime

            return self._apply_optimization_flags(body)

        except Exception as e:
            logger.error(f"[Skills] Failed to read skill content for {skill_name}: {e}")
            return None

    def get_skill_reference(self, skill_name: str, reference_path: str) -> Optional[str]:
        """
        Get the content of a text file from a skill.

        Args:
            skill_name: Name of the skill
            reference_path: Relative path to a skill file (e.g., 'guide.md' or 'references/oauth-workflow.md')

        Returns:
            Content of the reference file, or None if not found
        """
        metadata = self.get_skill_metadata(skill_name)
        if not metadata:
            logger.warning(f"Skill not found: {skill_name}")
            return None

        # Security: ensure reference_path doesn't escape skill directory
        normalized_path = os.path.normpath(reference_path)
        raw_parts = Path(reference_path).parts
        normalized_parts = Path(normalized_path).parts
        if (
            normalized_path.startswith('..')
            or os.path.isabs(normalized_path)
            or '..' in raw_parts
            or '..' in normalized_parts
        ):
            logger.error(f"Invalid reference path (path traversal attempt): {reference_path}")
            return None

        # Check if reference is in the available list
        if reference_path not in metadata.references:
            logger.debug(f"Reference not in advertised references list: {reference_path}")
            # Still try to load it if it exists (allows links to root-level skill files)

        try:
            skill_root = Path(metadata.path).resolve(strict=True)
            candidate_paths = [skill_root / normalized_path]
            if not normalized_path.startswith('references/'):
                candidate_paths.append(skill_root / 'references' / normalized_path)

            for full_path in candidate_paths:
                if not full_path.exists():
                    continue

                resolved_path = full_path.resolve(strict=True)
                try:
                    resolved_path.relative_to(skill_root)
                except ValueError:
                    logger.error(f"Invalid reference path outside skill directory: {reference_path}")
                    return None

                if not resolved_path.is_file():
                    logger.warning(f"Reference path is not a file: {resolved_path}")
                    return None

                with open(resolved_path, 'r', encoding='utf-8') as f:
                    return f.read()

            logger.warning(f"Reference file not found: {reference_path}")
            return None

        except UnicodeDecodeError:
            logger.error(f"Reference is not valid UTF-8 text: {reference_path}")
            return None
        except Exception as e:
            logger.error(f"Failed to read reference {reference_path} for skill {skill_name}: {e}")
            return None

    def get_all_metadata(self) -> List[SkillMetadata]:
        """
        Get metadata for all discovered skills.

        Returns:
            List of SkillMetadata objects
        """
        if not self._skills_cache:
            return self.discover_skills()

        # Hot-reload: refresh cache if invalidated or mtimes changed.
        if self._is_cache_stale():
            return self.discover_skills(force_refresh=True)

        return list(self._skills_cache.values())

    def get_skill_source(self, skill_name: str) -> Optional[str]:
        """
        Get the source type for a skill.

        Args:
            skill_name: Name of the skill

        Returns:
            'system', 'marketplace', 'user', or None if not found
        """
        metadata = self.get_skill_metadata(skill_name)
        return metadata.source if metadata else None

    def resolve_skill_path(self, skill_name: str) -> Optional[str]:
        """
        Resolve a skill's canonical directory path from its skill ID.

        Args:
            skill_name: Canonical skill name/ID

        Returns:
            Absolute path to the skill directory, or None if not found
        """
        metadata = self.get_skill_metadata(skill_name)
        return metadata.path if metadata else None

    def skill_exists(self, skill_name: str) -> bool:
        """
        Check if a skill exists.

        Args:
            skill_name: Name of the skill

        Returns:
            True if skill exists, False otherwise
        """
        return self.get_skill_metadata(skill_name) is not None

    def check_auto_activation(self, message: str) -> List[str]:
        """
        Check if a user message triggers auto-activation for skills with defined triggers.

        This simulates Atlas Desktop behavior where Atlas would naturally read SKILL.md
        when it sees a relevant task. Since we can't let Atlas read files directly,
        trigger-based auto-injection provides the equivalent behavior.

        Args:
            message: User message text

        Returns:
            List of skill names that should be auto-activated
        """
        logger.info("[Skills] " + "-" * 50)
        logger.info("[Skills] 🔍 SKILL_MANAGER: check_auto_activation()")
        logger.info(f"[Skills]    Message length: {len(message)} chars")

        if not self._skills_cache:
            logger.info("[Skills]    Cache empty, running discover_skills()...")
            self.discover_skills()
        elif self._is_cache_stale():
            logger.info("[Skills]    Cache stale, refreshing before auto-activation...")
            self.discover_skills(force_refresh=True)

        logger.info(f"[Skills]    Skills in cache: {len(self._skills_cache)}")

        message_lower = message.lower()
        normalized_message = self._normalize_trigger_text(message)
        activated = []

        skills_with_triggers = 0
        for skill_name, metadata in self._skills_cache.items():
            # Skip skills without triggers defined
            if not metadata.triggers:
                continue

            skills_with_triggers += 1
            logger.info(f"[Skills]    Checking '{skill_name}' triggers: {metadata.triggers}")

            # Check if any trigger matches
            for trigger in metadata.triggers:
                if not isinstance(trigger, str):
                    logger.warning(
                        "[Skills] Skipping non-string cached trigger for '%s' (type=%s)",
                        skill_name,
                        type(trigger).__name__,
                    )
                    continue
                trigger = trigger.strip()
                if not trigger:
                    continue
                trigger_lower = trigger.lower()
                normalized_trigger = self._normalize_trigger_text(trigger)
                if (
                    trigger_lower in message_lower
                    or (normalized_trigger and normalized_trigger in normalized_message)
                ):
                    activated.append(skill_name)
                    logger.info(f"[Skills]    ✅ MATCH: skill '{skill_name}' triggered by '{trigger}'")
                    break
                else:
                    logger.debug(f"[Skills]    ❌ No match for trigger '{trigger}'")

        logger.info(f"[Skills]    Skills with triggers: {skills_with_triggers}")
        logger.info(f"[Skills]    Skills activated: {len(activated)} - {activated}")
        logger.info("[Skills] " + "-" * 50)
        return activated

    @staticmethod
    def _normalize_trigger_text(text: str) -> str:
        """Normalize text for punctuation-insensitive trigger matching."""
        normalized = text.lower().replace("’", "'").replace("'", "")
        normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
        return re.sub(r"\s+", " ", normalized).strip()

    def reload_skills(self) -> List[SkillMetadata]:
        """
        Force reload of all skills (clears all caches including mtimes and re-discovers).
        Useful after marketplace install/uninstall operations.

        Returns:
            List of SkillMetadata objects for all discovered skills
        """
        self._skills_cache.clear()
        self._content_cache.clear()
        self._dir_mtimes.clear()
        self._skill_file_mtimes.clear()
        self._content_mtimes.clear()
        return self.discover_skills(force_refresh=True)

    def format_skills_for_prompt(self, skills: List[SkillMetadata] = None) -> str:
        """
        Format skill metadata as XML for injection into system prompt.

        Args:
            skills: List of skills to format, or None to use all discovered skills

        Returns:
            XML-formatted string with available skills
        """
        if skills is None:
            skills = self.get_all_metadata()

        if not skills:
            return "<available_skills>\nNo skills available.\n</available_skills>"

        lines = ["<available_skills>"]

        for skill in skills:
            lines.append("  <skill>")
            lines.append(f"    <name>{skill.name}</name>")
            lines.append(f"    <description>{skill.description}</description>")
            lines.append(f"    <priority>{skill.priority}</priority>")
            lines.append(f"    <source>{skill.source}</source>")
            lines.append("  </skill>")

        lines.append("</available_skills>")

        return "\n".join(lines)

    def format_activated_skill(self, skill_name: str) -> Optional[str]:
        """
        Format a skill's full content for injection into system prompt.

        Args:
            skill_name: Name of the skill to format

        Returns:
            XML-formatted string with skill content, or None if not found
        """
        metadata = self.get_skill_metadata(skill_name)
        if not metadata:
            return None

        content = self.get_skill_content(skill_name)
        if not content:
            return None

        lines = [f'<activated_skill name="{skill_name}">']
        lines.append(content)

        # Add available references if any
        if metadata.references:
            lines.append("")
            lines.append("<available_references>")
            for ref in metadata.references:
                lines.append(f"  - {ref}")
            lines.append("</available_references>")

        # Add available scripts if any
        if metadata.scripts:
            lines.append("")
            lines.append("<available_scripts>")
            lines.append("Execute scripts using: execute_skill_script(skill_name, script_name, args, vm_id=... or chat_id=...)")
            for script in metadata.scripts:
                lines.append(f"  - {script}")
            lines.append("</available_scripts>")

        # Add required MCP servers info if any
        if metadata.required_mcp_servers:
            lines.append("")
            lines.append("<required_mcp_servers>")
            lines.append("This skill requires the following MCP servers (auto-enabled on activation):")
            for server in metadata.required_mcp_servers:
                lines.append(f"  - {server}")
            lines.append("</required_mcp_servers>")

        lines.append("</activated_skill>")

        return "\n".join(lines)


# Singleton instance for use across the application
_skill_manager_instance: Optional[SkillManager] = None


def get_skill_manager(base_dir: str = None, redis_client=None) -> SkillManager:
    """
    Get or create the singleton SkillManager instance.

    Args:
        base_dir: Base directory (only used on first call)
        redis_client: Optional Redis client for cross-container cache invalidation (only used on first call)

    Returns:
        SkillManager instance
    """
    global _skill_manager_instance

    if _skill_manager_instance is None:
        _skill_manager_instance = SkillManager(base_dir, redis_client)

    return _skill_manager_instance


def reset_skill_manager() -> None:
    """Reset the singleton instance (mainly for testing)."""
    global _skill_manager_instance
    _skill_manager_instance = None
