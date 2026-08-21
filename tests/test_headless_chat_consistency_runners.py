import html
import importlib.util
import json
import runpy
import sys
import types
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _fake_httpx_module():
    return types.SimpleNamespace(
        Client=object,
        HTTPError=Exception,
        get=lambda *args, **kwargs: None,
        post=lambda *args, **kwargs: None,
    )


def _load_module(module_name: str, relative_path: str, injected_modules: dict[str, object] | None = None):
    source_path = REPO_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(module_name, source_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None

    previous_modules: dict[str, object | None] = {}
    for name, value in (injected_modules or {}).items():
        previous_modules[name] = sys.modules.get(name)
        sys.modules[name] = value

    try:
        spec.loader.exec_module(module)
    finally:
        for name, previous in previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
    return module


def _load_google_runner():
    return _load_module(
        "run_google_workspace_chat_consistency",
        "src/scripts/run_google_workspace_chat_consistency.py",
        {"httpx": _fake_httpx_module()},
    )


def _load_code_runner(google_runner):
    return _load_module(
        "run_code_execution_followup_chat_consistency",
        "src/scripts/run_code_execution_followup_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_calibration_runner(google_runner):
    return _load_module(
        "run_calibration_skill_activation_chat_consistency",
        "src/scripts/run_calibration_skill_activation_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_atlassian_steer_runner(google_runner):
    return _load_module(
        "run_atlassian_steer_chat_consistency",
        "src/scripts/run_atlassian_steer_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_browser_runner(google_runner):
    return _load_module(
        "run_browser_automation_chat_consistency",
        "src/scripts/run_browser_automation_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_marketplace_provenance_runner(google_runner):
    return _load_module(
        "run_marketplace_provenance_chat_consistency",
        "src/scripts/run_marketplace_provenance_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_opus_reasoning_runner(google_runner):
    return _load_module(
        "run_opus_5_reasoning_chat_consistency",
        "src/scripts/run_opus_5_reasoning_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_opus_prompt_cache_runner(google_runner):
    return _load_module(
        "run_opus_48_prompt_cache_chat_consistency",
        "src/scripts/run_opus_48_prompt_cache_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_gemini_runner(google_runner):
    return _load_module(
        "run_gemini_vertex_chat_consistency",
        "src/scripts/run_gemini_vertex_chat_consistency.py",
        {
            "httpx": _fake_httpx_module(),
            "run_google_workspace_chat_consistency": google_runner,
        },
    )


def _load_data_platform_diagnostic_runner():
    return _load_module(
        "run_data_platform_execute_query_diagnostic",
        "src/scripts/run_data_platform_execute_query_diagnostic.py",
    )


def _encoded_attr(payload: object) -> str:
    return html.escape(json.dumps(json.dumps(payload)), quote=True)


def _tool_call_details(name: str, arguments: object | None, result: object | None) -> str:
    attrs = [
        'type="tool_calls"',
        'done="true"',
        'duration="1"',
        f'name="{name}"',
    ]
    if arguments is not None:
        attrs.append(f'arguments="{_encoded_attr(arguments)}"')
    if result is not None:
        attrs.append(f'result="{_encoded_attr(result)}"')
    return f"<details {' '.join(attrs)}></details>"


def test_google_workspace_runner_prefers_bridge_key_for_debug_monitor(monkeypatch):
    monkeypatch.delenv("DEBUG_MONITOR_TOKEN", raising=False)
    monkeypatch.delenv("LLM_DEBUG_MONITOR_TOKEN", raising=False)
    monkeypatch.setenv("BIFROST_BRIDGE_LOCAL_API_KEY", "bridge-token")
    monkeypatch.setenv("LOCAL_STACK_API_KEY", "stack-token")

    module = _load_google_runner()

    assert module.DEBUG_MONITOR_TOKEN == "bridge-token"
    assert module._debug_monitor_headers() == {
        "X-Debug-Monitor-Token": "bridge-token"
    }


def test_google_workspace_runner_resolves_debug_monitor_token_from_container(monkeypatch):
    module = _load_google_runner()
    module.DEBUG_MONITOR_TOKEN = None

    def fake_run(*args, **kwargs):
        return types.SimpleNamespace(
            stdout="TZ=UTC\nDEBUG_MONITOR_TOKEN=runtime-token\n"
        )

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    assert module._debug_monitor_headers() == {
        "X-Debug-Monitor-Token": "runtime-token"
    }
    assert module.DEBUG_MONITOR_TOKEN == "runtime-token"


def test_google_workspace_runner_resolves_debug_monitor_token_file_from_container(monkeypatch):
    module = _load_google_runner()
    module.DEBUG_MONITOR_TOKEN = None

    def fake_run(args, **kwargs):
        if args[:3] == ["docker", "inspect", "llm-debug-monitor"]:
            return types.SimpleNamespace(
                stdout="TZ=UTC\nDEBUG_MONITOR_TOKEN_FILE=/run/secrets/debug-token\n"
            )
        if args[:3] == ["docker", "exec", "llm-debug-monitor"]:
            assert args[-1] == "/run/secrets/debug-token"
            return types.SimpleNamespace(stdout="file-token\n")
        raise AssertionError(f"unexpected subprocess args: {args!r}")

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    assert module._debug_monitor_headers() == {
        "X-Debug-Monitor-Token": "file-token"
    }
    assert module.DEBUG_MONITOR_TOKEN == "file-token"


def test_google_workspace_request_fidelity_accepts_request_correctness_contract():
    module = _load_google_runner()

    request_details = [
        {
            "request_id": "req-initial",
            "request_phase": "initial",
            "messages": [
                {"role": "system", "content": "# Portico - Your AI Assistant"},
                {"role": "system", "content": "<portico_context><static_context>static</static_context></portico_context>"},
                {
                    "role": "system",
                    "content": (
                        "<portico_context><dynamic_context>"
                        '<tool_servers><enabled><server>server:google_workspace</server></enabled></tool_servers>'
                        '<activated_skill name="google-workspace">Calendar help</activated_skill>'
                        "</dynamic_context></portico_context>"
                    ),
                },
                {"role": "user", "content": "What are my most important meetings this week?"},
                {"role": "assistant", "content": "I'll check your calendar."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "mcp_assistant_toggle_integration"}},
                {"type": "function", "function": {"name": "mcp_assistant_activate_integration"}},
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
        {
            "request_id": "req-followup",
            "request_phase": "tool_followup",
            "messages": [
                {"role": "system", "content": "# Portico - Your AI Assistant"},
                {"role": "system", "content": "<portico_context><static_context>static</static_context></portico_context>"},
                {
                    "role": "system",
                    "content": (
                        "<portico_context><dynamic_context>"
                        '<tool_servers><enabled><server>server:google_workspace</server></enabled></tool_servers>'
                        '<activated_skill name="google-workspace">Calendar help</activated_skill>'
                        "</dynamic_context></portico_context>"
                    ),
                },
                {"role": "assistant", "content": "I'll parse the calendar results next."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "google_workspace_get_events"}},
                {"type": "function", "function": {"name": "agent_vm_bash"}},
            ],
            "tool_ids": [
                "server:mcp-assistant",
                "server:skills",
                "server:subagents",
                "server:agent-vm",
                "server:google_workspace",
            ],
        },
    ]
    active_capabilities = {
        "tools": [{"server_id": "agent-vm"}, {"server_id": "google_workspace"}],
        "skills": [{"name": "google-workspace"}],
    }

    failures = module._validate_google_workspace_request_fidelity(
        tool_batch_count=1,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert failures == []


def test_google_workspace_request_fidelity_rejects_collapsed_system_prompt_and_dynamic_user_tail():
    module = _load_google_runner()

    request_details = [
        {
            "request_id": "req-bad",
            "request_phase": "tool_followup",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "<portico_context><static_context>static</static_context></portico_context>\n\n---\n\n"
                        "<portico_context><dynamic_context>dynamic</dynamic_context></portico_context>"
                    ),
                },
                {"role": "assistant", "content": "I'll continue."},
                {
                    "role": "user",
                    "content": "<portico_context><dynamic_context>dynamic</dynamic_context></portico_context>",
                },
            ],
            "tools": [
                {"type": "function", "function": {"name": "google_workspace_get_events"}},
            ],
        },
    ]
    active_capabilities = {
        "tools": [{"server_id": "google_workspace"}],
        "skills": [{"name": "google-workspace"}],
    }

    failures = module._validate_google_workspace_request_fidelity(
        tool_batch_count=0,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert any(
        "3-system-message prefix" in failure or "exactly 3 system messages" in failure
        for failure in failures
    )
    assert any("merged static and dynamic context" in failure for failure in failures)
    assert any("<dynamic_context> as a user message" in failure for failure in failures)


def test_google_workspace_noninteractive_validator_excludes_authorization_tools():
    module = _load_google_runner()
    assistant_html = _tool_call_details(
        "google_workspace_get_events",
        {"calendar_id": "primary"},
        {"success": True, "events": []},
    )
    request_details = [
        {
            "request_id": "req-initial",
            "request_phase": "initial",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "<tool_servers><enabled>"
                        "<server>server:google_workspace</server>"
                        "</enabled></tool_servers>"
                    ),
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "google_workspace_get_events"},
                }
            ],
        },
        {
            "request_id": "req-followup",
            "request_phase": "tool_followup",
            "messages": [],
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "google_workspace_get_events"},
                }
            ],
        },
    ]

    verdict = module._validate_noninteractive_run(
        "chat-safe",
        assistant_html,
        content_blocks=[{"type": "tool_calls"}],
        request_details=request_details,
    )

    assert verdict["perfect"] is True
    assert verdict["failures"] == []
    assert verdict["noninteractive"] is True

    request_details[0]["tools"].append(
        {
            "type": "function",
            "function": {"name": "mcp_assistant_authorize_integration"},
        }
    )
    unsafe_verdict = module._validate_noninteractive_run(
        "chat-unsafe",
        assistant_html,
        content_blocks=[{"type": "tool_calls"}],
        request_details=request_details,
    )
    assert unsafe_verdict["perfect"] is False
    assert any(
        "authorize_integration was available" in failure
        for failure in unsafe_verdict["failures"]
    )


