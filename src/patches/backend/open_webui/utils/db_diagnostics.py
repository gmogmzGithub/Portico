"""Bounded, value-free diagnostics for Open WebUI's SQLAlchemy engine.

The ledger is deliberately observational: listeners never change connection,
transaction, retry, or error behavior.  SQL parameter values, request bodies,
headers, query strings, and Python locals are never retained.
"""

import asyncio
import contextvars
import datetime
import hashlib
import logging
import os
import re
import threading
import time
import traceback
import weakref
from collections import OrderedDict, deque
from contextlib import contextmanager


_log = logging.getLogger("open_webui.utils.db_diagnostics")

_request_context = contextvars.ContextVar("portico_db_diagnostics_request", default=None)
_install_lock = threading.Lock()
_installed_engines = weakref.WeakSet()

_SAFE_CONTEXT_TEXT = re.compile(r"[^A-Za-z0-9 ./_:{}/-]+")
_TABLE_PATTERN = re.compile(
    r"\b(?:from|join|update|into|delete\s+from)\s+([A-Za-z_][A-Za-z0-9_$]*)",
    re.IGNORECASE,
)
_WRITE_OPERATIONS = {
    "ALTER",
    "ATTACH",
    "CREATE",
    "DELETE",
    "DETACH",
    "DROP",
    "INSERT",
    "REINDEX",
    "REPLACE",
    "UPDATE",
    "VACUUM",
}


