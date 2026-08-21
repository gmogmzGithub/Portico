import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "src/scripts/test-bifrost-prompt-caching.sh"


class _GatewayState:
    def __init__(
        self,
        denied_models=None,
        include_success_model=True,
        success_model="GPT-5.5",
        gpt_explicit_write_tokens=False,
    ):
        self.denied_models = set(denied_models or [])
        self.include_success_model = include_success_model
        self.success_model = success_model
        self.gpt_explicit_write_tokens = gpt_explicit_write_tokens
        self.chat_call_counts = {}
        self.chat_payloads = {}

    def model_ids(self):
        models = ["Atlas Sonnet 4.6"]
        if self.include_success_model:
            models.append(self.success_model)
        models.append("text-embedding-3-large")
        return models


class _GatewayHandler(BaseHTTPRequestHandler):
    server_version = "PromptCacheTestServer/1.0"

    def log_message(self, format, *args):
        return

    @property
    def state(self):
        return self.server.gateway_state

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        return json.loads(body or b"{}")

    def _send_json(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "bifrost_ready": True,
                    "model_count": len(self.state.model_ids()),
                },
            )
            return

        if self.path == "/v1/models":
            self._send_json(
                200,
                {"data": [{"id": model_id} for model_id in self.state.model_ids()]},
            )
            return

        self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path == "/v1/chat/completions":
            payload = self._read_json_body()
            model = payload.get("model")
            chat_id = payload.get("chat_id")
            chat_key = (model, chat_id)
            self.state.chat_payloads.setdefault(chat_key, []).append(payload)
            if model in self.state.denied_models:
                self._send_json(
                    403,
                    {
                        "error": {
                            "message": (
                                "AccessDeniedException: aws-marketplace:Subscribe "
                                "is required for this model."
                            )
                        }
                    },
                )
                return

            if payload.get("stream"):
                cached_write_tokens = (
                    40
                    if str(model).startswith("Atlas")
                    or (self.state.gpt_explicit_write_tokens and str(model).startswith("GPT-5.6"))
                    else 0
                )
                usage = {
                    "prompt_tokens": 80,
                    "completion_tokens": 1,
                    "total_tokens": 81,
                    "cost": 0.0001,
                    "prompt_tokens_details": {
                        "cached_tokens": 40,
                        "cached_read_tokens": 40,
                        "cached_write_tokens": cached_write_tokens,
                    },
                }
                body = (
                    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
                    f"data: {json.dumps({'usage': usage})}\n\n"
                    "data: [DONE]\n"
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            prior_calls = self.state.chat_call_counts.get(chat_key, 0)
            self.state.chat_call_counts[chat_key] = prior_calls + 1
            cached_read_tokens = 40 if prior_calls >= 1 else 0
            cached_write_tokens = (
                40
                if prior_calls == 0
                and (str(model).startswith("Atlas") or self.state.gpt_explicit_write_tokens)
                else 0
            )
            usage = {
                "prompt_tokens": 80,
                "completion_tokens": 1,
                "total_tokens": 81,
                "cost": 0.0001,
                "prompt_tokens_details": {
                    "cached_tokens": cached_read_tokens,
                    "cached_read_tokens": cached_read_tokens,
                    "cached_write_tokens": cached_write_tokens,
                },
                "completion_tokens_details": {},
            }
            self._send_json(
                200,
                {
                    "choices": [
                        {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}
                    ],
                    "usage": usage,
                },
            )
            return

        if self.path == "/v1/embeddings":
            self._send_json(
                200,
                {
                    "data": [{"embedding": [0.1, 0.2, 0.3], "index": 0}],
                    "usage": {"prompt_tokens": 3, "total_tokens": 3, "cost": 0.00001},
                },
            )
            return

        self._send_json(404, {"error": {"message": "not found"}})


class _GatewayServer:
    def __init__(
        self,
        denied_models=None,
        include_success_model=True,
        success_model="GPT-5.5",
        gpt_explicit_write_tokens=False,
    ):
        self.state = _GatewayState(
            denied_models=denied_models,
            include_success_model=include_success_model,
            success_model=success_model,
            gpt_explicit_write_tokens=gpt_explicit_write_tokens,
        )
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _GatewayHandler)
        self.httpd.gateway_state = self.state
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        host, port = self.httpd.server_address
        self.base_url = f"http://{host}:{port}"
        return self

    def __exit__(self, exc_type, exc, tb):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def _run_script(tmp_path, base_url):
    report_path = tmp_path / "prompt-cache-report.json"
    env = os.environ.copy()
    env.update(
        {
            "GATEWAY_URL": base_url,
            "OUT_JSON": str(report_path),
            "RUN_ID": "pytest-prompt-cache",
            # The local fixture updates cache counters synchronously. Production
            # probes retain the real two-second provider-settle delay.
            "PROMPT_CACHE_SETTLE_SECONDS": "0",
        }
    )
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env=env,
    )
    return result, report_path