def test_google_workspace_noninteractive_precondition_never_toggles_or_authorizes(monkeypatch):
    module = _load_google_runner()
    monkeypatch.setattr(module, "_server_reported_tool_ready", lambda: False)
    monkeypatch.setattr(
        module,
        "_fetch_readiness",
        lambda: {"readiness_phase": "needs_oauth"},
    )
    monkeypatch.setattr(
        module.httpx,
        "post",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("noninteractive precondition must not make POST requests")
        ),
    )

    try:
        module.ensure_noninteractive_precondition()
    except RuntimeError as error:
        assert "refusing to toggle or authorize" in str(error)
    else:
        raise AssertionError("expected the noninteractive precondition to fail closed")


def test_google_runner_parses_service_not_found_tool_results():
    module = _load_google_runner()

    content = _tool_call_details(
        "skills_activate_skill",
        {"skill_name": "browser-automation", "chat_id": "chat-1"},
        {
            "success": False,
            "blocked_integrations": [
                {
                    "tool_server_id": "server:missing-one",
                    "readiness_phase": "service_not_found",
                    "recovery_hint": "integration_missing",
                }
            ],
        },
    )

    tool_calls = module._parse_tool_calls(content)

    assert tool_calls[0]["name"] == "skills_activate_skill"
    assert tool_calls[0]["result"]["blocked_integrations"][0]["readiness_phase"] == (
        "service_not_found"
    )
    assert tool_calls[0]["result"]["blocked_integrations"][0]["recovery_hint"] == (
        "integration_missing"
    )


