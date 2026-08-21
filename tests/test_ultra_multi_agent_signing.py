import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "ultra_multi_agent.py"
)
SPEC = importlib.util.spec_from_file_location(
    "test_ultra_multi_agent_module", MODULE_PATH
)
ULTRA = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ULTRA
SPEC.loader.exec_module(ULTRA)

SECRET = (
    "ultra-sign-v1-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
)


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.subagent_keys = set()

    async def set(self, key, value, nx=False, ex=None):
        assert ex == ULTRA.RUN_TTL_SECONDS
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    async def get(self, key):
        return self.values.get(key)

    async def exists(self, key):
        return key in self.subagent_keys


def request_with(redis, *, with_origin=True):
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(redis=redis)),
        state=SimpleNamespace(),
    )
    if with_origin:
        request.state.portico_ultra_origin = ULTRA.create_server_owned_origin(
            "user-private", "chat-private", "message-private"
        )
    return request


def interactive_metadata():
    return {
        "user_id": "user-private",
        "chat_id": "chat-private",
        "message_id": "message-private",
    }


def ultra_payload():
    return {
        "model": "GPT-5.6 Sol",
        "reasoning_effort": "ultra",
        "stream": True,
        "messages": [{"role": "user", "content": "private prompt"}],
    }


@pytest.fixture(autouse=True)
def signing_secret(monkeypatch):
    monkeypatch.delenv("ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE", raising=False)
    monkeypatch.setenv("ULTRA_MULTI_AGENT_SIGNING_SECRET", SECRET)


def test_background_task_guard_allows_disabled_frontend_flags_only():
    assert not ULTRA.background_tasks_enabled(None)
    assert not ULTRA.background_tasks_enabled({})
    assert not ULTRA.background_tasks_enabled(
        {"title_generation": False, "follow_up_generation": False}
    )
    assert ULTRA.background_tasks_enabled({"follow_up_generation": True})
    assert ULTRA.background_tasks_enabled("scheduled")


@pytest.mark.asyncio
async def test_exact_serialized_body_is_signed_with_only_opaque_identity_headers():
    redis = FakeRedis()
    headers = {"Authorization": "Bearer local-gateway"}
    payload = ultra_payload()
    exact_body = json.dumps(payload)

    admission = await ULTRA.admit_and_sign_request(
        request_with(redis),
        headers,
        exact_body,
        payload,
        SimpleNamespace(id="user-private"),
    )

    assert set(headers) == {
        "Authorization",
        ULTRA.HEADER_KEY_VERSION,
        ULTRA.HEADER_TIMESTAMP,
        ULTRA.HEADER_CONTEXT,
        ULTRA.HEADER_FINGERPRINT,
        ULTRA.HEADER_SIGNATURE,
    }
    dump = json.dumps(headers, sort_keys=True)
    assert "user-private" not in dump
    assert "chat-private" not in dump
    assert "message-private" not in dump
    assert headers[ULTRA.HEADER_CONTEXT] == admission.context_digest
    assert headers[ULTRA.HEADER_FINGERPRINT] == admission.fingerprint

    changed = ULTRA.sign_exact_body(
        SECRET,
        (exact_body + " ").encode(),
        admission.context_digest,
        admission.fingerprint,
        timestamp=int(headers[ULTRA.HEADER_TIMESTAMP]),
    )
    assert changed[ULTRA.HEADER_SIGNATURE] != headers[ULTRA.HEADER_SIGNATURE]


@pytest.mark.asyncio
async def test_concurrent_duplicate_admission_allows_only_one_dispatch():
    redis = FakeRedis()
    payload = ultra_payload()
    exact_body = json.dumps(payload)
    user = SimpleNamespace(id="user-private")

    async def admit_once():
        return await ULTRA.admit_and_sign_request(
            request_with(redis), {}, exact_body, payload, user
        )

    results = await asyncio.gather(admit_once(), admit_once(), return_exceptions=True)
    assert sum(isinstance(result, ULTRA.UltraAdmission) for result in results) == 1
    conflicts = [
        result
        for result in results
        if isinstance(result, HTTPException) and result.status_code == 409
    ]
    assert len(conflicts) == 1


