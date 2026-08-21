import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest
from sqlalchemy import Column, Float, MetaData, String, Table, create_engine, text
from sqlalchemy.pool import StaticPool


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "chat_search.py"
)


def build_chat_payload(*messages):
    messages_map = {}
    previous_id = None

    for index, (role, content, timestamp) in enumerate(messages, start=1):
        message_id = f"message-{index}"
        message = {
            "id": message_id,
            "role": role,
            "content": content,
            "timestamp": timestamp,
            "parentId": previous_id,
            "childrenIds": [],
        }
        messages_map[message_id] = message
        if previous_id:
            messages_map[previous_id]["childrenIds"] = [message_id]
        previous_id = message_id

    return {
        "history": {
            "currentId": previous_id,
            "messages": messages_map,
        }
    }


def build_chat_payload_from_messages(messages):
    messages_map = {}
    previous_id = None

    for index, message in enumerate(messages, start=1):
        message_id = f"message-{index}"
        next_message = {
            "id": message_id,
            "role": message["role"],
            "content": message.get("content", ""),
            "timestamp": message["timestamp"],
            "parentId": previous_id,
            "childrenIds": [],
        }
        if "contentBlocks" in message:
            next_message["contentBlocks"] = message["contentBlocks"]
        if "reasoning_content" in message:
            next_message["reasoning_content"] = message["reasoning_content"]
        if "thinking_content" in message:
            next_message["thinking_content"] = message["thinking_content"]
        messages_map[message_id] = next_message
        if previous_id:
            messages_map[previous_id]["childrenIds"] = [message_id]
        previous_id = message_id

    return {
        "history": {
            "currentId": previous_id,
            "messages": messages_map,
        }
    }


def load_chat_search(rows):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    metadata = MetaData()
    chat_table = Table(
        "chat_records",
        metadata,
        Column("id", String, primary_key=True),
        Column("user_id", String, nullable=False),
        Column("title", String),
        Column("model_id", String),
        Column("updated_at", Float),
        Column("chat", String),
    )
    metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            chat_table.insert(),
            [{**row, "model_id": row.get("model_id")} for row in rows],
        )

    open_webui_module = types.ModuleType("open_webui")
    internal_module = types.ModuleType("open_webui.internal")
    db_module = types.ModuleType("open_webui.internal.db")
    db_module.engine = engine
    models_module = types.ModuleType("open_webui.models")
    chats_module = types.ModuleType("open_webui.models.chats")

    class ChatRecord:
        __table__ = chat_table

    chats_module.ChatRecord = ChatRecord
    open_webui_module.internal = internal_module
    open_webui_module.models = models_module
    internal_module.db = db_module
    models_module.chats = chats_module

    injected_modules = {
        "open_webui": open_webui_module,
        "open_webui.internal": internal_module,
        "open_webui.internal.db": db_module,
        "open_webui.models": models_module,
        "open_webui.models.chats": chats_module,
    }
    previous_modules = {name: sys.modules.get(name) for name in injected_modules}
    sys.modules.update(injected_modules)

    spec = importlib.util.spec_from_file_location(
        "chat_search_test_module",
        MODULE_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module, engine, previous_modules


def restore_modules(previous_modules):
    for name, previous_module in previous_modules.items():
        if previous_module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous_module


def assert_empty_result(result):
    assert result["results"] == []
    assert result["has_more"] is False
    assert result.get("next_cursor") is None


def test_ensure_search_populated_skips_invalid_chat_payload_rows():
    rows = [
        {
            "id": "chat-good",
            "user_id": "user-1",
            "title": "Healthy chat",
            "updated_at": 200.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("user", "First question", 100.0),
                    ("assistant", "First answer", 110.0),
                )
            ),
        },
        {
            "id": "chat-bad",
            "user_id": "user-1",
            "title": "Broken chat",
            "updated_at": 150.0,
            "chat": '{"history": ',
        },
    ]
    module, engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()

        with engine.connect() as conn:
            indexed_rows = conn.execute(
                text("SELECT chat_id, message_id FROM chat_search_messages ORDER BY chat_id, message_id")
            ).fetchall()
            conversation_rows = conn.execute(
                text("SELECT chat_id, body_content FROM chat_search_conversations ORDER BY chat_id")
            ).fetchall()
            version = conn.execute(
                text("SELECT value FROM chat_search_meta WHERE key = 'search_version'")
            ).scalar_one()

        assert indexed_rows == [
            ("chat-good", "message-1"),
            ("chat-good", "message-2"),
        ]
        assert conversation_rows == [
            ("chat-good", "First question\nFirst answer"),
        ]
        assert version == module._SEARCH_VERSION
    finally:
        restore_modules(previous_modules)


