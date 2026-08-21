import hashlib
from pathlib import Path
from types import SimpleNamespace
import sys
from urllib.parse import parse_qs

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))

import open_webui.utils.mcp_runtime as mcp_runtime  # noqa: E402
from open_webui.utils.mcp_runtime import (  # noqa: E402
    CHAT_ID_HEADER,
    MESSAGE_ID_HEADER,
    SESSION_ID_HEADER,
    TOOL_CALL_ID_HEADER,
    apply_openwebui_metadata_headers,
    build_openapi_request_headers,
    build_mcp_request_headers,
    call_openapi_tool_with_runtime_headers,
    call_mcp_tool_with_runtime_headers,
    normalize_tool_execution_error,
)


class FakeOAuthClientManager:
    def __init__(self, token=None):
        self.token = token
        self.calls = []

    async def get_oauth_token(self, user_id, server_id):
        self.calls.append((user_id, server_id))
        return self.token


class FakeMCPClient:
    instances = []

    def __init__(self):
        self.connected = []
        self.tool_calls = []
        self.disconnected = False
        FakeMCPClient.instances.append(self)

    async def connect(self, url: str, headers=None):
        self.connected.append({"url": url, "headers": headers})

    async def call_tool(self, function_name: str, function_args: dict):
        self.tool_calls.append(
            {"function_name": function_name, "function_args": function_args}
        )
        return {"ok": True}

    async def disconnect(self):
        self.disconnected = True


class TimeoutMCPClient(FakeMCPClient):
    async def call_tool(self, function_name: str, function_args: dict):
        raise RuntimeError(
            'HTTP error 504: {"message":"tool call failed: Transport send error: '
            'Transport [rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker<mcp_orc::oauth::binding::OAuthStreamableHttpClient<mcp_orc::streamable_http_reqwest_compat::CompatibleReqwestStreamableHttpClient>>>] '
            'error: unexpected server response: HTTP 504 Gateway Timeout: <html>\\r\\n<head><title>504 Gateway Time-out</title></head>\\r\\n<body>\\r\\n<center><h1>504 Gateway Time-out</h1></center>\\r\\n<hr><center>nginx</center>\\r\\n</body>\\r\\n</html>\\r\\n","authorization_url":null}'
        )


class FailingMCPClient(FakeMCPClient):
    async def call_tool(self, function_name: str, function_args: dict):
        raise RuntimeError("tool exploded")


class NoopThread:
    def __init__(self, *args, **kwargs):
        pass

    def start(self):
        pass


class ImmediateThread:
    def __init__(self, target, *args, **kwargs):
        self.target = target

    def start(self):
        self.target()


@pytest.fixture(autouse=True)
def prevent_logrepo_network(monkeypatch):
    monkeypatch.setenv("PORTICO_USER_ID", "ccrescas")
    monkeypatch.setattr(mcp_runtime.threading, "Thread", NoopThread)
    monkeypatch.setattr(
        mcp_runtime.requests,
        "post",
        lambda *args, **kwargs: SimpleNamespace(ok=True, text="uid"),
    )


def make_request(oauth_token=None, bearer="session-token"):
    oauth_manager = FakeOAuthClientManager(oauth_token)
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(oauth_client_manager=oauth_manager)),
        state=SimpleNamespace(token=SimpleNamespace(credentials=bearer)),
    )
    return request, oauth_manager


def make_user(user_id="user-123", email="ccrescas@example.invalid", ldap=None):
    return SimpleNamespace(id=user_id, email=email, ldap=ldap)


def read_authorization_header(headers):
    for key, value in headers.items():
        if str(key).lower() == "authorization":
            return value
    raise AssertionError("Expected Authorization header to be present")


def oversized_tool_call_id():
    return "agent_vm_create_files_ts_" + ("A" * 36812)


def expected_bounded_tool_call_id(value: str):
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return f"{value[:96]}-{digest}"


def test_apply_openwebui_metadata_headers_merges_present_fields():
    headers = apply_openwebui_metadata_headers(
        {"Authorization": "Bearer abc"},
        {
            "chat_id": "chat-1",
            "message_id": "message-1",
            "session_id": "session-1",
            "tool_call_id": "tool-call-1",
        },
    )

    assert headers == {
        "Authorization": "Bearer abc",
        CHAT_ID_HEADER: "chat-1",
        MESSAGE_ID_HEADER: "message-1",
        SESSION_ID_HEADER: "session-1",
        TOOL_CALL_ID_HEADER: "tool-call-1",
    }


