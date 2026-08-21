# Skills Hot-Reload Implementation

> **Implementation Date:** January 2026
> **Status:** Implemented

## Problem Statement

The current skills system has a **cross-container cache staleness problem**:

1. Multiple containers share skills directories via Docker volume mounts:
   - `open-webui` (runs `unified_context.py` filter)
   - `mcpo-core-skills` (runs Skills MCP server)
   - `mcpo-core-mcp-assistant` and others

2. Each container has its own **in-memory SkillManager singleton** with caches:
   - `_skills_cache`: Dict of skill_name → SkillMetadata
   - `_content_cache`: Dict of skill_name → SKILL.md body content

3. When Container A modifies a skill and calls `reload_skills()`:
   - Container A's cache is cleared and refreshed
   - **Container B's cache remains stale**

### Critical Agentic Workflow Scenario

```
Turn 1: User asks to modify a skill
    ↓
LLM calls update_skill() tool in mcpo-core-skills container
    ↓
MCP server writes to filesystem + calls reload_skills() locally
    ↓
Follow-up request → open-webui container → unified_context.py
    ↓
SkillManager.get_skill_content() returns STALE cached content!
```

**Goal**: Ensure that skill changes are immediately reflected in the very next LLM request.

---

## Current Architecture Analysis

### Skill Directories and Docker Mounts

| Directory | Mount Mode | Purpose |
|-----------|------------|---------|
| `skills/` | Read-only (`:ro`) | 6 system skills (version controlled) |
| `skills-user/` | Read-write (`:rw`) | User-created skills |
| `skills-marketplace/` | Read-write (`:rw`) | Downloaded marketplace skills (nested) |

### SkillManager Caching (`src/managers/skill_manager.py`)

```python
class SkillManager:
    def __init__(self, ...):
        self._skills_cache: Dict[str, SkillMetadata] = {}  # Metadata cache
        self._content_cache: Dict[str, str] = {}           # Content cache
        self._last_discovery_time: float = 0               # UNUSED! Never implemented

    def discover_skills(self, force_refresh: bool = False):
        # Returns cached data if cache exists AND force_refresh=False
        if not force_refresh and self._skills_cache:
            return list(self._skills_cache.values())  # STALE!

    def get_skill_content(self, skill_name):
        # Returns cached content without checking if file changed
        if skill_name in self._content_cache:
            return self._content_cache[skill_name]  # POTENTIALLY STALE!
```

### Key Observation

Line 99 has `self._last_discovery_time: float = 0` but it's **never used**. This suggests someone anticipated time-based invalidation but never implemented it.

---

## Solution: Hybrid Approach (Redis Pub/Sub + mtime Fallback)

### Why Hybrid?

| Approach | Pros | Cons |
|----------|------|------|
| mtime-only | Simple, reliable | stat() calls on each request |
| Redis pub/sub only | Instant notification | May miss events (network issues) |
| **Hybrid (chosen)** | Instant + reliable fallback | Most comprehensive |

**Hybrid approach:**
1. **Primary**: Redis pub/sub for instant cross-container notification
2. **Fallback**: mtime checking as defense-in-depth

### Architecture

```
Container A (mcpo-core-skills):
  update_skill() writes file
       ↓
  calls reload_skills() locally
       ↓
  publishes "skill:invalidate" to Redis channel
       ↓
Container B (open-webui):
  Redis subscriber receives "skill:invalidate"
       ↓
  sets _cache_invalidated = True
       ↓
  next request: checks _cache_invalidated flag
       ↓
  if True: clears cache, reloads from disk
       ↓
  FALLBACK: mtime check catches any missed notifications
```

### Race Condition Mitigation

**Potential Race:**
```
T0: Container A writes file (mtime updated on disk)
T1: Container A publishes Redis message
T2: Network delay - message in flight (~1-5ms)
T3: Container B gets follow-up request
T4: Container B checks Redis flag → False (message not arrived yet!)
T5: Does Container B return stale data? 🚨
```

**Why This Race is Mitigated:**

The mtime fallback is **not optional** - it's checked on EVERY request when Redis flag is False:

```python
def _is_cache_stale(self) -> bool:
    if self._cache_invalidated:
        return True  # Fast path: Redis notification received
    # ALWAYS check mtimes when Redis flag is False:
    return self._check_directories_changed()  # ← This catches the race!
```

**Timeline with mtime fallback:**
```
T0: Container A writes file (mtime = 12345 on disk - SYNCHRONOUS)
T1: Container A publishes Redis message (ASYNC)
T3: Container B gets request
T4: Redis flag = False (message still in flight)
T5: _check_directories_changed() does stat()
T6: current_mtime (12345) > cached_mtime (12340) → True
T7: Cache refreshed → FRESH data returned ✓
```

**Key Insight:** File mtime is updated **synchronously** at write time (T0), before any network I/O. The mtime check will detect the change regardless of Redis latency.

### Order of Operations (Critical)

In the MCP tools, we MUST ensure file is fully written before publishing:

