import importlib.util
from pathlib import Path
import sys
import types


def _load_api_client_module():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "integration"
        / "framework"
        / "utils"
        / "api_client.py"
    )
    spec = importlib.util.spec_from_file_location("integration_api_client", source_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    previous_httpx = sys.modules.get("httpx")
    fake_httpx = types.SimpleNamespace(
        Client=object,
        HTTPError=Exception,
        get=lambda *args, **kwargs: None,
        post=lambda *args, **kwargs: None,
    )
    sys.modules["httpx"] = fake_httpx
    spec.loader.exec_module(module)
    if previous_httpx is None:
        sys.modules.pop("httpx", None)
    else:
        sys.modules["httpx"] = previous_httpx
    return module


class _DummyResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return dict(self._payload)


class _DummyClient:
    def __init__(self):
        self.calls = []
        self.get_payloads = {}

    def get(self, url):
        self.calls.append({"url": url, "method": "GET"})
        return _DummyResponse(self.get_payloads.get(url, {}))

    def post(self, url, json=None, timeout=None):
        self.calls.append(
            {
                "url": url,
                "json": json,
                "timeout": timeout,
            }
        )
        return _DummyResponse({})


def _make_client():
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://example.test", token="token")
    client.get_model_item = lambda model_id: {"id": model_id}
    client.get_chat_active_capability_tool_ids = lambda _chat_id: [
        "server:mcp-assistant",
        "server:skills",
    ]
    client._generate_session_id = lambda: "session-123"
    client._generate_variables = lambda: {"timezone": "America/New_York"}
    dummy = _DummyClient()
    client._client = dummy
    return client, dummy


def test_generate_completion_defaults_to_non_streaming():
    client, dummy = _make_client()

    result = client.generate_completion(
        chat_id="chat-1",
        model="Atlas Sonnet 4.6",
        prompt="What are my most important meetings this week?",
        user_message_id="user-1",
    )

    assert len(dummy.calls) == 1
    request = dummy.calls[0]["json"]
    assert request["stream"] is False
    assert request["chat_id"] == "chat-1"
    assert request["parent_id"] == "user-1"
    assert request["tool_ids"] == ["server:mcp-assistant", "server:skills"]
    assert result["session_id"] == "session-123"
    assert "message_id" in result


def test_generate_completion_allows_explicit_streaming():
    client, dummy = _make_client()

    client.generate_completion(
        chat_id="chat-2",
        model="GPT-5.4",
        prompt="hello",
        user_message_id="user-2",
        stream=True,
    )

    assert len(dummy.calls) == 1
    request = dummy.calls[0]["json"]
    assert request["stream"] is True


def test_generate_completion_includes_reasoning_effort_when_requested():
    client, dummy = _make_client()

    client.generate_completion(
        chat_id="chat-3",
        model="Atlas Opus 4.7",
        prompt="Solve this logic puzzle.",
        user_message_id="user-3",
        stream=True,
        reasoning_effort="max",
    )

    assert len(dummy.calls) == 1
    request = dummy.calls[0]["json"]
    assert request["params"]["function_calling"] == "native"
    assert request["params"]["reasoning_effort"] == "max"


def test_active_capability_tool_ids_match_frontend_server_id_contract():
    module = _load_api_client_module()
    client = module.OWUIClient(base_url="http://example.test", token="token")
    dummy = _DummyClient()
    dummy.get_payloads["/api/v1/chats/chat-4/active-capabilities"] = {
        "tools": [
            {"server_id": "mcp-assistant"},
            {"server_id": " skills "},
            {"server_id": "mcp-assistant"},
            {"server_id": ""},
            {"display_name": "missing id"},
        ]
    }
    client._client = dummy

    assert client.get_chat_active_capability_tool_ids("chat-4") == [
        "server:mcp-assistant",
        "server:skills",
    ]


def test_generate_completion_accepts_explicit_tool_id_override():
    client, dummy = _make_client()

    client.generate_completion(
        chat_id="chat-5",
        model="Atlas Sonnet 4.6",
        prompt="hello",
        user_message_id="user-5",
        tool_ids=[],
    )

    assert dummy.calls[0]["json"]["tool_ids"] == []