def test_apply_openwebui_metadata_headers_bounds_oversized_tool_call_id():
    tool_call_id = oversized_tool_call_id()

    headers = apply_openwebui_metadata_headers(
        {"Authorization": "Bearer abc"},
        {
            "chat_id": "chat-1",
            "message_id": "message-1",
            "tool_call_id": tool_call_id,
        },
    )

    bounded = headers[TOOL_CALL_ID_HEADER]
    assert bounded == expected_bounded_tool_call_id(tool_call_id)
    assert len(bounded) <= mcp_runtime.METADATA_HEADER_VALUE_MAX_CHARS
    assert bounded != tool_call_id
    assert bounded.endswith(hashlib.sha256(tool_call_id.encode("utf-8")).hexdigest())
    assert headers[CHAT_ID_HEADER] == "chat-1"
    assert headers[MESSAGE_ID_HEADER] == "message-1"


def test_apply_openwebui_metadata_headers_bounds_header_unsafe_tool_call_id():
    tool_call_id = "tool-call-with\nunsafe-header"

    headers = apply_openwebui_metadata_headers({}, {"tool_call_id": tool_call_id})

    bounded = headers[TOOL_CALL_ID_HEADER]
    assert "\n" not in bounded
    assert bounded.startswith("tool-call-with_unsafe-header-")
    assert bounded.endswith(hashlib.sha256(tool_call_id.encode("utf-8")).hexdigest())


@pytest.mark.asyncio
async def test_build_mcp_request_headers_includes_bearer_and_metadata_headers():
    request, _ = make_request()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="glean",
        mcp_server_connection={
            "auth_type": "bearer",
            "key": "top-secret",
            "headers": {"X-Custom": "1"},
        },
        extra_params={},
        metadata={"chat_id": "chat-1", "message_id": "msg-1"},
    )

    assert headers["Authorization"] == "Bearer top-secret"
    assert headers["X-Custom"] == "1"
    assert headers[CHAT_ID_HEADER] == "chat-1"
    assert headers[MESSAGE_ID_HEADER] == "msg-1"
    assert TOOL_CALL_ID_HEADER not in headers
    assert SESSION_ID_HEADER not in headers


@pytest.mark.asyncio
async def test_build_mcp_request_headers_bounds_oversized_tool_call_id():
    request, _ = make_request()
    tool_call_id = oversized_tool_call_id()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="agent-vm",
        mcp_server_connection={"auth_type": "none"},
        extra_params={},
        metadata={"chat_id": "chat-agent-vm", "tool_call_id": tool_call_id},
    )

    assert headers[CHAT_ID_HEADER] == "chat-agent-vm"
    assert headers[TOOL_CALL_ID_HEADER] == expected_bounded_tool_call_id(tool_call_id)


@pytest.mark.asyncio
async def test_build_mcp_request_headers_omits_empty_bearer_key():
    request, _ = make_request()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="google_workspace",
        mcp_server_connection={
            "auth_type": "bearer",
            "key": "   ",
        },
        extra_params={},
        metadata={"chat_id": "chat-google"},
    )

    assert "Authorization" not in headers


@pytest.mark.asyncio
async def test_build_mcp_request_headers_uses_oauth_client_manager_for_oauth_21():
    request, oauth_manager = make_request({"access_token": "oauth-token"})

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user("user-42"),
        server_id="server:mcp:glean",
        mcp_server_connection={"auth_type": "oauth_2.1"},
        extra_params={},
        metadata={"chat_id": "chat-1"},
    )

    assert headers["Authorization"] == "Bearer oauth-token"
    assert headers[CHAT_ID_HEADER] == "chat-1"
    assert oauth_manager.calls == [("user-42", "mcp:glean")]


@pytest.mark.asyncio
async def test_build_mcp_request_headers_omits_empty_oauth_21_access_token():
    request, oauth_manager = make_request({"access_token": "   "})

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user("user-42"),
        server_id="server:mcp:glean",
        mcp_server_connection={"auth_type": "oauth_2.1"},
        extra_params={},
        metadata={"chat_id": "chat-1"},
    )

    assert "Authorization" not in headers
    assert oauth_manager.calls == [("user-42", "mcp:glean")]


@pytest.mark.asyncio
async def test_build_mcp_request_headers_omits_empty_system_oauth_access_token():
    request, _ = make_request()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="google_workspace",
        mcp_server_connection={"auth_type": "system_oauth"},
        extra_params={"__oauth_token__": {"access_token": "   "}},
        metadata={"chat_id": "chat-google"},
    )

    assert "Authorization" not in headers


