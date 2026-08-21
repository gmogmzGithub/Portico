"""
Chat search index for message-level search across conversations.

PORTICO PATCH: Message-level search across conversations.

Maintains two SQLite tables — `chat_search_conversations` (regular table
with B-tree indexes for index-accelerated pagination) and `chat_search_messages`
(regular table with B-tree indexes for per-chat snippet lookups) — that
mirror the message content stored inside the `chat` JSON blobs. The index
is populated incrementally in the background (or explicitly via
`ensure_search_populated`) and kept in sync by calling `sync_chat_to_search`
after any chat save/update.
"""

import json
import logging
import re
import time
import html
import threading
from typing import Optional

from sqlalchemy import bindparam, text
from open_webui.internal.db import engine

log = logging.getLogger(__name__)

_LEGACY_REASONING_BLOCK_RE = re.compile(
    r"<(?P<tag>think|thinking|reason|reasoning|thought|Thought)>(?P<body>[\s\S]*?)</(?P=tag)>",
    flags=re.IGNORECASE,
)
_LEGACY_REASONING_TAG_RE = re.compile(
    r"</?(?:think|thinking|reason|reasoning|thought|Thought)>",
    flags=re.IGNORECASE,
)

_search_initialized = False
_search_populated = False

# --- v10: Regular conversation table + regular message table ----------------
# Both tables are regular SQLite tables with B-tree indexes. Text matching
# uses instr() substring search. The conversation-level composite index on
# (user_id, updated_at, chat_id) accelerates cursor-based pagination.

DDL_CREATE_SEARCH_CONVERSATIONS = """
CREATE TABLE IF NOT EXISTS chat_search_conversations (
    chat_id TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    body_content TEXT NOT NULL DEFAULT '',
    user_content TEXT NOT NULL DEFAULT '',
    assistant_content TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL DEFAULT 0
);
"""

DDL_CREATE_SEARCH_CONVERSATIONS_IDX = """
CREATE INDEX IF NOT EXISTS idx_search_conv_user_updated
    ON chat_search_conversations (user_id, updated_at DESC, chat_id DESC);
"""

DDL_CREATE_SEARCH_MESSAGES = """
CREATE TABLE IF NOT EXISTS chat_search_messages (
    chat_id            TEXT NOT NULL,
    message_id         TEXT NOT NULL,
    role               TEXT NOT NULL DEFAULT 'unknown',
    body_content       TEXT NOT NULL DEFAULT '',
    structured_content TEXT NOT NULL DEFAULT '',
    timestamp          REAL NOT NULL DEFAULT 0,
    user_id            TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (chat_id, message_id)
);
"""

DDL_CREATE_SEARCH_MESSAGES_IDX = """
CREATE INDEX IF NOT EXISTS idx_search_msg_chat
    ON chat_search_messages (chat_id, timestamp DESC);
"""

DDL_DROP_SEARCH_CONVERSATIONS = "DROP TABLE IF EXISTS chat_search_conversations"
DDL_DROP_SEARCH_MESSAGES = "DROP TABLE IF EXISTS chat_search_messages"

