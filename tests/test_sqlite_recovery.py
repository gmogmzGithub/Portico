"""Tests for the PORTICO-201 SQLite disk I/O recovery patch.

Covers: DBAPI-only error classification, the escalation state machine,
installer behavior on real SQLAlchemy engines, and the source contracts the
process-exit escalation relies on (compose restart policy + entrypoint exec).

NOTE: the SQLAlchemy-backed tests skip when sqlalchemy is not importable.
Run via the smoke gate (./run-tests.sh) or reproduce its environment with
    uv run --with pytest --with-requirements requirements-open-webui-slim.txt \
        python -m pytest tests/test_sqlite_recovery.py
to exercise the full suite (20 tests, 0 skips).
"""

import importlib.util
import json
import logging
import sqlite3
import sys
from pathlib import Path
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "sqlite_recovery.py"
)
MAIN_PATH = REPO_ROOT / "src" / "patches" / "backend" / "open_webui" / "main.py"
COMPOSE_PATH = REPO_ROOT / "docker-compose.yml"
ENTRYPOINT_PATH = REPO_ROOT / "src" / "patches" / "patch-openwebui-entrypoint.sh"
DB_DIAGNOSTICS_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "db_diagnostics.py"
)
AUTH_BRIDGE_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "routers"
    / "portico_auth_bridge.py"
)

