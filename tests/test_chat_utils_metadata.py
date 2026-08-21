from pathlib import Path
import copy
import importlib.util
import sys
import types
from types import SimpleNamespace
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "chat.py"
)


def load_chat_module():
    sentinel = object()
    aiocache_module = types.ModuleType("aiocache")

    def cached(*args, **kwargs):
        def decorator(fn):
            return fn

        return decorator

    aiocache_module.cached = cached

    fastapi_module = types.ModuleType("fastapi")

    class Request:
        pass

    fastapi_module.Request = Request
    fastapi_module.status = SimpleNamespace(HTTP_200_OK=200)

    starlette_responses_module = types.ModuleType("starlette.responses")

    class Response:
        pass

    class StreamingResponse:
        def __init__(self, body_iterator=None, media_type=None, background=None, headers=None):
            self.body_iterator = body_iterator
            self.media_type = media_type
            self.background = background
            self.headers = headers or {}

    class JSONResponse(dict):
        pass

    class PlainTextResponse:
        def __init__(self, content="", status_code=200, **_kwargs):
            self.body = str(content).encode("utf-8")
            self.status_code = status_code

    starlette_responses_module.Response = Response
    starlette_responses_module.StreamingResponse = StreamingResponse
    starlette_responses_module.JSONResponse = JSONResponse
    starlette_responses_module.PlainTextResponse = PlainTextResponse

    open_webui_module = types.ModuleType("open_webui")
    open_webui_module.__path__ = []
    models_module = types.ModuleType("open_webui.models")
    models_module.__path__ = []
    utils_module = types.ModuleType("open_webui.utils")
    utils_module.__path__ = []
    routers_module = types.ModuleType("open_webui.routers")
    routers_module.__path__ = []

    users_module = types.ModuleType("open_webui.models.users")

    class UserModel:
        def model_dump(self):
            return {}

    users_module.UserModel = UserModel

    socket_main_module = types.ModuleType("open_webui.socket.main")
    socket_main_module.sio = SimpleNamespace(on=lambda *args, **kwargs: None, handlers={"/": {}})
    socket_main_module.get_event_call = lambda metadata: None
    socket_main_module.get_event_emitter = lambda metadata: None

    functions_module = types.ModuleType("open_webui.functions")

    async def generate_function_chat_completion(request, form_data, user=None, models=None):
        return {"form_data": form_data}

    functions_module.generate_function_chat_completion = generate_function_chat_completion

    openai_router_module = types.ModuleType("open_webui.routers.openai")
    capture = {"response": {"ok": True}}

    async def generate_openai_chat_completion(request, form_data, user=None, bypass_filter=False):
        capture["form_data"] = copy.deepcopy(form_data)
        capture["bypass_filter"] = bypass_filter
        exc = capture.get("exception")
        if exc is not None:
            raise exc
        response = capture.get("response", {"ok": True})
        return copy.deepcopy(response)

    openai_router_module.generate_chat_completion = generate_openai_chat_completion

    ollama_router_module = types.ModuleType("open_webui.routers.ollama")

    async def generate_ollama_chat_completion(request, form_data, user=None, bypass_filter=False):
        return {"form_data": form_data}

    ollama_router_module.generate_chat_completion = generate_ollama_chat_completion

    pipelines_module = types.ModuleType("open_webui.routers.pipelines")

    async def process_pipeline_inlet_filter(request, payload, user, models):
        return payload

    async def process_pipeline_outlet_filter(request, payload, user, models):
        return payload

    pipelines_module.process_pipeline_inlet_filter = process_pipeline_inlet_filter
    pipelines_module.process_pipeline_outlet_filter = process_pipeline_outlet_filter

    functions_model_module = types.ModuleType("open_webui.models.functions")

    class Functions:
        @staticmethod
        def get_function_by_id(_id):
            return None

        @staticmethod
        def get_function_valves_by_id(_id):
            return {}

        @staticmethod
        def get_user_valves_by_id_and_user_id(_id, _user_id):
            return {}

    functions_model_module.Functions = Functions

    models_model_module = types.ModuleType("open_webui.models.models")

    class Models:
        @staticmethod
        def get_model_by_id(_id):
            return None

    models_model_module.Models = Models

    plugin_module = types.ModuleType("open_webui.utils.plugin")
    plugin_module.load_function_module_by_id = lambda *args, **kwargs: None
    plugin_module.get_function_module_from_cache = lambda *args, **kwargs: (SimpleNamespace(), None, None)

    models_utils_module = types.ModuleType("open_webui.utils.models")

    async def get_all_models(request, user=None):
        return []

    def check_model_access(user, model):
        return None

    models_utils_module.get_all_models = get_all_models
    models_utils_module.check_model_access = check_model_access

    payload_module = types.ModuleType("open_webui.utils.payload")
    payload_module.convert_payload_openai_to_ollama = lambda form_data: form_data

    response_module = types.ModuleType("open_webui.utils.response")
    response_module.convert_response_ollama_to_openai = lambda response: response
    response_module.convert_streaming_response_ollama_to_openai = lambda response: response

    filter_module = types.ModuleType("open_webui.utils.filter")
    filter_module.get_sorted_filter_ids = lambda request, model, filter_ids=None: []

    async def process_filter_functions(request=None, filter_functions=None, filter_type=None, form_data=None, extra_params=None):
        return form_data, None

    filter_module.process_filter_functions = process_filter_functions

    env_module = types.ModuleType("open_webui.env")
    env_module.GLOBAL_LOG_LEVEL = "INFO"
    env_module.BYPASS_MODEL_ACCESS_CONTROL = False

    llm_debug_module = types.ModuleType("open_webui.utils.llm_debug")
    auxiliary_task_names = {
        "title_generation",
        "follow_up_generation",
        "tags_generation",
        "emoji_generation",
        "query_generation",
        "image_prompt_generation",
        "autocomplete_generation",
        "moa_response_generation",
    }

    def normalize_task_name(task_name):
        if task_name is None:
            return None
        if not isinstance(task_name, str):
            task_name = str(task_name)
        task_name = task_name.strip()
        return task_name or None

    def is_auxiliary_task_name(task_name):
        return normalize_task_name(task_name) in auxiliary_task_names

    llm_debug_module.normalize_task_name = normalize_task_name
    llm_debug_module.is_auxiliary_task_name = is_auxiliary_task_name

    event_publisher_module = types.ModuleType("event_publisher")
    published_events = []

    async def publish_response_complete(**kwargs):
        published_events.append(
            {
                "event_type": "llm_response_complete",
                **kwargs,
            }
        )
        return True

    async def publish_error(**kwargs):
        published_events.append(
            {
                "event_type": "error",
                **kwargs,
            }
        )
        return True

    event_publisher_module.publish_response_complete = publish_response_complete
    event_publisher_module.publish_error = publish_error

    patched_modules = {
        "aiocache": aiocache_module,
        "fastapi": fastapi_module,
        "starlette.responses": starlette_responses_module,
        "open_webui": open_webui_module,
        "open_webui.models": models_module,
        "open_webui.utils": utils_module,
        "open_webui.routers": routers_module,
        "open_webui.models.users": users_module,
        "open_webui.socket.main": socket_main_module,
        "open_webui.functions": functions_module,
        "open_webui.routers.openai": openai_router_module,
        "open_webui.routers.ollama": ollama_router_module,
        "open_webui.routers.pipelines": pipelines_module,
        "open_webui.models.functions": functions_model_module,
        "open_webui.models.models": models_model_module,
        "open_webui.utils.plugin": plugin_module,
        "open_webui.utils.models": models_utils_module,
        "open_webui.utils.payload": payload_module,
        "open_webui.utils.response": response_module,
        "open_webui.utils.filter": filter_module,
        "open_webui.utils.llm_debug": llm_debug_module,
        "open_webui.env": env_module,
        "event_publisher": event_publisher_module,
    }
    original_modules = {
        name: sys.modules.get(name, sentinel) for name in patched_modules
    }

    try:
        sys.modules.update(patched_modules)
        spec = importlib.util.spec_from_file_location("tested_chat_utils", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        module._captured_openai = capture
        module._published_events = published_events
        return module
    finally:
        for name, original in original_modules.items():
            if original is sentinel:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


CHAT_MODULE = load_chat_module()


def build_request(parent_metadata: dict):
    return SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                MODELS={
                    "Claude Haiku 4.5": {
                        "id": "Claude Haiku 4.5",
                        "owned_by": "openai",
                    }
                }
            )
        ),
        state=SimpleNamespace(
            metadata=parent_metadata,
            direct=False,
            model=None,
        ),
    )


class ChatUtilsMetadataTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        CHAT_MODULE._captured_openai.clear()
        CHAT_MODULE._captured_openai["response"] = {"ok": True}
        CHAT_MODULE._published_events.clear()

    async def test_generate_chat_completion_prefers_nested_form_metadata(self):
        request = build_request(
            {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-parent",
                "debug_request_id": "debug-parent",
                "user_id": "user-1",
            }
        )

        form_data = {
            "model": "Claude Haiku 4.5",
            "messages": [{"role": "user", "content": "Summarize this chat"}],
            "stream": False,
            "metadata": {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-child",
                "debug_request_id": "debug-child",
                "task": "title_generation",
            },
        }

        user = SimpleNamespace(role="admin")

        await CHAT_MODULE.generate_chat_completion(
            request,
            form_data,
            user,
        )

        dispatched_metadata = CHAT_MODULE._captured_openai["form_data"]["metadata"]

        self.assertEqual(dispatched_metadata["chat_id"], "chat-parent")
        self.assertEqual(dispatched_metadata["session_id"], "session-parent")
        self.assertEqual(dispatched_metadata["user_id"], "user-1")
        self.assertEqual(dispatched_metadata["task"], "title_generation")
        self.assertEqual(dispatched_metadata["message_id"], "message-child")
        self.assertEqual(dispatched_metadata["debug_request_id"], "debug-child")

    def test_merge_request_and_form_metadata_keeps_parent_defaults(self):
        merged = CHAT_MODULE._merge_request_and_form_metadata(
            {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-parent",
                "debug_request_id": "debug-parent",
                "user_id": "user-1",
            },
            {
                "message_id": "message-child",
                "debug_request_id": "debug-child",
                "task": "title_generation",
            },
        )

        self.assertEqual(
            merged,
            {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-child",
                "debug_request_id": "debug-child",
                "user_id": "user-1",
                "task": "title_generation",
            },
        )

    async def test_generate_chat_completion_publishes_auxiliary_completion_event(self):
        CHAT_MODULE._captured_openai["response"] = {
            "model": "Claude Haiku 4.5",
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": '{"title":"Hello"}',
                        "reasoning_content": "",
                        "tool_calls": [],
                    },
                }
            ],
        }
        request = build_request(
            {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-parent",
                "debug_request_id": "debug-parent",
                "user_id": "user-1",
            }
        )
        form_data = {
            "model": "Claude Haiku 4.5",
            "messages": [{"role": "user", "content": "Summarize this chat"}],
            "stream": False,
            "metadata": {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-child",
                "debug_request_id": "debug-child",
                "task": "title_generation",
            },
        }

        await CHAT_MODULE.generate_chat_completion(
            request,
            form_data,
            SimpleNamespace(role="admin"),
        )

        self.assertEqual(len(CHAT_MODULE._published_events), 1)
        event = CHAT_MODULE._published_events[0]
        self.assertEqual(event["event_type"], "llm_response_complete")
        self.assertEqual(event["debug_request_id"], "debug-child")
        self.assertEqual(event["task_name"], "title_generation")
        self.assertEqual(event["model"], "Claude Haiku 4.5")
        self.assertEqual(event["finish_reason"], "stop")
        self.assertEqual(event["response_content"], '{"title":"Hello"}')

    async def test_generate_chat_completion_publishes_auxiliary_error_event_for_error_payload(self):
        CHAT_MODULE._captured_openai["response"] = {
            "error": {
                "message": "Title generation failed",
            }
        }
        request = build_request(
            {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-parent",
                "debug_request_id": "debug-parent",
                "user_id": "user-1",
            }
        )
        form_data = {
            "model": "Claude Haiku 4.5",
            "messages": [{"role": "user", "content": "Summarize this chat"}],
            "stream": False,
            "metadata": {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-child",
                "debug_request_id": "debug-child",
                "task": "title_generation",
            },
        }

        await CHAT_MODULE.generate_chat_completion(
            request,
            form_data,
            SimpleNamespace(role="admin"),
        )

        self.assertEqual(len(CHAT_MODULE._published_events), 1)
        event = CHAT_MODULE._published_events[0]
        self.assertEqual(event["event_type"], "error")
        self.assertEqual(event["debug_request_id"], "debug-child")
        self.assertEqual(event["task_name"], "title_generation")
        self.assertEqual(event["error"], "Title generation failed")

    async def test_generate_chat_completion_skips_terminal_publish_for_non_auxiliary_request(self):
        CHAT_MODULE._captured_openai["response"] = {
            "model": "Claude Opus 4.6",
            "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": "Hello there",
                    },
                }
            ],
        }
        request = build_request(
            {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-parent",
                "debug_request_id": "debug-parent",
                "user_id": "user-1",
            }
        )
        form_data = {
            "model": "Claude Haiku 4.5",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": False,
            "metadata": {
                "chat_id": "chat-parent",
                "session_id": "session-parent",
                "message_id": "message-child",
                "debug_request_id": "debug-child",
            },
        }

        await CHAT_MODULE.generate_chat_completion(
            request,
            form_data,
            SimpleNamespace(role="admin"),
        )

        self.assertEqual(CHAT_MODULE._published_events, [])
