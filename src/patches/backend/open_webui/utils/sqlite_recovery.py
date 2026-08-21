"""
PORTICO PATCH (PORTICO-201): self-heal a SQLite pool poisoned by disk I/O errors.

Incident: the bind-mounted ``webui.db`` (virtiofs on macOS) can start failing
with persistent ``sqlite3.OperationalError: disk I/O error`` (stale file
handle / WAL issue). Every pooled SQLAlchemy connection then fails forever,
the container stays "running", and every DB-backed request 500s until someone
manually restarts services.

This module installs a SQLAlchemy ``handle_error`` engine listener that:

1. Marks matching errors as disconnects (``context.is_disconnect = True``)
   and leaves ``invalidate_pool_on_disconnect`` at its default (``True``), so
   SQLAlchemy invalidates the pool generation and subsequent checkouts reopen
   the database file with fresh file descriptors. This recovers transient
   stale-handle conditions within seconds without touching the pool from
   inside the error handler.
2. Escalates to terminating the process when disk I/O errors persist for a
   configurable window despite pool invalidation. The open-webui container
   runs with ``restart: unless-stopped`` and its entrypoint ``exec``s
   ``start.sh`` (uvicorn), so a process exit triggers a container restart
   that re-establishes the bind mount — recovering conditions a same-process
   reopen cannot.

Deliberately no SQLAlchemy import at module import time so the module stays
standalone-testable; SQLAlchemy is only touched inside the installer.

Environment overrides (all optional):
    OWUI_SQLITE_IO_RECOVERY_ENABLED                 default "true"
    OWUI_SQLITE_IO_RECOVERY_EXIT_ENABLED            default "true"
    OWUI_SQLITE_IO_RECOVERY_ESCALATE_AFTER_SECONDS  default 120
    OWUI_SQLITE_IO_RECOVERY_MIN_ERRORS              default 3
    OWUI_SQLITE_IO_RECOVERY_QUIET_RESET_SECONDS     default 600
"""

import logging
import os
import sys
import threading
import time

DISK_IO_ERROR_MESSAGE = "disk i/o error"
EXIT_CODE = 74  # EX_IOERR

_DEFAULT_ESCALATE_AFTER_SECONDS = 120.0
_DEFAULT_MIN_ERRORS = 3
_DEFAULT_QUIET_RESET_SECONDS = 600.0

_module_log = logging.getLogger("open_webui.utils.sqlite_recovery")

_install_lock = threading.Lock()
_installed_engine_ids = set()