def test_prompt_cache_script_skips_denied_models_and_reports_successful_ones(tmp_path):
    with _GatewayServer(denied_models={"Atlas Sonnet 4.6"}, include_success_model=True) as gateway:
        result, report_path = _run_script(tmp_path, gateway.base_url)

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text())

    atlas_result = next(item for item in report["chat_results"] if item["model"] == "Atlas Sonnet 4.6")
    gpt_result = next(item for item in report["chat_results"] if item["model"] == "GPT-5.5")

    assert atlas_result["success"] is False
    assert atlas_result["skipped"] is True
    assert atlas_result["reason"] == "model_access_denied"
    assert gpt_result["success"] is True
    assert report["embedding_result"]["success"] is True


def test_gpt56_cache_population_accepts_optional_explicit_write_counters(tmp_path):
    models = (
        "GPT-5.6 Sol",
        "GPT-5.6 Sol Pro",
        "GPT-5.6 Terra",
        "GPT-5.6 Luna",
    )

    for model in models:
        for explicit_write in (False, True):
            case_dir = tmp_path / (model.replace(" ", "-") + f"-{explicit_write}")
            case_dir.mkdir()
            with _GatewayServer(
                denied_models={"Atlas Sonnet 4.6"},
                success_model=model,
                gpt_explicit_write_tokens=explicit_write,
            ) as gateway:
                result, report_path = _run_script(case_dir, gateway.base_url)

            assert result.returncode == 0, result.stderr
            report = json.loads(report_path.read_text())
            model_result = next(
                item for item in report["chat_results"] if item["model"] == model
            )
            assert model_result["success"] is True
            assert model_result["expected_cache_mode"] == "populate-read"
            assert model_result["call1_usage"]["prompt_tokens"] > 0
            assert model_result["call1_usage"]["cached_write_tokens"] == (
                40 if explicit_write else 0
            )
            assert model_result["call2_usage"]["cached_read_tokens"] > 0


def test_prompt_cache_script_fails_when_no_chat_models_succeed(tmp_path):
    with _GatewayServer(denied_models={"Atlas Sonnet 4.6"}, include_success_model=False) as gateway:
        result, report_path = _run_script(tmp_path, gateway.base_url)

    assert result.returncode != 0
    assert not report_path.exists()
    assert "No chat models completed the prompt-cache probe successfully." in result.stderr

def test_prompt_cache_script_fails_closed_for_unknown_model_expectations(tmp_path):
    with _GatewayServer(
        denied_models={"Atlas Sonnet 4.6"},
        success_model="Unknown Future Model",
    ) as gateway:
        result, report_path = _run_script(tmp_path, gateway.base_url)

    assert result.returncode != 0
    assert not report_path.exists()
    assert "no prompt-cache expectation is defined for model: Unknown Future Model" in result.stderr



def test_prompt_cache_script_builds_three_system_atlas_payload_and_varies_only_dynamic_context(tmp_path):
    with _GatewayServer(denied_models=set(), include_success_model=False) as gateway:
        result, report_path = _run_script(tmp_path, gateway.base_url)

        assert result.returncode == 0, result.stderr
        report = json.loads(report_path.read_text())
        atlas_result = next(item for item in report["chat_results"] if item["model"] == "Atlas Sonnet 4.6")
        assert atlas_result["success"] is True

        atlas_payloads = [
            payloads
            for (model, _chat_id), payloads in gateway.state.chat_payloads.items()
            if model == "Atlas Sonnet 4.6"
        ]
        assert len(atlas_payloads) == 1
        call_sequence = atlas_payloads[0]
        assert len(call_sequence) >= 2

        first_payload = call_sequence[0]
        second_payload = call_sequence[1]
        first_messages = first_payload["messages"]
        second_messages = second_payload["messages"]

        assert [message["role"] for message in first_messages[:4]] == [
            "system",
            "system",
            "system",
            "user",
        ]
        assert "You are Portico" in first_messages[0]["content"]
        assert "<static_context>" in first_messages[1]["content"]
        assert "<dynamic_context>" in first_messages[2]["content"]
        assert first_messages[1]["content"] == second_messages[1]["content"]
        assert first_messages[2]["content"] != second_messages[2]["content"]