SPEC = importlib.util.spec_from_file_location("sqlite_recovery", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

is_sqlite_disk_io_error = MODULE.is_sqlite_disk_io_error
DiskIoEscalationState = MODULE.DiskIoEscalationState
install_sqlite_io_recovery = MODULE.install_sqlite_io_recovery

DIAGNOSTICS_SPEC = importlib.util.spec_from_file_location(
    "db_diagnostics", DB_DIAGNOSTICS_PATH
)
assert DIAGNOSTICS_SPEC and DIAGNOSTICS_SPEC.loader
DIAGNOSTICS = importlib.util.module_from_spec(DIAGNOSTICS_SPEC)
sys.modules[DIAGNOSTICS_SPEC.name] = DIAGNOSTICS
DIAGNOSTICS_SPEC.loader.exec_module(DIAGNOSTICS)


class FakeClock:
    def __init__(self, now=0.0):
        self.now = float(now)

    def __call__(self):
        return self.now


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def test_matches_direct_sqlite_disk_io_operational_error():
    assert is_sqlite_disk_io_error(sqlite3.OperationalError("disk I/O error"))


def test_matches_wrapped_error_via_orig_chain():
    sqlalchemy_exc = pytest.importorskip("sqlalchemy.exc")
    wrapper = sqlalchemy_exc.OperationalError(
        "SELECT 1", {}, sqlite3.OperationalError("disk I/O error")
    )
    assert is_sqlite_disk_io_error(wrapper)


def test_rejects_plain_exception_with_matching_text():
    assert not is_sqlite_disk_io_error(Exception("disk I/O error"))


def test_rejects_other_sqlite_operational_errors():
    assert not is_sqlite_disk_io_error(sqlite3.OperationalError("database is locked"))


def test_rejects_wrapper_text_false_positive_from_parameters():
    """A wrapper whose rendered text mentions "disk I/O error" via user
    parameters must NOT match when the DBAPI original is a different error."""
    sqlalchemy_exc = pytest.importorskip("sqlalchemy.exc")
    wrapper = sqlalchemy_exc.OperationalError(
        "INSERT INTO chat (title) VALUES (?)",
        ("my note about a disk I/O error",),
        sqlite3.OperationalError("database is locked"),
    )
    assert "disk i/o error" in str(wrapper).lower()  # sanity: text does contain it
    assert not is_sqlite_disk_io_error(wrapper)


def test_rejects_non_sqlite_operational_error_class():
    class OperationalError(Exception):
        pass

    assert not is_sqlite_disk_io_error(OperationalError("disk I/O error"))


def test_orig_cycle_is_safe():
    err = sqlite3.OperationalError("database is locked")
    err.orig = err  # pathological self-cycle
    assert not is_sqlite_disk_io_error(err)


# ---------------------------------------------------------------------------
# Escalation state machine
# ---------------------------------------------------------------------------


def test_no_escalation_before_thresholds():
    clock = FakeClock()
    state = DiskIoEscalationState(
        escalate_after_seconds=120, min_errors=3, quiet_reset_seconds=600, clock=clock
    )
    assert state.record_error() is False  # t=0, count=1
    clock.now = 10
    assert state.record_error() is False  # count=2, age=10
    clock.now = 60
    assert state.record_error() is False  # count=3 but age=60 < 120


def test_escalates_when_persistent_and_frequent():
    clock = FakeClock()
    state = DiskIoEscalationState(
        escalate_after_seconds=120, min_errors=3, quiet_reset_seconds=600, clock=clock
    )
    state.record_error()  # t=0
    clock.now = 10
    state.record_error()
    clock.now = 130
    assert state.record_error() is True  # count=3, age=130


def test_quiet_period_resets_episode():
    clock = FakeClock()
    state = DiskIoEscalationState(
        escalate_after_seconds=120, min_errors=2, quiet_reset_seconds=600, clock=clock
    )
    state.record_error()  # t=0
    clock.now = 700  # gap 700 >= 600 -> reset
    assert state.record_error() is False
    assert state.error_count == 1


def test_health_cadence_aligned_errors_still_escalate():
    """Errors arriving once per ~5-minute health-check cycle must not reset
    the episode forever (quiet reset is 600s > 300s cadence)."""
    clock = FakeClock()
    state = DiskIoEscalationState(
        escalate_after_seconds=120, min_errors=3, quiet_reset_seconds=600, clock=clock
    )
    assert state.record_error() is False  # t=0
    clock.now = 300
    assert state.record_error() is False  # gap 300 < 600, count=2
    clock.now = 600
    assert state.record_error() is True  # count=3, age=600


# ---------------------------------------------------------------------------
# Installer on real SQLAlchemy engines
# ---------------------------------------------------------------------------


@pytest.fixture
def sqlite_engine(tmp_path):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    engine = sqlalchemy.create_engine(
        f"sqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    yield engine
    engine.dispose()


def _capturing_logger(name):
    records = []

    class ListHandler(logging.Handler):
        def emit(self, record):
            records.append(record)

    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    logger.addHandler(ListHandler())
    logger.propagate = False
    return logger, records


def test_installer_no_op_for_non_sqlite_engine():
    class FakeDialect:
        name = "postgresql"

    class FakeEngine:
        dialect = FakeDialect()

    assert install_sqlite_io_recovery(FakeEngine()) is False


def test_installer_disabled_via_env(monkeypatch, sqlite_engine):
    monkeypatch.setenv("OWUI_SQLITE_IO_RECOVERY_ENABLED", "0")
    assert install_sqlite_io_recovery(sqlite_engine) is False


def test_empty_env_flag_keeps_recovery_enabled(monkeypatch, sqlite_engine):
    """An exported-but-empty variable must mean "use the default", not off."""
    monkeypatch.setenv("OWUI_SQLITE_IO_RECOVERY_ENABLED", "")
    assert install_sqlite_io_recovery(sqlite_engine) is True


def test_disk_io_error_invalidates_pool_and_engine_recovers(sqlite_engine):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text

    logger, records = _capturing_logger("test.sqlite_recovery.recovers")
    exit_calls = []
    assert (
        install_sqlite_io_recovery(
            sqlite_engine, logger=logger, exit_fn=exit_calls.append
        )
        is True
    )

    with mock.patch.object(
        sqlite_engine.dialect,
        "do_execute",
        side_effect=sqlite3.OperationalError("disk I/O error"),
    ):
        with pytest.raises(sqlalchemy.exc.OperationalError) as excinfo:
            with sqlite_engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        assert excinfo.value.connection_invalidated is True

    # Pool was invalidated, not broken: a fresh connection works immediately.
    with sqlite_engine.connect() as conn:
        assert conn.execute(text("SELECT 1")).scalar() == 1

    assert exit_calls == []  # single error never escalates
    assert any(
        "disk I/O error detected" in record.getMessage() for record in records
    )


def test_installer_is_idempotent(sqlite_engine):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text

    logger, records = _capturing_logger("test.sqlite_recovery.idempotent")
    assert install_sqlite_io_recovery(sqlite_engine, logger=logger) is True
    assert install_sqlite_io_recovery(sqlite_engine, logger=logger) is True

    with mock.patch.object(
        sqlite_engine.dialect,
        "do_execute",
        side_effect=sqlite3.OperationalError("disk I/O error"),
    ):
        with pytest.raises(sqlalchemy.exc.OperationalError):
            with sqlite_engine.connect() as conn:
                conn.execute(text("SELECT 1"))

    detections = [
        record
        for record in records
        if "disk I/O error detected" in record.getMessage()
    ]
    assert len(detections) == 1  # a duplicate listener would log twice


def test_persistent_errors_escalate_to_exit(sqlite_engine):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text

    clock = FakeClock()
    exit_calls = []
    assert (
        install_sqlite_io_recovery(
            sqlite_engine,
            logger=_capturing_logger("test.sqlite_recovery.escalates")[0],
            clock=clock,
            exit_fn=exit_calls.append,
        )
        is True
    )

    def trigger():
        with mock.patch.object(
            sqlite_engine.dialect,
            "do_execute",
            side_effect=sqlite3.OperationalError("disk I/O error"),
        ):
            with pytest.raises(sqlalchemy.exc.OperationalError):
                with sqlite_engine.connect() as conn:
                    conn.execute(text("SELECT 1"))

    trigger()  # t=0
    clock.now = 10
    trigger()
    assert exit_calls == []
    clock.now = 130
    trigger()  # count=3, age=130 >= 120
    assert exit_calls == [MODULE.EXIT_CODE]


def test_exit_kill_switch_prevents_escalation(monkeypatch, sqlite_engine):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text

    monkeypatch.setenv("OWUI_SQLITE_IO_RECOVERY_EXIT_ENABLED", "false")
    clock = FakeClock()
    exit_calls = []
    assert (
        install_sqlite_io_recovery(
            sqlite_engine,
            logger=_capturing_logger("test.sqlite_recovery.killswitch")[0],
            clock=clock,
            exit_fn=exit_calls.append,
        )
        is True
    )

    for now in (0, 10, 130, 200):
        clock.now = now
        with mock.patch.object(
            sqlite_engine.dialect,
            "do_execute",
            side_effect=sqlite3.OperationalError("disk I/O error"),
        ):
            with pytest.raises(sqlalchemy.exc.OperationalError):
                with sqlite_engine.connect() as conn:
                    conn.execute(text("SELECT 1"))

    assert exit_calls == []


# ---------------------------------------------------------------------------
# Bounded transaction diagnostics
# ---------------------------------------------------------------------------


@pytest.fixture
def diagnostic_engine(tmp_path):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text

    engine = sqlalchemy.create_engine(
        f"sqlite:///{tmp_path / 'diagnostics.db'}",
        connect_args={"check_same_thread": False, "timeout": 0.02},
    )
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE chat (id INTEGER, body TEXT)"))
    yield engine
    engine.dispose()


def _install_diagnostics(engine, **ledger_options):
    ledger = DIAGNOSTICS.DatabaseDiagnosticsLedger(**ledger_options)
    assert DIAGNOSTICS.install_database_diagnostics(engine, ledger=ledger) is True
    return ledger


def test_sql_templates_remove_inline_literals_comments_and_parameter_values():
    secret = "private-chat-secret@example.invalid"
    metadata = DIAGNOSTICS._redact_sql(
        f"UPDATE chat SET body = '{secret}', id = 918273 /* {secret} */ WHERE id = 7"
    )
    rendered = json.dumps(metadata)

    assert metadata["operation"] == "UPDATE"
    assert metadata["tables"] == ["chat"]
    assert metadata["sqlTemplate"] == "UPDATE chat SET body = ?, id = ? WHERE id = ?"
    assert secret not in rendered
    assert "918273" not in rendered


def test_unparseable_sql_fails_closed_to_structure_only():
    secret = "never-retain-this-inline-value"
    metadata = DIAGNOSTICS._redact_sql(f"UPDATE chat SET body = '{secret}")
    rendered = json.dumps(metadata)

    assert metadata["redaction"] == "structure_only"
    assert "sqlTemplate" not in metadata
    assert secret not in rendered


def test_request_context_owns_server_id_and_only_accepts_sanitized_client_id():
    with DIAGNOSTICS.database_request_context(
        "post", "/api/v1/chats/{id}"
    ) as first_server_id:
        context = DIAGNOSTICS._current_execution_context()["request"]
        assert context["serverRequestId"] == first_server_id
        assert context["route"] == "/api/v1/chats/{id}"
        assert context["method"] == "POST"
        assert "clientRequestId" not in context

    with DIAGNOSTICS.database_request_context(
        "get", "/api/v1/users/{id}"
    ) as second_server_id:
        context = DIAGNOSTICS._current_execution_context()["request"]
        assert "clientRequestId" not in context
        assert context["serverRequestId"] == second_server_id
        assert second_server_id != first_server_id

    assert DIAGNOSTICS._current_execution_context()["request"] is None


def test_transaction_lifecycle_and_connection_reuse_are_not_conflated(
    diagnostic_engine,
):
    from sqlalchemy import text

    ledger = _install_diagnostics(diagnostic_engine)
    with diagnostic_engine.connect() as connection:
        connection.execute(text("SELECT 1"))
        connection.commit()
    with diagnostic_engine.connect() as connection:
        connection.execute(text("SELECT 2"))
        connection.rollback()

    snapshot = ledger.snapshot()
    recent = snapshot["recentTransactions"]
    assert [transaction["state"] for transaction in recent] == [
        "committed",
        "rolled_back",
    ]
    assert recent[0]["connectionId"] == recent[1]["connectionId"]
    assert recent[1]["connectionGeneration"] > recent[0]["connectionGeneration"]
    assert recent[1]["transactionGeneration"] > recent[0]["transactionGeneration"]
    assert snapshot["activeTransactions"] == []


def test_first_write_survives_statement_ring_rotation_without_values(
    diagnostic_engine,
):
    from sqlalchemy import text

    ledger = _install_diagnostics(diagnostic_engine, statement_limit=2)
    connection = diagnostic_engine.connect()
    transaction = connection.begin()
    connection.execute(
        text("INSERT INTO chat (id, body) VALUES (:id, :body)"),
        {"id": 1, "body": "ring-rotation-secret"},
    )
    for value in (1, 2, 3):
        connection.execute(text("SELECT :value"), {"value": value})

    active = ledger.snapshot()["activeTransactions"][0]
    rendered = json.dumps(active)
    assert active["firstWrite"]["operation"] == "INSERT"
    assert active["firstWrite"]["status"] == "succeeded"
    assert len(active["recentStatements"]) == 2
    assert "ring-rotation-secret" not in rendered

    transaction.rollback()
    connection.close()


def test_cte_prefixed_write_is_preserved_as_first_write(diagnostic_engine):
    from sqlalchemy import text

    ledger = _install_diagnostics(diagnostic_engine)
    connection = diagnostic_engine.connect()
    transaction = connection.begin()
    connection.execute(
        text(
            "WITH seed(value) AS (SELECT :value) "
            "INSERT INTO chat (id, body) SELECT value, :body FROM seed"
        ),
        {"value": 9, "body": "cte-private-value"},
    )

    first_write = ledger.snapshot()["activeTransactions"][0]["firstWrite"]
    assert first_write["operation"] == "WITH"
    assert first_write["status"] == "succeeded"
    assert "cte-private-value" not in json.dumps(first_write)

    transaction.rollback()
    connection.close()


def test_recent_transaction_ring_is_bounded(diagnostic_engine):
    from sqlalchemy import text

    ledger = _install_diagnostics(diagnostic_engine, recent_limit=2)
    for value in (1, 2, 3):
        with diagnostic_engine.begin() as connection:
            connection.execute(text("SELECT :value"), {"value": value})

    snapshot = ledger.snapshot()
    assert len(snapshot["recentTransactions"]) == 2
    assert json.loads(json.dumps(snapshot))["schemaVersion"] == 1


def test_diagnostics_callback_failure_never_changes_query_behavior(diagnostic_engine):
    from sqlalchemy import text

    class ExplodingLedger(DIAGNOSTICS.DatabaseDiagnosticsLedger):
        def before_cursor_execute(self, *_args, **_kwargs):
            raise RuntimeError("diagnostic-only failure")

    ledger = ExplodingLedger()
    assert DIAGNOSTICS.install_database_diagnostics(
        diagnostic_engine, ledger=ledger
    ) is True
    with diagnostic_engine.connect() as connection:
        assert connection.execute(text("SELECT 42")).scalar() == 42


def test_failed_commit_remains_visible_as_lock_victim(diagnostic_engine):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text

    ledger = _install_diagnostics(diagnostic_engine)
    connection = diagnostic_engine.connect()
    transaction = connection.begin()
    connection.execute(
        text("INSERT INTO chat (id, body) VALUES (:id, :body)"),
        {"id": 10, "body": "commit-private-value"},
    )

    with mock.patch.object(
        diagnostic_engine.dialect,
        "do_commit",
        side_effect=sqlite3.OperationalError("database is locked"),
    ):
        with pytest.raises(sqlalchemy.exc.OperationalError):
            transaction.commit()

    snapshot = ledger.snapshot()
    assert snapshot["endingTransactions"][0]["state"] == "commit_failed"
    lock_event = snapshot["lockEvents"][0]
    assert lock_event["victim"]["state"] == "commit_failed"
    assert lock_event["victim"]["endAttempt"]["operation"] == "COMMIT"
    assert lock_event["victim"]["endAttempt"]["errorKind"] == "sqlite_busy"
    assert "commit-private-value" not in json.dumps(snapshot)
    connection.close()


def test_pool_dispose_and_detach_do_not_leave_stale_or_uninstrumented_records(
    diagnostic_engine,
):
    from sqlalchemy import text

    ledger = _install_diagnostics(diagnostic_engine)
    detached = diagnostic_engine.connect()
    detached.execute(text("SELECT 1"))
    detached.detach()
    detached.close()
    assert ledger.snapshot()["activeConnections"] == []

    diagnostic_engine.dispose()
    with diagnostic_engine.begin() as connection:
        connection.execute(text("SELECT 2"))

    snapshot = ledger.snapshot()
    assert snapshot["activeConnections"] == []
    assert any(
        transaction["recentStatements"][0]["sqlTemplate"] == "SELECT ?"
        for transaction in snapshot["recentTransactions"]
    )


def test_controlled_contention_identifies_holder_and_victim_without_secrets(
    diagnostic_engine,
):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy import text

    logger, records = _capturing_logger("test.db_diagnostics.contention")
    ledger = _install_diagnostics(diagnostic_engine, logger=logger)
    holder = diagnostic_engine.connect()
    holder_transaction = holder.begin()
    holder.execute(
        text("INSERT INTO chat (id, body) VALUES (:id, :body)"),
        {"id": 1, "body": "holder-private-value"},
    )
    victim = diagnostic_engine.connect()

    with pytest.raises(sqlalchemy.exc.OperationalError):
        victim.execute(
            text("INSERT INTO chat (id, body) VALUES (:id, :body)"),
            {"id": 2, "body": "victim-private-value"},
        )

    snapshot = ledger.snapshot()
    assert len(snapshot["lockEvents"]) == 1
    lock_event = snapshot["lockEvents"][0]
    assert lock_event["victim"]["currentStatement"]["errorKind"] == "sqlite_busy"
    holder_id = snapshot["activeTransactions"][0]["transactionId"]
    assert any(
        candidate["transactionId"] == holder_id
        and candidate["dbapiInTransaction"] is True
        for candidate in lock_event["activeWriterCandidates"]
    )
    assert all(
        candidate["transactionId"] != lock_event["victim"]["transactionId"]
        for candidate in lock_event["activeWriterCandidates"]
    )
    rendered = json.dumps(snapshot)
    assert "holder-private-value" not in rendered
    assert "victim-private-value" not in rendered
    assert "INSERT INTO chat (id, body) VALUES (?, ?)" in rendered
    assert records == []

    victim.close()
    holder_transaction.rollback()
    holder.close()


def test_database_diagnostics_installer_is_idempotent(diagnostic_engine):
    from sqlalchemy import text

    ledger = _install_diagnostics(diagnostic_engine)
    assert DIAGNOSTICS.install_database_diagnostics(
        diagnostic_engine, ledger=ledger
    ) is True
    with diagnostic_engine.begin() as connection:
        connection.execute(text("SELECT 1"))
    assert len(ledger.snapshot()["recentTransactions"]) == 1


# ---------------------------------------------------------------------------
# Source contracts
# ---------------------------------------------------------------------------


def test_main_py_installs_recovery_hook_after_engine_import():
    source = MAIN_PATH.read_text()
    engine_import = source.index("from open_webui.internal.db import Session, engine")
    hook = source.index("install_sqlite_io_recovery(engine)")
    assert hook > engine_import
    # Installer failures must never block startup.
    guarded_region = source[engine_import:hook]
    assert "try:" in guarded_region


def test_main_installs_database_diagnostics_and_request_correlation_after_engine():
    source = MAIN_PATH.read_text()
    engine_import = source.index("from open_webui.internal.db import Session, engine")
    installer = source.index("install_database_diagnostics(engine)")
    middleware = source.index("async def correlate_database_transactions")
    assert engine_import < installer < middleware
    assert "resolve_request_route_template(request)" in source[middleware:]
    assert "X-PORTICO-Client-Request-ID" not in source[middleware:]


def test_database_diagnostics_endpoint_authenticates_before_memory_snapshot():
    source = AUTH_BRIDGE_PATH.read_text()
    main_source = MAIN_PATH.read_text()
    endpoint = source.index("async def get_database_diagnostics(request: Request):")
    guard = source.index("_require_bridge_secret(request)", endpoint)
    snapshot = source.index("get_database_diagnostics_snapshot()", endpoint)
    next_route = source.index("@router.post", endpoint)
    assert endpoint < guard < snapshot < next_route
    assert "Session" not in source[endpoint:next_route]
    assert "get_db" not in source[endpoint:next_route]
    commit_middleware = main_source.index("async def commit_session_after_request")
    next_middleware = main_source.index(
        '@app.middleware("http")', commit_middleware + 1
    )
    assert (
        'request.url.path == "/api/v1/portico/auth/diagnostics/database"'
        in main_source[commit_middleware:next_middleware]
    )


def _compose_service_block(source, service_key):
    lines = source.splitlines()
    start = lines.index(f"  {service_key}:")
    block = []
    for line in lines[start + 1 :]:
        if line and not line.startswith("    ") and line.strip():
            break
        block.append(line)
    return "\n".join(block)


def test_open_webui_service_keeps_restart_policy():
    """The os._exit escalation relies on Docker restarting the container."""
    block = _compose_service_block(COMPOSE_PATH.read_text(), "open-webui")
    assert "restart: unless-stopped" in block


def test_patch_entrypoint_still_execs_start_sh():
    """The escalation also relies on uvicorn being the tail process of the
    container entrypoint chain."""
    source = ENTRYPOINT_PATH.read_text()
    assert "exec bash /app/backend/start.sh" in source