@pytest.mark.asyncio
async def test_build_mcp_request_headers_normalizes_raw_authorization_header_to_bearer():
    request, _ = make_request()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="google_workspace",
        mcp_server_connection={
            "auth_type": "none",
            "headers": {"Authorization": "raw-google-token"},
        },
        extra_params={},
        metadata={"chat_id": "chat-google"},
    )

    assert headers["Authorization"] == "Bearer raw-google-token"


@pytest.mark.asyncio
async def test_build_mcp_request_headers_preserves_existing_authorization_scheme():
    request, _ = make_request()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="google_workspace",
        mcp_server_connection={
            "auth_type": "none",
            "headers": {"Authorization": "Basic abc123"},
        },
        extra_params={},
        metadata={"chat_id": "chat-google"},
    )

    assert headers["Authorization"] == "Basic abc123"


@pytest.mark.asyncio
async def test_build_mcp_request_headers_rejects_malformed_bearer_override():
    request, _ = make_request()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="google_workspace",
        mcp_server_connection={
            "auth_type": "none",
            "headers": {"Authorization": "Bearer"},
        },
        extra_params={},
        metadata={"chat_id": "chat-google"},
    )

    assert "Authorization" not in headers


@pytest.mark.asyncio
async def test_build_mcp_request_headers_keeps_valid_bearer_when_override_is_malformed():
    request, _ = make_request()

    headers = await build_mcp_request_headers(
        request=request,
        user=make_user(),
        server_id="google_workspace",
        mcp_server_connection={
            "auth_type": "bearer",
            "key": "real-token",
            "headers": {"Authorization": "Bearer"},
        },
        extra_params={},
        metadata={"chat_id": "chat-google"},
    )

    assert headers["Authorization"] == "Bearer real-token"


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_uses_current_metadata_for_connect():
    FakeMCPClient.instances.clear()
    request, _ = make_request()

    result = await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user(),
        server_id="glean",
        mcp_server_connection={
            "auth_type": "session",
            "url": "http://mcpo-glean:8000/mcp",
        },
        extra_params={},
        metadata={
            "chat_id": "chat-runtime",
            "message_id": "msg-runtime",
            "session_id": "session-runtime",
            "tool_call_id": "tool-call-runtime",
        },
        function_name="glean_user_activity",
        function_args={"start_date": "2026-03-01"},
    )

    assert result == {"ok": True}
    assert len(FakeMCPClient.instances) == 1
    client = FakeMCPClient.instances[0]
    assert client.connected == [
        {
            "url": "http://mcpo-glean:8000/mcp",
            "headers": {
                "Authorization": "Bearer session-token",
                CHAT_ID_HEADER: "chat-runtime",
                MESSAGE_ID_HEADER: "msg-runtime",
                SESSION_ID_HEADER: "session-runtime",
                TOOL_CALL_ID_HEADER: "tool-call-runtime",
            },
        }
    ]
    assert client.tool_calls == [
        {
            "function_name": "glean_user_activity",
            "function_args": {"start_date": "2026-03-01"},
        }
    ]
    assert client.disconnected is True


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_bounds_header_but_keeps_execution(
    monkeypatch,
):
    FakeMCPClient.instances.clear()
    captured = {}

    def fake_post(*args, **kwargs):
        captured["body"] = kwargs["data"].decode("utf-8")
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()
    tool_call_id = oversized_tool_call_id()

    result = await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user("user-large-id"),
        server_id="agent-vm",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-agent-vm"},
        extra_params={},
        metadata={"chat_id": "chat-large-id", "tool_call_id": tool_call_id},
        function_name="create_files",
        function_args={"vm_id": "vm-1", "files": []},
    )

    expected_id = expected_bounded_tool_call_id(tool_call_id)
    client = FakeMCPClient.instances[0]
    assert result == {"ok": True}
    assert client.connected[0]["headers"][TOOL_CALL_ID_HEADER] == expected_id
    assert client.tool_calls == [
        {
            "function_name": "create_files",
            "function_args": {"vm_id": "vm-1", "files": []},
        }
    ]

    fields = {
        key: values[0]
        for key, values in parse_qs(captured["body"], keep_blank_values=True).items()
    }
    assert fields["tool_call_id"] == expected_id
    assert tool_call_id not in captured["body"]


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_emits_completed_logrepo_event(monkeypatch):
    captured = {}

    def fake_post(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user("user-audit"),
        server_id="datadog",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-datadog"},
        extra_params={},
        metadata={
            "chat_id": "chat-audit",
            "message_id": "msg-audit",
            "session_id": "session-audit",
            "tool_call_id": "tool-call-audit",
            "model": {"id": "agent-audit", "name": "Marketplace Audit Agent"},
        },
        function_name="search_logs",
        function_args={"query": "do-not-log"},
    )

    assert captured["args"] == (mcp_runtime.MCP_LOGREPO_URL,)
    assert captured["kwargs"]["headers"] == {
        "Content-Type": "application/x-www-form-urlencoded"
    }
    assert captured["kwargs"]["timeout"] == 2
    body = captured["kwargs"]["data"].decode("utf-8")
    fields = {key: values[0] for key, values in parse_qs(body).items()}
    assert fields["type"] == "porticoAiChatMcpUsage"
    assert fields["user_id"] == "user-audit"
    assert fields["ldap"] == "ccrescas"
    assert fields["agent_name"] == "Marketplace Audit Agent"
    assert fields["server_id"] == "datadog"
    assert fields["tool_name"] == "search_logs"
    assert fields["outcome"] == "completed"
    assert fields["tool_call_id"] == "tool-call-audit"
    assert fields["chat_id"] == "chat-audit"
    assert fields["message_id"] == "msg-audit"
    assert fields["session_id"] == "session-audit"
    assert int(fields["elapsed_ms"]) >= 0
    assert int(fields["ts"]) > 0
    assert "do-not-log" not in body


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_can_suppress_private_observability(
    monkeypatch,
):
    observed = []
    monkeypatch.setattr(
        mcp_runtime,
        "_log_tool_execution_start",
        lambda *args, **kwargs: observed.append(("start", args, kwargs)),
    )
    monkeypatch.setattr(
        mcp_runtime,
        "_log_tool_execution_finish",
        lambda *args, **kwargs: observed.append(("finish", args, kwargs)),
    )
    monkeypatch.setattr(
        mcp_runtime,
        "_emit_mcp_logrepo_event",
        lambda *args, **kwargs: observed.append(("logrepo", args, kwargs)),
    )
    monkeypatch.setattr(
        mcp_runtime.log,
        "warning",
        lambda *args, **kwargs: observed.append(("warning", args, kwargs)),
    )
    request, _ = make_request()

    for client_factory in (FakeMCPClient, FailingMCPClient):
        await call_mcp_tool_with_runtime_headers(
            client_factory=client_factory,
            request=request,
            user=make_user("private-user"),
            server_id="private-server",
            mcp_server_connection={"auth_type": "none", "url": "unused"},
            extra_params={},
            metadata={
                "chat_id": "private-chat",
                "message_id": "private-message",
                "tool_call_id": "private-call",
            },
            function_name="private-read",
            function_args={"secret": "private"},
            suppress_observability=True,
        )

    assert observed == []


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_logs_agent_vm_skill_name(monkeypatch):
    captured = {}

    def fake_post(*args, **kwargs):
        captured["body"] = kwargs["data"].decode("utf-8")
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user("user-skill"),
        server_id="agent-vm",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-agent-vm"},
        extra_params={},
        metadata={
            "chat_id": "chat-skill",
            "tool_call_id": "tool-call-skill",
            "model": {"id": "agent-skill", "name": "Calibration Agent"},
        },
        function_name="execute_skill_script",
        function_args={
            "skill_name": "calibration-host-live",
            "script_name": "process.py",
            "args": ["do-not-log"],
        },
    )

    fields = {
        key: values[0]
        for key, values in parse_qs(captured["body"], keep_blank_values=True).items()
    }
    assert fields["server_id"] == "agent-vm"
    assert fields["agent_name"] == "Calibration Agent"
    assert fields["tool_name"] == "execute_skill_script"
    assert fields["skill_name"] == "calibration-host-live"
    assert "do-not-log" not in captured["body"]
    assert "process.py" not in captured["body"]


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_logs_skills_activation_skill_name(
    monkeypatch,
):
    captured = {}

    def fake_post(*args, **kwargs):
        captured["body"] = kwargs["data"].decode("utf-8")
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user("user-skill"),
        server_id="skills",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-skills"},
        extra_params={},
        metadata={"chat_id": "chat-skill", "tool_call_id": "tool-call-skill"},
        function_name="skills_activate_skill",
        function_args={
            "skill_name": "local-report-builder",
            "chat_id": "chat-skill",
        },
    )

    fields = {
        key: values[0]
        for key, values in parse_qs(captured["body"], keep_blank_values=True).items()
    }
    assert fields["server_id"] == "skills"
    assert fields["tool_name"] == "skills_activate_skill"
    assert fields["skill_name"] == "local-report-builder"


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_emits_failed_logrepo_event(monkeypatch):
    captured = {}

    def fake_post(*args, **kwargs):
        captured["body"] = kwargs["data"].decode("utf-8")
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    result = await call_mcp_tool_with_runtime_headers(
        client_factory=FailingMCPClient,
        request=request,
        user=make_user("user-failed"),
        server_id="slack",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-slack"},
        extra_params={},
        metadata={"chat_id": "chat-failed", "tool_call_id": "tool-call-failed"},
        function_name="search_messages",
        function_args={"channel": "secret"},
    )

    fields = {key: values[0] for key, values in parse_qs(captured["body"]).items()}
    assert result["is_error"] is True
    assert fields["user_id"] == "user-failed"
    assert fields["ldap"] == "ccrescas"
    assert fields["server_id"] == "slack"
    assert fields["tool_name"] == "search_messages"
    assert fields["outcome"] == "failed"
    assert fields["chat_id"] == "chat-failed"
    assert fields["tool_call_id"] == "tool-call-failed"
    assert "secret" not in captured["body"]


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_ignores_logrepo_failures(monkeypatch):
    def fake_post(*args, **kwargs):
        raise RuntimeError("clip unavailable")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    result = await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user(),
        server_id="glean",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-glean"},
        extra_params={},
        metadata={"chat_id": "chat-runtime"},
        function_name="glean_user_activity",
        function_args={},
    )

    assert result == {"ok": True}


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_warns_when_chat_id_missing(caplog):
    FakeMCPClient.instances.clear()
    request, _ = make_request()

    with caplog.at_level("WARNING"):
        await call_mcp_tool_with_runtime_headers(
            client_factory=FakeMCPClient,
            request=request,
            user=make_user(),
            server_id="glean",
            mcp_server_connection={"auth_type": "none", "url": "http://mcpo-glean"},
            extra_params={},
            metadata={"message_id": "msg-only"},
            function_name="glean_user_activity",
            function_args={},
        )

    assert "Missing chat_id" in caplog.text
    client = FakeMCPClient.instances[0]
    assert client.connected[0]["headers"][MESSAGE_ID_HEADER] == "msg-only"
    assert TOOL_CALL_ID_HEADER in client.connected[0]["headers"]


