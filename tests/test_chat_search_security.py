"""Regression tests for the chat_search ReDoS hardening.

These cover the contract described in docs/security-hardening-overview.md
under N-001 (and re-asserted by the slack-oauth merge audit finding F4):

1. Pathological regex patterns (nested quantifiers, multiple unbounded gaps)
   are rejected **before** any DB query runs.
2. When a regex is accepted and contains literals, the query path emits
   ``instr(...)`` literal pre-filters so SQLite narrows the candidate set.
   Patterns without literals are allowed but capped by ``_REGEX_EVAL_BUDGET``.
"""

from pathlib import Path
import importlib.util
import sys
import types

import pytest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "chat_search.py"
)


# ---------------------------------------------------------------------------
# SQLAlchemy Connection / Result stubs. The production code calls
# ``conn.execute(...).mappings().all()`` so we mimic that surface exactly.
# ---------------------------------------------------------------------------


class FakeMappings:
    def __init__(self, rows):
        self.rows = list(rows)

    def all(self):
        return list(self.rows)


class FakeResult:
    def __init__(self, rows):
        self.rows = list(rows)

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def mappings(self):
        return FakeMappings(self.rows)


class FakeConnection:
    def __init__(self, engine):
        self.engine = engine

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, statement, params=None):
        sql_text = str(getattr(statement, "text", statement))
        self.engine.executed.append((sql_text, dict(params or {})))
        return FakeResult(self.engine.rows)

    def commit(self):
        return None


class FakeEngine:
    def __init__(self, rows):
        self.rows = list(rows)
        self.executed = []

    def connect(self):
        return FakeConnection(self)

    def executed_queries(self) -> list[tuple[str, dict]]:
        """Return SELECT/INSERT/etc. queries, excluding setup PRAGMAs.

        ``_configure_sqlite_connection`` runs ``PRAGMA busy_timeout`` on every
        connection; filtering those out lets tests assert on the substantive
        query count without coupling to SQLite-housekeeping details.
        """
        return [
            (sql, params)
            for sql, params in self.executed
            if not sql.strip().upper().startswith("PRAGMA ")
        ]


class _SqlTextStub:
    def __init__(self, sql):
        self.text = sql

    def __str__(self):
        return self.text

    def bindparams(self, *args, **kwargs):
        return self


class _BindParamStub:
    def __init__(self, name, **kwargs):
        self.name = name
        self.kwargs = dict(kwargs)


def _install_sqlalchemy_stub_if_needed(monkeypatch):
    try:
        has_sqlalchemy = importlib.util.find_spec("sqlalchemy") is not None
    except (ImportError, ValueError):
        has_sqlalchemy = False

    if has_sqlalchemy:
        return

    sqlalchemy_module = types.ModuleType("sqlalchemy")
    sqlalchemy_module.text = lambda sql: _SqlTextStub(sql)
    sqlalchemy_module.bindparam = lambda name, **kwargs: _BindParamStub(
        name, **kwargs
    )
    monkeypatch.setitem(sys.modules, "sqlalchemy", sqlalchemy_module)


# ---------------------------------------------------------------------------
# Minimal stand-ins for the Open WebUI chat table metadata the module reads
# via SQLAlchemy reflection. We advertise a "chat" table with the columns the
# module expects (id, user_id, chat, title, updated_at) so the DDL generators
# build a realistic JOIN.
# ---------------------------------------------------------------------------


class _FakeColumnCollection:
    def __init__(self, names):
        self._names = list(names)

    def keys(self):
        return list(self._names)


class _FakeTable:
    def __init__(self, name, column_names):
        self.name = name
        self.columns = _FakeColumnCollection(column_names)


class _FakeChatsModel:
    __table__ = _FakeTable(
        "chat", ["id", "user_id", "chat", "title", "model_id", "updated_at"]
    )