def test_search_messages_uses_raw_chat_metadata_for_titles_and_filters():
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Docker failures",
            "model_id": "Claude Opus 4.8",
            "updated_at": 300.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("user", "Saw Error while starting containers", 200.0),
                    ("assistant", "Investigating the startup Error", 210.0),
                )
            ),
        },
        {
            "id": "chat-2",
            "user_id": "user-1",
            "title": "Other notes",
            "updated_at": 250.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("user", "error in lowercase only", 205.0),
                    ("assistant", "captured lowercase follow-up", 215.0),
                )
            ),
        },
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(
            user_id="user-1",
            query="Error",
            page_size=10,
            case_sensitive=True,
        )

        assert result["has_more"] is False
        assert [item["title"] for item in result["results"]] == ["Docker failures"]
        assert result["results"][0]["model_id"] == "Claude Opus 4.8"
        assert result["results"][0]["match_count"] == 2
        assert len(result["results"][0]["matches"]) == 2
        assert "Error" in result["results"][0]["matches"][0]["snippet"]
    finally:
        restore_modules(previous_modules)


def test_literal_search_uses_conversation_index_for_newest_first_chat_selection():
    rows = [
        {
            "id": "older-message-newer-chat",
            "user_id": "user-1",
            "title": "Newer updated chat",
            "updated_at": 300.0,
            "chat": json.dumps(
                build_chat_payload(("assistant", "shared needle body", 100.0))
            ),
        },
        {
            "id": "newer-message-older-chat",
            "user_id": "user-1",
            "title": "Older updated chat",
            "updated_at": 100.0,
            "chat": json.dumps(
                build_chat_payload(("assistant", "shared needle body", 900.0))
            ),
        },
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(
            user_id="user-1",
            query="shared needle",
            page_size=10,
        )

        assert [item["chat_id"] for item in result["results"]] == [
            "older-message-newer-chat",
            "newer-message-older-chat",
        ]
        assert result["results"][0]["match_count"] == 1
        assert "shared needle" in result["results"][0]["matches"][0]["snippet"]
    finally:
        restore_modules(previous_modules)


def test_literal_search_role_filters_use_conversation_role_columns():
    rows = [
        {
            "id": "user-match",
            "user_id": "user-1",
            "title": "User match",
            "updated_at": 300.0,
            "chat": json.dumps(build_chat_payload(("user", "role scoped needle", 300.0))),
        },
        {
            "id": "assistant-match",
            "user_id": "user-1",
            "title": "Assistant match",
            "updated_at": 200.0,
            "chat": json.dumps(
                build_chat_payload(("assistant", "role scoped needle", 200.0))
            ),
        },
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(
            user_id="user-1",
            query="role scoped needle",
            role="user",
        )

        assert [item["chat_id"] for item in result["results"]] == ["user-match"]
        assert result["results"][0]["matches"][0]["role"] == "user"
    finally:
        restore_modules(previous_modules)


def test_incremental_indexer_selects_most_recent_chats_first():
    rows = [
        {
            "id": "older",
            "user_id": "user-1",
            "title": "Older chat",
            "updated_at": 100.0,
            "chat": json.dumps(build_chat_payload(("assistant", "older body", 100.0))),
        },
        {
            "id": "newest",
            "user_id": "user-1",
            "title": "Newest chat",
            "updated_at": 300.0,
            "chat": json.dumps(build_chat_payload(("assistant", "newest body", 300.0))),
        },
        {
            "id": "middle",
            "user_id": "user-1",
            "title": "Middle chat",
            "updated_at": 200.0,
            "chat": json.dumps(build_chat_payload(("assistant", "middle body", 200.0))),
        },
    ]
    module, engine, previous_modules = load_chat_search(rows)

    try:
        with engine.connect() as conn:
            module._configure_sqlite_connection(conn)
            module._ensure_search_schema(conn)
            conn.commit()

            first_batch = module._get_next_index_batch(conn, limit=2)
            assert [row["id"] for row in first_batch] == ["newest", "middle"]

            module._index_source_chat_row(conn, first_batch[0])
            conn.commit()

            second_batch = module._get_next_index_batch(conn, limit=2)
            assert [row["id"] for row in second_batch] == ["middle", "older"]
    finally:
        restore_modules(previous_modules)


def test_search_messages_uses_committed_partial_index_while_building():
    rows = [
        {
            "id": "recent",
            "user_id": "user-1",
            "title": "Recent match",
            "updated_at": 300.0,
            "chat": json.dumps(
                build_chat_payload(("assistant", "recent-only searchable body", 300.0))
            ),
        },
        {
            "id": "older",
            "user_id": "user-1",
            "title": "Older match",
            "updated_at": 100.0,
            "chat": json.dumps(
                build_chat_payload(("assistant", "older-only searchable body", 100.0))
            ),
        },
    ]
    module, engine, previous_modules = load_chat_search(rows)

    try:
        with engine.connect() as conn:
            module._configure_sqlite_connection(conn)
            module._ensure_search_schema(conn)
            first_batch = module._get_next_index_batch(conn, limit=1)
            assert [row["id"] for row in first_batch] == ["recent"]
            module._index_source_chat_row(conn, first_batch[0])
            conn.commit()

        partial_status = {
            "state": "building",
            "partial": True,
            "indexed_chats": 1,
            "total_chats": 2,
            "indexed_messages": 1,
            "last_error": None,
        }
        module.start_background_indexing_if_needed = lambda: dict(partial_status)
        module.get_index_status = lambda: dict(partial_status)

        recent_result = module.search_messages(
            user_id="user-1",
            query="recent-only searchable",
        )
        older_result = module.search_messages(
            user_id="user-1",
            query="older-only searchable",
        )

        assert recent_result["index_status"]["partial"] is True
        assert [item["chat_id"] for item in recent_result["results"]] == ["recent"]
        assert_empty_result(older_result)
    finally:
        restore_modules(previous_modules)


def test_old_incompatible_schema_is_recreated_before_partial_search():
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Schema repair chat",
            "updated_at": 100.0,
            "chat": json.dumps(
                build_chat_payload(("assistant", "schema repair searchable", 100.0))
            ),
        }
    ]
    module, engine, previous_modules = load_chat_search(rows)

    try:
        with engine.connect() as conn:
            conn.execute(
                text(
                    """
                    CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
                        chat_id UNINDEXED,
                        message_id UNINDEXED,
                        role UNINDEXED,
                        content,
                        timestamp UNINDEXED,
                        user_id UNINDEXED
                    )
                    """
                )
            )
            conn.execute(text("CREATE TABLE chat_search_meta (key TEXT PRIMARY KEY, value TEXT)"))
            conn.commit()

        module._init_search_tables()

        with engine.connect() as conn:
            columns = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(chat_search_messages)")).fetchall()
            ]
            conversation_columns = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(chat_search_conversations)")).fetchall()
            ]
            assert columns == module._EXPECTED_SEARCH_MESSAGES_COLUMNS
            assert conversation_columns == module._EXPECTED_SEARCH_CONVERSATIONS_COLUMNS
            first_batch = module._get_next_index_batch(conn, limit=1)
            module._index_source_chat_row(conn, first_batch[0])
            conn.commit()

        partial_status = {
            "state": "building",
            "partial": True,
            "indexed_chats": 1,
            "total_chats": 1,
            "indexed_messages": 1,
            "last_error": None,
        }
        module.start_background_indexing_if_needed = lambda: dict(partial_status)
        module.get_index_status = lambda: dict(partial_status)

        result = module.search_messages(user_id="user-1", query="schema repair")

        assert [item["chat_id"] for item in result["results"]] == ["chat-1"]
    finally:
        restore_modules(previous_modules)


