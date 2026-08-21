import ast
from pathlib import Path
import importlib.util
import sqlite3
import sys
import tempfile
import threading
import types
from types import SimpleNamespace
import unittest
from unittest import mock

import sqlalchemy as sa


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "routers"
    / "tasks.py"
)
CHAT_TITLES_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "chat_titles.py"
)
CHATS_ROUTER_PATH = CHAT_TITLES_PATH.parents[1] / "routers" / "chats.py"
TITLE_MIGRATION_PATH = (
    CHAT_TITLES_PATH.parents[1]
    / "migrations"
    / "versions"
    / "portico_title_emoji_v1_clean_chat_titles.py"
)


def load_module(module_name, path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def load_chat_endpoint_helpers():
    module_ast = ast.parse(
        CHATS_ROUTER_PATH.read_text(encoding="utf-8"),
        filename=str(CHATS_ROUTER_PATH),
    )
    helper_names = {"_sidebar_chat_rows", "search_user_chat_messages"}
    selected_nodes = []
    for node in module_ast.body:
        if isinstance(node, ast.FunctionDef) and node.name in helper_names:
            node.decorator_list = []
            selected_nodes.append(node)

    class Response(dict):
        def __init__(self, **data):
            super().__init__(data)

    class HTTPException(Exception):
        def __init__(self, status_code=None, detail=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    namespace = {
        "Optional": __import__("typing").Optional,
        "Depends": lambda dependency: dependency,
        "get_verified_user": None,
        "MessageSearchResponse": Response,
        "ChatMessageSearchResult": Response,
        "MessageSearchIndexStatus": Response,
        "SidebarChatTitleIdResponse": Response,
        "HTTPException": HTTPException,
        "status": SimpleNamespace(
            HTTP_400_BAD_REQUEST=400,
            HTTP_503_SERVICE_UNAVAILABLE=503,
        ),
        "log": SimpleNamespace(
            warning=lambda *_args, **_kwargs: None,
            exception=lambda *_args, **_kwargs: None,
        ),
    }
    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(CHATS_ROUTER_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace


CHAT_TITLES_MODULE = load_module("tested_chat_titles", CHAT_TITLES_PATH)


def load_tasks_module():
    sentinel = object()
    fastapi_module = types.ModuleType("fastapi")
    fastapi_responses_module = types.ModuleType("fastapi.responses")
    pydantic_module = types.ModuleType("pydantic")

    class APIRouter:
        def get(self, *args, **kwargs):
            return lambda fn: fn

        def post(self, *args, **kwargs):
            return lambda fn: fn

    def Depends(dep):
        return dep

    class HTTPException(Exception):
        def __init__(self, status_code=None, detail=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class Response:
        pass

    class Request:
        pass

    class JSONResponse(dict):
        def __init__(self, status_code=None, content=None):
            super().__init__(content or {})
            self.status_code = status_code
            self.content = content or {}

    class RedirectResponse(JSONResponse):
        pass

    class BaseModel:
        pass

    fastapi_module.APIRouter = APIRouter
    fastapi_module.Depends = Depends
    fastapi_module.HTTPException = HTTPException
    fastapi_module.Response = Response
    fastapi_module.Request = Request
    fastapi_module.status = SimpleNamespace(
        HTTP_200_OK=200,
        HTTP_400_BAD_REQUEST=400,
        HTTP_404_NOT_FOUND=404,
        HTTP_500_INTERNAL_SERVER_ERROR=500,
    )
    fastapi_responses_module.JSONResponse = JSONResponse
    fastapi_responses_module.RedirectResponse = RedirectResponse
    pydantic_module.BaseModel = BaseModel

    open_webui_module = types.ModuleType("open_webui")
    open_webui_module.__path__ = []
    utils_module = types.ModuleType("open_webui.utils")
    utils_module.__path__ = []
    routers_module = types.ModuleType("open_webui.routers")
    routers_module.__path__ = []

    chat_module = types.ModuleType("open_webui.utils.chat")

    async def generate_chat_completion(request, form_data, user):
        return form_data

    chat_module.generate_chat_completion = generate_chat_completion

    task_module = types.ModuleType("open_webui.utils.task")
    task_module.title_generation_template = lambda template, messages, user: template
    task_module.follow_up_generation_template = lambda *args, **kwargs: "follow-up-prompt"
    task_module.query_generation_template = lambda *args, **kwargs: "query-prompt"
    task_module.image_prompt_generation_template = lambda *args, **kwargs: "image-prompt"
    task_module.autocomplete_generation_template = lambda *args, **kwargs: "autocomplete-prompt"
    task_module.tags_generation_template = lambda *args, **kwargs: "tags-prompt"
    task_module.emoji_generation_template = lambda *args, **kwargs: "emoji-prompt"
    task_module.moa_response_generation_template = lambda *args, **kwargs: "moa-prompt"

    def get_task_model_id(model_id, task_model, task_model_external, models):
        if task_model_external and task_model_external in models:
            return task_model_external
        if task_model and task_model in models:
            return task_model
        return model_id

    task_module.get_task_model_id = get_task_model_id

    auth_module = types.ModuleType("open_webui.utils.auth")
    auth_module.get_admin_user = lambda: None
    auth_module.get_verified_user = lambda: None
    llm_debug_module = types.ModuleType("open_webui.utils.llm_debug")

    _llm_counter = {"value": 0}

    def _next_id(prefix: str) -> str:
        _llm_counter["value"] += 1
        return f"{prefix}-{_llm_counter['value']}"

    def build_auxiliary_task_metadata(metadata, *, task_name, task_body, chat_id):
        next_metadata = dict(metadata or {})
        next_metadata["debug_request_id"] = _next_id("dbg")
        next_metadata["message_id"] = _next_id("msg")
        next_metadata["task"] = str(task_name)
        next_metadata["task_body"] = task_body
        next_metadata["chat_id"] = chat_id
        return next_metadata

    def restore_auxiliary_task_metadata(
        metadata, auxiliary_metadata, *, task_name, task_body, chat_id
    ):
        next_metadata = dict(metadata or {})
        for key in (
            "user_id",
            "session_id",
            "message_id",
            "debug_request_id",
            "task",
            "task_body",
            "chat_id",
        ):
            value = auxiliary_metadata.get(key)
            if value is not None:
                next_metadata[key] = value
        next_metadata["task"] = str(task_name)
        next_metadata["task_body"] = task_body
        next_metadata["chat_id"] = chat_id
        return next_metadata

    llm_debug_module.build_auxiliary_task_metadata = build_auxiliary_task_metadata
    llm_debug_module.restore_auxiliary_task_metadata = restore_auxiliary_task_metadata

    constants_module = types.ModuleType("open_webui.constants")
    constants_module.TASKS = SimpleNamespace(
        TITLE_GENERATION="title_generation",
        FOLLOW_UP_GENERATION="follow_up_generation",
        TAGS_GENERATION="tags_generation",
        IMAGE_PROMPT_GENERATION="image_prompt_generation",
        QUERY_GENERATION="query_generation",
        AUTOCOMPLETE_GENERATION="autocomplete_generation",
        EMOJI_GENERATION="emoji_generation",
        MOA_RESPONSE_GENERATION="moa_response_generation",
    )

    pipelines_module = types.ModuleType("open_webui.routers.pipelines")

    async def process_pipeline_inlet_filter(request, payload, user, models):
        return payload

    pipelines_module.process_pipeline_inlet_filter = process_pipeline_inlet_filter

    config_module = types.ModuleType("open_webui.config")
    config_module.DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_FOLLOW_UP_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_TAGS_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_QUERY_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_EMOJI_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_MOA_GENERATION_PROMPT_TEMPLATE = ""
    config_module.DEFAULT_VOICE_MODE_PROMPT_TEMPLATE = ""

    patched_modules = {
        "fastapi": fastapi_module,
        "fastapi.responses": fastapi_responses_module,
        "pydantic": pydantic_module,
        "open_webui": open_webui_module,
        "open_webui.utils": utils_module,
        "open_webui.utils.chat": chat_module,
        "open_webui.utils.task": task_module,
        "open_webui.utils.auth": auth_module,
        "open_webui.utils.llm_debug": llm_debug_module,
        "open_webui.utils.chat_titles": CHAT_TITLES_MODULE,
        "open_webui.constants": constants_module,
        "open_webui.routers": routers_module,
        "open_webui.routers.pipelines": pipelines_module,
        "open_webui.config": config_module,
    }
    original_modules = {
        name: sys.modules.get(name, sentinel) for name in patched_modules
    }

    try:
        sys.modules.update(patched_modules)
        spec = importlib.util.spec_from_file_location("tested_tasks_router", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        for name, original in original_modules.items():
            if original is sentinel:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


TASKS_MODULE = load_tasks_module()


def build_request(models, *, direct_model=None, enable_title_generation=True):
    config = SimpleNamespace(
        TASK_MODEL="",
        TASK_MODEL_EXTERNAL="",
        ENABLE_TITLE_GENERATION=enable_title_generation,
        TITLE_GENERATION_PROMPT_TEMPLATE="",
        FOLLOW_UP_GENERATION_PROMPT_TEMPLATE="",
        TAGS_GENERATION_PROMPT_TEMPLATE="",
        IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE="",
        QUERY_GENERATION_PROMPT_TEMPLATE="",
        AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE="",
    )
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(MODELS=models, config=config)),
        state=SimpleNamespace(
            direct=direct_model is not None,
            model=direct_model,
            metadata={},
        ),
    )


class TaskRouterTests(unittest.IsolatedAsyncioTestCase):

    def test_title_normalizer_removes_complete_emoji_sequences_and_whitespace(self):
        cases = {
            "🌍  Global   Plan": "Global Plan",
            "🇺🇸  Hiring Update": "Hiring Update",
            "1️⃣  Priority List": "Priority List",
            "👩🏽‍💻  Engineering Notes": "Engineering Notes",
            "Text\ufe0f\u200d": "Text",
        }
        for raw_title, expected in cases.items():
            with self.subTest(raw_title=raw_title):
                self.assertEqual(
                    CHAT_TITLES_MODULE.normalize_chat_title(raw_title), expected
                )

        self.assertEqual(
            CHAT_TITLES_MODULE.normalize_chat_title("🤖", "🌍 First   prompt"),
            "First prompt",
        )
        self.assertEqual(
            CHAT_TITLES_MODULE.normalize_chat_title("🤖", "🧠"), "New Chat"
        )

    def test_title_completion_sanitizer_preserves_json_and_removes_emoji(self):
        response = {
            "choices": [
                {
                    "message": {
                        "content": 'prefix {"title":"🌍  Global   Plan","extra":true} suffix'
                    }
                }
            ]
        }

        normalized = CHAT_TITLES_MODULE.sanitize_title_completion_response(response)

        self.assertEqual(
            normalized["choices"][0]["message"]["content"],
            'prefix {"title": "Global Plan", "extra": true} suffix',
        )

    def test_title_migration_cleans_both_copies_and_preserves_updated_at(self):
        db_engine = sa.create_engine("sqlite+pysqlite:///:memory:")
        metadata = sa.MetaData()
        chat = sa.Table(
            "chat",
            metadata,
            sa.Column("id", sa.String, primary_key=True),
            sa.Column("title", sa.Text),
            sa.Column("chat", sa.JSON),
            sa.Column("updated_at", sa.BigInteger),
        )
        metadata.create_all(db_engine)

        with db_engine.begin() as connection:
            connection.execute(
                chat.insert(),
                [
                    {
                        "id": "mixed",
                        "title": "🌍  Weekly   Plan",
                        "chat": {"title": "👩🏽‍💻  Team   Plan"},
                        "updated_at": 111,
                    },
                    {
                        "id": "emoji-only",
                        "title": "🤖",
                        "chat": {"title": "🇺🇸"},
                        "updated_at": 222,
                    },
                ],
            )
            sentinel = object()
            prior = sys.modules.get("open_webui.utils.chat_titles", sentinel)
            sys.modules["open_webui.utils.chat_titles"] = CHAT_TITLES_MODULE
            try:
                migration = load_module("tested_title_migration", TITLE_MIGRATION_PATH)
            finally:
                if prior is sentinel:
                    sys.modules.pop("open_webui.utils.chat_titles", None)
                else:
                    sys.modules["open_webui.utils.chat_titles"] = prior

            migration.op = SimpleNamespace(get_bind=lambda: connection)
            migration.upgrade()
            rows = {
                row.id: row
                for row in connection.execute(sa.select(chat)).mappings()
            }

        self.assertEqual(rows["mixed"].title, "Weekly Plan")
        self.assertEqual(rows["mixed"].chat["title"], "Team Plan")
        self.assertEqual(rows["mixed"].updated_at, 111)
        self.assertEqual(rows["emoji-only"].title, "New Chat")
        self.assertEqual(rows["emoji-only"].chat["title"], "New Chat")
        self.assertEqual(rows["emoji-only"].updated_at, 222)

    def test_large_sidebar_chat_projection_does_not_block_concurrent_write(self):
        helpers = load_chat_endpoint_helpers()
        route_paused = threading.Event()
        release_route = threading.Event()
        legacy_lookup_called = threading.Event()
        route_result = {}

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = Path(temp_dir) / "webui.db"
            setup = sqlite3.connect(db_path)
            self.assertEqual(setup.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
            setup.execute(
                "CREATE TABLE chat (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, chat TEXT)"
            )
            setup.execute(
                "INSERT INTO chat VALUES (?, ?, ?, ?)",
                ("chat-1", "owner", "Large chat", "x" * (2 * 1024 * 1024)),
            )
            setup.commit()
            setup.close()

            class PausedChatRow:
                id = "chat-1"

                def model_dump(self):
                    route_paused.set()
                    if not release_route.wait(5):
                        raise TimeoutError("test did not release sidebar projection")
                    return {
                        "id": self.id,
                        "title": "Large chat",
                        "model_id": "Atlas Opus 4.8",
                        "updated_at": 1,
                        "created_at": 1,
                    }

            def legacy_history_lookup(_user_id, _chat_ids):
                legacy_lookup_called.set()
                reader = sqlite3.connect(db_path)
                reader.execute("BEGIN")
                reader.execute("SELECT chat FROM chat WHERE id = 'chat-1'").fetchone()
                route_paused.set()
                try:
                    if not release_route.wait(5):
                        raise TimeoutError("test did not release legacy history lookup")
                finally:
                    reader.rollback()
                    reader.close()
                return {}

            # If the production helper regresses to the old enrichment call,
            # this injected lookup holds a real rollback-journal read lock and
            # makes the concurrent writer fail with SQLITE_BUSY.
            helpers["_chat_model_ids_for_user"] = legacy_history_lookup

            def run_sidebar_projection():
                try:
                    route_result["rows"] = helpers["_sidebar_chat_rows"](
                        [PausedChatRow()], "owner"
                    )
                except BaseException as error:
                    route_result["error"] = error

            route_thread = threading.Thread(target=run_sidebar_projection)
            route_thread.start()
            self.assertTrue(route_paused.wait(5), "sidebar projection did not start")

            writer_error = None
            writer = sqlite3.connect(db_path, timeout=0.2)
            writer.execute("PRAGMA busy_timeout=200")
            try:
                writer.execute("UPDATE chat SET title = 'Updated' WHERE id = 'chat-1'")
                writer.commit()
            except BaseException as error:
                writer_error = error
            finally:
                writer.close()
                release_route.set()
                route_thread.join(5)

            self.assertFalse(route_thread.is_alive(), "sidebar projection did not finish")
            self.assertNotIn("error", route_result)
            self.assertIsNone(writer_error)
            self.assertFalse(legacy_lookup_called.is_set())
            self.assertEqual(
                route_result["rows"][0]["model_id"], "Atlas Opus 4.8"
            )

            verify = sqlite3.connect(db_path)
            try:
                self.assertEqual(
                    verify.execute("SELECT title FROM chat WHERE id = 'chat-1'").fetchone()[0],
                    "Updated",
                )
            finally:
                verify.close()

        router_source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
        self.assertNotIn("sidebar_chat_models", router_source)
        self.assertNotIn("_chat_model_ids_for_user", router_source)

    def test_message_search_returns_scalar_model_metadata_without_history_lookup(self):
        helpers = load_chat_endpoint_helpers()

        open_webui_module = types.ModuleType("open_webui")
        open_webui_module.__path__ = []
        utils_module = types.ModuleType("open_webui.utils")
        utils_module.__path__ = []
        chat_search_module = types.ModuleType("open_webui.utils.chat_search")

        def search_messages(**_kwargs):
            return {
                "results": [
                    {
                        "chat_id": "chat-1",
                        "title": "Search result",
                        "title_html": "Search result",
                        "updated_at": 123.0,
                        "model_id": "GPT-5.6",
                        "title_matched": True,
                        "match_count": 0,
                        "matches": [],
                    }
                ],
                "has_more": False,
                "next_cursor": None,
                "index_status": {
                    "state": "ready",
                    "partial": False,
                    "indexed_chats": 1,
                    "total_chats": 1,
                    "indexed_messages": 0,
                },
                "regex_budget_exhausted": False,
            }

        chat_search_module.search_messages = search_messages
        patched_modules = {
            "open_webui": open_webui_module,
            "open_webui.utils": utils_module,
            "open_webui.utils.chat_search": chat_search_module,
        }

        with mock.patch.dict(sys.modules, patched_modules):
            response = helpers["search_user_chat_messages"](
                text="Search", user=SimpleNamespace(id="owner")
            )

            self.assertEqual(response["results"][0]["model_id"], "GPT-5.6")

    def test_title_prompt_and_search_index_version_are_emoji_safe(self):
        template = TASKS_MODULE.portico_DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE
        self.assertIn("3-5 word title", template)
        self.assertIn("no emoji", template.lower())
        self.assertNotIn("appropriate emoji", template.lower())
        self.assertEqual(CHAT_TITLES_MODULE.emoji.emoji_list(template), [])

        search_source = (
            CHAT_TITLES_PATH.with_name("chat_search.py").read_text(encoding="utf-8")
        )
        self.assertIn('_SEARCH_VERSION = "11"', search_source)

        middleware_source = (
            CHAT_TITLES_PATH.with_name("middleware.py").read_text(encoding="utf-8")
        )
        self.assertIn("title = normalize_chat_title(", middleware_source)

    def test_get_available_task_models_merges_direct_model_with_registry(self):
        request = build_request(
            {"Atlas Haiku 4.5": {"id": "Atlas Haiku 4.5"}},
            direct_model={"id": "Atlas Opus 4.6", "owned_by": "openai"},
        )

        models = TASKS_MODULE.get_available_task_models(request)

        self.assertEqual(set(models), {"Atlas Haiku 4.5", "Atlas Opus 4.6"})
        self.assertEqual(models["Atlas Opus 4.6"]["owned_by"], "openai")

    def test_get_task_model_config_strips_quotes_from_env_and_fallback(self):
        request = build_request({})
        request.app.state.config.TASK_MODEL = "'Atlas Sonnet 4.6'"
        request.app.state.config.TASK_MODEL_EXTERNAL = '"Atlas Haiku 4.5"'

        with mock.patch.dict(
            TASKS_MODULE.os.environ,
            {
                "TASK_MODEL": '"Atlas Opus 4.6"',
                "TASK_MODEL_EXTERNAL": "'Atlas Haiku 4.5'",
            },
            clear=False,
        ):
            self.assertEqual(
                TASKS_MODULE.get_task_model_config(request),
                ("Atlas Opus 4.6", "Atlas Haiku 4.5"),
            )

        with mock.patch.dict(TASKS_MODULE.os.environ, {}, clear=False):
            TASKS_MODULE.os.environ.pop("TASK_MODEL", None)
            TASKS_MODULE.os.environ.pop("TASK_MODEL_EXTERNAL", None)
            self.assertEqual(
                TASKS_MODULE.get_task_model_config(request),
                ("Atlas Sonnet 4.6", "Atlas Haiku 4.5"),
            )

    async def test_generate_title_uses_external_task_model_for_direct_requests(self):
        task_model_id = "Atlas Haiku 4.5"
        request = build_request(
            {
                task_model_id: {
                    "id": task_model_id,
                    "owned_by": "openai",
                    "info": {"params": {"max_tokens": 123}},
                }
            },
            direct_model={
                "id": "Atlas Opus 4.6",
                "owned_by": "openai",
                "info": {"params": {"max_tokens": 999}},
            },
        )

        with mock.patch.dict(
            TASKS_MODULE.os.environ,
            {"TASK_MODEL_EXTERNAL": f'"{task_model_id}"'},
            clear=False,
        ):
            result = await TASKS_MODULE.generate_title(
                request,
                {
                    "model": "Atlas Opus 4.6",
                    "messages": [{"role": "user", "content": "Summarize this"}],
                    "chat_id": "chat-1",
                },
                SimpleNamespace(email="admin@localhost"),
            )

        self.assertEqual(result["model"], task_model_id)
        self.assertEqual(result["max_completion_tokens"], 123)
        self.assertEqual(result["metadata"]["task"], "title_generation")
        prompt = result["messages"][0]["content"]
        self.assertIn("3-5 word title", prompt)
        self.assertIn("Do not use emoji", prompt)

    async def test_generate_title_sanitizes_model_output_and_custom_templates(self):
        task_model_id = "Atlas Haiku 4.5"
        request = build_request(
            {task_model_id: {"id": task_model_id, "owned_by": "openai"}}
        )
        request.app.state.config.TITLE_GENERATION_PROMPT_TEMPLATE = "Custom title prompt"

        async def emoji_completion(request, form_data, user):
            self.assertIn("Custom title prompt", form_data["messages"][0]["content"])
            self.assertIn("Do not use emoji", form_data["messages"][0]["content"])
            return {
                "choices": [
                    {"message": {"content": '{"title":"🌍  Global   Planning"}'}}
                ]
            }

        with mock.patch.object(
            TASKS_MODULE,
            "generate_chat_completion",
            side_effect=emoji_completion,
        ):
            result = await TASKS_MODULE.generate_title(
                request,
                {
                    "model": task_model_id,
                    "messages": [{"role": "user", "content": "Plan globally"}],
                    "chat_id": "chat-emoji",
                },
                SimpleNamespace(email="admin@localhost"),
            )

        self.assertEqual(
            result["choices"][0]["message"]["content"],
            '{"title": "Global Planning"}',
        )

    async def test_generate_title_replaces_parent_debug_request_and_message_ids(self):
        task_model_id = "Atlas Haiku 4.5"
        request = build_request(
            {
                task_model_id: {
                    "id": task_model_id,
                    "owned_by": "openai",
                    "info": {"params": {"max_tokens": 64}},
                }
            },
            direct_model={
                "id": "Atlas Opus 4.6",
                "owned_by": "openai",
                "info": {"params": {"max_tokens": 999}},
            },
        )
        request.state.metadata = {
            "chat_id": "chat-1",
            "session_id": "session-1",
            "message_id": "parent-message",
            "debug_request_id": "parent-debug",
            "user_id": "user-1",
        }

        async def clobber_metadata(request, payload, user, models):
            payload["metadata"] = {
                **payload.get("metadata", {}),
                "message_id": "parent-message",
                "debug_request_id": "parent-debug",
            }
            return payload

        with mock.patch.dict(
            TASKS_MODULE.os.environ,
            {"TASK_MODEL_EXTERNAL": f'"{task_model_id}"'},
            clear=False,
        ), mock.patch.object(
            TASKS_MODULE,
            "process_pipeline_inlet_filter",
            side_effect=clobber_metadata,
        ):
            result = await TASKS_MODULE.generate_title(
                request,
                {
                    "model": "Atlas Opus 4.6",
                    "messages": [{"role": "user", "content": "Summarize this"}],
                    "chat_id": "chat-1",
                },
                SimpleNamespace(email="admin@localhost"),
            )

        self.assertEqual(result["metadata"]["chat_id"], "chat-1")
        self.assertEqual(result["metadata"]["session_id"], "session-1")
        self.assertEqual(result["metadata"]["user_id"], "user-1")
        self.assertEqual(result["metadata"]["task"], "title_generation")
        self.assertNotEqual(result["metadata"]["message_id"], "parent-message")
        self.assertNotEqual(
            result["metadata"]["debug_request_id"], "parent-debug"
        )
