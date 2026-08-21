import argparse
import importlib.util
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = REPO_ROOT / "src/scripts/run_gpt_56_qualification.py"


def _load_runner():
    fake_google_runner = types.SimpleNamespace(
        OWUIClient=object,
        _detect_openwebui_base_url=lambda: "http://localhost",
        _fetch_chat_request_summaries=lambda _chat_id: [],
        _fetch_request_detail=lambda _request_id: {},
        _main_request_summaries=lambda summaries: summaries,
        ensure_debug_monitor_healthy=lambda: None,
    )
    previous = sys.modules.get("run_google_workspace_chat_consistency")
    sys.modules["run_google_workspace_chat_consistency"] = fake_google_runner
    try:
        spec = importlib.util.spec_from_file_location(
            "run_gpt_56_qualification",
            RUNNER_PATH,
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous is None:
            sys.modules.pop("run_google_workspace_chat_consistency", None)
        else:
            sys.modules["run_google_workspace_chat_consistency"] = previous


def test_runner_defines_full_model_and_ordinary_effort_matrix():
    module = _load_runner()

    assert module.MODELS == (
        "GPT-5.6 Sol",
        "GPT-5.6 Sol Pro",
        "GPT-5.6 Terra",
        "GPT-5.6 Luna",
    )
    assert module.ORDINARY_EFFORTS == (
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    )
    assert len(module.CACHE_STATIC_PREFIX.split()) > 1_000
    assert "query=" in module.ORDINARY_TOOL_PROMPT
    assert "filter=" not in module.ORDINARY_TOOL_PROMPT


def test_tool_completion_validation_uses_final_text_not_tool_details():
    module = _load_runner()
    completion = {
        "content": (
            '<details type="tool_calls" done="true" result="private">'
            "<summary>Tool Executed</summary></details>\n"
            "tool qualification ok"
        ),
        "content_blocks": [
            {"type": "text", "content": ""},
            {
                "type": "tool_calls",
                "content": [{"result": "private tool output"}],
            },
            {"type": "text", "content": "tool qualification ok"},
        ],
    }

    assert module._completion_final_text(completion) == "tool qualification ok"
    completion.pop("content_blocks")
    assert module._completion_final_text(completion) == "tool qualification ok"


def test_runner_csv_parsers_accept_only_qualified_models_and_efforts():
    module = _load_runner()

    assert module._parse_models("GPT-5.6 Sol,GPT-5.6 Luna") == [
        "GPT-5.6 Sol",
        "GPT-5.6 Luna",
    ]
    assert module._parse_efforts("none,xhigh,max") == ["none", "xhigh", "max"]

    for parser, value in [
        (module._parse_models, "GPT-5.4"),
        (module._parse_efforts, "ultra"),
        (module._parse_efforts, "bogus"),
    ]:
        try:
            parser(value)
        except argparse.ArgumentTypeError:
            pass
        else:
            raise AssertionError(f"{value!r} should have been rejected")


def test_cache_observation_extracts_nested_openai_read_and_write_usage():
    module = _load_runner()
    observation = module._cache_observation(
        {
            "input_tokens": 3_000,
            "prompt_tokens_details": {
                "cached_tokens": 1_282,
                "cached_write_tokens": "2411",
            }
        },
        source="unit",
        turn_index=1,
    )

    assert observation == {
        "source": "unit",
        "turn_index": 1,
        "input_tokens": 3_000,
        "uncached_input_tokens": 1_718,
        "cache_read_tokens": 1_282,
        "cache_write_tokens": 2_411,
    }


def _valid_cache_observations():
    return [
        {
            "source": "debug-monitor",
            "turn_index": 0,
            "accepted": True,
            "prompt_cache_key": "cache-key",
            "prompt_cache_retention": "24h",
            "input_tokens": 2_500,
            "uncached_input_tokens": 2_500,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        },
        {
            "source": "debug-monitor",
            "turn_index": 1,
            "accepted": True,
            "prompt_cache_key": "cache-key",
            "prompt_cache_retention": "24h",
            "input_tokens": 2_600,
            "uncached_input_tokens": 100,
            "cache_read_tokens": 2_500,
            "cache_write_tokens": 0,
        },
    ]


def test_cache_validator_accepts_population_then_hit_without_write_counter():
    module = _load_runner()
    observations = _valid_cache_observations()

    assert module.validate_cache_evidence(observations) == []
    observations[0]["cache_write_tokens"] = 2_500
    assert module.validate_cache_evidence(observations) == []


def test_cache_validator_requires_strict_order_acceptance_and_later_hit():
    module = _load_runner()
    assert module.validate_cache_evidence([]) == [
        "no prompt-cache usage evidence was captured"
    ]

    unordered = _valid_cache_observations()
    unordered[1]["turn_index"] = 2
    assert module.validate_cache_evidence(unordered) == [
        "prompt-cache evidence did not contain exactly turns 1 and 2"
    ]

    no_uncached_input = _valid_cache_observations()
    no_uncached_input[0]["uncached_input_tokens"] = 0
    assert "cache turn 1 reported no positive uncached input" in (
        module.validate_cache_evidence(no_uncached_input)
    )

    rejected_first = _valid_cache_observations()
    rejected_first[0]["accepted"] = False
    assert "cache turn 1 was not captured as an accepted request" in (
        module.validate_cache_evidence(rejected_first)
    )

    no_later_hit = _valid_cache_observations()
    no_later_hit[1]["cache_read_tokens"] = 0
    assert "cache turn 2 reported no real prompt-cache read" in (
        module.validate_cache_evidence(no_later_hit)
    )

def test_ordinary_control_validator_covers_every_model_and_effort():
    module = _load_runner()

    for model, spec in module.MODEL_SPECS.items():
        for effort in module.ORDINARY_EFFORTS:
            controls = [
                {
                    "model": spec["provider_model"],
                    "effort": effort,
                    "mode": "pro" if spec["pro"] else None,
                    "prompt_cache_retention": "24h",
                    "prompt_cache_key_present": True,
                }
            ]
            assert module.validate_ordinary_controls(
                model=model,
                effort=effort,
                controls=controls,
            ) == []


class _FakeHttpStatusError(RuntimeError):
    def __init__(self, status_code, body):
        super().__init__(f"HTTP {status_code}")
        self.response = types.SimpleNamespace(
            status_code=status_code,
            text=body,
        )


def _http_error(status_code, body):
    return _FakeHttpStatusError(status_code, body)


def _invalid_effort_detail(module, *, error=None, status_code=None, status="error"):
    detail = {
        "status": status,
        "raw_payload": {
            "params": {
                "reasoning_effort": module.INVALID_EFFORT,
            }
        },
    }
    if error is not None:
        detail["response"] = {"error": {"message": error}}
    if status_code is not None:
        detail["status_code"] = status_code
    return detail


def test_invalid_effort_rejection_requires_specific_http_4xx_validation_signal():
    module = _load_runner()

    assert module.invalid_effort_was_rejected(
        completion=None,
        exception=_http_error(
            400,
            "Invalid reasoning.effort: invalid-portico-qualification",
        ),
        request_details=[],
    )
    assert module.invalid_effort_was_rejected(
        completion=None,
        exception=_http_error(
            422,
            "reasoning_effort has an unsupported value",
        ),
        request_details=[],
    )

    for exception in (
        RuntimeError("arbitrary transport failure"),
        TimeoutError("timed out"),
        _http_error(
            500,
            "Invalid reasoning.effort: invalid-portico-qualification",
        ),
        _http_error(400, "authentication failed"),
    ):
        assert not module.invalid_effort_was_rejected(
            completion=None,
            exception=exception,
            request_details=[],
        )


def test_invalid_effort_rejection_requires_matching_terminal_debug_error():
    module = _load_runner()

    assert module.invalid_effort_was_rejected(
        completion={
            "complete": False,
            "error": (
                "Invalid value: '__invalid__'. Supported values are: "
                "'none', 'low', 'medium', 'high', and 'xhigh'."
            ),
        },
        exception=None,
        request_details=[_invalid_effort_detail(module)],
    )
    assert module.invalid_effort_was_rejected(
        completion={
            "complete": False,
            "error": "provider rejected invalid reasoning effort",
        },
        exception=None,
        request_details=[_invalid_effort_detail(module)],
    )
    assert module.invalid_effort_was_rejected(
        completion=None,
        exception=None,
        request_details=[
            _invalid_effort_detail(
                module,
                error="reasoning_effort has an unsupported value",
                status_code=400,
            )
        ],
    )

    failing_cases = (
        (
            {"complete": False, "error": "provider rejected invalid reasoning effort"},
            [],
        ),
        (
            {"complete": False, "error": "Timeout waiting for completion"},
            [_invalid_effort_detail(module)],
        ),
        (
            {"complete": True},
            [
                _invalid_effort_detail(
                    module,
                    error="upstream connection reset",
                )
            ],
        ),
        (
            {"complete": True},
            [
                _invalid_effort_detail(
                    module,
                    error="invalid reasoning effort",
                    status_code=503,
                )
            ],
        ),
        (
            {"complete": False, "error": "invalid reasoning effort"},
            [_invalid_effort_detail(module, status="complete")],
        ),
    )
    for completion, request_details in failing_cases:
        assert not module.invalid_effort_was_rejected(
            completion=completion,
            exception=None,
            request_details=request_details,
        )


def test_ultra_root_hook_rejects_private_child_output_leakage():
    module = _load_runner()
    assert module.validate_ultra_root_case(
        {"complete": True, "content": module.ULTRA_ROOT_OUTPUT},
        2,
    ) == []

    failures = module.validate_ultra_root_case(
        {
            "complete": True,
            "content": f"{module.ULTRA_ROOT_OUTPUT} {module.ULTRA_CHILD_CANARY}",
        },
        0,
    )
    assert any("child output leaked" in failure for failure in failures)
    assert any("did not prove" in failure for failure in failures)



def test_ultra_child_count_extracts_sanitized_header_or_audit_evidence():
    module = _load_runner()
    assert module._extract_ultra_child_count(
        [
            {"response_headers": {"x-portico-ultra-child-count": "2"}},
            {"response": {"ultra_audit": {"child_agent_count": 1}}},
        ]
    ) == 2
    assert module._extract_ultra_child_count([]) == 0


def test_ultra_tool_hook_requires_balanced_root_owned_private_audit_counters():
    module = _load_runner()
    completion = {
        "complete": True,
        "content": module.ULTRA_TOOL_OUTPUT,
    }
    audit = {
        "child_agent_count": 1,
        "tool_call_count": 2,
        "child_tool_call_count": 0,
        "tool_result_count": 2,
        "continuation_count": 1,
        "arguments_logged": False,
        "results_logged": False,
    }
    assert module.validate_ultra_tool_case(completion, audit) == []

    mismatched = dict(audit, tool_result_count=1)
    failures = module.validate_ultra_tool_case(completion, mismatched)
    assert any(
        "match every local tool call to one result" in failure
        for failure in failures
    )

    child_owned = dict(audit, child_tool_call_count=1)
    failures = module.validate_ultra_tool_case(completion, child_owned)
    assert any("forbidden child-owned local tool call" in failure for failure in failures)

    leaked = dict(
        completion,
        content=f'<details type="tool_calls"></details> {module.ULTRA_TOOL_OUTPUT}',
    )
    failures = module.validate_ultra_tool_case(leaked, {})
    assert any("leaked" in failure for failure in failures)
    assert any("audit counters were unavailable" in failure for failure in failures)


def test_ultra_audit_extractor_combines_sanitized_counters_only():
    module = _load_runner()
    audit = module._extract_ultra_audit(
        [
            {
                "ultra_audit": {
                    "tool_call_count": 1,
                    "child_tool_call_count": 1,
                    "tool_result_count": 1,
                    "continuation_count": 0,
                    "arguments_logged": False,
                    "results_logged": False,
                }
            },
            {"response": {"ultra_audit": {"continuation_count": 1}}},
        ]
    )
    assert audit["tool_call_count"] == 1
    assert audit["child_tool_call_count"] == 1
    assert audit["tool_result_count"] == 1
    assert audit["continuation_count"] == 1
    assert audit["arguments_logged"] is False
    assert audit["results_logged"] is False


def test_ordinary_output_must_match_exactly_after_whitespace_normalization(monkeypatch):
    module = _load_runner()
    controls = [
        {
            "model": "gpt-5.6-sol",
            "effort": "medium",
            "mode": None,
            "prompt_cache_retention": "24h",
            "prompt_cache_key_present": True,
        }
    ]

    def completion_with(content):
        return {
            "chat_id": "chat-1",
            "completion": {"complete": True, "content": content},
            "controls": controls,
        }

    monkeypatch.setattr(
        module,
        "_run_completion",
        lambda *args, **kwargs: completion_with(f"prefix {module.ORDINARY_OUTPUT} suffix"),
    )
    rejected = module.run_ordinary_case(
        object(),
        model="GPT-5.6 Sol",
        effort="medium",
        timeout_seconds=1,
        evidence_timeout_seconds=1,
    )
    assert rejected["perfect"] is False
    assert (
        f"assistant response was not exactly {module.ORDINARY_OUTPUT}"
        in rejected["failures"]
    )

    monkeypatch.setattr(
        module,
        "_run_completion",
        lambda *args, **kwargs: completion_with(f"\n  {module.ORDINARY_OUTPUT}\t"),
    )
    accepted = module.run_ordinary_case(
        object(),
        model="GPT-5.6 Sol",
        effort="medium",
        timeout_seconds=1,
        evidence_timeout_seconds=1,
    )
    assert accepted["perfect"] is True


def test_ordinary_controls_require_every_safe_effort_parameter_to_match():
    module = _load_runner()
    failures = module.validate_ordinary_controls(
        model="GPT-5.6 Terra",
        effort="high",
        controls=[{"effort": "high"}, {"effort": "low"}],
    )
    assert failures == [
        "one or more GPT-5.6 Terra requests did not preserve reasoning_effort='high'"
    ]

def test_cache_usage_is_correlated_by_message_id_not_file_order(tmp_path, monkeypatch):
    module = _load_runner()
    reporting_dir = tmp_path / "events"
    reporting_dir.mkdir()
    events = [
        ("z.json", "turn-2", 200),
        ("a.json", "unrelated", 999),
        ("m.json", "turn-1", 100),
    ]
    for filename, message_id, cached_tokens in events:
        (reporting_dir / filename).write_text(
            __import__("json").dumps(
                {
                    "chatId": "chat-1",
                    "messageId": message_id,
                    "usage": {
                        "prompt_tokens": 500,
                        "prompt_tokens_details": {
                            "cached_tokens": cached_tokens,
                        },
                    },
                }
            )
        )
    monkeypatch.setattr(module, "REPORTING_EVENTS_DIR", reporting_dir)

    observations = module._reporting_observations(
        "chat-1",
        turn_message_ids=("turn-1", "turn-2"),
    )
    assert {
        observation["message_id"]: observation["turn_index"]
        for observation in observations
    } == {"turn-1": 0, "turn-2": 1}
    assert all(observation["message_id"] != "unrelated" for observation in observations)


def test_ordinary_tool_case_proves_a_function_call_without_request_capture(monkeypatch):
    module = _load_runner()
    assert not module._request_details_include_function_call(
        [{"tools": [{"type": "function", "name": module.ULTRA_TOOL_NAME}]}],
        tool_name=module.ULTRA_TOOL_NAME,
    )

    for model in module.MODEL_SPECS:
        details = [
            {
                "status": "complete",
                "parameters": {"reasoning_effort": "medium"},
                "response": {
                    "output": [
                        {
                            "type": "function_call",
                            "name": module.ULTRA_TOOL_NAME,
                            "call_id": "call-1",
                        }
                    ]
                },
            },
            {
                "status": "complete",
                "parameters": {"reasoning_effort": "medium"},
            },
        ]
        monkeypatch.setattr(
            module,
            "_run_completion",
            lambda *args, **kwargs: {
                "chat_id": "chat-tool",
                "completion": {
                    "complete": True,
                    "content": f"\n{module.ORDINARY_TOOL_OUTPUT}\t",
                },
            },
        )
        monkeypatch.setattr(
            module,
            "_wait_for_request_details",
            lambda *args, _details=details, **kwargs: _details,
        )

        result = module.run_ordinary_tool_case(
            object(),
            model=model,
            timeout_seconds=1,
            evidence_timeout_seconds=1,
        )
        assert result["perfect"] is True, result

def test_web_search_case_proves_local_tool_continuation_without_request_capture(
    monkeypatch,
):
    module = _load_runner()
    details = [
        {
            "status": "complete",
            "parameters": {"reasoning_effort": "medium"},
            "response": {
                "output": [
                    {
                        "type": "function_call",
                        "name": module.WEB_SEARCH_TOOL_NAME,
                        "call_id": "call-web-1",
                    }
                ]
            },
        },
        {
            "status": "complete",
            "parameters": {"reasoning_effort": "medium"},
        },
    ]
    monkeypatch.setattr(
        module,
        "_run_completion",
        lambda *args, **kwargs: {
            "chat_id": "chat-web-search",
            "completion": {
                "complete": True,
                "content": module.WEB_SEARCH_OUTPUT,
            },
        },
    )
    monkeypatch.setattr(
        module,
        "_wait_for_request_details",
        lambda *args, **kwargs: details,
    )

    result = module.run_web_search_case(
        object(),
        timeout_seconds=1,
        evidence_timeout_seconds=1,
    )
    assert result["perfect"] is True, result

def test_cache_turn_correlation_prefers_user_trigger_over_assistant_message():
    module = _load_runner()
    turn_ids = ("user-turn-one", "user-turn-two")

    assert module._turn_index_for_request(
        {
            "message_id": "assistant-response",
            "trigger_message_id": "user-turn-two",
        },
        turn_ids,
    ) == 1
    assert module._turn_index_for_request(
        {"transcript_anchor_message_id": "user-turn-one"}, turn_ids
    ) == 0