DDL_CREATE_META = """
CREATE TABLE IF NOT EXISTS chat_search_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

DDL_CREATE_PROGRESS = """
CREATE TABLE IF NOT EXISTS chat_search_progress (
    chat_id TEXT PRIMARY KEY,
    search_version TEXT NOT NULL,
    source_updated_at TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
);
"""

DDL_DROP_FTS = "DROP TABLE IF EXISTS chat_messages_fts"
DDL_DROP_CONVERSATIONS_FTS = "DROP TABLE IF EXISTS chat_conversations_fts"
DDL_DROP_OLD_META = "DROP TABLE IF EXISTS chat_messages_fts_meta"
DDL_DROP_OLD_PROGRESS = "DROP TABLE IF EXISTS chat_messages_fts_progress"

_EXPECTED_SEARCH_CONVERSATIONS_COLUMNS = [
    "chat_id",
    "user_id",
    "title",
    "body_content",
    "user_content",
    "assistant_content",
    "updated_at",
]

_EXPECTED_SEARCH_MESSAGES_COLUMNS = [
    "chat_id",
    "message_id",
    "role",
    "body_content",
    "structured_content",
    "timestamp",
    "user_id",
]


_index_worker_lock = threading.Lock()
_index_worker_thread: Optional[threading.Thread] = None


def _read_meta(conn, key: str) -> Optional[str]:
    row = conn.execute(
        text("SELECT value FROM chat_search_meta WHERE key = :key"),
        {"key": key},
    ).fetchone()
    return None if row is None else str(row[0])


def _write_meta(conn, key: str, value) -> None:
    conn.execute(
        text(
            "INSERT OR REPLACE INTO chat_search_meta (key, value) "
            "VALUES (:key, :value)"
        ),
        {"key": key, "value": str(value)},
    )


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        text(
            "SELECT 1 FROM sqlite_master "
            "WHERE type IN ('table', 'view') AND name = :table_name LIMIT 1"
        ),
        {"table_name": table_name},
    ).fetchone()
    return row is not None


def _get_table_columns(conn, table_name: str = "chat_search_conversations") -> list[str]:
    if not _table_exists(conn, table_name):
        return []
    return [str(row[1]) for row in conn.execute(text(f"PRAGMA table_info({table_name})")).fetchall()]


def _search_schema_current(conn) -> bool:
    return (
        _get_table_columns(conn, "chat_search_conversations") == _EXPECTED_SEARCH_CONVERSATIONS_COLUMNS
        and _get_table_columns(conn, "chat_search_messages") == _EXPECTED_SEARCH_MESSAGES_COLUMNS
    )


def _ensure_search_schema(conn) -> bool:
    """Create or repair the search tables. Returns True if tables were recreated (fresh empty index)."""
    conn.execute(text(DDL_CREATE_META))

    version = _read_meta(conn, "search_version")
    needs_recreate = (
        not _table_exists(conn, "chat_search_conversations")
        or not _table_exists(conn, "chat_search_messages")
        or not _search_schema_current(conn)
        or version != _SEARCH_VERSION
    )

    if needs_recreate:
        _recreate_search_tables(conn)
        conn.execute(text(DDL_CREATE_PROGRESS))
        conn.execute(text("DELETE FROM chat_search_progress"))
        conn.execute(text("DELETE FROM chat_search_meta"))
        _write_meta(conn, "search_version", _SEARCH_VERSION)
        _write_meta(conn, "index_state", "building")
        log.info("[Search] Recreated search index for schema version %s", _SEARCH_VERSION)
        return True
    else:
        conn.execute(text(DDL_CREATE_SEARCH_CONVERSATIONS))
        conn.execute(text(DDL_CREATE_SEARCH_CONVERSATIONS_IDX))
        conn.execute(text(DDL_CREATE_SEARCH_MESSAGES))
        conn.execute(text(DDL_CREATE_SEARCH_MESSAGES_IDX))
        conn.execute(text(DDL_CREATE_PROGRESS))
        _write_meta(conn, "search_version", _SEARCH_VERSION)
        if _read_meta(conn, "index_state") is None:
            _write_meta(conn, "index_state", "building")
        return False


_init_lock = threading.Lock()


def _init_search_tables():
    """Create or repair the search tables and metadata tables."""
    global _search_initialized
    if _search_initialized:
        return

    with _init_lock:
        if _search_initialized:
            return
        with engine.connect() as conn:
            _configure_sqlite_connection(conn)
            _ensure_search_schema(conn)
            conn.commit()
        _search_initialized = True
        log.info("[Search] Search tables initialized")


def _recreate_search_tables(conn) -> None:
    # Drop old v9 FTS5 tables if they exist
    conn.execute(text(DDL_DROP_FTS))
    conn.execute(text(DDL_DROP_CONVERSATIONS_FTS))
    # Drop old meta/progress tables from previous naming
    conn.execute(text(DDL_DROP_OLD_META))
    conn.execute(text(DDL_DROP_OLD_PROGRESS))
    # Drop current tables
    conn.execute(text(DDL_DROP_SEARCH_CONVERSATIONS))
    conn.execute(text(DDL_DROP_SEARCH_MESSAGES))
    # Create tables
    conn.execute(text(DDL_CREATE_SEARCH_CONVERSATIONS))
    conn.execute(text(DDL_CREATE_SEARCH_CONVERSATIONS_IDX))
    conn.execute(text(DDL_CREATE_SEARCH_MESSAGES))
    conn.execute(text(DDL_CREATE_SEARCH_MESSAGES_IDX))


def _is_populated() -> bool:
    """Check whether every current chat has current-version search progress."""
    try:
        return get_index_status()["state"] == "ready"
    except Exception:
        return False


def _coerce_search_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)


def _normalize_search_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip().lower()


def _normalize_non_regex_query(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _append_unique_search_text(segments: list[str], seen: set[str], value) -> None:
    text = _coerce_search_text(value).strip()
    if not text:
        return

    normalized = _normalize_search_text(text)
    if not normalized or normalized in seen:
        return

    for existing in segments:
        if normalized in _normalize_search_text(existing):
            seen.add(normalized)
            return

    seen.add(normalized)
    segments.append(text)


def _serialize_tool_call_for_search(tool_call) -> str:
    if not isinstance(tool_call, dict):
        return _coerce_search_text(tool_call)

    function = tool_call.get("function") or {}
    name = ""
    arguments = ""
    if isinstance(function, dict):
        name = str(function.get("name") or "").strip()
        arguments = _coerce_search_text(function.get("arguments"))
    if not name:
        name = str(tool_call.get("name") or "").strip()
    if not arguments:
        arguments = _coerce_search_text(tool_call.get("arguments"))

    parts = []
    if name:
        parts.append(f"Tool {name}")
    if arguments.strip():
        parts.append(f"Arguments {arguments.strip()}")
    return "\n".join(parts)


def _serialize_tool_result_for_search(result) -> str:
    if not isinstance(result, dict):
        return _coerce_search_text(result)

    parts = []
    tool_name = str(result.get("name") or result.get("tool_name") or "").strip()
    if tool_name:
        parts.append(f"Tool {tool_name}")

    for key in ("content", "result", "output", "error", "status"):
        value = _coerce_search_text(result.get(key)).strip()
        if value:
            parts.append(f"{key.capitalize()} {value}")

    return "\n".join(parts)


def _extract_legacy_reasoning_search_content(content: str) -> tuple[str, str]:
    if not content:
        return "", ""

    reasoning_segments: list[str] = []

    def replace_reasoning_block(match: re.Match) -> str:
        reasoning_text = (match.group("body") or "").strip()
        if reasoning_text:
            reasoning_segments.append(reasoning_text)
        return " "

    visible_content = _LEGACY_REASONING_BLOCK_RE.sub(replace_reasoning_block, content)
    visible_content = _LEGACY_REASONING_TAG_RE.sub(" ", visible_content)
    visible_content = re.sub(r"\s+", " ", visible_content).strip()

    return visible_content, "\n".join(reasoning_segments).strip()


def _build_message_search_content(msg: dict) -> tuple[str, str]:
    body_segments: list[str] = []
    body_seen: set[str] = set()
    structured_segments: list[str] = []
    structured_seen: set[str] = set()

    _append_unique_search_text(
        structured_segments, structured_seen, msg.get("reasoning_content")
    )
    _append_unique_search_text(
        structured_segments, structured_seen, msg.get("thinking_content")
    )

    tool_calls = msg.get("tool_calls") or []
    if isinstance(tool_calls, list):
        for tool_call in tool_calls:
            _append_unique_search_text(
                structured_segments,
                structured_seen,
                _serialize_tool_call_for_search(tool_call),
            )

    content_blocks = msg.get("contentBlocks") or []
    has_content_blocks = isinstance(content_blocks, list) and len(content_blocks) > 0

    if has_content_blocks:
        for block in content_blocks:
            if not isinstance(block, dict):
                continue

            block_type = str(block.get("type") or "").strip().lower()
            block_attributes = block.get("attributes") or {}
            is_reasoning_block = block_type == "reasoning" or (
                isinstance(block_attributes, dict)
                and str(block_attributes.get("type") or "").strip().lower()
                == "reasoning_content"
            )

            if block_type == "tool_calls":
                if isinstance(block_attributes, dict):
                    _append_unique_search_text(
                        structured_segments,
                        structured_seen,
                        _serialize_tool_call_for_search({
                            "name": block_attributes.get("name"),
                            "arguments": block_attributes.get("arguments"),
                        }),
                    )
                    _append_unique_search_text(
                        structured_segments, structured_seen, block_attributes.get("result")
                    )

                block_tool_calls = block.get("content") or []
                if isinstance(block_tool_calls, list):
                    for tool_call in block_tool_calls:
                        _append_unique_search_text(
                            structured_segments,
                            structured_seen,
                            _serialize_tool_call_for_search(tool_call),
                        )

                block_results = block.get("results") or []
                if isinstance(block_results, list):
                    for result in block_results:
                        _append_unique_search_text(
                            structured_segments,
                            structured_seen,
                            _serialize_tool_result_for_search(result),
                        )
            elif is_reasoning_block:
                _append_unique_search_text(
                    structured_segments, structured_seen, block.get("content")
                )
            else:
                _append_unique_search_text(body_segments, body_seen, block.get("content"))
    else:
        raw_content = msg.get("content", "")
        if isinstance(raw_content, str):
            visible_content, reasoning_content = _extract_legacy_reasoning_search_content(
                raw_content
            )
            _append_unique_search_text(body_segments, body_seen, visible_content)
            _append_unique_search_text(
                structured_segments, structured_seen, reasoning_content
            )

    return (
        "\n".join(body_segments).strip(),
        "\n".join(structured_segments).strip(),
    )


def _extract_messages(chat_data: dict) -> list[dict]:
    """Extract messages on the current conversation path only.

    Open WebUI stores ALL branches in ``history.messages``. Following the
    ``parentId`` chain from ``history.currentId`` back to the root gives
    us only the messages the user currently sees, avoiding duplicates
    from regenerated or edited branches.
    """
    history = chat_data.get("history") or {}
    messages_map = history.get("messages") or {}
    if not isinstance(messages_map, dict):
        return []

    current_id = history.get("currentId")
    if current_id:
        active_ids: list[str] = []
        seen_ids: set[str] = set()
        cursor = current_id
        while cursor and cursor in messages_map and cursor not in seen_ids:
            active_ids.append(cursor)
            seen_ids.add(cursor)
            parent = messages_map[cursor]
            cursor = parent.get("parentId") if isinstance(parent, dict) else None
        active_ids.reverse()
    else:
        active_ids = list(messages_map.keys())

    results = []
    for msg_id in active_ids:
        msg = messages_map.get(msg_id)
        if not isinstance(msg, dict):
            continue
        body_content, structured_content = _build_message_search_content(msg)
        if not body_content and not structured_content:
            continue
        results.append({
            "message_id": str(msg_id),
            "role": msg.get("role", "unknown"),
            "body_content": body_content,
            "structured_content": structured_content,
            "timestamp": str(msg.get("timestamp", 0)),
        })
    return results


_SEARCH_VERSION = "11"
_CHAT_INDEX_BATCH_SIZE = 8
_INSERT_BATCH_SIZE = 200
_MATCH_PREVIEW_LIMIT = 5
_SQLITE_BUSY_TIMEOUT_MS = 5000

# --- Regex-path ReDoS hardening ---------------------------------------------
# Keep this set in lockstep with tests/test_chat_search_security.py. The
# packaged Open WebUI runtime uses the CPython stdlib `re` engine, which is
# backtracking-based and has no per-match timeout, so we refuse regexes that
# are obviously pathological (nested unbounded quantifiers, multiple `.*`/`.+`
# gaps, huge `{n,m}` counters). When the pattern contains literal substrings
# they are pushed into `instr()` SQL pre-filters; patterns without literals
# are allowed but capped by _REGEX_EVAL_BUDGET.
MAX_REGEX_QUERY_LENGTH = 128
MAX_REGEX_LITERAL_SEGMENTS = 4
MAX_REGEX_LITERAL_REPEAT_CHARS = 8
MAX_REGEX_REPEAT_COUNT = 64
MAX_REGEX_UNBOUNDED_GAP_ATOMS = 1

SAFE_REGEX_CHARSET_ESCAPES = frozenset({"d", "D", "s", "S", "w", "W"})
SAFE_REGEX_BOUNDARY_ESCAPES = frozenset({"A", "Z", "b", "B"})
SAFE_REGEX_CONTROL_ESCAPES = {
    "t": "\t",
    "n": "\n",
    "r": "\r",
    "f": "\f",
    "v": "\v",
}

_chat_table_cache = None

INSERT_SEARCH_MESSAGE_SQL = text(
    "INSERT OR REPLACE INTO chat_search_messages "
    "(chat_id, message_id, role, body_content, structured_content, timestamp, user_id) "
    "VALUES (:chat_id, :message_id, :role, :body_content, :structured_content, :timestamp, :user_id)"
)
INSERT_SEARCH_CONVERSATION_SQL = text(
    "INSERT INTO chat_search_conversations "
    "(chat_id, user_id, title, body_content, user_content, assistant_content, updated_at) "
    "VALUES (:chat_id, :user_id, :title, :body_content, :user_content, :assistant_content, :updated_at)"
)
DELETE_SEARCH_MESSAGES_SQL = text("DELETE FROM chat_search_messages WHERE chat_id = :chat_id")
DELETE_SEARCH_CONVERSATION_SQL = text("DELETE FROM chat_search_conversations WHERE chat_id = :chat_id")

# Max page size the client can request
_MAX_PAGE_SIZE = 50
_DEFAULT_PAGE_SIZE = 10

# Regex batched cursor scanning budget
_REGEX_EVAL_BUDGET = 500
_REGEX_CURSOR_BATCH_SIZE = 50


def _configure_sqlite_connection(conn) -> None:
    try:
        conn.execute(text(f"PRAGMA busy_timeout = {_SQLITE_BUSY_TIMEOUT_MS}"))
    except Exception:
        log.debug("[Search] Failed to configure SQLite connection", exc_info=True)


def _resolve_chat_table():
    global _chat_table_cache
    if _chat_table_cache is not None:
        return _chat_table_cache

    from open_webui.models import chats as chats_module

    for attr_name in dir(chats_module):
        candidate = getattr(chats_module, attr_name, None)
        table = getattr(candidate, "__table__", None)
        if table is None:
            continue
        column_names = set(table.columns.keys())
        if {"id", "user_id", "chat"}.issubset(column_names):
            _chat_table_cache = table
            return table

    raise RuntimeError("[Search] Unable to resolve Open WebUI chat table metadata")


def _get_chat_table_details() -> dict:
    table = _resolve_chat_table()
    column_names = set(table.columns.keys())
    return {
        "name": table.name,
        "has_title": "title" in column_names,
        "has_updated_at": "updated_at" in column_names,
        "has_model_id": "model_id" in column_names,
    }


def _get_source_chat_select_sql() -> str:
    details = _get_chat_table_details()
    title_expr = "title" if details["has_title"] else "'' AS title"
    updated_at_expr = "updated_at" if details["has_updated_at"] else "0 AS updated_at"
    order_clause = "updated_at DESC, id DESC" if details["has_updated_at"] else "id DESC"
    return (
        f'SELECT id, user_id, {title_expr}, {updated_at_expr}, chat '
        f'FROM "{details["name"]}" ORDER BY {order_clause}'
    )


def _get_chat_title_sql(details: dict) -> str:
    if details["has_title"]:
        return "COALESCE(NULLIF(c.title, ''), 'Untitled')"
    return "'Untitled'"


def _get_chat_model_id_sql(details: dict) -> str:
    return "c.model_id" if details["has_model_id"] else "NULL"


def _coerce_chat_payload(raw_chat, chat_id: str) -> Optional[dict]:
    if isinstance(raw_chat, dict):
        return raw_chat

    if raw_chat is None:
        return None

    if isinstance(raw_chat, (bytes, bytearray)):
        raw_chat = raw_chat.decode("utf-8", errors="ignore")

    if isinstance(raw_chat, str):
        stripped = raw_chat.strip()
        if not stripped:
            log.warning("[Search] Skipping chat %s with empty chat payload", chat_id)
            return None
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            log.warning("[Search] Skipping chat %s with invalid chat JSON", chat_id)
            return None
        if not isinstance(parsed, dict):
            log.warning("[Search] Skipping chat %s with non-dict chat payload", chat_id)
            return None
        return parsed

    log.warning(
        "[Search] Skipping chat %s with unsupported chat payload type %s",
        chat_id,
        type(raw_chat).__name__,
    )
    return None


def _build_message_rows(chat_id: str, user_id: str, chat_data: dict) -> list[dict]:
    rows = []
    for msg in _extract_messages(chat_data):
        rows.append(
            {
                "chat_id": chat_id,
                "message_id": msg["message_id"],
                "role": msg["role"],
                "body_content": msg["body_content"],
                "structured_content": msg["structured_content"],
                "timestamp": msg["timestamp"],
                "user_id": user_id,
            }
        )
    return rows


def _build_conversation_row(
    chat_id: str,
    user_id: str,
    title: str,
    updated_at,
    message_rows: list[dict],
) -> dict:
    body_segments: list[str] = []
    user_segments: list[str] = []
    assistant_segments: list[str] = []

    for row in message_rows:
        body_content = str(row.get("body_content") or "").strip()
        if not body_content:
            continue

        body_segments.append(body_content)
        role = str(row.get("role") or "").strip().lower()
        if role == "user":
            user_segments.append(body_content)
        elif role == "assistant":
            assistant_segments.append(body_content)

    return {
        "chat_id": chat_id,
        "user_id": user_id,
        "title": (title or "").strip() or "Untitled",
        "body_content": "\n".join(body_segments),
        "user_content": "\n".join(user_segments),
        "assistant_content": "\n".join(assistant_segments),
        "updated_at": _source_updated_at_value(updated_at),
    }


def _insert_message_rows(conn, rows: list[dict]) -> int:
    if not rows:
        return 0

    inserted = 0
    for start_index in range(0, len(rows), _INSERT_BATCH_SIZE):
        batch = rows[start_index : start_index + _INSERT_BATCH_SIZE]
        conn.execute(INSERT_SEARCH_MESSAGE_SQL, batch)
        inserted += len(batch)
    return inserted


def _write_chat_index_rows(
    conn,
    chat_id: str,
    user_id: str,
    chat_data,
    title: str = "",
    updated_at=0,
) -> int:
    payload = _coerce_chat_payload(chat_data, chat_id)
    if payload is None:
        return 0
    rows = _build_message_rows(chat_id, user_id, payload)
    inserted = _insert_message_rows(conn, rows)
    conn.execute(
        INSERT_SEARCH_CONVERSATION_SQL,
        _build_conversation_row(chat_id, user_id, title, updated_at, rows),
    )
    return inserted


def _source_updated_at_value(value) -> str:
    if value is None:
        return "0"
    return str(value)


def _get_chat_source_updated_at(conn, chat_id: str) -> str:
    details = _get_chat_table_details()
    if not details["has_updated_at"]:
        return "0"
    row = conn.execute(
        text(f'SELECT updated_at FROM "{details["name"]}" WHERE id = :chat_id'),
        {"chat_id": chat_id},
    ).fetchone()
    return "0" if row is None else _source_updated_at_value(row[0])


def _get_chat_source_metadata(conn, chat_id: str) -> dict:
    details = _get_chat_table_details()
    title_expr = "title" if details["has_title"] else "'' AS title"
    updated_at_expr = "updated_at" if details["has_updated_at"] else "0 AS updated_at"
    row = conn.execute(
        text(
            f'SELECT {title_expr}, {updated_at_expr} '
            f'FROM "{details["name"]}" WHERE id = :chat_id'
        ),
        {"chat_id": chat_id},
    ).mappings().fetchone()
    if row is None:
        return {"title": "", "updated_at": "0"}
    return {
        "title": "" if row["title"] is None else str(row["title"]),
        "updated_at": _source_updated_at_value(row["updated_at"]),
    }


def _record_chat_progress(
    conn,
    chat_id: str,
    source_updated_at: str,
    message_count: int,
) -> None:
    conn.execute(
        text(
            "INSERT OR REPLACE INTO chat_search_progress "
            "(chat_id, search_version, source_updated_at, indexed_at, message_count) "
            "VALUES (:chat_id, :search_version, :source_updated_at, :indexed_at, :message_count)"
        ),
        {
            "chat_id": chat_id,
            "search_version": _SEARCH_VERSION,
            "source_updated_at": source_updated_at,
            "indexed_at": str(time.time()),
            "message_count": int(message_count or 0),
        },
    )


def _delete_chat_progress(conn, chat_id: str) -> None:
    conn.execute(
        text("DELETE FROM chat_search_progress WHERE chat_id = :chat_id"),
        {"chat_id": chat_id},
    )


def _index_source_chat_row(conn, row, skip_deletes: bool = False) -> int:
    chat_id = str(row["id"])
    user_id = "" if row["user_id"] is None else str(row["user_id"])
    source_updated_at = _source_updated_at_value(row["updated_at"])

    if not skip_deletes:
        conn.execute(DELETE_SEARCH_MESSAGES_SQL, {"chat_id": chat_id})
        conn.execute(DELETE_SEARCH_CONVERSATION_SQL, {"chat_id": chat_id})
    message_count = _write_chat_index_rows(
        conn,
        chat_id,
        user_id,
        row["chat"],
        "" if row["title"] is None else str(row["title"]),
        row["updated_at"],
    )
    _record_chat_progress(conn, chat_id, source_updated_at, message_count)
    return message_count


def _record_population_metadata(conn) -> None:
    _write_meta(conn, "populated_at", str(time.time()))
    _write_meta(conn, "search_version", _SEARCH_VERSION)
    _write_meta(conn, "index_state", "ready")
    conn.execute(text("DELETE FROM chat_search_meta WHERE key = 'last_error'"))


def _record_index_error(message: str) -> None:
    try:
        with engine.connect() as conn:
            _configure_sqlite_connection(conn)
            conn.execute(text(DDL_CREATE_META))
            _write_meta(conn, "index_state", "error")
            _write_meta(conn, "last_error", message)
            conn.commit()
    except Exception:
        log.debug("[Search] Failed to record index error", exc_info=True)


def _source_updated_at_sql(details: dict) -> str:
    if details["has_updated_at"]:
        return "CAST(COALESCE(c.updated_at, 0) AS TEXT)"
    return "'0'"


def _get_next_index_batch(conn, limit: int = _CHAT_INDEX_BATCH_SIZE) -> list[dict]:
    details = _get_chat_table_details()
    title_expr = "c.title" if details["has_title"] else "'' AS title"
    updated_at_expr = "c.updated_at" if details["has_updated_at"] else "0 AS updated_at"
    order_clause = "c.updated_at DESC, c.id DESC" if details["has_updated_at"] else "c.id DESC"
    source_updated_at_sql = _source_updated_at_sql(details)
    sql = text(
        f"""
        SELECT c.id, c.user_id, {title_expr}, {updated_at_expr}, c.chat
        FROM "{details["name"]}" c
        LEFT JOIN chat_search_progress p
            ON p.chat_id = c.id
            AND p.search_version = :search_version
        WHERE p.chat_id IS NULL
            OR p.source_updated_at != {source_updated_at_sql}
        ORDER BY {order_clause}
        LIMIT :limit
        """
    )
    return list(
        conn.execute(sql, {"search_version": _SEARCH_VERSION, "limit": limit})
        .mappings()
        .all()
    )


def _get_index_counts(conn) -> tuple[int, int, int]:
    details = _get_chat_table_details()
    source_updated_at_sql = _source_updated_at_sql(details)
    total_chats = int(
        conn.execute(text(f'SELECT COUNT(*) FROM "{details["name"]}"')).scalar() or 0
    )
    indexed_chats = int(
        conn.execute(
            text(
                f"""
                SELECT COUNT(*)
                FROM "{details["name"]}" c
                JOIN chat_search_progress p
                    ON p.chat_id = c.id
                    AND p.search_version = :search_version
                    AND p.source_updated_at = {source_updated_at_sql}
                """
            ),
            {"search_version": _SEARCH_VERSION},
        ).scalar()
        or 0
    )
    indexed_messages = int(
        conn.execute(text("SELECT COUNT(*) FROM chat_search_messages")).scalar() or 0
    )
    return total_chats, indexed_chats, indexed_messages


def _is_index_worker_running() -> bool:
    with _index_worker_lock:
        return _index_worker_thread is not None and _index_worker_thread.is_alive()


def get_index_status() -> dict:
    _init_search_tables()
    try:
        with engine.connect() as conn:
            _configure_sqlite_connection(conn)
            total_chats, indexed_chats, indexed_messages = _get_index_counts(conn)
            stored_state = _read_meta(conn, "index_state") or "building"
            last_error = _read_meta(conn, "last_error")

        ready = indexed_chats >= total_chats
        if stored_state == "error":
            state = "error"
        elif ready:
            state = "ready"
        elif _is_index_worker_running():
            state = "building"
        else:
            state = "stale"

        return {
            "state": state,
            "partial": not ready,
            "indexed_chats": indexed_chats,
            "total_chats": total_chats,
            "indexed_messages": indexed_messages,
            "last_error": last_error,
        }
    except Exception as exc:
        log.exception("[Search] Failed to read search index status")
        return {
            "state": "error",
            "partial": True,
            "indexed_chats": 0,
            "total_chats": 0,
            "indexed_messages": 0,
            "last_error": str(exc),
        }


def _run_indexing_to_completion() -> None:
    global _search_populated
    start = time.monotonic()
    total_messages = 0
    indexed_chats = 0

    try:
        with engine.connect() as conn:
            _configure_sqlite_connection(conn)
            fresh_index = _ensure_search_schema(conn)
            _write_meta(conn, "index_state", "building")
            conn.execute(text("DELETE FROM chat_search_meta WHERE key = 'last_error'"))
            conn.commit()

            while True:
                batch = _get_next_index_batch(conn)
                if not batch:
                    break

                # Fast path: index the entire batch and commit once
                try:
                    batch_messages = 0
                    for row in batch:
                        batch_messages += _index_source_chat_row(
                            conn, row, skip_deletes=fresh_index
                        )
                    conn.commit()
                    total_messages += batch_messages
                    indexed_chats += len(batch)
                except Exception:
                    # Slow path: batch failed, rollback and retry per-chat
                    conn.rollback()
                    log.debug(
                        "[Search] Batch indexing failed, falling back to per-chat commits"
                    )
                    for row in batch:
                        chat_id = str(row["id"])
                        try:
                            total_messages += _index_source_chat_row(conn, row)
                            indexed_chats += 1
                            conn.commit()
                        except Exception:
                            conn.rollback()
                            log.exception(
                                "[Search] Failed to index chat %s during incremental population",
                                chat_id,
                            )
                            try:
                                conn.execute(DELETE_SEARCH_MESSAGES_SQL, {"chat_id": chat_id})
                                conn.execute(DELETE_SEARCH_CONVERSATION_SQL, {"chat_id": chat_id})
                                _record_chat_progress(
                                    conn,
                                    chat_id,
                                    _source_updated_at_value(row["updated_at"]),
                                    0,
                                )
                                conn.commit()
                            except Exception:
                                conn.rollback()
                                raise

            _record_population_metadata(conn)
            conn.commit()

        _search_populated = True
        elapsed = time.monotonic() - start
        log.info(
            "[Search] Indexed %d messages across %d chats in %.2fs",
            total_messages,
            indexed_chats,
            elapsed,
        )
    except Exception as exc:
        _search_populated = False
        _record_index_error(str(exc))
        log.exception("[Search] Failed to populate search index")
        raise


def _background_index_worker() -> None:
    try:
        _run_indexing_to_completion()
    except Exception:
        # _run_indexing_to_completion already logs and records the error.
        return


def start_background_indexing_if_needed() -> dict:
    status = get_index_status()
    if not status["partial"]:
        return status

    global _index_worker_thread
    with _index_worker_lock:
        if _index_worker_thread is not None and _index_worker_thread.is_alive():
            status["state"] = "building"
            return status

        _index_worker_thread = threading.Thread(
            target=_background_index_worker,
            name="chat-search-indexer",
            daemon=True,
        )
        _index_worker_thread.start()

    status["state"] = "building"
    return status


def ensure_search_populated():
    """Populate the search index from existing chats if it is stale or missing."""
    global _search_populated
    _init_search_tables()

    if _search_populated and _is_populated():
        return

    if _is_populated():
        _search_populated = True
        return

    log.info("[Search] Populating search index (version %s) from existing chat data...", _SEARCH_VERSION)
    _run_indexing_to_completion()


def sync_chat_to_search(chat_id: str, user_id: str, chat_data: dict):
    """Sync a single chat into the search index after save/update."""
    _init_search_tables()

    try:
        with engine.connect() as conn:
            _configure_sqlite_connection(conn)
            metadata = _get_chat_source_metadata(conn, chat_id)
            conn.execute(DELETE_SEARCH_MESSAGES_SQL, {"chat_id": chat_id})
            conn.execute(DELETE_SEARCH_CONVERSATION_SQL, {"chat_id": chat_id})
            message_count = _write_chat_index_rows(
                conn,
                chat_id,
                str(user_id or ""),
                chat_data,
                metadata["title"],
                metadata["updated_at"],
            )
            _record_chat_progress(
                conn,
                chat_id,
                metadata["updated_at"],
                message_count,
            )
            conn.commit()
    except Exception:
        log.exception("[Search] Failed to sync chat %s", chat_id)


def delete_chat_from_search(chat_id: str):
    """Remove all search index rows for a deleted chat."""
    _init_search_tables()
    try:
        with engine.connect() as conn:
            _configure_sqlite_connection(conn)
            conn.execute(DELETE_SEARCH_MESSAGES_SQL, {"chat_id": chat_id})
            conn.execute(DELETE_SEARCH_CONVERSATION_SQL, {"chat_id": chat_id})
            _delete_chat_progress(conn, chat_id)
            conn.commit()
    except Exception:
        log.exception("[Search] Failed to delete chat %s from search index", chat_id)


def _prepare_display_text(content: str) -> str:
    return html.unescape(content or "")


def _build_snippet(
    content: str, query: str, window: int = 100, case_sensitive: bool = False
) -> str:
    """Build a snippet with <mark> highlighting around the match."""
    flags = 0 if case_sensitive else re.IGNORECASE
    safe_query = re.escape(query)
    display_content = _prepare_display_text(content)
    match = re.search(safe_query, display_content, flags)
    if not match:
        preview = (
            display_content[: window * 2]
            if len(display_content) > window * 2
            else display_content
        )
        return html.escape(preview, quote=False)

    start = max(0, match.start() - window)
    end = min(len(display_content), match.end() + window)
    snippet = display_content[start:end]

    prefix = "\u2026" if start > 0 else ""
    suffix = "\u2026" if end < len(display_content) else ""

    def highlight_match(m):
        return f"<mark>{html.escape(m.group(), quote=False)}</mark>"

    highlighted = re.sub(
        safe_query,
        highlight_match,
        html.escape(snippet, quote=False),
        flags=flags,
    )
    return f"{prefix}{highlighted}{suffix}"


def _build_regex_snippet(content: str, pattern: re.Pattern, window: int = 100) -> str:
    display_content = _prepare_display_text(content)
    match = pattern.search(display_content)
    if not match or match.start() == match.end():
        preview = (
            display_content[: window * 2]
            if len(display_content) > window * 2
            else display_content
        )
        return html.escape(preview, quote=False)

    start = max(0, match.start() - window)
    end = min(len(display_content), match.end() + window)
    snippet = display_content[start:end]

    prefix = "\u2026" if start > 0 else ""
    suffix = "\u2026" if end < len(display_content) else ""

    result = ""
    last_end = 0
    for local_match in pattern.finditer(snippet):
        if local_match.start() == local_match.end():
            continue
        result += html.escape(snippet[last_end:local_match.start()], quote=False)
        result += f"<mark>{html.escape(local_match.group(), quote=False)}</mark>"
        last_end = local_match.end()
    if last_end == 0:
        return f"{prefix}{html.escape(snippet, quote=False)}{suffix}"
    result += html.escape(snippet[last_end:], quote=False)
    return f"{prefix}{result}{suffix}"


def _row_matches_query(
    body_content: str,
    query: str,
    case_sensitive: bool,
) -> bool:
    haystack = _prepare_display_text(body_content)
    if case_sensitive:
        return query in haystack
    return query.lower() in haystack.lower()


def _select_snippet_source(
    body_content: str,
    query: str,
    case_sensitive: bool,
) -> str:
    if _row_matches_query(body_content, query, case_sensitive):
        return body_content or ""
    return body_content or ""


def _select_regex_snippet_source(
    body_content: str,
    pattern: re.Pattern,
) -> str:
    body_display = _prepare_display_text(body_content)
    if pattern.search(body_display):
        return body_content or ""
    return ""


def _parse_cursor(cursor: Optional[str]) -> Optional[tuple[float, str]]:
    if not cursor:
        return None
    parts = cursor.split(":", 1)
    if len(parts) != 2:
        return None
    try:
        return (float(parts[0]), parts[1])
    except (ValueError, TypeError):
        return None


def _encode_cursor(updated_at: float, chat_id: str) -> str:
    return f"{updated_at}:{chat_id}"


def _build_title_html(title: str, query: str, case_sensitive: bool, is_regex: bool = False, pattern: Optional[re.Pattern] = None) -> str:
    safe_title = html.escape(title or "Untitled conversation", quote=False)
    if not query:
        return safe_title
    if is_regex and pattern is not None:
        escaped = html.escape(title or "", quote=False)
        result = ""
        last_end = 0
        for m in pattern.finditer(escaped):
            if m.start() == m.end():
                continue
            result += escaped[last_end:m.start()]
            result += f"<mark>{html.escape(m.group(), quote=False)}</mark>"
            last_end = m.end()
        if last_end == 0:
            return safe_title
        result += escaped[last_end:]
        return result
    flags = 0 if case_sensitive else re.IGNORECASE
    safe_query = re.escape(query)
    result = ""
    last_end = 0
    for match in re.finditer(safe_query, safe_title, flags):
        result += safe_title[last_end:match.start()]
        result += f"<mark>{match.group()}</mark>"
        last_end = match.end()
    if last_end == 0:
        return safe_title
    result += safe_title[last_end:]
    return result


def _title_matches_query(title: str, query: str, case_sensitive: bool) -> bool:
    if not query:
        return False
    if case_sensitive:
        return query in (title or "")
    return query.lower() in (title or "").lower()


def _fetch_message_snippets(
    conn,
    chat_ids: list[str],
    query: str,
    case_sensitive: bool,
    role: Optional[str] = None,
    is_regex: bool = False,
    pattern: Optional[re.Pattern] = None,
) -> dict[str, dict]:
    if not chat_ids:
        return {}

    role_filter = ""
    snippet_params: dict = {"chat_ids": chat_ids}
    if role in ("user", "assistant"):
        role_filter = " AND m.role = :role_filter"
        snippet_params["role_filter"] = role

    snippet_sql = text(
        "SELECT m.chat_id, m.message_id, m.role, m.body_content, "
        "m.timestamp "
        "FROM chat_search_messages m "
        f"WHERE m.chat_id IN :chat_ids{role_filter} "
        "ORDER BY m.timestamp DESC"
    ).bindparams(bindparam("chat_ids", expanding=True))
    rows = conn.execute(snippet_sql, snippet_params).mappings().all()

    groups: dict[str, dict] = {cid: {"match_count": 0, "matches": []} for cid in chat_ids}

    for row in rows:
        chat_id = row["chat_id"]
        group = groups.get(chat_id)
        if not group:
            continue

        if is_regex and pattern is not None:
            snippet_source = _select_regex_snippet_source(
                row["body_content"], pattern,
            )
            if not snippet_source:
                continue
            group["match_count"] += 1
            if len(group["matches"]) < _MATCH_PREVIEW_LIMIT:
                group["matches"].append({
                    "message_id": row["message_id"],
                    "role": row["role"],
                    "snippet": _build_regex_snippet(snippet_source, pattern),
                    "timestamp": float(row["timestamp"] or 0),
                })
        else:
            if not _row_matches_query(
                row["body_content"], query, case_sensitive,
            ):
                continue
            group["match_count"] += 1
            if len(group["matches"]) < _MATCH_PREVIEW_LIMIT:
                group["matches"].append({
                    "message_id": row["message_id"],
                    "role": row["role"],
                    "snippet": _build_snippet(
                        _select_snippet_source(
                            row["body_content"], query, case_sensitive,
                        ),
                        query, case_sensitive=case_sensitive,
                    ),
                    "timestamp": float(row["timestamp"] or 0),
                })

    return groups


def _search_text(
    user_id: str,
    query: str,
    page_size: int,
    cursor: Optional[str],
    role: Optional[str],
    updated_since: Optional[float],
    case_sensitive: bool,
) -> dict:
    details = _get_chat_table_details()
    table_name = details["name"]
    parsed_cursor = _parse_cursor(cursor)

    filters: list[str] = ["c.user_id = :user_id"]
    params: dict = {"user_id": user_id}

    if parsed_cursor is not None:
        cursor_ts, cursor_id = parsed_cursor
        filters.append(
            "(CAST(c.updated_at AS REAL) < :cursor_ts "
            "OR (CAST(c.updated_at AS REAL) = :cursor_ts AND c.id < :cursor_id))"
        )
        params["cursor_ts"] = cursor_ts
        params["cursor_id"] = cursor_id

    if updated_since is not None:
        filters.append("CAST(c.updated_at AS REAL) >= :updated_since")
        params["updated_since"] = updated_since

    if role == "user":
        body_col = "f.user_content"
    elif role == "assistant":
        body_col = "f.assistant_content"
    else:
        body_col = "f.body_content"

    if case_sensitive:
        params["search_query"] = query
        filters.append(
            f"(instr({body_col}, :search_query) > 0 "
            f"OR instr(f.title, :search_query) > 0)"
        )
    else:
        params["search_query"] = query.lower()
        filters.append(
            f"(instr(lower({body_col}), :search_query) > 0 "
            f"OR instr(lower(f.title), :search_query) > 0)"
        )

    where_clause = " AND ".join(filters)
    chat_title_sql = _get_chat_title_sql(details)
    chat_model_id_sql = _get_chat_model_id_sql(details)
    params["page_limit"] = page_size + 1

    candidate_sql = text(f"""
        SELECT
            c.id AS chat_id,
            {chat_title_sql} AS title,
            {chat_model_id_sql} AS model_id,
            CAST(COALESCE(c.updated_at, 0) AS REAL) AS updated_at
        FROM "{table_name}" c
        JOIN chat_search_conversations f ON f.chat_id = c.id
        WHERE {where_clause}
        ORDER BY CAST(c.updated_at AS REAL) DESC, c.id DESC
        LIMIT :page_limit
    """)

    with engine.connect() as conn:
        _configure_sqlite_connection(conn)
        rows = conn.execute(candidate_sql, params).mappings().all()

        has_more = len(rows) > page_size
        page_rows = rows[:page_size]

        if not page_rows:
            return {"results": [], "has_more": False, "next_cursor": None}

        chat_ids = [row["chat_id"] for row in page_rows]
        snippet_groups = _fetch_message_snippets(
            conn, chat_ids, query, case_sensitive, role,
        )

    last_row = page_rows[-1]
    next_cursor = _encode_cursor(float(last_row["updated_at"]), last_row["chat_id"]) if has_more else None

    results = []
    for row in page_rows:
        chat_id = row["chat_id"]
        title = row["title"] or "Untitled conversation"
        group = snippet_groups.get(chat_id, {"match_count": 0, "matches": []})
        title_matched = _title_matches_query(title, query, case_sensitive)

        if not title_matched and group["match_count"] == 0:
            continue

        results.append({
            "chat_id": chat_id,
            "title": title,
            "title_html": _build_title_html(title, query, case_sensitive),
            "updated_at": float(row["updated_at"] or 0),
            "model_id": row["model_id"],
            "title_matched": title_matched,
            "match_count": group["match_count"],
            "matches": group["matches"],
        })

    return {
        "results": results,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }


def _flush_literal_segment(segments: list[str], current: list[str]) -> None:
    if current:
        segments.append("".join(current))
        current.clear()


def _consume_regex_char_class(query: str, index: int) -> Optional[int]:
    cursor = index + 1
    if cursor >= len(query):
        return None
    if query[cursor] == "^":
        cursor += 1

    saw_member = False
    while cursor < len(query):
        char = query[cursor]
        if char == "\\":
            if cursor + 1 >= len(query):
                return None
            cursor += 2
            saw_member = True
            continue
        if char == "]" and saw_member:
            return cursor + 1
        saw_member = True
        cursor += 1

    return None


def _consume_regex_escape(query: str, index: int):
    if index + 1 >= len(query):
        return None, None, index + 1

    escaped = query[index + 1]
    if escaped.isdigit():
        return None, None, index + 2
    if escaped in SAFE_REGEX_CHARSET_ESCAPES:
        return "wildcard", None, index + 2
    if escaped in SAFE_REGEX_BOUNDARY_ESCAPES:
        return "anchor", None, index + 2
    if escaped in SAFE_REGEX_CONTROL_ESCAPES:
        return "literal", SAFE_REGEX_CONTROL_ESCAPES[escaped], index + 2
    if escaped.isalpha():
        return None, None, index + 2
    return "literal", escaped, index + 2


def _consume_regex_atom(query: str, index: int):
    char = query[index]
    if char in "()|?*+{}":
        return None, None, index + 1
    if char in "^$":
        return "anchor", None, index + 1
    if char == ".":
        return "wildcard", None, index + 1
    if char == "[":
        end_index = _consume_regex_char_class(query, index)
        if end_index is None:
            return None, None, index + 1
        return "wildcard", None, end_index
    if char == "\\":
        return _consume_regex_escape(query, index)
    return "literal", char, index + 1


def _consume_regex_quantifier(query: str, index: int):
    if index >= len(query):
        return 1, 1, index

    char = query[index]
    if char == "?":
        return 0, 1, index + 1
    if char == "*":
        return 0, None, index + 1
    if char == "+":
        return 1, None, index + 1
    if char != "{":
        return 1, 1, index

    cursor = index + 1
    min_start = cursor
    while cursor < len(query) and query[cursor].isdigit():
        cursor += 1
    if cursor == min_start:
        return None, None, cursor

    min_repeat = int(query[min_start:cursor])
    max_repeat = min_repeat

    if cursor >= len(query):
        return None, None, cursor

    if query[cursor] == "}":
        cursor += 1
    elif query[cursor] == ",":
        cursor += 1
        max_start = cursor
        while cursor < len(query) and query[cursor].isdigit():
            cursor += 1
        if max_start == cursor or cursor >= len(query) or query[cursor] != "}":
            return None, None, cursor
        max_repeat = int(query[max_start:cursor])
        if max_repeat < min_repeat:
            return None, None, cursor + 1
        cursor += 1
    else:
        return None, None, cursor

    if min_repeat > MAX_REGEX_REPEAT_COUNT or max_repeat > MAX_REGEX_REPEAT_COUNT:
        return None, None, cursor

    return min_repeat, max_repeat, cursor


def _select_regex_prefilter_literals(query: str) -> Optional[tuple[str, ...]]:
    # Walk the regex at the token level and extract literal substrings that
    # every match MUST contain. Unsupported constructs (grouping, alternation,
    # nested quantifiers, backreferences) fail the walk and force the caller
    # to reject the query so we never hand an unbounded backtracker to
    # stdlib ``re``.
    segments: list[str] = []
    current: list[str] = []
    index = 0
    unbounded_gap_atoms = 0

    while index < len(query):
        atom_kind, atom_value, atom_end = _consume_regex_atom(query, index)
        if atom_kind is None:
            return None

        min_repeat, max_repeat, next_index = _consume_regex_quantifier(query, atom_end)
        if min_repeat is None:
            return None

        if atom_kind == "anchor":
            if next_index != atom_end:
                return None
            _flush_literal_segment(segments, current)
            index = next_index
            continue

        if atom_kind == "literal" and min_repeat > 0:
            current.append(atom_value * min(min_repeat, MAX_REGEX_LITERAL_REPEAT_CHARS))
            unbounded_gap_atoms = 0
        else:
            _flush_literal_segment(segments, current)
            if max_repeat is None:
                unbounded_gap_atoms += 1
                if unbounded_gap_atoms > MAX_REGEX_UNBOUNDED_GAP_ATOMS:
                    return None

        index = next_index

    _flush_literal_segment(segments, current)

    unique_segments: list[str] = []
    seen: set[str] = set()
    for segment in sorted(segments, key=len, reverse=True):
        if segment and segment not in seen:
            unique_segments.append(segment)
            seen.add(segment)

    return tuple(unique_segments[:MAX_REGEX_LITERAL_SEGMENTS])


def _build_safe_regex_search_plan(
    query: str, case_sensitive: bool
) -> tuple[re.Pattern, tuple[str, ...]]:
    """Compile *query* into a safe regex search plan or raise ValueError.

    Supported regex subset (N-001 ReDoS contract)
    ──────────────────────────────────────────────
    Allowed:
      • Literal characters           – ``abc``, ``hello world``
      • Escaped characters            – ``\\.``, ``\\(``, ``\\n``, ``\\t``
      • Character classes             – ``[abc]``, ``[a-z]``, ``[^0-9]``
      • Dot wildcard                  – ``.`` (matches any character)
      • Anchors                       – ``^``, ``$``
      • Quantifiers on simple atoms   – ``a*``, ``[abc]+``, ``.?``, ``x{2,5}``

    Not allowed (raises ValueError):
      • Grouping                      – ``(...)`` including ``(?:...)``
      • Alternation                   – ``foo|bar``
      • Backreferences                – ``\\1``
      • Lookaheads / lookbehinds      – ``(?=...)``, ``(?!...)``

    These constructs are rejected because Python's ``re`` module uses a
    backtracking NFA engine. Patterns like ``(a+)+`` cause exponential
    backtracking (ReDoS). A linear-time engine (e.g. google-re2) would
    allow the full regex grammar safely.

    If the pattern contains literal substrings, they are pushed into
    ``instr()`` SQL pre-filters so SQLite narrows the candidate set
    before the regex engine runs. Patterns without literals (e.g.
    ``\\d+``) are still allowed — the ``_REGEX_EVAL_BUDGET`` caps how
    many rows the regex engine processes.
    """
    if not query:
        raise ValueError("Regex query must not be empty")

    if len(query) > MAX_REGEX_QUERY_LENGTH:
        raise ValueError(
            f"Regex pattern exceeds the maximum length of {MAX_REGEX_QUERY_LENGTH} characters"
        )

    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        compiled = re.compile(query, flags)
    except re.error as error:
        raise ValueError("Invalid regular expression") from error

    literal_segments = _select_regex_prefilter_literals(query)
    if literal_segments is None:
        raise ValueError(
            "Regex uses unsupported features (grouping, alternation, backreferences). "
            "Supported: literals, character classes [abc], dot wildcard, "
            "and quantifiers on simple atoms."
        )
    return compiled, literal_segments


def _search_regex(
    user_id: str,
    query: str,
    page_size: int,
    cursor: Optional[str],
    role: Optional[str],
    updated_since: Optional[float],
    case_sensitive: bool,
) -> dict:
    pattern, regex_prefilter_literals = _build_safe_regex_search_plan(
        query, case_sensitive
    )

    details = _get_chat_table_details()
    table_name = details["name"]
    parsed_cursor = _parse_cursor(cursor)

    filters: list[str] = ["c.user_id = :user_id"]
    params: dict = {"user_id": user_id}

    if parsed_cursor is not None:
        cursor_ts, cursor_id = parsed_cursor
        filters.append(
            "(CAST(c.updated_at AS REAL) < :cursor_ts "
            "OR (CAST(c.updated_at AS REAL) = :cursor_ts AND c.id < :cursor_id))"
        )
        params["cursor_ts"] = cursor_ts
        params["cursor_id"] = cursor_id

    if updated_since is not None:
        filters.append("CAST(c.updated_at AS REAL) >= :updated_since")
        params["updated_since"] = updated_since

    if role == "user":
        body_col = "f.user_content"
    elif role == "assistant":
        body_col = "f.assistant_content"
    else:
        body_col = "f.body_content"

    body_col_lower = f"lower({body_col})" if not case_sensitive else body_col
    for literal_index, literal in enumerate(regex_prefilter_literals):
        param_name = f"regex_literal_{literal_index}"
        needle = literal if case_sensitive else literal.lower()
        filters.append(f"(instr({body_col_lower}, :{param_name}) > 0 OR instr({'lower(f.title)' if not case_sensitive else 'f.title'}, :{param_name}) > 0)")
        params[param_name] = needle

    where_clause = " AND ".join(filters)
    chat_title_sql = _get_chat_title_sql(details)
    chat_model_id_sql = _get_chat_model_id_sql(details)

    batch_sql = text(f"""
        SELECT
            c.id AS chat_id,
            {chat_title_sql} AS title,
            {chat_model_id_sql} AS model_id,
            CAST(COALESCE(c.updated_at, 0) AS REAL) AS updated_at,
            f.body_content AS conv_body,
            f.user_content AS conv_user,
            f.assistant_content AS conv_assistant
        FROM "{table_name}" c
        JOIN chat_search_conversations f ON f.chat_id = c.id
        WHERE {where_clause}
        ORDER BY CAST(c.updated_at AS REAL) DESC, c.id DESC
        LIMIT :batch_size
    """)

    verified_results: list[dict] = []
    evals_remaining = _REGEX_EVAL_BUDGET
    regex_budget_exhausted = False
    last_scanned_row = None

    with engine.connect() as conn:
        _configure_sqlite_connection(conn)

        scan_params = dict(params)
        while len(verified_results) < page_size and evals_remaining > 0:
            scan_params["batch_size"] = _REGEX_CURSOR_BATCH_SIZE
            rows = conn.execute(batch_sql, scan_params).mappings().all()
            if not rows:
                break

            for row in rows:
                last_scanned_row = row
                evals_remaining -= 1

                if role == "user":
                    haystack = row["conv_user"] or ""
                elif role == "assistant":
                    haystack = row["conv_assistant"] or ""
                else:
                    haystack = row["conv_body"] or ""

                display_haystack = _prepare_display_text(haystack)
                title_display = _prepare_display_text(row["title"] or "")

                if not pattern.search(display_haystack) and not pattern.search(title_display):
                    if evals_remaining <= 0:
                        regex_budget_exhausted = True
                        break
                    continue

                verified_results.append({
                    "chat_id": row["chat_id"],
                    "title": row["title"] or "Untitled conversation",
                    "model_id": row["model_id"],
                    "updated_at": float(row["updated_at"] or 0),
                })

                if len(verified_results) >= page_size:
                    break

                if evals_remaining <= 0:
                    regex_budget_exhausted = True
                    break

            if last_scanned_row is not None:
                scan_params["cursor_ts"] = float(last_scanned_row["updated_at"])
                scan_params["cursor_id"] = last_scanned_row["chat_id"]
                if "cursor_ts" not in params:
                    filters_with_cursor = list(filters)
                    filters_with_cursor.append(
                        "(CAST(c.updated_at AS REAL) < :cursor_ts "
                        "OR (CAST(c.updated_at AS REAL) = :cursor_ts AND c.id < :cursor_id))"
                    )
                    new_where = " AND ".join(filters_with_cursor)
                    batch_sql = text(f"""
                        SELECT
                            c.id AS chat_id,
                            {chat_title_sql} AS title,
                            {chat_model_id_sql} AS model_id,
                            CAST(COALESCE(c.updated_at, 0) AS REAL) AS updated_at,
                            f.body_content AS conv_body,
                            f.user_content AS conv_user,
                            f.assistant_content AS conv_assistant
                        FROM "{table_name}" c
                        JOIN chat_search_conversations f ON f.chat_id = c.id
                        WHERE {new_where}
                        ORDER BY CAST(c.updated_at AS REAL) DESC, c.id DESC
                        LIMIT :batch_size
                    """)

            if len(rows) < _REGEX_CURSOR_BATCH_SIZE:
                break

        if not verified_results:
            return {"results": [], "has_more": False, "next_cursor": None, "regex_budget_exhausted": regex_budget_exhausted}

        chat_ids = [r["chat_id"] for r in verified_results]
        snippet_groups = _fetch_message_snippets(
            conn, chat_ids, query, case_sensitive, role,
            is_regex=True, pattern=pattern,
        )

    has_more = regex_budget_exhausted or (last_scanned_row is not None and len(verified_results) >= page_size)
    next_cursor = None
    if has_more and last_scanned_row is not None:
        next_cursor = _encode_cursor(float(last_scanned_row["updated_at"]), last_scanned_row["chat_id"])

    results = []
    for r in verified_results:
        chat_id = r["chat_id"]
        title = r["title"]
        group = snippet_groups.get(chat_id, {"match_count": 0, "matches": []})
        title_display = _prepare_display_text(title)
        title_matched = bool(pattern.search(title_display))

        results.append({
            "chat_id": chat_id,
            "title": title,
            "title_html": _build_title_html(title, query, case_sensitive, is_regex=True, pattern=pattern),
            "updated_at": r["updated_at"],
            "model_id": r["model_id"],
            "title_matched": title_matched,
            "match_count": group["match_count"],
            "matches": group["matches"],
        })

    return {
        "results": results,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "regex_budget_exhausted": regex_budget_exhausted,
    }


def search_messages(
    user_id: str,
    query: str,
    page_size: int = _DEFAULT_PAGE_SIZE,
    cursor: Optional[str] = None,
    role: Optional[str] = None,
    updated_since: Optional[float] = None,
    case_sensitive: bool = False,
    regex: bool = False,
) -> dict:
    """
    Search across all chats for a user.

    Returns dict with:
      - results: list of search result dicts
      - has_more: whether more pages exist
      - next_cursor: cursor string for next page (None if no more)
      - index_status: current search indexing status
      - regex_budget_exhausted: True if regex eval budget was hit
    """
    normalized_query = (
        _normalize_non_regex_query(query) if not regex else (query or "").strip()
    )
    if not normalized_query:
        index_status = start_background_indexing_if_needed()
        return {
            "results": [],
            "has_more": False,
            "next_cursor": None,
            "index_status": index_status,
            "regex_budget_exhausted": False,
        }

    page_size = max(1, min(int(page_size or _DEFAULT_PAGE_SIZE), _MAX_PAGE_SIZE))

    start_background_indexing_if_needed()

    if regex:
        result = _search_regex(
            user_id=user_id,
            query=normalized_query,
            page_size=page_size,
            cursor=cursor,
            role=role,
            updated_since=updated_since,
            case_sensitive=case_sensitive,
        )
        result["index_status"] = get_index_status()
        return result

    result = _search_text(
        user_id=user_id,
        query=normalized_query,
        page_size=page_size,
        cursor=cursor,
        role=role,
        updated_since=updated_since,
        case_sensitive=case_sensitive,
    )
    result["regex_budget_exhausted"] = False
    result["index_status"] = get_index_status()
    return result