def test_sync_chat_to_search_replaces_existing_rows_and_delete_removes_them():
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Ops chat",
            "updated_at": 200.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("user", "timeout while calling service", 100.0),
                    ("assistant", "timeout reproduced", 110.0),
                )
            ),
        }
    ]
    module, engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        initial = module.search_messages(user_id="user-1", query="timeout")
        assert initial["results"][0]["match_count"] == 2

        module.sync_chat_to_search(
            "chat-1",
            "user-1",
            build_chat_payload(
                ("user", "all clear after retry", 120.0),
                ("assistant", "resolved successfully", 130.0),
            ),
        )
        after_sync = module.search_messages(user_id="user-1", query="timeout")
        assert_empty_result(after_sync)

        module.delete_chat_from_search("chat-1")
        after_delete = module.search_messages(user_id="user-1", query="resolved")
        assert_empty_result(after_delete)
        with engine.connect() as conn:
            conversation_count = conn.execute(
                text("SELECT COUNT(*) FROM chat_search_conversations WHERE chat_id = 'chat-1'")
            ).scalar_one()
        assert conversation_count == 0
    finally:
        restore_modules(previous_modules)


def test_reasoning_content_blocks_are_not_searchable():
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Reasoning block chat",
            "updated_at": 200.0,
            "chat": json.dumps(
                build_chat_payload_from_messages(
                    [
                        {
                            "role": "assistant",
                            "content": "Visible final answer",
                            "timestamp": 100.0,
                            "contentBlocks": [
                                {
                                    "type": "reasoning",
                                    "attributes": {"type": "reasoning_content"},
                                    "content": "artifact creation capabilities",
                                },
                                {
                                    "type": "text",
                                    "content": "Visible final answer",
                                },
                            ],
                        }
                    ]
                )
            ),
        }
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(
            user_id="user-1",
            query="artifact creation capabilities",
        )
        assert_empty_result(result)
    finally:
        restore_modules(previous_modules)