```python
# In tools.py - CORRECT ORDER
def update_skill(...):
    # 1. Write file to disk (SYNCHRONOUS - blocks until complete)
    with open(skill_path, 'w') as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())  # Force disk write

    # 2. Reload local cache (uses new mtime)
    skill_manager.reload_skills()

    # 3. Publish notification (can be async - mtime is already on disk)
    skill_manager.publish_invalidation(skill_name, "skill_changed")

    return {"success": True}
```

**The `os.fsync()` guarantees:**
1. File content is written to disk
2. File mtime is updated
3. Other processes can see the change via stat()

This eliminates any filesystem caching delay.

---

## Implementation Design

### Data Structure Changes

```python
class SkillManager:
    def __init__(self, base_dir: str = None, redis_client=None):
        # Existing caches
        self._skills_cache: Dict[str, SkillMetadata] = {}
        self._content_cache: Dict[str, str] = {}

        # NEW: mtime tracking (fallback mechanism)
        self._dir_mtimes: Dict[str, float] = {}           # skill_dir_path -> mtime
        self._skill_file_mtimes: Dict[str, float] = {}    # skill_path -> SKILL.md mtime
        self._content_mtimes: Dict[str, float] = {}       # skill_name -> content mtime

        # NEW: Redis pub/sub (primary mechanism)
        self._redis_client = redis_client
        self._cache_invalidated: bool = False             # Flag set by Redis subscriber
        self._pubsub_thread: Optional[threading.Thread] = None
```

### Redis Pub/Sub Channel

```python
SKILL_INVALIDATE_CHANNEL = "skill:invalidate"

# Message format (JSON)
{
    "event": "skill_changed",      # or "skill_created", "skill_deleted"
    "skill_name": "code-execution",
    "timestamp": 1704672000.123,
    "source_container": "mcpo-core-skills"
}
```

### Files to Track

Per skill directory:
- `SKILL.md` - primary file (metadata + content)
- `references/` directory mtime (detects new/deleted refs)
- `scripts/` directory mtime (detects new/deleted scripts)
- Skill directory mtime (detects ANY change within the skill)

Per top-level directory:
- `skills/`, `skills-user/`, `skills-marketplace/` mtimes (detects new/deleted skills)

### Critical: Full Metadata Re-parse on Any Change

When ANY file within a skill changes (not just SKILL.md), we need to:
1. **Re-parse the entire skill** (not just content reload)
2. **Update metadata.references** list (discovers new reference files)
3. **Update metadata.scripts** list (discovers new script files)

This ensures the LLM sees new scripts/references immediately, even if added mid-turn.

### Edge Cases to Handle

| Scenario | Detection Method | Action |
|----------|-----------------|--------|
| New skill created mid-turn | Top-level dir mtime changes | Full rescan of all directories |
| Skill deleted from filesystem | FileNotFoundError OR dir mtime change | Remove from cache, graceful handling |
| Reference file added | Skill dir mtime changes | Re-parse skill metadata |
| Reference file modified | Reference file mtime (on access) | Return fresh content |
| Reference file deleted | FileNotFoundError on access | Graceful error, re-parse metadata |
| Script file added | Skill dir mtime changes | Re-parse skill metadata |
| Script file modified | Script file mtime (for execution) | No cache (scripts run fresh) |
| Script file deleted | FileNotFoundError on execution | Graceful error |
| User modifies filesystem mid-turn | mtime fallback catches it | Full rescan before returning |

---

## Key Methods

### Redis Subscriber Methods

```python
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
    """Publish cache invalidation message to Redis."""
    if not self._redis_client:
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
```

### Combined Cache Check

```python
def _is_cache_stale(self) -> bool:
    """Check if cache needs refresh (Redis flag OR mtime changes)."""
    # PRIMARY: Check Redis invalidation flag
    if self._cache_invalidated:
        logger.info("[Skills] Hot-reload: Cache invalidated via Redis")
        self._cache_invalidated = False  # Reset flag
        return True

    # FALLBACK: Check mtimes (catches missed Redis messages)
    return self._check_directories_changed()
```

### Incremental Refresh

```python
def _refresh_single_skill(self, skill_name: str) -> Optional[SkillMetadata]:
    """Re-parse a single skill's metadata (catches new refs/scripts)."""
    if skill_name not in self._skills_cache:
        return None

    old_metadata = self._skills_cache[skill_name]
    skill_md_path = Path(old_metadata.path) / "SKILL.md"

    try:
        new_metadata = self._parse_skill_file(skill_md_path, old_metadata.source)
        if new_metadata:
            self._skills_cache[skill_name] = new_metadata
            # Update mtimes
            skill_path = Path(new_metadata.path)
            self._dir_mtimes[new_metadata.path] = skill_path.stat().st_mtime
            self._skill_file_mtimes[new_metadata.path] = skill_md_path.stat().st_mtime
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

def _invalidate_skill(self, skill_name: str):
    """Remove a skill from all caches."""
    metadata = self._skills_cache.pop(skill_name, None)
    self._content_cache.pop(skill_name, None)
    self._content_mtimes.pop(skill_name, None)
    if metadata:
        self._dir_mtimes.pop(metadata.path, None)
        self._skill_file_mtimes.pop(metadata.path, None)
    logger.info(f"[Skills] Hot-reload: Invalidated skill '{skill_name}'")
```

