#!/usr/bin/env python3
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


EXPECTED_HEADERS = {
    "authorization": "Bearer key",
    "x-portico-userid": "user",
    "x-portico-redact-allow": "*",
    "x-portico-appid": "portico",
    "x-portico-track": "dev-build",
    "x-portico-log-request": "false",
    "x-portico-log-response": "false",
    "content-type": "application/json",
}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class CaptureStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: list[dict] = []

    def append(self, item: dict) -> None:
        with self._lock:
            self._items.append(item)

    def snapshot(self) -> list[dict]:
        with self._lock:
            return list(self._items)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


def make_handler(captures: CaptureStore):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length)
            captures.append(
                {
                    "path": self.path,
                    "headers": {key.lower(): value for key, value in self.headers.items()},
                    "body": raw_body.decode("utf-8", errors="replace"),
                }
            )

            if self.path == "/openai/v1/chat/completions":
                payload = {
                    "id": "chatcmpl_mock",
                    "object": "chat.completion",
                    "model": "gpt-5.6-terra",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 3,
                        "completion_tokens": 1,
                        "total_tokens": 4,
                    },
                }
            elif self.path == "/openai/v1/responses":
                payload = {
                    "id": "resp_mock",
                    "output": [
                        {
                            "type": "message",
                            "content": [{"type": "output_text", "text": "ok"}],
                        }
                    ],
                    "usage": {
                        "input_tokens": 3,
                        "output_tokens": 1,
                        "total_tokens": 4,
                    },
                }
            elif self.path == "/openai/v1/embeddings":
                payload = {
                    "object": "list",
                    "data": [{"object": "embedding", "embedding": [0.1, 0.2], "index": 0}],
                    "model": "text-embedding-3-large",
                    "usage": {"prompt_tokens": 3, "total_tokens": 3},
                }
            elif self.path == "/bedrock/converse":
                payload = {
                    "output": {"message": {"content": [{"text": "ok"}]}},
                    "usage": {"inputTokens": 3, "outputTokens": 1},
                    "stopReason": "end_turn",
                }
            else:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"unknown path")
                return

            response = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args) -> None:
            return

    return Handler


def wait_for_health(base_url: str, timeout_seconds: float = 60.0) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/health", timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"gateway did not become healthy at {base_url}/health")


def post_json(url: str, payload: dict, headers: dict[str, str] | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        url,
        data=body,
        headers=request_headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def build_image(repo_root: Path, image_tag: str) -> None:
    subprocess.run(
        ["docker", "build", "-f", "Dockerfile.bifrost-bridge", "-t", image_tag, "."],
        cwd=repo_root,
        check=True,
    )


def prepare_config(repo_root: Path, upstream_port: int) -> Path:
    raw = (repo_root / "model_catalog.yaml").read_text()
    raw = raw.replace(
        "https://llm-proxy.sandbox.example.invalid",
        f"http://host.docker.internal:{upstream_port}",
    )
    handle = tempfile.NamedTemporaryFile("w", delete=False, suffix=".yaml")
    handle.write(raw)
    handle.flush()
    handle.close()
    return Path(handle.name)


def start_gateway(
    repo_root: Path,
    image_tag: str,
    config_path: Path,
    gateway_port: int,
    upstream_port: int,
    route_mode: str,
) -> str:
    env = [
        "-e",
        "PORTICO_LLM_API_KEY=key",
        "-e",
        "PORTICO_USER_ID=user",
        "-e",
        "PORTICO_REDACT_ALLOW=*",
        "-e",
        "PORTICO_BUILD_TRACK=dev-build",
        "-e",
        "GPT_OPENAI_ROUTE_MODE=" + route_mode,
        "-e",
        "LLM_PROXY_BASE_URL=http://host.docker.internal:" + str(upstream_port),
        "-e",
        "BIFROST_CONFIG_OUTPUT=/app/data/config.json",
    ]
    result = subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--add-host",
            "host.docker.internal:host-gateway",
            "-p",
            f"{gateway_port}:4000",
            "-v",
            f"{config_path}:/app/model_catalog.yaml:ro",
            *env,
            image_tag,
        ],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def stop_gateway(container_id: str) -> None:
    subprocess.run(["docker", "rm", "-f", container_id], check=False, capture_output=True)


def container_logs(container_id: str) -> str:
    result = subprocess.run(
        ["docker", "logs", container_id], check=False, capture_output=True, text=True
    )
    return result.stdout + result.stderr


def wait_for_log_line(
    container_id: str, needle: str, timeout_seconds: float = 60.0
) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if needle in container_logs(container_id):
            return
        time.sleep(1)
    raise RuntimeError(f"container {container_id} did not emit expected log line: {needle!r}")


def wait_for_capture(captures: CaptureStore, expected_count: int, timeout_seconds: float = 30.0) -> list[dict]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        snapshot = captures.snapshot()
        if len(snapshot) >= expected_count:
            return snapshot
        time.sleep(0.25)
    raise RuntimeError(f"expected {expected_count} upstream requests, saw {len(captures.snapshot())}")


