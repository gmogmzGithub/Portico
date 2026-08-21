import asyncio
import importlib.util
from pathlib import Path
import sys
import types


def _load_chat_simulator_module():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "integration"
        / "framework"
        / "tools"
        / "chat_simulator.py"
    )
    module_name = "tests.integration.framework.tools.chat_simulator"
    spec = importlib.util.spec_from_file_location(module_name, source_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None

    previous_modules = {
        name: sys.modules.get(name)
        for name in (
            "tests",
            "tests.integration",
            "tests.integration.framework",
            "tests.integration.framework.tools",
            "tests.integration.framework.tools.assertions",
            "tests.integration.framework.utils",
            "tests.integration.framework.utils.api_client",
            "httpx",
        )
    }

    class HTTPError(Exception):
        pass

    class ConnectError(HTTPError):
        def __init__(self, message, request=None):
            super().__init__(message)
            self.request = request

    class ConnectTimeout(HTTPError):
        pass

    class ReadTimeout(HTTPError):
        pass

    class RemoteProtocolError(HTTPError):
        pass

    class Request:
        def __init__(self, method, url):
            self.method = method
            self.url = url

    fake_httpx = types.SimpleNamespace(
        HTTPError=HTTPError,
        ConnectError=ConnectError,
        ConnectTimeout=ConnectTimeout,
        ReadTimeout=ReadTimeout,
        RemoteProtocolError=RemoteProtocolError,
        Request=Request,
        get=lambda *args, **kwargs: None,
    )

    tests_pkg = types.ModuleType("tests")
    tests_pkg.__path__ = []
    integration_pkg = types.ModuleType("tests.integration")
    integration_pkg.__path__ = []
    framework_pkg = types.ModuleType("tests.integration.framework")
    framework_pkg.__path__ = []
    tools_pkg = types.ModuleType("tests.integration.framework.tools")
    tools_pkg.__path__ = []
    utils_pkg = types.ModuleType("tests.integration.framework.utils")
    utils_pkg.__path__ = []

    async def _default_assert_condition(**_kwargs):
        return None

    assertions_module = types.ModuleType(
        "tests.integration.framework.tools.assertions"
    )
    assertions_module.assert_condition = _default_assert_condition

    api_client_module = types.ModuleType("tests.integration.framework.utils.api_client")

    class DummyOWUIClient:
        def __init__(self, *args, **kwargs):
            self.base_url = kwargs.get("base_url", "http://localhost:3789")

        def close(self):
            return None

    api_client_module.OWUIClient = DummyOWUIClient

    sys.modules["tests"] = tests_pkg
    sys.modules["tests.integration"] = integration_pkg
    sys.modules["tests.integration.framework"] = framework_pkg
    sys.modules["tests.integration.framework.tools"] = tools_pkg
    sys.modules["tests.integration.framework.tools.assertions"] = assertions_module
    sys.modules["tests.integration.framework.utils"] = utils_pkg
    sys.modules["tests.integration.framework.utils.api_client"] = api_client_module
    sys.modules["httpx"] = fake_httpx

    try:
        spec.loader.exec_module(module)
    finally:
        for name, previous in previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous

    return module


def test_simulate_chat_retries_after_connection_refused(monkeypatch):
    module = _load_chat_simulator_module()

    class _FailingClient:
        base_url = "http://localhost:3789"

        def ensure_folder(self, _name):
            request = module.httpx.Request("GET", f"{self.base_url}/api/v1/folders/")
            raise module.httpx.ConnectError("Connection refused", request=request)

    class _SuccessfulClient:
        base_url = "http://localhost:3789"

        def ensure_folder(self, _name):
            return "folder-1"

        def create_chat(self, **_kwargs):
            return {
                "chat_id": "chat-1",
                "user_message_id": "user-1",
                "timestamp": 123,
            }

        def generate_completion(self, **_kwargs):
            return {"task_id": "task-1"}

        def poll_for_completion(self, **_kwargs):
            return {
                "complete": True,
                "assistant_message_id": "assistant-1",
                "content": "done",
                "tool_calls": [],
            }

    attempts = iter([_FailingClient(), _SuccessfulClient()])
    waited = []
    reset_calls = []

    async def _assert_condition(**_kwargs):
        return None

    monkeypatch.setattr(module, "get_client", lambda: next(attempts))
    monkeypatch.setattr(module, "reset_client", lambda: reset_calls.append(True))
    monkeypatch.setattr(
        module,
        "_wait_for_owui_ready",
        lambda **kwargs: waited.append(
            (kwargs.get("base_url"), kwargs.get("timeout_seconds"))
        ),
    )
    monkeypatch.setattr(module, "assert_condition", _assert_condition)

    result = asyncio.run(
        module.simulate_chat(
            prompt="hello",
            wait_for_completion=True,
            timeout_seconds=30,
            auto_assert=False,
        )
    )

    assert result["success"] is True
    assert result["chat_id"] == "chat-1"
    assert waited == [("http://localhost:3789", 30.0)]
    assert reset_calls == [True]


def test_simulate_chat_does_not_retry_non_retryable_errors(monkeypatch):
    module = _load_chat_simulator_module()

    class _BoomClient:
        def ensure_folder(self, _name):
            raise RuntimeError("boom")

    waited = []
    reset_calls = []

    async def _assert_condition(**_kwargs):
        return None

    monkeypatch.setattr(module, "get_client", lambda: _BoomClient())
    monkeypatch.setattr(module, "reset_client", lambda: reset_calls.append(True))
    monkeypatch.setattr(
        module,
        "_wait_for_owui_ready",
        lambda **kwargs: waited.append(
            (kwargs.get("base_url"), kwargs.get("timeout_seconds"))
        ),
    )
    monkeypatch.setattr(module, "assert_condition", _assert_condition)

    result = asyncio.run(
        module.simulate_chat(
            prompt="hello",
            wait_for_completion=True,
            timeout_seconds=30,
            auto_assert=False,
        )
    )

    assert result == {
        "success": False,
        "error": "boom",
        "error_type": "RuntimeError",
    }
    assert waited == []
    assert reset_calls == []


def test_wait_for_owui_ready_retries_until_health_succeeds(monkeypatch):
    module = _load_chat_simulator_module()
    attempts = []

    class _Response:
        def __init__(self, status_code):
            self.status_code = status_code

    def _fake_get(url, timeout):
        attempts.append((url, timeout))
        if len(attempts) == 1:
            request = module.httpx.Request("GET", url)
            raise module.httpx.ConnectError("Connection refused", request=request)
        return _Response(200)

    monkeypatch.setattr(module.httpx, "get", _fake_get)
    monkeypatch.setattr(module.time, "sleep", lambda *_args, **_kwargs: None)

    module._wait_for_owui_ready(
        base_url="http://localhost:3789",
        timeout_seconds=1,
        poll_interval=0,
    )

    assert attempts[0][0] == "http://localhost:3789/health"
    assert attempts[1][0] == "http://localhost:3789"