@pytest.mark.asyncio
async def test_build_openapi_request_headers_includes_metadata_headers():
    request, _ = make_request(bearer="session-bearer")

    headers, cookies = await build_openapi_request_headers(
        request=request,
        user=make_user(),
        tool_server_connection={
            "auth_type": "session",
            "headers": {"X-Custom": "abc"},
        },
        server_id="glean",
        extra_params={},
        metadata={"chat_id": "chat-openapi", "session_id": "session-openapi"},
    )

    assert headers["Content-Type"] == "application/json"
    assert headers["Authorization"] == "Bearer session-bearer"
    assert headers["X-Custom"] == "abc"
    assert headers[CHAT_ID_HEADER] == "chat-openapi"
    assert headers[SESSION_ID_HEADER] == "session-openapi"
    assert TOOL_CALL_ID_HEADER not in headers
    assert cookies == {}


@pytest.mark.asyncio
async def test_build_openapi_request_headers_uses_oauth_client_manager_for_oauth_21():
    request, oauth_manager = make_request({"access_token": "oauth-openapi-token"})

    headers, cookies = await build_openapi_request_headers(
        request=request,
        user=make_user("user-openapi"),
        tool_server_connection={"auth_type": "oauth_2.1"},
        server_id="server:google_workspace",
        extra_params={},
        metadata={"chat_id": "chat-openapi"},
    )

    assert headers["Authorization"] == "Bearer oauth-openapi-token"
    assert headers[CHAT_ID_HEADER] == "chat-openapi"
    assert cookies == {}
    assert oauth_manager.calls == [("user-openapi", "mcp:google_workspace")]


