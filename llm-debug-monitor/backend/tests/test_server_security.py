import asyncio

import pytest

from backend import server


def test_sanitize_monitor_event_redacts_secrets_without_clobbering_usage_counts():
    event = {
        "event_type": "llm_request_transformed",
        "data": {
            "provider_headers_raw": {"Authorization": "Bearer secret"},
            "providerHeadersRaw": {"authorization": "Bearer secret-2"},
            "payload": {
                "api_key": "secret-key",
                "prompt_tokens": 123,
                "nested": {
                    "access_token": "secret-token",
                },
            },
        },
    }

    sanitized = server.sanitize_monitor_event(event)

    assert "provider_headers_raw" not in sanitized["data"]
    assert "providerHeadersRaw" not in sanitized["data"]
    assert sanitized["data"]["payload"]["api_key"] == "[REDACTED]"
    assert sanitized["data"]["payload"]["nested"]["access_token"] == "[REDACTED]"
    assert sanitized["data"]["payload"]["prompt_tokens"] == 123


def test_verify_debug_monitor_token_rejects_missing_or_invalid_token():
    original_token = server.DEBUG_MONITOR_TOKEN
    server.DEBUG_MONITOR_TOKEN = "expected-token"
    try:
        server.verify_debug_monitor_token("expected-token")

        with pytest.raises(server.HTTPException) as missing_exc:
            server.verify_debug_monitor_token(None)
        assert missing_exc.value.status_code == 401

        with pytest.raises(server.HTTPException) as invalid_exc:
            server.verify_debug_monitor_token("wrong-token")
        assert invalid_exc.value.status_code == 401
    finally:
        server.DEBUG_MONITOR_TOKEN = original_token


def test_read_secret_env_supports_file_ingress(tmp_path, monkeypatch):
    token_file = tmp_path / "debug-monitor-token"
    token_file.write_text("file-token\n", encoding="utf-8")
    monkeypatch.delenv("DEBUG_MONITOR_TOKEN", raising=False)
    monkeypatch.setenv("DEBUG_MONITOR_TOKEN_FILE", str(token_file))

    assert server.read_secret_env("DEBUG_MONITOR_TOKEN") == "file-token"


def test_read_secret_env_prefers_direct_value(tmp_path, monkeypatch):
    token_file = tmp_path / "debug-monitor-token"
    token_file.write_text("file-token\n", encoding="utf-8")
    monkeypatch.setenv("DEBUG_MONITOR_TOKEN", "direct-token")
    monkeypatch.setenv("DEBUG_MONITOR_TOKEN_FILE", str(token_file))

    assert server.read_secret_env("DEBUG_MONITOR_TOKEN") == "direct-token"


def test_resolve_debug_monitor_token_prefers_debug_then_bifrost_then_local(monkeypatch):
    monkeypatch.setenv("DEBUG_MONITOR_TOKEN", "debug-token")
    monkeypatch.setenv("BIFROST_BRIDGE_LOCAL_API_KEY", "bifrost-token")
    monkeypatch.setenv("LOCAL_STACK_API_KEY", "local-token")
    assert server.resolve_debug_monitor_token() == "debug-token"

    monkeypatch.delenv("DEBUG_MONITOR_TOKEN")
    assert server.resolve_debug_monitor_token() == "bifrost-token"

    monkeypatch.delenv("BIFROST_BRIDGE_LOCAL_API_KEY")
    assert server.resolve_debug_monitor_token() == "local-token"


class _FakeEventSink:
    def __init__(self):
        self.events = []
        self.connection_count = 0

    async def process_event(self, event):
        self.events.append(event)

    async def broadcast(self, event):
        self.events.append(event)


def test_dispatch_monitor_event_drops_deprecated_payloads_before_side_effects():
    store = _FakeEventSink()
    manager = _FakeEventSink()

    dropped = asyncio.run(
        server.dispatch_monitor_event(
            {"event_type": "llm_request_transformed", "data": {"payload": {}}},
            store=store,
            manager=manager,
        )
    )
    assert dropped is False
    assert store.events == []
    assert manager.events == []

    accepted = asyncio.run(
        server.dispatch_monitor_event(
            {
                "event_type": "llm_request_start",
                "chat_id": "chat-1",
                "data": {"model": "safe-model"},
            },
            store=store,
            manager=manager,
        )
    )
    assert accepted is True
    assert len(store.events) == 1
    assert len(manager.events) == 1
