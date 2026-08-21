import importlib.util
import json
from pathlib import Path
import sys
import types


def _load_redis_client_module(fake_redis_module):
    source_path = (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "integration"
        / "framework"
        / "utils"
        / "redis_client.py"
    )
    spec = importlib.util.spec_from_file_location("integration_redis_client", source_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    previous_redis = sys.modules.get("redis")
    sys.modules["redis"] = fake_redis_module
    try:
        spec.loader.exec_module(module)
    finally:
        if previous_redis is None:
            sys.modules.pop("redis", None)
        else:
            sys.modules["redis"] = previous_redis
    return module


def test_redis_client_reconnects_with_runtime_ip_after_connection_error(monkeypatch):
    class FakeRedisError(Exception):
        pass

    class FakeConnectionError(FakeRedisError):
        pass

    constructed = []

    class FakeRedisHandle:
        def __init__(self, host, port, mode):
            self.host = host
            self.port = port
            self.mode = mode

        def close(self):
            return None

        def ping(self):
            if self.mode == "new":
                return True
            raise FakeConnectionError("stale connection")

        def get(self, key):
            if self.mode == "old":
                raise FakeConnectionError("stale connection")
            return f"value-for-{key}"

    def redis_factory(host, port, **_kwargs):
        mode = "new" if host == "192.168.97.5" else "old"
        constructed.append((host, port, mode))
        return FakeRedisHandle(host, port, mode)

    fake_redis = types.SimpleNamespace(
        Redis=redis_factory,
        exceptions=types.SimpleNamespace(RedisError=FakeRedisError),
    )

    module = _load_redis_client_module(fake_redis)

    def fake_run(cmd, capture_output, check, text, timeout):
        assert cmd[:2] == ["docker", "inspect"]
        return types.SimpleNamespace(
            stdout=json.dumps(
                {"portico-network": {"IPAddress": "192.168.97.5"}}
            )
        )

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    client = module.RedisClient(host="192.168.97.4", port=6379)
    value = client.get("chat_tools:chat-1")

    assert value == "value-for-chat_tools:chat-1"
    assert client.host == "192.168.97.5"
    assert client.port == 6379
    assert constructed == [
        ("192.168.97.4", 6379, "old"),
        ("192.168.97.5", 6379, "new"),
    ]


def test_redis_client_falls_back_to_docker_port_mapping(monkeypatch):
    class FakeRedisError(Exception):
        pass

    class FakeConnectionError(FakeRedisError):
        pass

    constructed = []

    class FakeRedisHandle:
        def __init__(self, host, port, mode):
            self.host = host
            self.port = port
            self.mode = mode

        def close(self):
            return None

        def ping(self):
            if self.mode == "mapped":
                return True
            raise FakeConnectionError("stale connection")

        def get(self, key):
            if self.mode == "old":
                raise FakeConnectionError("stale connection")
            return f"mapped-{key}"

    def redis_factory(host, port, **_kwargs):
        mode = "mapped" if (host, port) == ("127.0.0.1", 46379) else "old"
        constructed.append((host, port, mode))
        return FakeRedisHandle(host, port, mode)

    fake_redis = types.SimpleNamespace(
        Redis=redis_factory,
        exceptions=types.SimpleNamespace(RedisError=FakeRedisError),
    )

    module = _load_redis_client_module(fake_redis)

    def fake_run(cmd, capture_output, check, text, timeout):
        if cmd[:2] == ["docker", "inspect"]:
            return types.SimpleNamespace(stdout="{}")
        if cmd[:2] == ["docker", "port"]:
            return types.SimpleNamespace(stdout="0.0.0.0:46379\n")
        raise AssertionError(f"Unexpected command: {cmd}")

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    client = module.RedisClient(host="192.168.97.4", port=6379)
    value = client.get("chat_tools:chat-2")

    assert value == "mapped-chat_tools:chat-2"
    assert client.host == "127.0.0.1"
    assert client.port == 46379
    assert constructed == [
        ("192.168.97.4", 6379, "old"),
        ("127.0.0.1", 46379, "mapped"),
    ]