@pytest.mark.asyncio
async def test_build_openapi_request_headers_omits_empty_oauth_21_access_token():
    request, oauth_manager = make_request({"access_token": "   "})

    headers, cookies = await build_openapi_request_headers(
        request=request,
        user=make_user("user-openapi"),
        tool_server_connection={"auth_type": "oauth_2.1"},
        server_id="server:google_workspace",
        extra_params={},
        metadata={"chat_id": "chat-openapi"},
    )

    assert "Authorization" not in headers
    assert cookies == {}
    assert oauth_manager.calls == [("user-openapi", "mcp:google_workspace")]


@pytest.mark.asyncio
async def test_build_openapi_request_headers_bounds_oversized_tool_call_id():
    request, _ = make_request()
    tool_call_id = oversized_tool_call_id()

    headers, cookies = await build_openapi_request_headers(
        request=request,
        user=make_user(),
        tool_server_connection={"auth_type": "none"},
        server_id="agent-vm",
        extra_params={},
        metadata={"chat_id": "chat-openapi", "tool_call_id": tool_call_id},
    )

    assert headers[CHAT_ID_HEADER] == "chat-openapi"
    assert headers[TOOL_CALL_ID_HEADER] == expected_bounded_tool_call_id(tool_call_id)
    assert cookies == {}


