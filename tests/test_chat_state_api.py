import asyncio
import copy
from datetime import datetime, timedelta
from pathlib import Path
import importlib.util
import sys
import types

try:
    from fastapi import HTTPException
except ImportError:  # pragma: no cover - test fallback when fastapi is absent
    class HTTPException(Exception):
        def __init__(self, status_code=None, detail=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail


MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "chat-state-api" / "main.py"
SPEC = importlib.util.spec_from_file_location("chat_state_api_main", MODULE_PATH)
chat_state_api_main = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader

motor_module = types.ModuleType("motor")
motor_asyncio_module = types.ModuleType("motor.motor_asyncio")
motor_asyncio_module.AsyncIOMotorClient = object
motor_module.motor_asyncio = motor_asyncio_module
sys.modules.setdefault("motor", motor_module)
sys.modules.setdefault("motor.motor_asyncio", motor_asyncio_module)

fastapi_module = types.ModuleType("fastapi")


class _FastAPIStub:
    def __init__(self, *args, **kwargs):
        self.state = types.SimpleNamespace()

    def add_middleware(self, *args, **kwargs):
        return None

    def on_event(self, *args, **kwargs):
        return lambda fn: fn

    def get(self, *args, **kwargs):
        return lambda fn: fn

    def put(self, *args, **kwargs):
        return lambda fn: fn

    def delete(self, *args, **kwargs):
        return lambda fn: fn


fastapi_module.FastAPI = _FastAPIStub
fastapi_module.HTTPException = HTTPException
sys.modules.setdefault("fastapi", fastapi_module)

cors_module = types.ModuleType("fastapi.middleware.cors")
cors_module.CORSMiddleware = object
try:
    import fastapi.middleware.cors  # noqa: F401
except ImportError:
    sys.modules.setdefault("fastapi.middleware.cors", cors_module)

pydantic_module = types.ModuleType("pydantic")


class _BaseModelStub:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


pydantic_module.BaseModel = _BaseModelStub
sys.modules.setdefault("pydantic", pydantic_module)

SPEC.loader.exec_module(chat_state_api_main)


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = copy.deepcopy(docs or {})
        self.update_calls = []
        self.delete_calls = []

    async def find_one(self, query, projection=None):
        doc = self.docs.get(query["_id"])
        return copy.deepcopy(doc) if doc is not None else None

    async def update_one(self, query, update_doc, upsert=False):
        key = query["_id"]
        existing = copy.deepcopy(self.docs.get(key))

        if existing is None and not upsert:
            return types.SimpleNamespace(matched_count=0, modified_count=0)

        if existing is None:
            existing = {}
            existing.update(copy.deepcopy(update_doc.get("$setOnInsert", {})))

        existing.update(copy.deepcopy(update_doc.get("$set", {})))
        self.docs[key] = existing
        self.update_calls.append(
            {
                "query": copy.deepcopy(query),
                "update_doc": copy.deepcopy(update_doc),
                "upsert": upsert,
            }
        )
        return types.SimpleNamespace(matched_count=1, modified_count=1)

    async def delete_one(self, query):
        self.delete_calls.append(copy.deepcopy(query))
        deleted = 1 if self.docs.pop(query["_id"], None) is not None else 0
        return types.SimpleNamespace(deleted_count=deleted)


def _with_fake_collection(fake_collection):
    previous = chat_state_api_main.collection
    chat_state_api_main.collection = fake_collection
    return previous


def test_infer_model_context_window_covers_supported_models():
    assert chat_state_api_main.infer_model_context_window("Claude Sonnet 5") == 1_000_000
    assert chat_state_api_main.infer_model_context_window("Claude Sonnet 4.5") == 0
    assert chat_state_api_main.infer_model_context_window("Claude Opus 5") == 1_000_000
    assert (
        chat_state_api_main.infer_model_context_window("us.anthropic.claude-opus-5")
        == 1_000_000
    )
    assert chat_state_api_main.infer_model_context_window("Claude Opus 4.5") == 0
    assert chat_state_api_main.infer_model_context_window("Claude Opus 4.8") == 1_000_000
    assert chat_state_api_main.infer_model_context_window("Claude Opus 4.7") == 1_000_000
    assert chat_state_api_main.infer_model_context_window("Claude Opus 4.6") == 1_000_000
    assert chat_state_api_main.infer_model_context_window("Claude Sonnet 4.6") == 1_000_000
    assert chat_state_api_main.infer_model_context_window("GPT-5.5") == 1_050_000
    assert chat_state_api_main.infer_model_context_window("GPT-5.6 Sol") == 1_050_000
    assert chat_state_api_main.infer_model_context_window("GPT-5.6 Sol Pro") == 1_050_000
    assert chat_state_api_main.infer_model_context_window("GPT-5.6 Terra") == 1_050_000
    assert chat_state_api_main.infer_model_context_window("GPT-5.6 Luna") == 1_050_000
    assert (
        chat_state_api_main.infer_model_context_window(
            "openai/responses/gpt-5.6-sol:latest"
        )
        == 1_050_000
    )
    assert chat_state_api_main.infer_model_context_window("GPT-5.4") == 1_050_000
    assert chat_state_api_main.normalize_reasoning_effort_value(" XHIGH ") == "xhigh"
    assert chat_state_api_main.normalize_reasoning_effort_value(" NONE ") == "none"
    assert chat_state_api_main.infer_model_context_window("unknown") == 0


def test_ultra_reasoning_persistence_is_restricted_to_gpt_56_sol():
    for sol_alias in (
        "GPT-5.6 Sol",
        "gpt-5.6-sol:latest",
        "openai/responses/gpt-5.6-sol",
        "openai/gpt-5.6-sol",
    ):
        assert chat_state_api_main.is_gpt_56_sol_model(sol_alias)
        assert (
            chat_state_api_main.normalize_reasoning_effort_value(" ULTRA ", sol_alias)
            == "ultra"
        )

    for disallowed_model in (
        None,
        "GPT-5.6 Sol Pro",
        "GPT-5.6 Terra",
        "GPT-5.6 Luna",
        "GPT-5.5",
    ):
        assert not chat_state_api_main.is_gpt_56_sol_model(disallowed_model)
        assert (
            chat_state_api_main.normalize_reasoning_effort_value(
                "ultra", disallowed_model
            )
            is None
        )

    assert chat_state_api_main.normalize_reasoning_effort_by_model(
        {"0": "ultra", "1": "ultra", "2": "none"},
        "GPT-5.6 Sol",
    ) == {"0": "ultra", "2": "none"}
    assert chat_state_api_main.normalize_reasoning_effort_by_model(
        {"0": "ultra", "1": "none"},
        "GPT-5.6 Terra",
    ) == {"1": "none"}


def test_normalize_chat_state_values_clamps_old_rust_opus_state():
    context_tokens, max_context_tokens = chat_state_api_main.normalize_chat_state_values(
        3_034_894,
        200_000,
        "Claude Opus 4.6",
    )

    assert context_tokens == 1_000_000
    assert max_context_tokens == 1_000_000


def test_normalize_chat_state_values_preserves_valid_usage():
    context_tokens, max_context_tokens = chat_state_api_main.normalize_chat_state_values(
        879_408,
        1_000_000,
        "Claude Opus 4.6",
    )

    assert context_tokens == 879_408
    assert max_context_tokens == 1_000_000


def test_canonicalize_reasoning_state_prefers_per_model_map():
    reasoning_effort, reasoning_effort_by_model = (
        chat_state_api_main.canonicalize_reasoning_state(
            "medium",
            {"0": " max ", "1": "high", " ": "low", "2": "invalid"},
        )
    )

    assert reasoning_effort == "max"
    assert reasoning_effort_by_model == {"0": "max", "1": "high"}


def test_canonicalize_reasoning_state_preserves_legacy_only_records():
    reasoning_effort, reasoning_effort_by_model = (
        chat_state_api_main.canonicalize_reasoning_state(" High ", None)
    )

    assert reasoning_effort == "high"
    assert reasoning_effort_by_model is None


def test_canonicalize_reasoning_state_keeps_explicit_empty_map():
    reasoning_effort, reasoning_effort_by_model = (
        chat_state_api_main.canonicalize_reasoning_state("medium", {})
    )

    assert reasoning_effort is None
    assert reasoning_effort_by_model == {}


def test_normalize_reasoning_effort_by_model_drops_invalid_entries_and_sorts_keys():
    assert chat_state_api_main.normalize_reasoning_effort_by_model(None) is None
    assert chat_state_api_main.normalize_reasoning_effort_by_model(["max"]) == {}
    assert chat_state_api_main.normalize_reasoning_effort_by_model(
        {
            " 1 ": " High ",
            "0": "max",
            " ": "medium",
            "2": "invalid",
            3: "low",
        }
    ) == {"0": "max", "1": "high"}


def test_upsert_chat_state_canonicalizes_reasoning_and_persists_primary_effort():
    async def _run():
        fake_collection = FakeCollection()
        previous_collection = _with_fake_collection(fake_collection)

        try:
            response = await chat_state_api_main.upsert_chat_state(
                "chat-1",
                chat_state_api_main.ChatStateInput(
                    context_tokens=42,
                    max_context_tokens=128000,
                    reasoning_effort="medium",
                    reasoning_effort_by_model={"1": " High ", "0": " max ", "2": "invalid"},
                    model_name="Claude Opus 4.6",
                ),
                current_user={"id": "user-1"},
            )
        finally:
            chat_state_api_main.collection = previous_collection

        stored_doc = fake_collection.docs["chat-1"]
        assert response.chat_id == "chat-1"
        assert response.context_tokens == 42
        assert response.max_context_tokens == 1_000_000
        assert response.reasoning_effort == "max"
        assert response.reasoning_effort_by_model == {"0": "max", "1": "high"}
        assert stored_doc["_id"] == "chat-1"
        assert stored_doc["owner_user_id"] == "user-1"
        assert stored_doc["reasoning_effort"] == "max"
        assert stored_doc["reasoning_effort_by_model"] == {"0": "max", "1": "high"}
        assert stored_doc["created_at"] == response.created_at
        assert stored_doc["last_updated"] == response.last_updated
        assert len(fake_collection.update_calls) == 1
        assert fake_collection.update_calls[0]["upsert"] is True

    asyncio.run(_run())


def test_upsert_chat_state_persists_none_and_sol_only_ultra():
    async def _run():
        fake_collection = FakeCollection()
        previous_collection = _with_fake_collection(fake_collection)

        try:
            sol = await chat_state_api_main.upsert_chat_state(
                "chat-sol",
                chat_state_api_main.ChatStateInput(
                    context_tokens=42,
                    max_context_tokens=128000,
                    reasoning_effort_by_model={"0": "ultra"},
                    model_name="GPT-5.6 Sol",
                ),
                current_user={"id": "user-1"},
            )
            pro = await chat_state_api_main.upsert_chat_state(
                "chat-pro",
                chat_state_api_main.ChatStateInput(
                    context_tokens=42,
                    max_context_tokens=128000,
                    reasoning_effort_by_model={"0": "ultra"},
                    model_name="GPT-5.6 Sol Pro",
                ),
                current_user={"id": "user-1"},
            )
            terra = await chat_state_api_main.upsert_chat_state(
                "chat-terra",
                chat_state_api_main.ChatStateInput(
                    context_tokens=42,
                    max_context_tokens=128000,
                    reasoning_effort_by_model={"0": "ultra", "1": "none"},
                    model_name="GPT-5.6 Terra",
                ),
                current_user={"id": "user-1"},
            )
            luna_ultra = await chat_state_api_main.upsert_chat_state(
                "chat-luna",
                chat_state_api_main.ChatStateInput(
                    context_tokens=42,
                    max_context_tokens=128000,
                    reasoning_effort_by_model={"0": "ultra"},
                    model_name="GPT-5.6 Luna",
                ),
                current_user={"id": "user-1"},
            )
            none = await chat_state_api_main.upsert_chat_state(
                "chat-none",
                chat_state_api_main.ChatStateInput(
                    context_tokens=42,
                    max_context_tokens=128000,
                    reasoning_effort="none",
                    model_name="GPT-5.6 Luna",
                ),
                current_user={"id": "user-1"},
            )
        finally:
            chat_state_api_main.collection = previous_collection

        assert sol.max_context_tokens == 1_050_000
        assert sol.reasoning_effort == "ultra"
        assert sol.reasoning_effort_by_model == {"0": "ultra"}
        assert fake_collection.docs["chat-sol"]["reasoning_effort"] == "ultra"
        assert pro.max_context_tokens == 1_050_000
        assert pro.reasoning_effort is None
        assert pro.reasoning_effort_by_model == {}

        assert terra.max_context_tokens == 1_050_000
        assert terra.reasoning_effort is None
        assert terra.reasoning_effort_by_model == {"1": "none"}
        assert fake_collection.docs["chat-terra"]["reasoning_effort_by_model"] == {
            "1": "none"
        }

        assert luna_ultra.max_context_tokens == 1_050_000
        assert luna_ultra.reasoning_effort is None
        assert luna_ultra.reasoning_effort_by_model == {}

        assert none.max_context_tokens == 1_050_000
        assert none.reasoning_effort == "none"
        assert none.reasoning_effort_by_model is None

    asyncio.run(_run())


def test_get_chat_state_clamps_existing_usage_and_prefers_canonical_per_model_reasoning():
    async def _run():
        created_at = datetime.utcnow() - timedelta(hours=1)
        last_updated = created_at + timedelta(minutes=5)
        fake_collection = FakeCollection(
            {
                "chat-2": {
                    "_id": "chat-2",
                    "context_tokens": 3_034_894,
                    "max_context_tokens": 200_000,
                    "reasoning_effort": "medium",
                    "reasoning_effort_by_model": {"0": " max ", "1": "invalid"},
                    "model_name": "Claude Opus 4.6",
                    "owner_user_id": "user-1",
                    "created_at": created_at,
                    "last_updated": last_updated,
                }
            }
        )
        previous_collection = _with_fake_collection(fake_collection)

        try:
            response = await chat_state_api_main.get_chat_state(
                "chat-2", current_user={"id": "user-1"}
            )
        finally:
            chat_state_api_main.collection = previous_collection

        assert response.context_tokens == 1_000_000
        assert response.max_context_tokens == 1_000_000
        assert response.reasoning_effort == "max"
        assert response.reasoning_effort_by_model == {"0": "max"}
        assert response.created_at == created_at
        assert len(fake_collection.update_calls) == 1
        assert fake_collection.docs["chat-2"]["context_tokens"] == 1_000_000
        assert fake_collection.docs["chat-2"]["max_context_tokens"] == 1_000_000
        assert fake_collection.docs["chat-2"]["last_updated"] >= last_updated

    asyncio.run(_run())


def test_get_chat_state_keeps_explicit_empty_reasoning_map_without_inventing_medium():
    async def _run():
        now = datetime.utcnow()
        fake_collection = FakeCollection(
            {
                "chat-3": {
                    "_id": "chat-3",
                    "context_tokens": 10,
                    "max_context_tokens": 1_000_000,
                    "reasoning_effort": "medium",
                    "reasoning_effort_by_model": {},
                    "model_name": "Claude Sonnet 4.6",
                    "owner_user_id": "user-1",
                    "created_at": now,
                    "last_updated": now,
                }
            }
        )
        previous_collection = _with_fake_collection(fake_collection)

        try:
            response = await chat_state_api_main.get_chat_state(
                "chat-3", current_user={"id": "user-1"}
            )
        finally:
            chat_state_api_main.collection = previous_collection

        assert response.reasoning_effort is None
        assert response.reasoning_effort_by_model == {}
        assert fake_collection.update_calls == []

    asyncio.run(_run())


def test_normalize_fast_mode_flag_is_strict_bool():
    assert chat_state_api_main.normalize_fast_mode_flag(True) is True
    assert chat_state_api_main.normalize_fast_mode_flag(False) is False
    for junk in (None, 1, 0, "true", "True", "", {}, [], "on"):
        assert chat_state_api_main.normalize_fast_mode_flag(junk) is None


def test_upsert_chat_state_persists_and_preserves_fast_mode():
    async def _run():
        fake_collection = FakeCollection()
        previous_collection = _with_fake_collection(fake_collection)

        try:
            enabled = await chat_state_api_main.upsert_chat_state(
                "chat-fast",
                chat_state_api_main.ChatStateInput(
                    context_tokens=42,
                    max_context_tokens=128000,
                    fast_mode=True,
                    model_name="GPT-5.6 Sol",
                ),
                current_user={"id": "user-1"},
            )
            # A writer that omits the field (older client, reasoning-only save)
            # must not clobber the stored toggle.
            omitted = await chat_state_api_main.upsert_chat_state(
                "chat-fast",
                chat_state_api_main.ChatStateInput(
                    context_tokens=64,
                    max_context_tokens=128000,
                    model_name="GPT-5.6 Sol",
                ),
                current_user={"id": "user-1"},
            )
            disabled = await chat_state_api_main.upsert_chat_state(
                "chat-fast",
                chat_state_api_main.ChatStateInput(
                    context_tokens=64,
                    max_context_tokens=128000,
                    fast_mode=False,
                    model_name="GPT-5.6 Sol",
                ),
                current_user={"id": "user-1"},
            )
        finally:
            chat_state_api_main.collection = previous_collection

        assert enabled.fast_mode is True
        assert omitted.fast_mode is True
        assert fake_collection.docs["chat-fast"]["fast_mode"] is False
        assert disabled.fast_mode is False

    asyncio.run(_run())


def test_get_chat_state_normalizes_junk_fast_mode_values():
    async def _run():
        now = datetime.utcnow()
        fake_collection = FakeCollection(
            {
                "chat-junk": {
                    "_id": "chat-junk",
                    "context_tokens": 10,
                    "max_context_tokens": 1_050_000,
                    "fast_mode": "yes",
                    "model_name": "GPT-5.6 Luna",
                    "owner_user_id": "user-1",
                    "created_at": now,
                    "last_updated": now,
                },
                "chat-on": {
                    "_id": "chat-on",
                    "context_tokens": 10,
                    "max_context_tokens": 1_050_000,
                    "fast_mode": True,
                    "model_name": "GPT-5.6 Luna",
                    "owner_user_id": "user-1",
                    "created_at": now,
                    "last_updated": now,
                },
            }
        )
        previous_collection = _with_fake_collection(fake_collection)

        try:
            junk = await chat_state_api_main.get_chat_state(
                "chat-junk", current_user={"id": "user-1"}
            )
            enabled = await chat_state_api_main.get_chat_state(
                "chat-on", current_user={"id": "user-1"}
            )
        finally:
            chat_state_api_main.collection = previous_collection

        assert junk.fast_mode is None
        assert enabled.fast_mode is True

    asyncio.run(_run())


def test_get_chat_state_raises_404_for_missing_chat():
    async def _run():
        fake_collection = FakeCollection()
        previous_collection = _with_fake_collection(fake_collection)

        try:
            try:
                await chat_state_api_main.get_chat_state("missing-chat")
            except HTTPException as exc:
                assert exc.status_code == 404
                assert exc.detail == "Chat state not found"
            else:
                raise AssertionError("Expected HTTPException for missing chat state")
        finally:
            chat_state_api_main.collection = previous_collection

    asyncio.run(_run())


def test_parse_allowed_origins_defaults_to_loopback_webui_hosts():
    assert chat_state_api_main.parse_allowed_origins(None) == [
        "http://localhost:3789",
        "http://127.0.0.1:3789",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]


def test_extract_bearer_token_rejects_missing_or_invalid_headers():
    assert chat_state_api_main.extract_bearer_token("Bearer token-123") == "token-123"

    try:
        chat_state_api_main.extract_bearer_token(None)
    except chat_state_api_main.HTTPException as exc:
        assert exc.status_code == 401
    else:
        raise AssertionError("Expected missing Authorization header to fail")

    try:
        chat_state_api_main.extract_bearer_token("Basic abc123")
    except chat_state_api_main.HTTPException as exc:
        assert exc.status_code == 401
    else:
        raise AssertionError("Expected invalid Authorization header to fail")


def test_openwebui_auth_timeout_becomes_service_unavailable():
    previous_urlopen = chat_state_api_main.urllib_request.urlopen

    def _raise_timeout(*_args, **_kwargs):
        raise TimeoutError("timed out")

    chat_state_api_main.urllib_request.urlopen = _raise_timeout
    try:
        try:
            chat_state_api_main.fetch_openwebui_user_sync("secret-token")
        except chat_state_api_main.HTTPException as exc:
            assert exc.status_code == 503
            assert exc.detail == "Authentication service unavailable"
        else:
            raise AssertionError("Expected an upstream auth timeout to fail closed")
    finally:
        chat_state_api_main.urllib_request.urlopen = previous_urlopen


def test_openwebui_auth_timeout_response_keeps_cors_headers():
    if not hasattr(chat_state_api_main.app, "build_middleware_stack"):
        return

    from fastapi.testclient import TestClient

    previous_urlopen = chat_state_api_main.urllib_request.urlopen

    def _raise_timeout(*_args, **_kwargs):
        raise TimeoutError("timed out")

    chat_state_api_main.urllib_request.urlopen = _raise_timeout
    test_client = TestClient(chat_state_api_main.app)
    try:
        response = test_client.get(
            "/api/v1/chat-state/chat-timeout",
            headers={
                "Authorization": "Bearer secret-token",
                "Origin": "http://localhost:3789",
            },
        )

        assert response.status_code == 503
        assert response.json() == {"detail": "Authentication service unavailable"}
        assert response.headers["access-control-allow-origin"] == "http://localhost:3789"
    finally:
        test_client.close()
        chat_state_api_main.urllib_request.urlopen = previous_urlopen