def test_legacy_thinking_tags_are_not_searchable():
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Legacy reasoning chat",
            "updated_at": 200.0,
            "chat": json.dumps(
                build_chat_payload(
                    (
                        "assistant",
                        "Before <thinking>private trace payload</thinking> after",
                        100.0,
                    ),
                )
            ),
        }
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        visible_result = module.search_messages(
            user_id="user-1",
            query="after",
        )
        trace_result = module.search_messages(
            user_id="user-1",
            query="private trace payload",
        )

        assert visible_result["results"][0]["match_count"] == 1
        assert_empty_result(trace_result)
    finally:
        restore_modules(previous_modules)


def test_regex_search_raises_non_silent_validation_error():
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Regex chat",
            "updated_at": 100.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("assistant", "error timeout retry", 100.0),
                )
            ),
        }
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        with pytest.raises(ValueError, match="Invalid regular expression"):
            module.search_messages(
                user_id="user-1",
                query="(",
                regex=True,
            )
    finally:
        restore_modules(previous_modules)


def test_regex_search_rejects_alternation_per_n001_contract():
    # Pre-PORTICO-68 the regex search supported alternation. The N-001 ReDoS
    # hardening (see docs/security-hardening-overview.md) explicitly rejects
    # alternation/grouping/backreferences because those constructs prevent the
    # literal-prefilter walker from extracting a required-substring set, so a
    # malicious query could otherwise reach stdlib `re` with no SQL prefilter.
    # The accepted contract: raise ValueError so the router can surface a
    # clear 400 error to the user.
    rows = [
        {
            "id": "chat-foo",
            "user_id": "user-1",
            "title": "Foo chat",
            "updated_at": 200.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("assistant", "foo only match", 200.0),
                )
            ),
        },
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        with pytest.raises(ValueError, match="unsupported features"):
            module.search_messages(
                user_id="user-1",
                query="foo|bar",
                regex=True,
            )
    finally:
        restore_modules(previous_modules)