@pytest.mark.asyncio
async def test_build_openapi_request_headers_omits_empty_bearer_key():
    request, _ = make_request()

    headers, _cookies = await build_openapi_request_headers(
        request=request,
        user=make_user(),
        tool_server_connection={
            "auth_type": "bearer",
            "key": "",
        },
        server_id="google_workspace",
        extra_params={},
        metadata={"chat_id": "chat-openapi"},
    )

    assert "Authorization" not in headers


@pytest.mark.asyncio
async def test_build_openapi_request_headers_normalizes_raw_authorization_header_to_bearer():
    request, _ = make_request()

    headers, _cookies = await build_openapi_request_headers(
        request=request,
        user=make_user(),
        tool_server_connection={
            "auth_type": "none",
            "headers": {"authorization": "raw-openapi-token"},
        },
        server_id="google_workspace",
        extra_params={},
        metadata={"chat_id": "chat-openapi"},
    )

    assert read_authorization_header(headers) == "Bearer raw-openapi-token"


@pytest.mark.asyncio
async def test_build_openapi_request_headers_rejects_malformed_bearer_override():
    request, _ = make_request()

    headers, _cookies = await build_openapi_request_headers(
        request=request,
        user=make_user(),
        tool_server_connection={
            "auth_type": "none",
            "headers": {"authorization": "Bearer"},
        },
        server_id="google_workspace",
        extra_params={},
        metadata={"chat_id": "chat-openapi"},
    )

    assert "Authorization" not in headers
    assert "authorization" not in headers


@pytest.mark.asyncio
async def test_build_openapi_request_headers_keeps_valid_bearer_when_override_is_malformed():
    request, _ = make_request(bearer="session-bearer")

    headers, _cookies = await build_openapi_request_headers(
        request=request,
        user=make_user(),
        tool_server_connection={
            "auth_type": "session",
            "headers": {"authorization": "Bearer"},
        },
        server_id="google_workspace",
        extra_params={},
        metadata={"chat_id": "chat-openapi"},
    )

    assert headers["Authorization"] == "Bearer session-bearer"


@pytest.mark.asyncio
async def test_call_openapi_tool_with_runtime_headers_executes_with_runtime_metadata():
    captured = {}

    async def fake_execute_tool_server(**kwargs):
        captured.update(kwargs)
        return {"ok": True}, {"content-type": "application/json"}

    request, _ = make_request()
    result = await call_openapi_tool_with_runtime_headers(
        execute_tool_server=fake_execute_tool_server,
        request=request,
        user=make_user(),
        tool_server_connection={"auth_type": "bearer", "key": "abc123"},
        tool_server_data={"id": "glean", "url": "http://mcpo/glean", "openapi": {}},
        extra_params={},
        metadata={
            "chat_id": "chat-openapi",
            "message_id": "message-openapi",
            "session_id": "session-openapi",
            "tool_call_id": "tool-call-openapi",
        },
        function_name="glean_user_activity",
        function_args={"start_date": "2026-03-01"},
    )

    assert result == {"ok": True}
    assert captured["url"] == "http://mcpo/glean"
    assert captured["name"] == "glean_user_activity"
    assert captured["params"] == {"start_date": "2026-03-01"}
    assert captured["headers"]["Authorization"] == "Bearer abc123"
    assert captured["headers"][CHAT_ID_HEADER] == "chat-openapi"
    assert captured["headers"][MESSAGE_ID_HEADER] == "message-openapi"
    assert captured["headers"][SESSION_ID_HEADER] == "session-openapi"
    assert captured["headers"][TOOL_CALL_ID_HEADER] == "tool-call-openapi"