def _utc_iso(timestamp):
    return (
        datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _safe_context_text(value, fallback, max_length=160):
    normalized = _SAFE_CONTEXT_TEXT.sub("_", str(value or "").strip())
    return normalized[:max_length] or fallback


def _current_execution_context():
    request = _request_context.get()
    try:
        task = asyncio.current_task()
        task_name = task.get_name() if task is not None else None
    except RuntimeError:
        task_name = None
    return {
        "request": dict(request) if isinstance(request, dict) else None,
        "thread": _safe_context_text(
            threading.current_thread().name, "unnamed-thread", 96
        ),
        "task": _safe_context_text(task_name, "no-async-task", 96),
    }


def _application_call_site():
    """Return one application frame without source text or local variables."""
    try:
        frames = traceback.extract_stack(limit=40)
    except Exception:
        return None
    for frame in reversed(frames[:-1]):
        filename = str(frame.filename or "").replace("\\", "/")
        marker = "/open_webui/"
        marker_index = filename.rfind(marker)
        if marker_index < 0:
            continue
        relative = filename[marker_index + 1 :]
        if relative.endswith("utils/db_diagnostics.py"):
            continue
        function = _safe_context_text(frame.name, "unknown", 80)
        return f"{relative}:{int(frame.lineno)}:{function}"
    return None


def resolve_request_route_template(request):
    """Resolve a Starlette route template without retaining the raw URL path."""
    try:
        for route in request.app.routes:
            match, _ = route.matches(request.scope)
            if getattr(match, "name", "") != "FULL":
                continue
            template = getattr(route, "path", None)
            if template:
                return _safe_context_text(template, "<matched>", 240)
    except Exception:
        pass
    return "<unmatched>"


@contextmanager
def database_request_context(method, route_template):
    """Attach a server-owned request ID to SQL executed in this context."""
    server_request_id = hashlib.sha256(os.urandom(24)).hexdigest()[:24]
    context = {
        "serverRequestId": server_request_id,
        "method": _safe_context_text(str(method or "").upper(), "UNKNOWN", 16),
        "route": _safe_context_text(route_template, "<unmatched>", 240),
        "startedAt": _utc_iso(time.time()),
    }
    token = _request_context.set(context)
    try:
        yield server_request_id
    finally:
        _request_context.reset(token)


def _parameter_category(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "text"
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "bytes"
    if isinstance(value, dict):
        return "mapping"
    if isinstance(value, (list, tuple)):
        return "sequence"
    return "other"


def _parameter_shape(parameters, executemany=False):
    """Describe parameter containers without retaining names, lengths, or values."""
    try:
        if executemany and isinstance(parameters, (list, tuple)):
            sample = parameters[0] if parameters else None
            return {
                "kind": "executemany",
                "batchCount": len(parameters),
                "row": _parameter_shape(sample, False),
            }
        if isinstance(parameters, dict):
            categories = {}
            for value in parameters.values():
                category = _parameter_category(value)
                categories[category] = categories.get(category, 0) + 1
            return {
                "kind": "mapping",
                "count": len(parameters),
                "types": categories,
            }
        if isinstance(parameters, (list, tuple)):
            categories = {}
            for value in parameters:
                category = _parameter_category(value)
                categories[category] = categories.get(category, 0) + 1
            return {
                "kind": "sequence",
                "count": len(parameters),
                "types": categories,
            }
        return {
            "kind": _parameter_category(parameters),
            "count": 0 if parameters is None else 1,
        }
    except Exception:
        return {"kind": "unavailable"}


def _redact_sql(statement):
    """Replace SQL literals/comments while preserving useful query structure."""
    source = str(statement or "")
    output = []
    index = 0
    reliable = True
    length = len(source)

    while index < length:
        char = source[index]
        following = source[index + 1] if index + 1 < length else ""

        if char == "-" and following == "-":
            index += 2
            while index < length and source[index] not in "\r\n":
                index += 1
            output.append(" ")
            continue
        if char == "/" and following == "*":
            end = source.find("*/", index + 2)
            if end < 0:
                reliable = False
                break
            index = end + 2
            output.append(" ")
            continue
        if char == "'":
            output.append("?")
            index += 1
            closed = False
            while index < length:
                if source[index] == "'":
                    if index + 1 < length and source[index + 1] == "'":
                        index += 2
                        continue
                    index += 1
                    closed = True
                    break
                index += 1
            if not closed:
                reliable = False
                break
            continue
        if char in ('"', "`", "["):
            closing = "]" if char == "[" else char
            output.append("<identifier>")
            index += 1
            closed = False
            while index < length:
                if source[index] == closing:
                    if (
                        closing != "]"
                        and index + 1 < length
                        and source[index + 1] == closing
                    ):
                        index += 2
                        continue
                    index += 1
                    closed = True
                    break
                index += 1
            if not closed:
                reliable = False
                break
            continue
        if char.isdigit() and (
            index == 0 or not (source[index - 1].isalnum() or source[index - 1] in "_$")
        ):
            output.append("?")
            index += 1
            while index < length and (
                source[index].isalnum() or source[index] in ".xX_+-"
            ):
                index += 1
            continue

        output.append(char)
        index += 1

    normalized = " ".join("".join(output).split())
    operation_match = re.match(r"^([A-Za-z]+)", normalized)
    operation = operation_match.group(1).upper() if operation_match else "UNKNOWN"
    tables = sorted({match.lower() for match in _TABLE_PATTERN.findall(normalized)})[
        :12
    ]
    if reliable:
        fingerprint_source = normalized.lower()
        template = normalized[:4096]
        redaction = "literals_removed"
    else:
        raw_digest = hashlib.sha256(source.encode("utf-8", "replace")).hexdigest()
        fingerprint_source = f"{operation}|{','.join(tables)}|{raw_digest}"
        template = None
        redaction = "structure_only"
    result = {
        "operation": operation,
        "tables": tables,
        "fingerprint": hashlib.sha256(
            fingerprint_source.encode("utf-8", "replace")
        ).hexdigest()[:24],
        "redaction": redaction,
    }
    if template is not None:
        result["sqlTemplate"] = template
        result["templateTruncated"] = len(normalized) > 4096
    return result


def _is_write_statement(metadata, execution_context=None):
    if execution_context is not None and any(
        bool(getattr(execution_context, attribute, False))
        for attribute in ("isinsert", "isupdate", "isdelete")
    ):
        return True
    operation = metadata.get("operation")
    if operation in _WRITE_OPERATIONS:
        return True
    if operation == "WITH" and re.search(
        r"\b(?:INSERT|UPDATE|DELETE|REPLACE)\b",
        metadata.get("sqlTemplate", ""),
        re.IGNORECASE,
    ):
        return True
    return operation == "PRAGMA" and "=" in metadata.get("sqlTemplate", "")


def _is_sqlite_lock_error(exception, max_depth=8):
    node = exception
    seen = set()
    for _ in range(max_depth):
        if node is None or id(node) in seen:
            break
        seen.add(id(node))
        node_type = type(node)
        message = str(node).strip().lower()
        if (
            node_type.__name__ == "OperationalError"
            and getattr(node_type, "__module__", "") == "sqlite3"
            and (
                message.startswith("database is locked")
                or message.startswith("database table is locked")
            )
        ):
            return True
        node = getattr(node, "orig", None)
    return False


class DatabaseDiagnosticsLedger:
    def __init__(
        self,
        recent_limit=250,
        recent_ttl_seconds=600,
        lock_event_limit=100,
        statement_limit=20,
        clock=time.monotonic,
        wall_clock=time.time,
        logger=None,
    ):
        self.recent_limit = max(1, int(recent_limit))
        self.recent_ttl_seconds = max(1.0, float(recent_ttl_seconds))
        self.lock_event_limit = max(1, int(lock_event_limit))
        self.statement_limit = max(1, int(statement_limit))
        self._clock = clock
        self._wall_clock = wall_clock
        self._log = logger or _log
        self._lock = threading.RLock()
        self._active_connections = {}
        self._active_transactions = {}
        self._ending_transactions = {}
        self._fallback_record_state = weakref.WeakKeyDictionary()
        self._recent_transactions = deque(maxlen=self.recent_limit)
        self._lock_events = deque(maxlen=self.lock_event_limit)
        self._statement_cache = OrderedDict()
        self._counter = 0
        self._installed = False
        self._last_internal_failure = {}
        self._listeners = []

    def _next_id(self, prefix):
        self._counter += 1
        return f"{prefix}-{os.getpid()}-{self._counter}"

    def _report_internal_failure(self, event_name, exception):
        now = self._clock()
        with self._lock:
            previous = self._last_internal_failure.get(event_name, 0.0)
            if now - previous < 60.0:
                return
            self._last_internal_failure[event_name] = now
        try:
            self._log.error(
                "Database diagnostics callback failed (event=%s error_type=%s)",
                event_name,
                type(exception).__name__,
            )
        except Exception:
            pass

    def guarded(self, event_name, callback):
        def listener(*args, **kwargs):
            try:
                return callback(*args, **kwargs)
            except Exception as exception:
                self._report_internal_failure(event_name, exception)
                return None

        return listener

    def mark_installed(self):
        with self._lock:
            self._installed = True

    def _record_for_connection(self, connection):
        fairy = getattr(connection, "connection", None)
        return getattr(fairy, "_connection_record", None)

    def _ensure_record_state(self, connection_record):
        if connection_record is None:
            return {
                "recordToken": self._next_id("untracked-record"),
                "connectionId": self._next_id("connection"),
                "connectionGeneration": 0,
                "transactionGeneration": 0,
            }
        record_info = getattr(connection_record, "record_info", None)
        if isinstance(record_info, dict):
            state = record_info.get("porticoDatabaseDiagnostics")
        else:
            state = self._fallback_record_state.get(connection_record)
        if state is None:
            state = {
                "recordToken": self._next_id("record"),
                "connectionId": self._next_id("connection"),
                "connectionGeneration": 0,
                "transactionGeneration": 0,
            }
            if isinstance(record_info, dict):
                record_info["porticoDatabaseDiagnostics"] = state
            else:
                self._fallback_record_state[connection_record] = state
        return state

    def checkout(self, _dbapi_connection, connection_record, _connection_proxy):
        now = self._clock()
        wall = self._wall_clock()
        execution = _current_execution_context()
        with self._lock:
            state = self._ensure_record_state(connection_record)
            state["connectionGeneration"] += 1
            self._active_connections[state["recordToken"]] = {
                "connectionId": state["connectionId"],
                "connectionGeneration": state["connectionGeneration"],
                "checkedOutAt": _utc_iso(wall),
                "_checked_out_monotonic": now,
                **execution,
            }

    def _dbapi_in_transaction(self, connection):
        try:
            fairy = getattr(connection, "connection", None)
            driver = getattr(fairy, "driver_connection", None)
            if driver is None:
                driver = getattr(fairy, "connection", None)
            value = getattr(driver, "in_transaction", None)
            return bool(value) if value is not None else None
        except Exception:
            return None

    def begin(self, connection):
        now = self._clock()
        wall = self._wall_clock()
        connection_key = id(connection)
        connection_record = self._record_for_connection(connection)
        execution = _current_execution_context()
        if execution["request"] is None:
            execution["origin"] = _application_call_site()
        with self._lock:
            self._finalize_ending_transaction(connection_key, now, wall)
            state = self._ensure_record_state(connection_record)
            state["transactionGeneration"] += 1
            checkout = self._active_connections.get(state["recordToken"])
            self._active_transactions[connection_key] = {
                "transactionId": self._next_id("transaction"),
                "transactionGeneration": state["transactionGeneration"],
                "connectionId": state["connectionId"],
                "connectionGeneration": state["connectionGeneration"],
                "state": "active",
                "beganAt": _utc_iso(wall),
                "_began_monotonic": now,
                "checkedOutAt": checkout.get("checkedOutAt") if checkout else None,
                "_checked_out_monotonic": (
                    checkout.get("_checked_out_monotonic") if checkout else now
                ),
                "_record_token": state["recordToken"],
                "request": execution["request"],
                "thread": execution["thread"],
                "task": execution["task"],
                "origin": execution.get("origin"),
                "dbapiInTransaction": self._dbapi_in_transaction(connection),
                "firstWrite": None,
                "currentStatement": None,
                "recentStatements": deque(maxlen=self.statement_limit),
                "_statement_sequence": 0,
            }

    def _statement_metadata(self, statement):
        cache_key = hashlib.sha256(
            str(statement or "").encode("utf-8", "replace")
        ).digest()
        with self._lock:
            cached = self._statement_cache.get(cache_key)
            if cached is not None:
                self._statement_cache.move_to_end(cache_key)
                return dict(cached)
        metadata = _redact_sql(statement)
        with self._lock:
            self._statement_cache[cache_key] = dict(metadata)
            self._statement_cache.move_to_end(cache_key)
            while len(self._statement_cache) > 512:
                self._statement_cache.popitem(last=False)
        return metadata

    def before_cursor_execute(
        self, connection, _cursor, statement, parameters, execution_context, executemany
    ):
        now = self._clock()
        wall = self._wall_clock()
        metadata = self._statement_metadata(statement)
        connection_key = id(connection)
        with self._lock:
            transaction = self._active_transactions.get(connection_key)
            if transaction is None:
                return
            transaction["_statement_sequence"] += 1
            entry = {
                "sequence": transaction["_statement_sequence"],
                "startedAt": _utc_iso(wall),
                "status": "running",
                "parameterShape": _parameter_shape(parameters, executemany),
                "_started_monotonic": now,
                **metadata,
            }
            if (
                _is_write_statement(metadata, execution_context)
                and transaction["firstWrite"] is None
            ):
                entry["callSite"] = _application_call_site()
                # Keep a distinct reference even after the bounded statement
                # deque rotates; completion/error updates should still be
                # reflected in this first-write record.
                transaction["firstWrite"] = entry
            transaction["currentStatement"] = entry
            transaction["recentStatements"].append(entry)
            transaction["dbapiInTransaction"] = self._dbapi_in_transaction(connection)

    def after_cursor_execute(
        self, connection, _cursor, _statement, _parameters, _context, _executemany
    ):
        now = self._clock()
        with self._lock:
            transaction = self._active_transactions.get(id(connection))
            if transaction is None:
                return
            current = transaction.get("currentStatement")
            if current is not None:
                current["status"] = "succeeded"
                current["durationMs"] = round(
                    max(0.0, now - current["_started_monotonic"]) * 1000, 3
                )
            transaction["currentStatement"] = None
            transaction["dbapiInTransaction"] = self._dbapi_in_transaction(connection)

    def _serialize_statement(self, statement, now):
        if statement is None:
            return None
        result = {
            key: value for key, value in statement.items() if not key.startswith("_")
        }
        if statement.get("status") == "running":
            result["durationMs"] = round(
                max(0.0, now - statement["_started_monotonic"]) * 1000, 3
            )
        return result

    def _serialize_end_attempt(self, end_attempt, now):
        if end_attempt is None:
            return None
        result = {
            key: value for key, value in end_attempt.items() if not key.startswith("_")
        }
        if end_attempt.get("status") == "running":
            result["durationMs"] = round(
                max(0.0, now - end_attempt["_started_monotonic"]) * 1000, 3
            )
        return result

    def _serialize_transaction(self, transaction, now, active=True):
        result = {
            key: transaction.get(key)
            for key in (
                "transactionId",
                "transactionGeneration",
                "connectionId",
                "connectionGeneration",
                "state",
                "checkedOutAt",
                "beganAt",
                "endedAt",
                "request",
                "thread",
                "task",
                "origin",
                "dbapiInTransaction",
            )
            if transaction.get(key) is not None
        }
        result["checkoutAgeMs"] = round(
            max(0.0, now - transaction["_checked_out_monotonic"]) * 1000, 3
        )
        if active:
            result["transactionAgeMs"] = round(
                max(0.0, now - transaction["_began_monotonic"]) * 1000, 3
            )
        else:
            result["durationMs"] = round(
                max(
                    0.0,
                    transaction["_ended_monotonic"] - transaction["_began_monotonic"],
                )
                * 1000,
                3,
            )
        result["firstWrite"] = self._serialize_statement(
            transaction.get("firstWrite"), now
        )
        result["currentStatement"] = self._serialize_statement(
            transaction.get("currentStatement"), now
        )
        result["endAttempt"] = self._serialize_end_attempt(
            transaction.get("endAttempt"), now
        )
        result["recentStatements"] = [
            self._serialize_statement(statement, now)
            for statement in transaction["recentStatements"]
        ]
        return result

    def handle_error(self, context):
        connection = getattr(context, "connection", None)
        original = getattr(context, "original_exception", None)
        if connection is None:
            return
        now = self._clock()
        wall = self._wall_clock()
        is_lock = _is_sqlite_lock_error(original)
        snapshot = None
        with self._lock:
            connection_key = id(connection)
            transaction = self._active_transactions.get(connection_key)
            if transaction is None:
                transaction = self._ending_transactions.get(connection_key)
            current = transaction.get("currentStatement") if transaction else None
            if current is not None:
                current["status"] = "failed"
                current["errorKind"] = "sqlite_busy" if is_lock else "database_error"
                current["durationMs"] = round(
                    max(0.0, now - current["_started_monotonic"]) * 1000, 3
                )
                current["callSite"] = (
                    current.get("callSite") or _application_call_site()
                )
            end_attempt = transaction.get("endAttempt") if transaction else None
            if end_attempt is not None and end_attempt.get("status") == "running":
                end_attempt["status"] = "failed"
                end_attempt["errorKind"] = (
                    "sqlite_busy" if is_lock else "database_error"
                )
                end_attempt["durationMs"] = round(
                    max(0.0, now - end_attempt["_started_monotonic"]) * 1000,
                    3,
                )
                operation = end_attempt.get("operation", "END").lower()
                transaction["state"] = f"{operation}_failed"
            if not is_lock:
                return

            live_transactions = list(self._active_transactions.values()) + list(
                self._ending_transactions.values()
            )
            active = [
                self._serialize_transaction(item, now, active=True)
                for item in live_transactions
            ]
            victim_id = transaction.get("transactionId") if transaction else None
            writers = [
                item
                for item in active
                if item.get("transactionId") != victim_id
                and (item.get("firstWrite") or {}).get("status") == "succeeded"
                and item.get("dbapiInTransaction") is True
            ]
            snapshot = {
                "schemaVersion": 1,
                "event": "sqlite_lock_error",
                "lockEventId": self._next_id("lock"),
                "capturedAt": _utc_iso(wall),
                "victim": (
                    self._serialize_transaction(transaction, now, active=True)
                    if transaction
                    else None
                ),
                "activeTransactions": active,
                "activeWriterCandidates": writers,
            }
            self._lock_events.append(snapshot)

    def _attempt_end_transaction(self, connection, operation):
        now = self._clock()
        wall = self._wall_clock()
        with self._lock:
            connection_key = id(connection)
            if connection_key in self._ending_transactions:
                return
            transaction = self._active_transactions.pop(connection_key, None)
            if transaction is None:
                return
            current = transaction.get("currentStatement")
            if current is not None and current.get("status") == "running":
                current["status"] = "interrupted"
                current["durationMs"] = round(
                    max(0.0, now - current["_started_monotonic"]) * 1000, 3
                )
            transaction["currentStatement"] = None
            transaction["state"] = f"{operation.lower()}_attempted"
            transaction["endAttempt"] = {
                "operation": operation,
                "startedAt": _utc_iso(wall),
                "status": "running",
                "_started_monotonic": now,
            }
            transaction["dbapiInTransaction"] = self._dbapi_in_transaction(connection)
            self._ending_transactions[connection_key] = transaction

    def commit(self, connection):
        self._attempt_end_transaction(connection, "COMMIT")

    def rollback(self, connection):
        self._attempt_end_transaction(connection, "ROLLBACK")

    def _finalize_ending_transaction(
        self, connection_key, now, wall, fallback_state=None
    ):
        transaction = self._ending_transactions.pop(connection_key, None)
        if transaction is None:
            return
        end_attempt = transaction.get("endAttempt")
        if end_attempt is not None and end_attempt.get("status") == "running":
            end_attempt["status"] = "succeeded"
            end_attempt["durationMs"] = round(
                max(0.0, now - end_attempt["_started_monotonic"]) * 1000, 3
            )
            operation = end_attempt.get("operation")
            transaction["state"] = (
                "committed" if operation == "COMMIT" else "rolled_back"
            )
        elif fallback_state and not str(transaction.get("state", "")).endswith(
            "_failed"
        ):
            transaction["state"] = fallback_state
        transaction["endedAt"] = _utc_iso(wall)
        transaction["_ended_monotonic"] = now
        self._recent_transactions.append(transaction)

    def _finish_record_transactions(self, connection_record, state):
        now = self._clock()
        wall = self._wall_clock()
        with self._lock:
            record_state = self._ensure_record_state(connection_record)
            record_token = record_state["recordToken"]
            ending_keys = [
                key
                for key, transaction in self._ending_transactions.items()
                if transaction.get("_record_token") == record_token
            ]
            for key in ending_keys:
                self._finalize_ending_transaction(key, now, wall, state)
            matching = [
                key
                for key, transaction in self._active_transactions.items()
                if transaction.get("_record_token") == record_token
            ]
            for key in matching:
                transaction = self._active_transactions.pop(key)
                transaction["currentStatement"] = None
                transaction["state"] = state
                transaction["endedAt"] = _utc_iso(wall)
                transaction["_ended_monotonic"] = now
                self._recent_transactions.append(transaction)
            self._active_connections.pop(record_token, None)
            self._prune_recent(now)

    def checkin(self, _dbapi_connection, connection_record):
        self._finish_record_transactions(connection_record, "checked_in_without_end")

    def invalidate(self, _dbapi_connection, connection_record, _exception):
        self._finish_record_transactions(connection_record, "invalidated")

    def detach(self, _dbapi_connection, connection_record):
        self._finish_record_transactions(connection_record, "detached")

    def _prune_recent(self, now):
        while self._recent_transactions:
            ended = self._recent_transactions[0].get("_ended_monotonic", now)
            if now - ended <= self.recent_ttl_seconds:
                break
            self._recent_transactions.popleft()

    def snapshot(self):
        now = self._clock()
        wall = self._wall_clock()
        with self._lock:
            self._prune_recent(now)
            active_connections = []
            for connection in self._active_connections.values():
                item = {
                    key: value
                    for key, value in connection.items()
                    if not key.startswith("_")
                }
                item["checkoutAgeMs"] = round(
                    max(0.0, now - connection["_checked_out_monotonic"]) * 1000, 3
                )
                active_connections.append(item)
            return {
                "schemaVersion": 1,
                "generatedAt": _utc_iso(wall),
                "installed": self._installed,
                "process": {"pid": os.getpid()},
                "limits": {
                    "recentTransactions": self.recent_limit,
                    "recentTransactionTtlSeconds": self.recent_ttl_seconds,
                    "lockEvents": self.lock_event_limit,
                    "statementsPerTransaction": self.statement_limit,
                },
                "coverage": {
                    "sqlalchemyEngine": True,
                    "directSqliteConnections": False,
                    "otherProcesses": False,
                    "filesystemLockAnomalies": False,
                },
                "activeConnections": active_connections,
                "activeTransactions": [
                    self._serialize_transaction(transaction, now, active=True)
                    for transaction in self._active_transactions.values()
                ],
                "endingTransactions": [
                    self._serialize_transaction(transaction, now, active=True)
                    for transaction in self._ending_transactions.values()
                ],
                "recentTransactions": [
                    self._serialize_transaction(transaction, now, active=False)
                    for transaction in self._recent_transactions
                ],
                "lockEvents": list(self._lock_events),
            }


_ledger = DatabaseDiagnosticsLedger()


def install_database_diagnostics(engine, ledger=None, logger=None):
    """Install idempotent SQLAlchemy listeners on one SQLite engine."""
    target_ledger = ledger or _ledger
    dialect_name = getattr(getattr(engine, "dialect", None), "name", None)
    if dialect_name != "sqlite":
        return False

    with _install_lock:
        if engine in _installed_engines:
            return True
        from sqlalchemy import event

        listeners = (
            (engine, "checkout", target_ledger.checkout),
            (engine, "checkin", target_ledger.checkin),
            (engine, "invalidate", target_ledger.invalidate),
            (engine, "detach", target_ledger.detach),
            (engine, "begin", target_ledger.begin),
            (engine, "commit", target_ledger.commit),
            (engine, "rollback", target_ledger.rollback),
            (engine, "before_cursor_execute", target_ledger.before_cursor_execute),
            (engine, "after_cursor_execute", target_ledger.after_cursor_execute),
            (engine, "handle_error", target_ledger.handle_error),
        )
        installed = []
        try:
            for target, name, callback in listeners:
                listener = target_ledger.guarded(name, callback)
                event.listen(target, name, listener)
                installed.append((target, name, listener))
        except Exception:
            for target, name, listener in reversed(installed):
                try:
                    event.remove(target, name, listener)
                except Exception:
                    pass
            raise
        target_ledger._listeners.extend(installed)
        target_ledger.mark_installed()
        _installed_engines.add(engine)

    (logger or _log).info("Bounded SQLite transaction diagnostics installed")
    return True


def get_database_diagnostics_snapshot():
    """Return only the pre-redacted in-memory ledger; never queries SQLite."""
    return _ledger.snapshot()