def test_data_platform_diagnostic_classifies_raw_transport_504() -> None:
    module = _load_data_platform_diagnostic_runner()

    result = {
        "error": (
            'HTTP error 504: {"message":"tool call failed: Transport send error: '
            "unexpected server response: HTTP 504 Gateway Timeout: <html></html>\"}"
        )
    }

    assert module.classify_tool_result(result) == "raw_transport_504"
    assert module._extract_execution_id(result) is None


def test_data_platform_diagnostic_classifies_structured_timeout_with_execution_id() -> None:
    module = _load_data_platform_diagnostic_runner()

    result = {
        "is_error": True,
        "message": (
            "Query timed out after 10 seconds. Execution ID: "
            "3707595f-dbb7-4ac3-95b5-e7d343d6255f."
        ),
        "content": (
            "Query timed out after 10 seconds. Execution ID: "
            "3707595f-dbb7-4ac3-95b5-e7d343d6255f."
        ),
    }

    assert module.classify_tool_result(result) == "structured_timeout_with_execution_id"
    assert module._extract_execution_id(result) == "3707595f-dbb7-4ac3-95b5-e7d343d6255f"


def test_code_execution_runner_validates_initial_request_and_followup_contract():
    google_runner = _load_google_runner()
    module = _load_code_runner(google_runner)
    module._redis_json_get = lambda _key: ["code-execution"]

    completion = {
        "content": _tool_call_details(
            "agent_vm_python",
            {"script": "print('hi')"},
            {"success": True, "stdout": "2 3 5"},
        ),
        "content_blocks": [{"type": "tool_calls"}],
    }
    request_details = [
        {
            "request_id": "req-initial",
            "request_phase": "initial",
            "messages": [
                {
                    "role": "system",
                    "content": '<activated_skill name="code-execution">Execute code in Agent VM.</activated_skill>',
                },
                {"role": "assistant", "content": "I'll compute the primes."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "agent_vm_python"}},
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
        {
            "request_id": "req-followup",
            "request_phase": "tool_followup",
            "messages": [
                {
                    "role": "system",
                    "content": '<activated_skill name="code-execution">Execute code in Agent VM.</activated_skill>',
                },
                {"role": "assistant", "content": "The script ran; I'll summarize the output."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "agent_vm_python"}},
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
    ]
    active_capabilities = {"tools": [{"server_id": "agent-vm"}], "skills": [{"name": "code-execution"}]}

    verdict = module._validate_perfect_run(
        chat_id="chat-1",
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert verdict["perfect"] is True
    assert verdict["failures"] == []


def test_code_execution_runner_rejects_pseudo_tool_call_text_without_tool_calls():
    google_runner = _load_google_runner()
    module = _load_code_runner(google_runner)
    module._redis_json_get = lambda _key: ["code-execution"]

    completion = {
        "content": (
            "First, let me activate the code-execution skill.\n\n"
            '`skills_activate_skill(skill_name="code-execution", chat_id="chat-1")`'
        ),
        "content_blocks": [],
    }
    request_details = [
        {
            "request_id": "req-initial",
            "request_phase": "initial",
            "messages": [
                {
                    "role": "system",
                    "content": '<activated_skill name="code-execution">Execute code in Agent VM.</activated_skill>',
                }
            ],
            "tools": [
                {"type": "function", "function": {"name": "agent_vm_python"}},
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
    ]
    active_capabilities = {"tools": [{"server_id": "agent-vm"}], "skills": [{"name": "code-execution"}]}

    verdict = module._validate_perfect_run(
        chat_id="chat-1",
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert verdict["perfect"] is False
    assert verdict["pseudo_tool_call_text"] == ["skills_activate_skill"]
    assert any("pseudo tool-call text" in failure for failure in verdict["failures"])


def test_code_execution_runner_validates_markdown_workspace_file(tmp_path):
    google_runner = _load_google_runner()
    module = _load_code_runner(google_runner)
    module._redis_json_get = lambda _key: []

    report_path = tmp_path / module.MARKDOWN_FILE_NAME
    report_path.write_text(
        "# Native tool call regression\n\n"
        "| capability | status |\n"
        "| --- | --- |\n"
        "| native tool calls | required |\n"
    )
    module._find_workspace_files = lambda chat_id, filename: [report_path]

    completion = {
        "content": _tool_call_details(
            "agent_vm_bash",
            {"command": f"cat > {module.MARKDOWN_FILE_NAME}"},
            {"success": True},
        ),
        "content_blocks": [{"type": "tool_calls"}],
    }
    request_details = [
        {
            "request_id": "req-initial",
            "request_phase": "initial",
            "messages": [{"role": "system", "content": "Agent VM tools are available."}],
            "tools": [
                {"type": "function", "function": {"name": "agent_vm_bash"}},
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
        {
            "request_id": "req-followup",
            "request_phase": "tool_followup",
            "messages": [{"role": "system", "content": "Agent VM tools are available."}],
            "tools": [
                {"type": "function", "function": {"name": "agent_vm_bash"}},
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
    ]
    active_capabilities = {"tools": [{"server_id": "agent-vm"}], "skills": []}

    verdict = module._validate_perfect_run(
        chat_id="chat-1",
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
        expected_workspace_file=module.MARKDOWN_FILE_NAME,
        expected_file_markers=module.MARKDOWN_FILE_MARKERS,
        require_code_execution_skill=False,
    )

    assert verdict["perfect"] is True
    assert verdict["workspace_files"] == [str(report_path)]


def test_code_execution_runner_markdown_scenario_is_model_neutral():
    google_runner = _load_google_runner()
    module = _load_code_runner(google_runner)

    assert module._default_model_for_scenario("markdown-file") == google_runner.MODEL
    assert module.MARKDOWN_FILE_NAME in module._default_prompt_for_scenario("markdown-file")


def test_code_execution_runner_validates_svg_inline_display_contract(tmp_path):
    google_runner = _load_google_runner()
    module = _load_code_runner(google_runner)
    module._redis_json_get = lambda _key: []

    svg_path = tmp_path / module.SVG_FILE_NAME
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">'
        '<rect id="native-svg-display-regression" width="120" height="80"/>'
        "</svg>"
    )
    module._find_workspace_files = lambda chat_id, filename: [svg_path]
    browser_url = (
        "http://localhost:9876/workspace/chat-1/"
        f"{module.SVG_FILE_NAME}?inline=1"
    )
    download_url = (
        "http://localhost:9876/workspace/chat-1/" f"{module.SVG_FILE_NAME}"
    )
    completion = {
        "content": "".join(
            [
                _tool_call_details(
                    "agent_vm_bash",
                    {"command": f"write {module.SVG_FILE_NAME}"},
                    {"success": True},
                ),
                _tool_call_details(
                    "agent_vm_display_files",
                    {"file_paths": [f"/work/{module.SVG_FILE_NAME}"]},
                    {
                        "success": True,
                        "display_files": True,
                        "files": [
                            {
                                "file_name": module.SVG_FILE_NAME,
                                "file_path": module.SVG_FILE_NAME,
                                "mime_type": "image/svg+xml",
                                "is_image": True,
                                "browser_url": browser_url,
                                "download_url": download_url,
                                "url": browser_url,
                            }
                        ],
                    },
                ),
            ]
        ),
        "content_blocks": [{"type": "tool_calls"}],
    }
    request_details = [
        {
            "request_id": "req-initial",
            "request_phase": "initial",
            "messages": [{"role": "system", "content": "Agent VM tools are available."}],
            "tools": [{"type": "function", "function": {"name": "agent_vm_bash"}}],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
        {
            "request_id": "req-followup",
            "request_phase": "tool_followup",
            "messages": [{"role": "system", "content": "Agent VM tools are available."}],
            "tools": [
                {"type": "function", "function": {"name": "agent_vm_display_files"}}
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
    ]
    active_capabilities = {"tools": [{"server_id": "agent-vm"}], "skills": []}

    class Response:
        status_code = 200
        text = svg_path.read_text()
        headers = {
            "content-type": "image/svg+xml; charset=utf-8",
            "content-disposition": 'inline; filename="native-svg-display-regression.svg"',
            "content-security-policy": "sandbox; script-src 'none'; img-src data:",
            "x-content-type-options": "nosniff",
        }

    verdict = module._validate_perfect_run(
        chat_id="chat-1",
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
        expected_workspace_file=module.SVG_FILE_NAME,
        expected_file_markers=module.SVG_FILE_MARKERS,
        expected_inline_display_file=module.SVG_FILE_NAME,
        expected_inline_display_markers=module.SVG_FILE_MARKERS,
        workspace_file_http_get=lambda _url, timeout: Response(),
        require_code_execution_skill=False,
    )

    assert verdict["perfect"] is True
    assert verdict["display_file_records"][0]["browser_url"] == browser_url
    assert verdict["display_file_response"]["content_type"].startswith(
        "image/svg+xml"
    )


def test_code_execution_runner_svg_scenario_is_model_neutral():
    google_runner = _load_google_runner()
    module = _load_code_runner(google_runner)

    assert module._default_model_for_scenario("svg-display") == google_runner.MODEL
    assert module.SVG_FILE_NAME in module._default_prompt_for_scenario("svg-display")


def test_calibration_runner_waits_for_skill_visibility_from_wrapped_list_response():
    google_runner = _load_google_runner()
    module = _load_calibration_runner(google_runner)

    seen_payloads = []
    responses = iter(
        [
            {"success": True, "skills": []},
            {
                "success": True,
                "skills": [{"name": "calibration-host-live-test"}],
            },
        ]
    )

    def fake_call_core_tool(server_id, tool_name, payload):
        seen_payloads.append((server_id, tool_name, payload))
        return next(responses)

    original_call = module._call_core_tool
    original_sleep = module.time.sleep
    module._call_core_tool = fake_call_core_tool
    module.time.sleep = lambda _seconds: None
    try:
        module._wait_for_skill_visibility("calibration-host-live-test", timeout_seconds=1)
    finally:
        module._call_core_tool = original_call
        module.time.sleep = original_sleep

    assert seen_payloads == [
        ("skills", "list_skills", {}),
        ("skills", "list_skills", {}),
    ]


def test_calibration_skill_content_declares_required_servers_and_bans_manual_activation():
    google_runner = _load_google_runner()
    module = _load_calibration_runner(google_runner)

    content = module._build_skill_content("calibration-host-live-test")

    assert "required_mcp_servers:" in content
    assert "server:google_workspace" in content
    assert "server:agent-vm" in content
    assert module.SKILL_SENTINEL in content
    assert "Do not call mcp_assistant_activate_integration" in content


def test_calibration_runner_validates_skill_activation_followup_contract():
    google_runner = _load_google_runner()
    module = _load_calibration_runner(google_runner)

    skill_name = "calibration-host-live-test"
    completion = {
        "content": "".join(
            [
                _tool_call_details(
                    "skills_activate_skill",
                    {"skill_name": skill_name, "chat_id": "chat-1"},
                    {
                        "success": True,
                        "enabled_mcp_servers": ["server:google_workspace", "server:agent-vm"],
                    },
                ),
                _tool_call_details(
                    "google_workspace_get_events",
                    {"calendar_id": "primary"},
                    {"success": True},
                ),
                _tool_call_details(
                    "agent_vm_bash",
                    {"command": "python summarize.py"},
                    {"success": True},
                ),
            ]
        ),
        "content_blocks": [{"type": "tool_calls"}, {"type": "tool_calls"}],
    }
    request_details = [
        {
            "request_id": "req-initial",
            "request_phase": "initial",
            "messages": [
                {"role": "user", "content": f"Activate {skill_name}."},
                {"role": "assistant", "content": "I'll activate the calibration skill first."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "skills_activate_skill"}},
            ],
            "tool_ids": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        },
        {
            "request_id": "req-followup-1",
            "request_phase": "tool_followup",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        '<tool_servers><enabled>'
                        '<server>server:google_workspace</server>'
                        '<server>server:agent-vm</server>'
                        '</enabled></tool_servers>'
                        f'<activated_skill name="{skill_name}">{module.SKILL_SENTINEL}</activated_skill>'
                    ),
                },
                {"role": "assistant", "content": "The skill is active; I'll check the calendar and analyze it."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "google_workspace_get_events"}},
                {"type": "function", "function": {"name": "agent_vm_bash"}},
            ],
            "tool_ids": [
                "server:mcp-assistant",
                "server:skills",
                "server:subagents",
                "server:google_workspace",
                "server:agent-vm",
            ],
        },
        {
            "request_id": "req-followup-2",
            "request_phase": "tool_followup",
            "messages": [
                {
                    "role": "system",
                    "content": f'<activated_skill name="{skill_name}">{module.SKILL_SENTINEL}</activated_skill>',
                },
                {"role": "assistant", "content": "I'll finalize the calibration plan."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "agent_vm_bash"}},
            ],
            "tool_ids": [
                "server:mcp-assistant",
                "server:skills",
                "server:subagents",
                "server:google_workspace",
                "server:agent-vm",
            ],
        },
    ]
    active_capabilities = {
        "tools": [{"server_id": "agent-vm"}, {"server_id": "google_workspace"}],
        "skills": [{"name": skill_name}],
    }

    verdict = module._validate_perfect_run(
        skill_name=skill_name,
        chat_id="chat-1",
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert verdict["perfect"] is True
    assert verdict["failures"] == []


def test_browser_runner_requires_chrome_navigation_before_recovery_tools():
    google_runner = _load_google_runner()
    module = _load_browser_runner(google_runner)
    module._redis_json_get = lambda _key: ["server:chrome-devtools"]

    completion = {
        "content": "".join(
            [
                _tool_call_details(
                    "chrome_devtools_navigate_page",
                    {"url": "https://example.com"},
                    {"success": True},
                ),
                _tool_call_details(
                    "chrome_devtools_take_screenshot",
                    {},
                    {"success": True},
                ),
            ]
        ),
        "content_blocks": [{"type": "tool_calls"}],
    }
    request_details = [
        {
            "request_id": "req-browser",
            "request_phase": "initial",
            "tools": [
                {"type": "function", "function": {"name": "chrome_devtools_navigate_page"}},
                {"type": "function", "function": {"name": "mcp_assistant_activate_integration"}},
            ],
            "tool_ids": [
                "server:mcp-assistant",
                "server:skills",
                "server:subagents",
                "server:agent-vm",
                "server:chrome-devtools",
            ],
        }
    ]
    active_capabilities = {"tools": [{"server_id": "agent-vm"}, {"server_id": "chrome-devtools"}], "skills": []}

    verdict = module._validate_perfect_run(
        chat_id="chat-1",
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert verdict["perfect"] is True
    assert verdict["failures"] == []

    bad_completion = {
        "content": "".join(
            [
                _tool_call_details(
                    "mcp_assistant_activate_integration",
                    {"chat_id": "chat-1", "tool_server_ids": ["server:chrome-devtools"]},
                    {"success": True, "already_enabled": ["server:chrome-devtools"]},
                ),
                _tool_call_details(
                    "chrome_devtools_navigate_page",
                    {"url": "https://example.com"},
                    {"success": True},
                ),
            ]
        ),
        "content_blocks": [{"type": "tool_calls"}],
    }

    bad_verdict = module._validate_perfect_run(
        chat_id="chat-1",
        completion=bad_completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert bad_verdict["perfect"] is False
    assert any("management/recovery tools" in failure for failure in bad_verdict["failures"])


def test_marketplace_provenance_runner_requires_authoritative_reads_and_no_mutations():
    google_runner = _load_google_runner()
    module = _load_marketplace_provenance_runner(google_runner)
    setup = {
        "agent_solution_id": "foreign-agent-solution",
        "skill_solution_id": "foreign-skill-solution",
    }
    completion = {
        "content": "".join(
            [
                _tool_call_details(
                    "subagents_get_agent",
                    {"model_id": module.AGENT_FIXTURE},
                    {
                        "id": module.AGENT_FIXTURE,
                        "creation_source": "marketplace",
                        "marketplace_relationship": "installed",
                        "marketplace_solution_id": setup["agent_solution_id"],
                        "is_read_only": True,
                    },
                ),
                _tool_call_details(
                    "subagents_list_published_agents",
                    {},
                    {"solutions": [], "viewer_email": "me@example.invalid"},
                ),
                _tool_call_details(
                    "skills_read_skill",
                    {"skill_name": f"ai-marketplace/{module.SKILL_FIXTURE}"},
                    {
                        "success": True,
                        "source": "marketplace",
                        "marketplace_relationship": "installed",
                        "marketplace_solution_id": setup["skill_solution_id"],
                        "is_read_only": True,
                    },
                ),
                _tool_call_details(
                    "skills_list_published_skills",
                    {},
                    {"solutions": [], "viewer_email": "me@example.invalid"},
                ),
                (
                    "Both artifacts are installed, read-only copies. The remote listings "
                    "are not owned by me, so neither can be published in place. Create a "
                    "copy to customize and publish the editable user-owned copy."
                ),
            ]
        ),
        "content_blocks": [{"type": "tool_calls"}],
    }

    verdict = module._validate_perfect_run(
        completion=completion,
        setup=setup,
        request_details=[{"request_id": "req-marketplace"}],
    )
    assert verdict["perfect"] is True
    assert verdict["failures"] == []
    assert verdict["final_text"].startswith("Both artifacts are installed")
    assert "tool_calls" not in verdict
    assert len(verdict["tool_call_summaries"]) == 4

    unsafe = {
        **completion,
        "content": completion["content"]
        + _tool_call_details(
            "subagents_unpublish_agent",
            {"solution_id": setup["agent_solution_id"]},
            {"success": False, "code": "not_owner"},
        ),
    }
    unsafe_verdict = module._validate_perfect_run(
        completion=unsafe,
        setup=setup,
        request_details=[{"request_id": "req-marketplace"}],
    )
    assert unsafe_verdict["perfect"] is False
    assert any(
        "mutation tools were called" in failure
        for failure in unsafe_verdict["failures"]
    )


def test_marketplace_provenance_cleanup_only_deletes_runner_installs(monkeypatch):
    google_runner = _load_google_runner()
    module = _load_marketplace_provenance_runner(google_runner)
    calls = []

    def fake_call(server_id, tool_name, payload):
        calls.append((server_id, tool_name, payload))
        return {"success": True}

    monkeypatch.setattr(module, "_call_core_tool", fake_call)
    module.cleanup_fixture_precondition(
        {
            "agent_installed_by_runner": False,
            "skill_installed_by_runner": True,
            "local_agent_id": module.AGENT_FIXTURE,
            "local_skill_id": f"ai-marketplace/{module.SKILL_FIXTURE}",
            "agent_solution_id": "foreign-agent-solution",
            "skill_solution_id": "foreign-skill-solution",
        }
    )

    assert (
        "subagents",
        "delete_agent",
        {"model_id": module.AGENT_FIXTURE},
    ) not in calls
    assert (
        "skills",
        "delete_skill",
        {
            "skill_name": f"ai-marketplace/{module.SKILL_FIXTURE}",
            "confirm": True,
        },
    ) in calls
    assert (
        "subagents",
        "get_marketplace_agent",
        {"solution_id": "foreign-agent-solution"},
    ) in calls
    assert (
        "skills",
        "get_marketplace_solution",
        {"solution_id": "foreign-skill-solution"},
    ) in calls


def test_marketplace_provenance_runner_discovers_file_backed_auth_secret(monkeypatch):
    google_runner = _load_google_runner()
    module = _load_marketplace_provenance_runner(google_runner)
    monkeypatch.delenv("OWUI_AUTH_BRIDGE_SECRET", raising=False)
    monkeypatch.delenv("OWUI_AUTH_BRIDGE_SECRET_FILE", raising=False)
    monkeypatch.setenv("OPENWEBUI_CONTAINER_NAME", "source-open-webui")
    calls = []

    class Result:
        def __init__(self, stdout):
            self.stdout = stdout

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        if args[:2] == ["docker", "inspect"]:
            return Result(
                "OTHER=value\n"
                "OWUI_AUTH_BRIDGE_SECRET_FILE=/run/secrets/owui_auth_bridge_secret\n"
            )
        assert args[:3] == ["docker", "exec", "source-open-webui"]
        return Result("file-backed-secret\n")

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    module._ensure_owui_auth_bridge_secret()

    assert module.os.environ["OWUI_AUTH_BRIDGE_SECRET"] == "file-backed-secret"
    assert calls[0][0][2] == "source-open-webui"
    assert calls[1][0][-1] == "/run/secrets/owui_auth_bridge_secret"
    assert all(call[1]["capture_output"] is True for call in calls)


def test_atlassian_steer_runner_validates_inline_steer_anchor_and_available_tool_contract():
    google_runner = _load_google_runner()
    module = _load_atlassian_steer_runner(google_runner)

    completion = {
        "content": _tool_call_details(
            "mcp_atlassian_Get_JIRA_Issue",
            {"cloudId": "cloud-1", "issueIdOrKey": "AI4A-801"},
            {"summary": "Fix the roster parameter bug", "description": "..."}, 
        ),
        "content_blocks": [{"type": "tool_calls"}],
    }
    request_details = [
        {
            "request_id": "req-steer-initial",
            "request_phase": "initial",
            "trigger_message_id": "user-steer-1",
            "transcript_anchor_kind": "user_message",
            "transcript_anchor_message_id": "user-steer-1",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        '<tool_servers><enabled><server>server:mcp-atlassian</server></enabled></tool_servers>'
                        '<activated_skill name="atlassian-portico">Jira help</activated_skill>'
                    ),
                },
                {"role": "user", "content": "Use the atlassian-portico skill."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "mcp_atlassian_Get_JIRA_Issue"}},
            ],
        },
        {
            "request_id": "req-steer-followup",
            "request_phase": "tool_followup",
            "trigger_message_id": "user-steer-1",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-steer-1",
            "transcript_anchor_tool_block_index": 0,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        '<tool_servers><enabled><server>server:mcp-atlassian</server></enabled></tool_servers>'
                        '<activated_skill name="atlassian-portico">Jira help</activated_skill>'
                    ),
                },
                {"role": "assistant", "content": "I have the issue details and will summarize them."},
            ],
            "tools": [
                {"type": "function", "function": {"name": "mcp_atlassian_Get_JIRA_Issue"}},
            ],
        },
    ]
    active_capabilities = {
        "tools": [{"server_id": "mcp-atlassian"}],
        "skills": [{"name": "atlassian-portico"}],
    }

    verdict = module._validate_perfect_run(
        chat_id="chat-1",
        steer_user_message_id="user-steer-1",
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )

    assert verdict["perfect"] is True
    assert verdict["failures"] == []


def test_opus_reasoning_runner_handles_optional_reasoning_tokens_and_visible_block():
    google_runner = _load_google_runner()
    module = _load_opus_reasoning_runner(google_runner)

    message = {
        "content": '<details type="reasoning" done="true"><summary>Thought</summary>trace</details>',
        "info": {
            "usage": {
                "completion_tokens_details": {
                    "reasoning_tokens": 42,
                }
            }
        },
    }

    assert module._reasoning_tokens_for_message(message) == 42
    assert module._has_visible_reasoning_block(message["content"]) is True
    assert module._extract_reasoning_block_text(message["content"]) == "trace"


def test_opus_reasoning_runner_detects_duplicated_streamed_reasoning_text():
    google_runner = _load_google_runner()
    module = _load_opus_reasoning_runner(google_runner)

    clean_report = module._reasoning_duplicate_report(
        "I need to review the table, compare the constraints, and return the valid assignments."
    )
    duplicate_report = module._reasoning_duplicate_report(
        "I need need to review to review Dionny Santiago's head Dionny Santiago's headcount "
        "tagging assignments tagging assignments that that Heather Wood already Heather Wood "
        "already worked worked through through."
    )

    assert clean_report["detected"] is False
    assert duplicate_report["detected"] is True
    assert duplicate_report["duplicate_span_count"] >= 5
    assert "need" in duplicate_report["samples"]


def test_opus_48_reasoning_runner_defaults_to_clean_stream_validation():
    calls = []

    def fake_main(**kwargs):
        calls.append(kwargs)
        return 0

    previous = sys.modules.get("run_opus_5_reasoning_chat_consistency")
    sys.modules["run_opus_5_reasoning_chat_consistency"] = types.SimpleNamespace(
        main=fake_main
    )
    try:
        try:
            runpy.run_path(
                str(REPO_ROOT / "src/scripts/run_opus_48_reasoning_chat_consistency.py"),
                run_name="__main__",
            )
        except SystemExit as exc:
            assert exc.code == 0
    finally:
        if previous is None:
            sys.modules.pop("run_opus_5_reasoning_chat_consistency", None)
        else:
            sys.modules["run_opus_5_reasoning_chat_consistency"] = previous

    assert calls == [
        {
            "default_model": "Atlas Opus 4.8",
            "default_require_clean_reasoning_stream": True,
            "default_require_debug_monitor_details": False,
        }
    ]


def test_opus_48_prompt_cache_runner_detects_large_zero_read_rewrite():
    google_runner = _load_google_runner()
    module = _load_opus_prompt_cache_runner(google_runner)

    usage_summaries = [
        {"cache_read_input_tokens": 0, "cache_creation_input_tokens": 50000},
        {"cache_read_input_tokens": 47000, "cache_creation_input_tokens": 103},
        {"cache_read_input_tokens": 0, "cache_creation_input_tokens": 47100},
    ]
    misses = module._large_zero_read_rewrites(
        usage_summaries,
        large_write_threshold=4096,
    )
    assert len(misses) == 1
    assert misses[0]["cache_creation_input_tokens"] == 47100

    failures = module._validate_prompt_cache_sequence(
        model="Atlas Opus 4.8",
        scenario="no-tools",
        usage_summaries=usage_summaries,
        required_target=True,
        large_write_threshold=4096,
    )
    assert any(
        "large zero-read prompt-cache rewrite" in failure for failure in failures
    )

def test_opus_48_prompt_cache_runner_accepts_safe_cache_read_sequence():
    google_runner = _load_google_runner()
    module = _load_opus_prompt_cache_runner(google_runner)

    failures = module._validate_prompt_cache_sequence(
        model="Atlas Opus 4.8",
        scenario="no-tools",
        usage_summaries=[
            {"cache_read_input_tokens": 0, "cache_creation_input_tokens": 50000},
            {"cache_read_input_tokens": 47000, "cache_creation_input_tokens": 103},
            {"cache_read_input_tokens": 47000, "cache_creation_input_tokens": 103},
        ],
        required_target=True,
        large_write_threshold=4096,
    )
    assert failures == []

def test_gemini_runner_validates_safe_route_model_and_reasoning_evidence():
    google_runner = _load_google_runner()
    module = _load_gemini_runner(google_runner)

    request_detail = {
        "request_id": "req-1",
        "model": "portico-gemini-vertex/gemini-3.5-flash",
        "parameters": {"reasoning_effort": "high"},
        "response": {
            "thinking": "visible summary",
            "reasoning_details": [
                {"type": "reasoning.text", "text": "visible summary"},
                {"type": "reasoning.encrypted", "encrypted": "signature"},
            ],
            "usage": {
                "completion_tokens_details": {"reasoning_tokens": 42},
            },
        },
    }
    completion = {
        "content": "GEMINI_OK",
        "content_blocks": [{"type": "reasoning", "content": "visible summary"}],
    }

    evidence = module._gemini_route_evidence(
        [request_detail],
        model_id="gemini-3.5-flash",
    )
    verdict = module._validate_basic_chat(
        model_name="Gemini 3.5 Flash",
        model_id="gemini-3.5-flash",
        completion=completion,
        request_details=[request_detail],
    )

    assert evidence == {
        "route_found": True,
        "model_found": True,
        "custom_tools_absent": True,
    }
    assert verdict["reasoning_evidence"] == {
        "request_reasoning_efforts": ["high"],
        "response_thinking_chars": len("visible summary"),
        "reasoning_details_text_chars": len("visible summary"),
        "reasoning_details_encrypted_entries": 1,
        "reasoning_tokens": 42,
        "chat_has_reasoning_block": True,
        "chat_reasoning_chars": len("visible summary"),
    }
    assert verdict["perfect"] is True
    assert verdict["failures"] == []

    bad_evidence = module._gemini_route_evidence(
        [{"model": "portico-gemini-vertex/gemini-3.1-pro-preview-customtools"}],
        model_id="gemini-3.1-pro-preview",
    )
    assert bad_evidence["custom_tools_absent"] is False

def test_gemini_runner_validates_tool_chat_without_provider_payloads():
    google_runner = _load_google_runner()
    module = _load_gemini_runner(google_runner)
    arguments_attr = _encoded_attr({"filter": "all", "include_disabled": True})
    result_attr = _encoded_attr({"servers": [{"id": "server:mcp-assistant"}]})

    completion = {
        "content": (
            '<details type="tool_calls" name="mcp_assistant_list_mcp_servers" '
            f'arguments="{arguments_attr}" '
            f'result="{result_attr}"></details>'
        )
    }
    request_details = [
        {
            "request_id": "req-tool",
            "model": "portico-gemini-vertex/gemini-3.5-flash",
            "parameters": {"reasoning_effort": "medium"},
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "mcp_assistant_list_mcp_servers"},
                },
            ],
        }
    ]

    verdict = module._validate_tool_chat(
        completion=completion,
        request_details=request_details,
    )

    assert verdict["perfect"] is True
    assert verdict["failures"] == []
    assert verdict["tool_names"] == ["mcp_assistant_list_mcp_servers"]
    assert verdict["request_tool_names"] == ["mcp_assistant_list_mcp_servers"]
    assert "provider_tool_names" not in verdict