@pytest.mark.asyncio
async def test_call_openapi_tool_with_runtime_headers_bounds_tool_call_id_header():
    captured = {}

    async def fake_execute_tool_server(**kwargs):
        captured.update(kwargs)
        return {"ok": True}, {"content-type": "application/json"}

    request, _ = make_request()
    tool_call_id = oversized_tool_call_id()

    result = await call_openapi_tool_with_runtime_headers(
        execute_tool_server=fake_execute_tool_server,
        request=request,
        user=make_user(),
        tool_server_connection={"auth_type": "none"},
        tool_server_data={
            "id": "agent-vm",
            "url": "http://mcpo/agent-vm",
            "openapi": {},
        },
        extra_params={},
        metadata={"chat_id": "chat-openapi-large-id", "tool_call_id": tool_call_id},
        function_name="create_files",
        function_args={"vm_id": "vm-1", "files": []},
    )

    assert result == {"ok": True}
    assert captured["headers"][TOOL_CALL_ID_HEADER] == expected_bounded_tool_call_id(
        tool_call_id
    )


@pytest.mark.asyncio
async def test_call_openapi_tool_with_runtime_headers_emits_completed_logrepo_event(monkeypatch):
    captured = {}

    async def fake_execute_tool_server(**kwargs):
        return {"ok": True}, {"content-type": "application/json"}

    def fake_post(*args, **kwargs):
        captured["body"] = kwargs["data"].decode("utf-8")
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    result = await call_openapi_tool_with_runtime_headers(
        execute_tool_server=fake_execute_tool_server,
        request=request,
        user=make_user("user-openapi-audit"),
        tool_server_connection={"auth_type": "bearer", "key": "abc123"},
        tool_server_data={"id": "glean", "url": "http://mcpo/glean", "openapi": {}},
        extra_params={},
        metadata={
            "chat_id": "chat-openapi-audit",
            "message_id": "message-openapi-audit",
            "session_id": "session-openapi-audit",
            "tool_call_id": "tool-call-openapi-audit",
            "model": {"id": "agent-openapi", "name": "Research Agent"},
        },
        function_name="glean_search",
        function_args={"query": "do-not-log"},
    )

    fields = {key: values[0] for key, values in parse_qs(captured["body"]).items()}
    assert result == {"ok": True}
    assert fields["type"] == "porticoAiChatMcpUsage"
    assert fields["user_id"] == "user-openapi-audit"
    assert fields["ldap"] == "ccrescas"
    assert fields["agent_name"] == "Research Agent"
    assert fields["server_id"] == "glean"
    assert fields["tool_name"] == "glean_search"
    assert fields["outcome"] == "completed"
    assert fields["tool_call_id"] == "tool-call-openapi-audit"
    assert fields["chat_id"] == "chat-openapi-audit"
    assert fields["message_id"] == "message-openapi-audit"
    assert fields["session_id"] == "session-openapi-audit"
    assert "do-not-log" not in captured["body"]


@pytest.mark.asyncio
async def test_call_openapi_tool_with_runtime_headers_emits_failed_logrepo_event(monkeypatch):
    captured = {}

    async def fake_execute_tool_server(**kwargs):
        raise RuntimeError("openapi tool exploded")

    def fake_post(*args, **kwargs):
        captured["body"] = kwargs["data"].decode("utf-8")
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    result = await call_openapi_tool_with_runtime_headers(
        execute_tool_server=fake_execute_tool_server,
        request=request,
        user=make_user("user-openapi-failed"),
        tool_server_connection={"auth_type": "none"},
        tool_server_data={"id": "glean", "url": "http://mcpo/glean", "openapi": {}},
        extra_params={},
        metadata={"chat_id": "chat-openapi-failed"},
        function_name="glean_search",
        function_args={"query": "do-not-log"},
    )

    fields = {key: values[0] for key, values in parse_qs(captured["body"]).items()}
    assert result["is_error"] is True
    assert fields["user_id"] == "user-openapi-failed"
    assert fields["ldap"] == "ccrescas"
    assert fields["server_id"] == "glean"
    assert fields["tool_name"] == "glean_search"
    assert fields["outcome"] == "failed"
    assert fields["chat_id"] == "chat-openapi-failed"
    assert "do-not-log" not in captured["body"]


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_emits_blank_agent_name_without_model(
    monkeypatch,
):
    captured = {}

    def fake_post(*args, **kwargs):
        captured["body"] = kwargs["data"].decode("utf-8")
        return SimpleNamespace(ok=True, text="uid")

    monkeypatch.setattr(mcp_runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(mcp_runtime.requests, "post", fake_post)
    request, _ = make_request()

    await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user("user-no-agent"),
        server_id="datadog",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-datadog"},
        extra_params={},
        metadata={"chat_id": "chat-no-agent", "tool_call_id": "tool-call-no-agent"},
        function_name="search_logs",
        function_args={"query": "do-not-log"},
    )

    fields = {
        key: values[0]
        for key, values in parse_qs(captured["body"], keep_blank_values=True).items()
    }
    assert fields["agent_name"] == ""
    assert fields["tool_name"] == "search_logs"
    assert "do-not-log" not in captured["body"]