def test_regex_search_allows_literal_free_pattern_capped_by_eval_budget():
    # Literal-free patterns like ``\d`` have no instr() pre-filter but are
    # still safe: the _REGEX_EVAL_BUDGET caps how many rows the regex engine
    # processes, preventing unbounded scans.
    rows = [
        {
            "id": "chat-digits",
            "user_id": "user-1",
            "title": "Chat with digits",
            "updated_at": 200.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("assistant", "error code 42", 200.0),
                )
            ),
        },
        {
            "id": "chat-no-digits",
            "user_id": "user-1",
            "title": "No digits here",
            "updated_at": 100.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("assistant", "plain text only", 100.0),
                )
            ),
        },
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(
            user_id="user-1",
            query=r"\d",
            regex=True,
            page_size=10,
        )

        assert [item["chat_id"] for item in result["results"]] == ["chat-digits"]
    finally:
        restore_modules(previous_modules)


@pytest.mark.parametrize(
    ("query", "expected_chat_ids"),
    [
        # Full word substring matches
        ("record", ["chat-records"]),
        ("records", ["chat-records"]),
        # Substring prefix still surfaces the message
        ("rec", ["chat-records"]),
        ("reco", ["chat-records"]),
        ("recor", ["chat-records"]),
        # Single character matches any content containing it (substring search)
        ("r", ["chat-records", "chat-unrelated"]),
        # Multi-word substring match (exact phrase, not per-word prefix)
        ("recent records", ["chat-records"]),
    ],
)
def test_partial_word_prefix_search_finds_matching_messages(query, expected_chat_ids):
    rows = [
        {
            "id": "chat-records",
            "user_id": "user-1",
            "title": "Meeting notes",
            "updated_at": 300.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("user", "Can you check the recent records?", 200.0),
                    ("assistant", "I found several records in the database.", 210.0),
                )
            ),
        },
        {
            "id": "chat-unrelated",
            "user_id": "user-1",
            "title": "Unrelated chat",
            "updated_at": 250.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("user", "Hello there", 100.0),
                    ("assistant", "Hi! How can I help?", 110.0),
                )
            ),
        },
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(
            user_id="user-1",
            query=query,
            page_size=10,
        )

        matched_chat_ids = [item["chat_id"] for item in result["results"]]
        assert matched_chat_ids == expected_chat_ids, (
            f"Query {query!r} returned chat_ids={matched_chat_ids}, "
            f"expected {expected_chat_ids}"
        )
        assert result["results"][0]["match_count"] >= 1
    finally:
        restore_modules(previous_modules)


@pytest.mark.parametrize(
    ("query", "expected_match_count", "expected_snippet"),
    [
        ('"hello', 1, '"hello'),
        ("“too”", 1, "“too”"),
        ("server:mcp-assistant", 1, "server:mcp-assistant"),
        ("(foo)", 1, "(foo)"),
        ("{bar}", 1, "{bar}"),
    ],
)
def test_non_regex_search_treats_special_characters_as_literal_text(
    query, expected_match_count, expected_snippet
):
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Literal punctuation chat",
            "updated_at": 100.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("assistant", 'prefix "hello world" suffix', 100.0),
                    ("assistant", "server:mcp-assistant is enabled", 110.0),
                    ("assistant", "literal (foo) and {bar} markers", 120.0),
                    ("assistant", "smart quotes say “too” here", 130.0),
                )
            ),
        }
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(user_id="user-1", query=query)

        assert result["has_more"] is False
        assert result["results"][0]["match_count"] == expected_match_count
        assert expected_snippet in result["results"][0]["matches"][0]["snippet"]
    finally:
        restore_modules(previous_modules)


@pytest.mark.parametrize(
    ("query", "message"),
    [
        ('"', 'message with "quotes"'),
        ("“", "smart quote “ marker"),
        (":", "contains : only"),
        ("(", "contains ( only"),
        ("{", "contains { only"),
    ],
)
def test_non_regex_punctuation_only_queries_still_match_literal_text(query, message):
    rows = [
        {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Punctuation-only chat",
            "updated_at": 100.0,
            "chat": json.dumps(
                build_chat_payload(
                    ("assistant", message, 100.0),
                )
            ),
        }
    ]
    module, _engine, previous_modules = load_chat_search(rows)

    try:
        module.ensure_search_populated()
        result = module.search_messages(user_id="user-1", query=query)

        assert result["has_more"] is False
        assert result["results"][0]["match_count"] == 1
        assert query in result["results"][0]["matches"][0]["snippet"]
    finally:
        restore_modules(previous_modules)