def assert_expected_headers(capture: dict) -> None:
    headers = capture["headers"]
    for key, expected in EXPECTED_HEADERS.items():
        actual = headers.get(key)
        if actual != expected:
            raise AssertionError(
                f"{capture['path']} missing expected header {key}: expected {expected!r}, got {actual!r}"
            )


def run_direct_checks(base_url: str, captures: CaptureStore) -> None:
    captures.clear()
    post_json(
        f"{base_url}/v1/chat/completions",
        {"model": "GPT-5.6 Sol", "messages": [{"role": "user", "content": "hi"}]},
    )
    post_json(
        f"{base_url}/internal/anthropic/v1/messages",
        {"model": "Claude Sonnet 4.6", "messages": [{"role": "user", "content": "hi"}]},
    )
    snapshot = wait_for_capture(captures, 2)
    expected_paths = {"/openai/v1/responses", "/bedrock/converse"}
    actual_paths = {entry["path"] for entry in snapshot}
    if actual_paths != expected_paths:
        raise AssertionError(f"direct mode paths mismatch: expected {expected_paths}, got {actual_paths}")
    for entry in snapshot:
        assert_expected_headers(entry)


def run_bifrost_checks(base_url: str, captures: CaptureStore) -> None:
    captures.clear()
    openwebui_headers = {
        "X-OpenWebUI-Chat-Id": "chat-123",
        "X-OpenWebUI-Message-Id": "msg-123",
        "X-OpenWebUI-Session-Id": "session-123",
    }
    post_json(
        f"{base_url}/v1/chat/completions",
        {
            "model": "GPT-5.6 Terra",
            "messages": [{"role": "user", "content": "hi"}],
            "metadata": {
                "chat_id": "chat-from-body",
                "message_id": "msg-from-body",
                "session_id": "session-from-body",
            },
        },
        headers=openwebui_headers,
    )
    post_json(
        f"{base_url}/v1/chat/completions",
        {"model": "GPT-5.6 Sol", "messages": [{"role": "user", "content": "hi"}]},
    )
    post_json(
        f"{base_url}/v1/chat/completions",
        {"model": "GPT-5.5", "messages": [{"role": "user", "content": "hi"}]},
    )
    post_json(
        f"{base_url}/v1/embeddings",
        {"model": "text-embedding-3-large", "input": ["hello"]},
    )
    snapshot = wait_for_capture(captures, 4)
    expected_paths = {
        "/openai/v1/responses",
        "/openai/v1/embeddings",
    }
    actual_paths = {entry["path"] for entry in snapshot}
    if actual_paths != expected_paths:
        raise AssertionError(f"bifrost mode paths mismatch: expected {expected_paths}, got {actual_paths}")
    for entry in snapshot:
        assert_expected_headers(entry)

    terra_capture = next(
        entry
        for entry in snapshot
        if json.loads(entry["body"]).get("model") == "gpt-5.6-terra"
    )
    terra_body = json.loads(terra_capture["body"])
    if "metadata" in terra_body:
        raise AssertionError("GPT-5.6 Terra provider payload still included metadata")

    responses_models = {
        json.loads(entry["body"]).get("model")
        for entry in snapshot
        if entry["path"] == "/openai/v1/responses"
    }
    expected_responses_models = {"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"}
    if responses_models != expected_responses_models:
        raise AssertionError(
            f"Bifrost Responses models mismatch: expected {expected_responses_models}, got {responses_models}"
        )


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    image_tag = "portico-bifrost-bridge:headers-e2e"
    upstream_port = free_port()
    captures = CaptureStore()
    server = ThreadingHTTPServer(("127.0.0.1", upstream_port), make_handler(captures))
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    config_path = prepare_config(repo_root, upstream_port)
    container_id = ""

    try:
        build_image(repo_root, image_tag)

        gateway_port = free_port()
        container_id = start_gateway(
            repo_root, image_tag, config_path, gateway_port, upstream_port, "direct"
        )
        base_url = f"http://127.0.0.1:{gateway_port}"
        wait_for_health(base_url)
        run_direct_checks(base_url, captures)
        stop_gateway(container_id)
        container_id = ""

        gateway_port = free_port()
        container_id = start_gateway(
            repo_root, image_tag, config_path, gateway_port, upstream_port, "bifrost"
        )
        base_url = f"http://127.0.0.1:{gateway_port}"
        wait_for_health(base_url)
        wait_for_log_line(container_id, "successfully started bifrost")
        run_bifrost_checks(base_url, captures)
        stop_gateway(container_id)
        container_id = ""
        print("validated Portico headers on direct and Bifrost upstream paths")
        return 0
    except Exception as error:
        print(f"header audit failed: {error}", file=sys.stderr)
        if container_id:
            print(container_logs(container_id), file=sys.stderr)
        return 1
    finally:
        if container_id:
            stop_gateway(container_id)
        server.shutdown()
        server.server_close()
        try:
            config_path.unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