def load_chat_search_module(monkeypatch, engine):
    _install_sqlalchemy_stub_if_needed(monkeypatch)

    open_webui_module = types.ModuleType("open_webui")
    internal_module = types.ModuleType("open_webui.internal")
    db_module = types.ModuleType("open_webui.internal.db")
    models_module = types.ModuleType("open_webui.models")
    chats_module = types.ModuleType("open_webui.models.chats")

    db_module.engine = engine
    chats_module.Chats = _FakeChatsModel

    open_webui_module.internal = internal_module
    open_webui_module.models = models_module
    internal_module.db = db_module
    models_module.chats = chats_module

    monkeypatch.setitem(sys.modules, "open_webui", open_webui_module)
    monkeypatch.setitem(sys.modules, "open_webui.internal", internal_module)
    monkeypatch.setitem(sys.modules, "open_webui.internal.db", db_module)
    monkeypatch.setitem(sys.modules, "open_webui.models", models_module)
    monkeypatch.setitem(sys.modules, "open_webui.models.chats", chats_module)

    spec = importlib.util.spec_from_file_location(
        "chat_search_security_test", MODULE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    module.ensure_search_populated = lambda: None
    module._search_populated = True
    ready_status = {
        "state": "ready",
        "partial": False,
        "indexed_chats": 0,
        "total_chats": 0,
        "indexed_messages": 0,
        "last_error": None,
    }
    module.start_background_indexing_if_needed = lambda: dict(ready_status)
    module.get_index_status = lambda: dict(ready_status)
    # Bypass the SQLAlchemy reflection walk — point the table cache directly
    # at the fake table so _get_chat_table_details returns deterministic
    # column metadata.
    module._chat_table_cache = _FakeChatsModel.__table__
    return module


def _candidate_row(
    *,
    chat_id: str,
    body_content: str,
    title: str = "Security Test Chat",
    model_id: str | None = None,
    updated_at: float = 123.0,
    message_id: str = "msg-1",
    role: str = "assistant",
) -> dict:
    return {
        "chat_id": chat_id,
        "title": title,
        "model_id": model_id,
        "updated_at": updated_at,
        "conv_body": body_content,
        "conv_user": "",
        "conv_assistant": body_content,
        "message_id": message_id,
        "role": role,
        "body_content": body_content,
        "structured_content": "",
        "timestamp": updated_at,
    }


def assert_empty_result(result):
    assert result["results"] == []
    assert result["has_more"] is False


def test_search_messages_rejects_nested_repeat_regex_before_query(monkeypatch):
    engine = FakeEngine([])
    chat_search = load_chat_search_module(monkeypatch, engine)

    with pytest.raises(ValueError, match="unsupported features"):
        chat_search.search_messages(
            user_id="user-1",
            query=r"(a+)+$",
            regex=True,
        )

    # Critical invariant: we MUST NOT touch SQLite with a pathological regex.
    assert engine.executed == []


def test_search_messages_rejects_multiple_unbounded_regex_gaps(monkeypatch):
    engine = FakeEngine([])
    chat_search = load_chat_search_module(monkeypatch, engine)

    with pytest.raises(ValueError, match="unsupported features"):
        chat_search.search_messages(
            user_id="user-1",
            query=r".*.*timeout",
            regex=True,
        )

    assert engine.executed == []


def test_search_messages_rejects_oversize_regex_query(monkeypatch):
    engine = FakeEngine([])
    chat_search = load_chat_search_module(monkeypatch, engine)

    over_limit = "a" * (chat_search.MAX_REGEX_QUERY_LENGTH + 1)
    with pytest.raises(ValueError, match="maximum length"):
        chat_search.search_messages(
            user_id="user-1",
            query=over_limit,
            regex=True,
        )

    assert engine.executed == []


def test_search_messages_allows_regex_with_short_literal(monkeypatch):
    # Short literal patterns are allowed — the eval budget caps work, not a
    # minimum literal length.
    engine = FakeEngine(
        [
            _candidate_row(chat_id="chat-1", body_content="apple pie recipe"),
        ]
    )
    chat_search = load_chat_search_module(monkeypatch, engine)

    result = chat_search.search_messages(
        user_id="user-1",
        query=r"a.*",
        regex=True,
    )

    assert result["results"][0]["chat_id"] == "chat-1"


def test_search_messages_regex_prefilter_uses_literal_instr_filters(monkeypatch):
    engine = FakeEngine(
        [
            _candidate_row(
                chat_id="chat-1",
                body_content="ab%_cd42 matched content",
            ),
        ]
    )
    chat_search = load_chat_search_module(monkeypatch, engine)

    result = chat_search.search_messages(
        user_id="user-1",
        query=r"ab%_cd\d{2}",
        regex=True,
    )

    queries = engine.executed_queries()
    assert len(queries) >= 1
    candidate_sql, candidate_params = queries[0]
    assert "instr(lower(f.body_content), :regex_literal_0) > 0" in candidate_sql
    # The module MUST NOT reintroduce LIKE-based fallbacks — those were the
    # original wildcard-injection / ReDoS vector that PORTICO-68 closed.
    assert "LIKE :like_query" not in candidate_sql
    assert " LIKE " not in candidate_sql.upper().replace("ESCAPE '\\\\'", "")
    assert "LIMIT :batch_size" in candidate_sql
    assert candidate_params["regex_literal_0"] == "ab%_cd"
    assert result["results"][0]["chat_id"] == "chat-1"


def test_search_messages_regex_eval_budget_limits_scanning(monkeypatch):
    # Give the fake engine more rows than the eval budget allows. The batched
    # scanner must stop after exhausting _REGEX_EVAL_BUDGET evaluations and
    # signal regex_budget_exhausted rather than scanning unboundedly.
    budget = 500  # matches chat_search._REGEX_EVAL_BUDGET
    engine = FakeEngine(
        [
            _candidate_row(
                chat_id=f"chat-{index}",
                body_content="release_42 matched content",
            )
            for index in range(budget + 50)
        ]
    )
    chat_search = load_chat_search_module(monkeypatch, engine)
    assert budget == chat_search._REGEX_EVAL_BUDGET

    result = chat_search.search_messages(
        user_id="user-1",
        query=r"release_\d{2}",
        regex=True,
    )

    # The batched cursor scanner uses LIMIT :batch_size.
    queries = engine.executed_queries()
    assert len(queries) >= 1
    sql, _params = queries[0]
    assert "LIMIT :batch_size" in sql