@pytest.mark.asyncio
async def test_call_openapi_tool_with_runtime_headers_forwards_oauth_21_token():
    captured = {}

    async def fake_execute_tool_server(**kwargs):
        captured.update(kwargs)
        return {"ok": True}, {"content-type": "application/json"}

    request, oauth_manager = make_request({"access_token": "oauth-openapi-token"})
    result = await call_openapi_tool_with_runtime_headers(
        execute_tool_server=fake_execute_tool_server,
        request=request,
        user=make_user("user-openapi"),
        tool_server_connection={"auth_type": "oauth_2.1"},
        tool_server_data={
            "id": "google_workspace",
            "url": "http://mcpo/google_workspace",
            "openapi": {},
        },
        extra_params={},
        metadata={"chat_id": "chat-openapi"},
        function_name="get_doc_content",
        function_args={"doc_id": "123"},
    )

    assert result == {"ok": True}
    assert captured["headers"]["Authorization"] == "Bearer oauth-openapi-token"
    assert oauth_manager.calls == [("user-openapi", "mcp:google_workspace")]


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_generates_tool_call_id_when_missing():
    FakeMCPClient.instances.clear()
    request, _ = make_request()

    await call_mcp_tool_with_runtime_headers(
        client_factory=FakeMCPClient,
        request=request,
        user=make_user(),
        server_id="glean",
        mcp_server_connection={"auth_type": "none", "url": "http://mcpo-glean"},
        extra_params={},
        metadata={"chat_id": "chat-runtime"},
        function_name="glean_user_activity",
        function_args={},
    )

    client = FakeMCPClient.instances[0]
    generated_id = client.connected[0]["headers"][TOOL_CALL_ID_HEADER]
    assert isinstance(generated_id, str)
    assert generated_id


def test_normalize_tool_execution_error_preserves_oauth_recovery_fields():
    payload = normalize_tool_execution_error(
        'HTTP error 401: {"message":"OAuth re-authorization required",'
        '"authorization_url":"https://secure.example.invalid/oauth/v2/authorize",'
        '"server_id":"data-plat-mcp","oauth_recovery_required":true,'
        '"force_auth_recommended":true}'
    )

    assert payload["is_error"] is True
    assert payload["authorization_url"] == "https://secure.example.invalid/oauth/v2/authorize"
    assert payload["server_id"] == "data-plat-mcp"
    assert payload["oauth_recovery_required"] is True
    assert payload["force_auth_recommended"] is True
    assert payload["error"]["status_code"] == 401
    assert payload["error"]["error_type"] == "oauth_recovery"


def test_normalize_tool_execution_error_keeps_oauth_and_timeout_classifications_mutually_exclusive():
    payload = normalize_tool_execution_error(
        {
            "message": "OAuth re-authorization required after request timed out",
            "authorization_url": "https://secure.example.invalid/oauth/v2/authorize",
            "oauth_recovery_required": True,
            "force_auth_recommended": True,
            "status_code": 504,
        }
    )

    assert payload["oauth_recovery_required"] is True
    assert payload["error"]["error_type"] == "oauth_recovery"
    assert payload["error"]["error_type"] != "tool_timeout"


def test_normalize_tool_execution_error_handles_malformed_wrapped_http_error_payload():
    payload = normalize_tool_execution_error(
        'HTTP error 504: {"message":"tool call failed"'
    )

    assert payload["is_error"] is True
    assert payload["error"]["status_code"] == 504
    assert payload["error"]["message"]


@pytest.mark.asyncio
async def test_call_mcp_tool_with_runtime_headers_returns_structured_timeout_payload():
    FakeMCPClient.instances.clear()
    request, _ = make_request()

    result = await call_mcp_tool_with_runtime_headers(
        client_factory=TimeoutMCPClient,
        request=request,
        user=make_user(),
        server_id="data-plat-mcp",
        mcp_server_connection={
            "auth_type": "session",
            "url": "http://mcpo-data-plat-mcp:8000/mcp",
        },
        extra_params={},
        metadata={"chat_id": "chat-timeout"},
        function_name="execute_query",
        function_args={"maxWait": 600},
    )

    assert result["is_error"] is True
    assert result["error"]["status_code"] == 504
    assert result["error"]["error_type"] == "tool_timeout"
    assert "narrowing the request scope" in result["error"]["suggested_action"]