def _env_flag(name, default=True):
    raw = os.environ.get(name)
    # Unset OR empty means "use the default" — an exported-but-empty variable
    # must not silently flip the feature off.
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _env_float(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return float(default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return float(default)
    return value if value > 0 else float(default)


def _env_int(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return int(default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return int(default)
    return value if value > 0 else int(default)


def is_sqlite_disk_io_error(exc, max_depth=8):
    """True iff ``exc`` (or an ``orig`` it wraps) is a DBAPI-level sqlite3
    OperationalError whose message is a disk I/O error.

    Only the DBAPI original exception is inspected — never SQLAlchemy wrapper
    text, which can embed rendered SQL statements and user-supplied
    parameters (false-positive risk).
    """
    node = exc
    depth = 0
    seen = set()
    while node is not None and depth < max_depth and id(node) not in seen:
        seen.add(id(node))
        node_type = type(node)
        if (
            node_type.__name__ == "OperationalError"
            and getattr(node_type, "__module__", "") == "sqlite3"
            and str(node).strip().lower().startswith(DISK_IO_ERROR_MESSAGE)
        ):
            return True
        node = getattr(node, "orig", None)
        depth += 1
    return False


class DiskIoEscalationState:
    """Thread-safe episode tracker deciding when pool invalidation has failed
    long enough that a process restart is warranted."""

    def __init__(
        self,
        escalate_after_seconds=_DEFAULT_ESCALATE_AFTER_SECONDS,
        min_errors=_DEFAULT_MIN_ERRORS,
        quiet_reset_seconds=_DEFAULT_QUIET_RESET_SECONDS,
        clock=time.monotonic,
    ):
        self.escalate_after_seconds = float(escalate_after_seconds)
        self.min_errors = int(min_errors)
        self.quiet_reset_seconds = float(quiet_reset_seconds)
        self._clock = clock
        self._lock = threading.Lock()
        self._episode_started_at = None
        self._last_error_at = None
        self._error_count = 0

    def record_error(self):
        """Record one matching error; returns ``True`` when the episode has
        persisted past the escalation thresholds."""
        now = self._clock()
        with self._lock:
            if (
                self._last_error_at is not None
                and now - self._last_error_at >= self.quiet_reset_seconds
            ):
                self._episode_started_at = None
                self._error_count = 0

            if self._episode_started_at is None:
                self._episode_started_at = now
            self._last_error_at = now
            self._error_count += 1

            episode_age = now - self._episode_started_at
            return (
                episode_age >= self.escalate_after_seconds
                and self._error_count >= self.min_errors
            )

    @property
    def error_count(self):
        with self._lock:
            return self._error_count


def _flush_all():
    try:
        for handler in logging.getLogger().handlers:
            try:
                handler.flush()
            except Exception:
                pass
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass


def install_sqlite_io_recovery(engine, logger=None, clock=None, exit_fn=None):
    """Install the disk-I/O recovery listener on ``engine``.

    No-op unless the engine is SQLite. Idempotent per engine. Returns ``True``
    when the listener was installed (now or previously), ``False`` otherwise.
    """
    log = logger or _module_log

    if not _env_flag("OWUI_SQLITE_IO_RECOVERY_ENABLED", True):
        log.info("SQLite disk I/O recovery disabled via env")
        return False

    dialect_name = getattr(getattr(engine, "dialect", None), "name", None)
    if dialect_name != "sqlite":
        log.debug(
            "SQLite disk I/O recovery not installed (dialect=%s)", dialect_name
        )
        return False

    with _install_lock:
        if id(engine) in _installed_engine_ids:
            return True
        _installed_engine_ids.add(id(engine))

    from sqlalchemy import event

    exit_enabled = _env_flag("OWUI_SQLITE_IO_RECOVERY_EXIT_ENABLED", True)
    state = DiskIoEscalationState(
        escalate_after_seconds=_env_float(
            "OWUI_SQLITE_IO_RECOVERY_ESCALATE_AFTER_SECONDS",
            _DEFAULT_ESCALATE_AFTER_SECONDS,
        ),
        min_errors=_env_int(
            "OWUI_SQLITE_IO_RECOVERY_MIN_ERRORS", _DEFAULT_MIN_ERRORS
        ),
        quiet_reset_seconds=_env_float(
            "OWUI_SQLITE_IO_RECOVERY_QUIET_RESET_SECONDS",
            _DEFAULT_QUIET_RESET_SECONDS,
        ),
        clock=clock or time.monotonic,
    )
    do_exit = exit_fn or os._exit

    @event.listens_for(engine, "handle_error")
    def _handle_sqlite_disk_io_error(context):
        original = getattr(context, "original_exception", None)
        if original is None or not is_sqlite_disk_io_error(original):
            return

        # Treat as a disconnect: SQLAlchemy invalidates the current
        # connection AND (invalidate_pool_on_disconnect default True) the
        # whole pool generation, so subsequent checkouts reopen the DB file.
        context.is_disconnect = True

        should_escalate = state.record_error()
        log.error(
            "SQLite disk I/O error detected (occurrence %d this episode); "
            "invalidating connection pool so new connections reopen the "
            "database file",
            state.error_count,
        )

        if should_escalate and exit_enabled:
            log.critical(
                "SQLite disk I/O errors persisted despite pool invalidation "
                "(>= %d errors over >= %.0fs); exiting with code %d so the "
                "container restart re-establishes the database bind mount",
                state.min_errors,
                state.escalate_after_seconds,
                EXIT_CODE,
            )
            _flush_all()
            do_exit(EXIT_CODE)

    log.info(
        "SQLite disk I/O recovery installed (exit escalation %s)",
        "enabled" if exit_enabled else "disabled",
    )
    return True
