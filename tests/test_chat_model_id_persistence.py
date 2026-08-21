from pathlib import Path
import importlib.util

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
import sqlalchemy as sa


ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = (
    ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "chat_model_id.py"
)
CHAT_MODEL_OVERLAY_PATH = (
    ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "models"
    / "chats.py"
)
SOURCE_PATCH_DIR = (
    ROOT
    / "src"
    / "patches"
    / "backend"
    / "_source_patches"
)
CHAT_MODEL_TRANSFORMER_PATH = (
    ROOT
    / "src"
    / "patches"
    / "backend"
    / "_source_transformers"
    / "patch_openwebui_chat_model_id.py"
)
MIGRATION_PATH = (
    ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "migrations"
    / "versions"
    / "portico_chat_model_id_v1_add_chat_model_id.py"
)
ENTRYPOINT_PATHS = (
    ROOT / "src" / "patches" / "patch-openwebui-entrypoint.sh",
    ROOT / "dev" / "entrypoint-fullstack.sh",
    ROOT / "dev" / "entrypoint.sh",
)
RUNTIME_DOCKERFILES = (
    ROOT / "Dockerfile.open-webui-patched",
    ROOT / "dev" / "Dockerfile.dev",
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


chat_model_id = load_module("tested_chat_model_id", HELPER_PATH)


def test_resolver_follows_only_the_active_branch_and_falls_back_safely():
    chat = {
        "models": ["Primary Model"],
        "history": {
            "currentId": "user-2",
            "messages": {
                "assistant-1": {
                    "role": "assistant",
                    "model": " Active Branch Model ",
                    "parentId": None,
                },
                "user-2": {"role": "user", "parentId": "assistant-1"},
                "inactive": {
                    "role": "assistant",
                    "model": "Inactive Branch Model",
                    "parentId": None,
                },
            },
        },
    }

    assert chat_model_id.resolve_chat_model_id(chat) == "Active Branch Model"

    chat["history"]["currentId"] = "inactive"
    assert chat_model_id.resolve_chat_model_id(chat) == "Inactive Branch Model"

    chat["history"]["messages"]["inactive"]["model"] = "undefined"
    assert chat_model_id.resolve_chat_model_id(chat) == "Primary Model"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"models": ["GPT-5.6"]}, "GPT-5.6"),
        ({"model": "Gemini 3.5 Pro"}, "Gemini 3.5 Pro"),
        (
            {"models": ["  null  "], "model": "Atlas Sonnet 4.6"},
            "Atlas Sonnet 4.6",
        ),
        ({"models": []}, None),
        (None, None),
    ],
)
def test_resolver_handles_fallback_and_malformed_payloads(payload, expected):
    assert chat_model_id.resolve_chat_model_id(payload) == expected


def test_resolver_stops_on_active_branch_cycles():
    chat = {
        "models": ["Cycle Fallback"],
        "history": {
            "currentId": "one",
            "messages": {
                "one": {"role": "user", "parentId": "two"},
                "two": {"role": "user", "parentId": "one"},
            },
        },
    }
    assert chat_model_id.resolve_chat_model_id(chat) == "Cycle Fallback"


def test_complete_overlay_owns_atomic_writes_and_lightweight_reads():
    source = CHAT_MODEL_OVERLAY_PATH.read_text(encoding="utf-8")

    compile(source, str(CHAT_MODEL_OVERLAY_PATH), "exec")
    assert source.startswith(
        "# Complete Portico overlay based on Open WebUI v0.6.43.\n"
    )
    assert len(source.splitlines()) > 1_300
    assert source.count("model_id = Column(Text, nullable=True)") == 1
    assert source.count("    model_id: Optional[str] = None") == 3
    assert source.count('"model_id": resolve_chat_model_id') == 3
    assert "chat_item.model_id = resolve_chat_model_id(cleaned_chat)" in source
    assert "shared_chat.model_id = resolve_chat_model_id(chat.chat)" in source
    assert source.count("Chat.model_id,") == 3
    assert source.count("ChatTitleIdResponse.model_validate(") == 3
    assert (
        "def get_pinned_chats_by_user_id(\n"
        "        self, user_id: str\n"
        "    ) -> list[ChatTitleIdResponse]:"
    ) in source
    assert (
        "def get_chats_by_folder_id_and_user_id(\n"
        "        self, folder_id: str, user_id: str, skip: int = 0, limit: int = 60\n"
        "    ) -> list[ChatTitleIdResponse]:"
    ) in source


def test_complete_overlay_preserves_enriched_usage_and_content_blocks():
    source = CHAT_MODEL_OVERLAY_PATH.read_text(encoding="utf-8")

    assert source.count("existing_usage = existing_message.get(\"usage\")") == 1
    assert source.count("merged_usage = {**existing_usage}") == 1
    assert 'if "contentBlocks" in existing_message and "contentBlocks" not in message:' in source
    assert 'merged_message["contentBlocks"] = existing_message["contentBlocks"]' in source


def test_runtime_uses_complete_overlay_without_chat_source_transformers():
    assert CHAT_MODEL_OVERLAY_PATH.is_file()
    assert not any(SOURCE_PATCH_DIR.glob("*"))
    assert not CHAT_MODEL_TRANSFORMER_PATH.exists()

    for path in ENTRYPOINT_PATHS:
        source = path.read_text(encoding="utf-8")
        assert "_source_patches" not in source
        assert "apply-single-file-patch.sh" not in source
        assert "openwebui-v0.6.43-chat-model-id.patch" not in source
        assert "patch_openwebui_chat_model_id.py" not in source
        assert "PATCH10_EOF" not in source
        assert "PATCH_CHATS_EOF" not in source
        assert "CHATS_MODEL_PY" not in source

    for path in RUNTIME_DOCKERFILES:
        source = path.read_text(encoding="utf-8")
        runtime_stage = source[source.rfind("FROM ") :]
        assert "ca-certificates patch" not in runtime_stage
        assert "\n    patch \\" not in runtime_stage


def test_migration_adds_only_a_nullable_scalar_without_backfilling_history():
    migration_source = MIGRATION_PATH.read_text(encoding="utf-8")
    lowered = migration_source.lower()
    assert "json_extract" not in lowered
    assert "sa.select" not in migration_source
    assert "connection.execute" not in migration_source
    assert 'down_revision: union[str, none] = "portico_title_emoji_v1"' in lowered

    migration = load_module("tested_chat_model_id_migration", MIGRATION_PATH)
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(
            sa.text("CREATE TABLE chat (id TEXT PRIMARY KEY, chat TEXT NOT NULL)")
        )
        original_payload = '{"history":{"messages":{"large":"unchanged"}}}'
        connection.execute(
            sa.text("INSERT INTO chat (id, chat) VALUES ('legacy', :chat)"),
            {"chat": original_payload},
        )

        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        columns = {
            row[1]: row
            for row in connection.execute(sa.text("PRAGMA table_info(chat)")).fetchall()
        }
        row = connection.execute(
            sa.text("SELECT chat, model_id FROM chat WHERE id = 'legacy'")
        ).one()

    assert "model_id" in columns
    assert columns["model_id"][3] == 0
    assert row == (original_payload, None)

    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.downgrade()
        columns_after_downgrade = {
            row[1]
            for row in connection.execute(sa.text("PRAGMA table_info(chat)")).fetchall()
        }
        legacy_payload = connection.execute(
            sa.text("SELECT chat FROM chat WHERE id = 'legacy'")
        ).scalar_one()

    assert "model_id" not in columns_after_downgrade
    assert legacy_payload == original_payload