def test_opus_reasoning_runner_succeeds_without_transformed_request_payloads():
    google_runner = _load_google_runner()
    module = _load_opus_reasoning_runner(google_runner)

    class FakeClient:
        def create_chat(self, *, model, prompt):
            return {"chat_id": "chat-1", "user_message_id": "user-1"}

        def generate_completion(self, **kwargs):
            assert kwargs["reasoning_effort"] == "xhigh"

        def poll_for_completion(self, **kwargs):
            return {"complete": True, "assistant_message_id": "assistant-1"}

        def get_chat(self, chat_id):
            assert chat_id == "chat-1"
            return {
                "chat": {
                    "history": {
                        "messages": {
                            "assistant-1": {
                                "content": (
                                    '<details type="reasoning" done="true">'
                                    "<summary>Thought</summary>trace</details>"
                                ),
                                "info": {"usage": {}},
                            }
                        }
                    }
                }
            }

    module._wait_for_main_request_details = lambda *args, **kwargs: [
        {
            "request_id": "request-1",
            "parameters": {"reasoning_effort": "xhigh"},
            "response": {"thinking": "trace"},
        }
    ]

    result = module.run_once(
        FakeClient(),
        prompt="Solve carefully",
        model="Atlas Opus 5",
        effort="xhigh",
        timeout_seconds=10,
    )

    assert result["perfect"] is True
    assert result["failures"] == []
    assert result["debug_response_thinking_chars"] == 5
    assert "thinking_type" not in result
    assert "output_config_effort" not in result