@pytest.mark.asyncio
async def test_direct_router_origin_and_consumed_marker_fail_closed():
    payload = ultra_payload()
    exact_body = json.dumps(payload)
    user = SimpleNamespace(id="user-private")

    with pytest.raises(HTTPException) as exc:
        await ULTRA.admit_and_sign_request(
            request_with(FakeRedis(), with_origin=False),
            {},
            exact_body,
            payload,
            user,
        )
    assert exc.value.status_code == 403

    request = request_with(FakeRedis())
    await ULTRA.admit_and_sign_request(request, {}, exact_body, payload, user)
    with pytest.raises(HTTPException) as exc:
        await ULTRA.admit_and_sign_request(request, {}, exact_body, payload, user)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_subagent_chat_and_missing_redis_fail_closed():
    redis = FakeRedis()
    redis.subagent_keys.add("subagent_chat:chat-private")
    with pytest.raises(HTTPException) as exc:
        await ULTRA.admit_and_sign_request(
            request_with(redis),
            {},
            json.dumps(ultra_payload()),
            ultra_payload(),
            SimpleNamespace(id="user-private"),
        )
    assert exc.value.status_code == 403

    with pytest.raises(HTTPException) as exc:
        await ULTRA.admit_and_sign_request(
            request_with(None),
            {},
            json.dumps(ultra_payload()),
            ultra_payload(),
            SimpleNamespace(id="user-private"),
        )
    assert exc.value.status_code == 503


def test_weak_or_bearer_shaped_secret_is_rejected():
    with pytest.raises(RuntimeError):
        ULTRA.validate_signing_secret("sk-bifrost-local-not-a-signing-secret")
    with pytest.raises(RuntimeError):
        ULTRA.validate_signing_secret("ultra-sign-v1-short")


def test_private_gateway_transport_requires_exact_origin_and_rebuilds_narrow_headers(
    monkeypatch,
):
    monkeypatch.delenv("OPENAI_API_KEY_FILE", raising=False)
    monkeypatch.setenv("OPENAI_API_BASE_URL", "http://llm-gateway:4000/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "local-bridge-key")

    headers, cookies = ULTRA.build_private_gateway_transport(
        "http://llm-gateway:4000/v1",
        "local-bridge-key",
        "http://llm-gateway:4000/v1/chat/completions",
    )
    assert headers == {
        "Content-Type": "application/json",
        "Authorization": "Bearer local-bridge-key",
    }
    assert cookies == {}
    serialized = json.dumps({"headers": headers, "cookies": cookies})
    for forbidden in (
        "chat-private",
        "message-private",
        "user-private",
        "traceparent",
        "baggage",
        "x-openwebui-chat-id",
        "injected-config-header",
    ):
        assert forbidden not in serialized.lower()

    invalid_routes = [
        (
            "http://custom-provider.example/v1",
            "http://custom-provider.example/v1/chat/completions",
        ),
        (
            "http://llm-gateway:4001/v1",
            "http://llm-gateway:4001/v1/chat/completions",
        ),
        (
            "http://llm-gateway:4000/other",
            "http://llm-gateway:4000/other/chat/completions",
        ),
        (
            "http://llm-gateway:4000/v1",
            "http://llm-gateway:4000/v1/chat/completions?injected=1",
        ),
    ]
    for selected, request_url in invalid_routes:
        with pytest.raises(HTTPException) as exc:
            ULTRA.build_private_gateway_transport(
                selected, "local-bridge-key", request_url
            )
        assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        ULTRA.build_private_gateway_transport(
            "http://llm-gateway:4000/v1",
            "stale-or-custom-key",
            "http://llm-gateway:4000/v1/chat/completions",
        )
    assert exc.value.status_code == 403


def test_openai_router_uses_a_cookie_free_no_redirect_private_transport():
    router_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "routers"
        / "openai.py"
    )
    source = router_path.read_text(encoding="utf-8")
    assert "if ultra_candidate:\n        headers, cookies = {}, {}" in source
    assert "build_private_gateway_transport(url, key, request_url)" in source
    assert (
        "cookie_jar=(\n                aiohttp.DummyCookieJar() if ultra_candidate else None"
        in source
    )
    assert (
        '{"User-Agent", "Accept", "Accept-Encoding"} if ultra_candidate else None'
        in source
    )
    assert "allow_redirects=not ultra_candidate" in source
    assert "max_attempts = 1 if ultra_candidate" in source
    assert "test_rate = 0 if ultra_candidate" in source