---

## Verification Plan

### 1. Build and Restart

```bash
bash src/scripts/docker-compose.sh restart
```

### 2. Check Logs for Hot-Reload Detection

```bash
docker logs portico-open-webui 2>&1 | grep -i "Hot-reload"
```

### 3. End-to-End Test via Electron

1. Launch Electron app
2. Start new chat
3. Activate a skill (e.g., `code-execution`)
4. Use `update_skill` tool to modify the skill content
5. Send follow-up message
6. Verify: LLM response shows updated skill content in system prompt

### 4. Manual Test

```bash
# Terminal 1: Watch logs
docker logs -f portico-open-webui 2>&1 | grep -i Skills

# Terminal 2: Modify a skill file
echo "# Modified!" >> skills-user/meeting-scheduler/SKILL.md

# Terminal 3: Trigger a request in the Electron app
# Should see "Hot-reload: ... changed" in logs
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Performance from stat() calls | Low | Low | stat() is ~microseconds; ~10 skills = ~100μs |
| Race condition: Redis slow | **None** | **None** | mtime fallback is ALWAYS checked when Redis flag is False |
| Race condition: write in progress | Very Low | Low | os.fsync() ensures mtime visible before return |
| Race condition: rapid writes | Low | Low | mtime resolution is 1s on some FS; fsync mitigates |
| File deleted mid-check | Low | Medium | FileNotFoundError handling with graceful fallback |
| Nested marketplace paths | Medium | Low | Already handled by `rglob()` + use `metadata.path` |
| Redis subscriber disconnects | Medium | None | mtime fallback provides full coverage |

### Race Condition Deep Dive

**Why there's no race condition:**

1. **File write is synchronous**: `write()` + `fsync()` blocks until mtime is on disk
2. **mtime check is always done**: When Redis flag is False, we ALWAYS check mtimes
3. **mtime updates atomically**: File mtime is updated when file is closed
4. **Order of operations**: File written → mtime visible → then Redis published

**Worst case scenario:**
- Redis is completely unavailable
- mtime fallback handles 100% of invalidation
- Overhead: ~100μs per request (stat() calls)

**Belt-and-suspenders guarantee:**
Even if Redis pub/sub fails entirely, the system remains correct because mtime checking provides complete coverage.

---

## Test Scenarios

### Core Hot-Reload Tests

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| 1 | New skill created mid-turn | Next `discover_skills()` finds new skill |
| 2 | `SKILL.md` content modified | `get_skill_content()` returns new content |
| 3 | Script added to existing skill | `get_skill_metadata().scripts` includes new script |
| 4 | Reference file added | `get_skill_metadata().references` includes new ref |
| 5 | Reference file modified | `get_skill_reference()` returns new content |
| 6 | Skill directory deleted | Graceful handling, skill removed from cache |
| 7 | Cross-container modification | Container B detects Container A's change via Redis |
| 8 | User modifies filesystem directly | mtime fallback detects change |

### Edge Cases

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| 9 | Skill created while iterating | Full rescan on next access |
| 10 | SKILL.md deleted (invalid skill) | Skill removed from cache |
| 11 | scripts/ dir deleted | Metadata shows empty scripts list |
| 12 | references/ dir deleted | Metadata shows empty references list |
| 13 | Redis subscriber disconnects | mtime fallback still works |
| 14 | Rapid successive changes | All changes detected (mtime resolution) |
| 15 | Nested marketplace skill modified | Detected via full path tracking |

---

## Files Modified

### Primary: `src/managers/skill_manager.py`
- Add Redis pub/sub subscriber (primary invalidation)
- Add mtime tracking (fallback invalidation)
- Add `publish_invalidation()` method
- Add `_refresh_single_skill()` for incremental updates
- Add `_invalidate_skill()` for graceful removal
- Modify `discover_skills()` to check staleness
- Modify `get_skill_content()` to check mtimes
- Modify `get_skill_metadata()` to check for changes
- Modify `get_skill_reference()` to use fresh metadata

### Secondary: `src/core-mcp-rust/skills/src/skills_server/tools.py`
- Call `publish_invalidation()` after skill CRUD operations

### Minor: `src/filters/unified_context.py`
- Pass Redis client to SkillManager

---

## Summary

**Key Design Principles:**
1. **Instant notification** (Redis pub/sub): Cross-container notification via Redis channel
2. **Reliable fallback** (mtime): File timestamp checking catches missed notifications
3. **Full re-parse on any change**: New refs/scripts discovered immediately
4. **Graceful deletion handling**: Skills removed from cache on FileNotFoundError
5. **Mid-turn resilience**: Works even when user modifies filesystem during chat

**Estimated Overhead:**
- Redis notification: ~1ms (network round-trip)
- mtime fallback: ~100μs (stat() calls)
- Per-skill refresh: ~1ms (re-parse SKILL.md + directory listing)
