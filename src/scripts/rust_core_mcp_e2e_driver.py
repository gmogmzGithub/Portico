#!/usr/bin/env python3

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path


CORE_SERVERS = [
    "agent-vm",
    "artifacts",
    "mcp-assistant",
    "scheduling",
    "skills",
    "subagents",
    "web-tools",
]


def log_step(message):
    print(f"[rust-core-e2e] {message}", flush=True)


def request_bytes(method, url, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise AssertionError(f"{method} {url} failed with HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise AssertionError(f"{method} {url} failed: {exc}") from exc


def request_json(method, url, payload=None):
    raw = request_bytes(method, url, payload)
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{method} {url} did not return JSON: {text!r}") from exc


def request_text(method, url, payload=None):
    return request_bytes(method, url, payload).decode("utf-8", errors="replace")


def get_text(url):
    return request_text("GET", url)


def unwrap_tool_output(payload):
    if not isinstance(payload, dict):
        return payload
    content = payload.get("content")
    if (
        not isinstance(content, list)
        or not content
        or not isinstance(content[0], dict)
        or "text" not in content[0]
    ):
        return payload
    text = content[0]["text"]
    return json.loads(text)


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for_json(url, predicate, timeout=120, interval=2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = request_json("GET", url)
        if predicate(payload):
            return payload
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {url}")


def call_tool(base_url, server_id, tool_name, payload):
    prefix = server_id.replace("-", "_")
    url = f"{base_url}/{server_id}/{prefix}_{tool_name}"
    return unwrap_tool_output(request_json("POST", url, payload))


def all_openapi_paths(project_root):
    expected = set()
    specs_root = Path(project_root) / "src/core-mcp-rust/crates"
    for spec_path in sorted(specs_root.glob("*-server/tool_spec.json")):
        server_id = spec_path.parent.name.removesuffix("-server")
        prefix = server_id.replace("-", "_")
        for tool in json.loads(spec_path.read_text()):
            expected.add(f"/{server_id}/{prefix}_{tool['name']}")
    return expected


def extract_server_entries(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("servers"), list):
        servers = payload["servers"]
        if servers and isinstance(servers[0], str):
            return [{"id": server_id} for server_id in servers]
        return servers
    raise AssertionError(f"unexpected /servers payload: {payload!r}")


def verify_server_health(base_url):
    health = request_text("GET", f"{base_url}/health")
    assert_true(health.strip() == "healthy", f"unexpected /health payload: {health!r}")
    servers_payload = wait_for_json(
        f"{base_url}/servers",
        lambda items: {item.get("id") for item in extract_server_entries(items)} == set(CORE_SERVERS),
    )
    servers = extract_server_entries(servers_payload)
    assert_true(len(servers) == len(CORE_SERVERS), "expected all core servers in /servers")
    seen = {item["id"] for item in servers}
    assert_true(seen == set(CORE_SERVERS), f"unexpected servers: {seen}")
    for server_id in CORE_SERVERS:
        status = wait_for_json(
            f"{base_url}/servers/{server_id}/status",
            lambda item: item.get("status") == "healthy"
            and item.get("readiness_phase") == "tool_ready"
            and item.get("proxy_probe_ok") is True,
        )
        assert_true(status["healthy"] is True, f"{server_id} should be healthy")


def verify_openapi(base_url, project_root):
    openapi = wait_for_json(
        f"{base_url}/openapi.json",
        lambda item: all(path in item.get("paths", {}) for path in all_openapi_paths(project_root)),
        timeout=120,
    )
    missing = sorted(all_openapi_paths(project_root) - set(openapi["paths"].keys()))
    assert_true(not missing, f"missing OpenAPI paths: {missing}")


def exercise_mcp_assistant(base_url, chat_id):
    integration_chat_id = f"{chat_id}-integrations"
    created = call_tool(
        base_url,
        "mcp-assistant",
        "create_user_mcp_server",
        {
            "server_id": "demo-user-http",
            "yaml_config": {
                "name": "Demo User HTTP Server",
                "display_name": "Demo User HTTP",
                "deployment_type": "docker",
                "description": "Demo user server for e2e",
            },
            "fragment": {
                "type": "streamable-http",
                "url": "http://example.com/mcp",
            },
        },
    )
    assert_true(created["success"] is True, "create_user_mcp_server failed")

    listed = call_tool(base_url, "mcp-assistant", "list_mcp_servers", {"filter": "all"})
    listed_ids = {item["id"] for item in listed["servers"]}
    assert_true(set(CORE_SERVERS).issubset(listed_ids), "missing core servers in list_mcp_servers")

    system_cfg = call_tool(
        base_url,
        "mcp-assistant",
        "get_system_mcp_config",
        {"server_id": "skills"},
    )
    assert_true(system_cfg["readonly"] is True, "system config should be readonly")

    validated = call_tool(
        base_url,
        "mcp-assistant",
        "validate_mcp_fragment",
        {"fragment": {"type": "streamable-http", "url": "http://example.com/mcp"}},
    )
    assert_true(validated["valid"] is True, "fragment should validate")

    read_back = call_tool(
        base_url,
        "mcp-assistant",
        "read_user_mcp_server",
        {"server_id": "demo-user-http"},
    )
    assert_true(read_back["server_id"] == "demo-user-http", "read_user_mcp_server mismatch")

    updated = call_tool(
        base_url,
        "mcp-assistant",
        "update_user_mcp_server",
        {
            "server_id": "demo-user-http",
            "yaml_config": {
                "name": "Demo User HTTP Server",
                "display_name": "Demo User HTTP Updated",
                "deployment_type": "docker",
                "description": "Updated user server for e2e",
            },
            "fragment": {
                "type": "streamable-http",
                "url": "http://example.com/mcp/updated",
            },
        },
    )
    assert_true(updated["success"] is True, "update_user_mcp_server failed")

    toggled_off = call_tool(
        base_url,
        "mcp-assistant",
        "toggle_integration",
        {"server_id": "demo-user-http", "enabled": False},
    )
    assert_true(toggled_off["enabled"] is False, "toggle off failed")

    toggled_on = call_tool(
        base_url,
        "mcp-assistant",
        "toggle_integration",
        {"server_id": "demo-user-http", "enabled": True},
    )
    assert_true(toggled_on["healthy"] is True, "toggle on should be healthy")

    restarted = call_tool(
        base_url,
        "mcp-assistant",
        "restart_mcp_server",
        {"server_id": "skills"},
    )
    assert_true(restarted["success"] is True, "restart_mcp_server failed")

    full_restart = call_tool(base_url, "mcp-assistant", "restart_mcp_infrastructure", {})
    assert_true(full_restart["success"] is True, "restart_mcp_infrastructure failed")

    activated = call_tool(
        base_url,
        "mcp-assistant",
        "activate_integration",
        {"chat_id": integration_chat_id, "tool_server_ids": ["server:skills"]},
    )
    assert_true(activated["success"] is True, "activate_integration failed")

    chat_tools = call_tool(
        base_url,
        "mcp-assistant",
        "get_chat_tools",
        {"chat_id": integration_chat_id},
    )
    assert_true("server:skills" in chat_tools["all_enabled_tools"], "skills not enabled for chat")

    authorized = call_tool(
        base_url,
        "mcp-assistant",
        "authorize_integration",
        {"server_id": "demo-user-http"},
    )
    assert_true(authorized["success"] is True and authorized["completed"] is True, "authorize failed")

    guided = call_tool(
        base_url,
        "mcp-assistant",
        "trigger_guided_setup",
        {"server_id": "demo-user-http", "reason": "e2e"},
    )
    assert_true(guided["success"] is True, "guided setup failed")

    return {"integration_chat_id": integration_chat_id}


def exercise_skills(base_url, chat_id):
    skill_name = "demo-skill"
    initial_content = """---
name: Demo Skill
description: Demo skill for e2e
required_mcp_servers:
  - web-tools
metadata:
  priority: high
  triggers:
    - demo skill
---
Initial demo skill content.
"""
    updated_content = initial_content.replace("Initial demo skill content.", "Updated demo skill content.")
    created = call_tool(
        base_url,
        "skills",
        "create_skill",
        {"skill_name": skill_name, "skill_content": initial_content},
    )
    assert_true(created["success"] is True, "create_skill failed")

    listed = call_tool(base_url, "skills", "list_skills", {"filter_source": "all"})
    assert_true(any(item["name"] == skill_name for item in listed["skills"]), "demo skill missing")

    read_back = call_tool(base_url, "skills", "read_skill", {"skill_name": skill_name})
    assert_true(skill_name == read_back["skill_name"], "read_skill mismatch")

    updated = call_tool(
        base_url,
        "skills",
        "update_skill",
        {"skill_name": skill_name, "skill_content": updated_content},
    )
    assert_true(updated["success"] is True, "update_skill failed")

    created_ref = call_tool(
        base_url,
        "skills",
        "create_skill_reference",
        {"skill_name": skill_name, "reference_path": "guide.md", "content": "reference one"},
    )
    assert_true(created_ref["success"] is True, "create_skill_reference failed")

    reference = call_tool(
        base_url,
        "skills",
        "get_skill_reference",
        {"skill_name": skill_name, "reference_path": "guide.md", "chat_id": chat_id},
    )
    assert_true(reference["content"] == "reference one", "reference content mismatch")

    updated_ref = call_tool(
        base_url,
        "skills",
        "update_skill_reference",
        {"skill_name": skill_name, "reference_path": "guide.md", "content": "reference two"},
    )
    assert_true(updated_ref["success"] is True, "update_skill_reference failed")

    created_script = call_tool(
        base_url,
        "skills",
        "create_skill_script",
        {
            "skill_name": skill_name,
            "script_path": "echo.py",
            "content": 'print("script-created")',
        },
    )
    assert_true(created_script["success"] is True, "create_skill_script failed")

    updated_script = call_tool(
        base_url,
        "skills",
        "update_skill_script",
        {
            "skill_name": skill_name,
            "script_path": "echo.py",
            "content": 'print("script-updated")',
        },
    )
    assert_true(updated_script["success"] is True, "update_skill_script failed")

    activated = call_tool(
        base_url,
        "skills",
        "activate_skill",
        {"skill_name": skill_name, "chat_id": chat_id},
    )
    assert_true(activated["success"] is True, "activate_skill failed")

    active = call_tool(
        base_url,
        "skills",
        "get_activated_skills",
        {"chat_id": chat_id},
    )
    assert_true(active["total"] >= 1, "expected activated skill")

    return {"skill_name": skill_name}


def exercise_scheduling(base_url):
    created = call_tool(
        base_url,
        "scheduling",
        "create_task",
        {
            "name": "Weekly status summary",
            "prompt": "Summarize the weekly status report",
            "model_id": "GPT-5.6 Sol",
            "schedule": {
                "kind": "once",
                "run_at": "2030-01-01T12:00:00Z",
                "timezone": "UTC",
            },
            "skill_ids": ["company-knowledge"],
            "tool_server_ids": ["server:web-tools"],
        },
    )
    task_id = created["id"]
    assert_true(created["next_run_at"] == "2030-01-01T12:00:00Z", "unexpected next_run_at")

    listed = call_tool(base_url, "scheduling", "list_tasks", {})
    assert_true(listed["count"] >= 1, "expected at least one scheduled task")
    assert_true(
        any(item["id"] == task_id for item in listed["tasks"]),
        "task missing from list_tasks",
    )

    fetched = call_tool(
        base_url,
        "scheduling",
        "get_task",
        {"task_id": task_id},
    )
    assert_true(fetched["id"] == task_id, "get_task mismatch")

    updated = call_tool(
        base_url,
        "scheduling",
        "update_task",
        {
            "task_id": task_id,
            "enabled": False,
            "tool_server_ids": ["server:web-tools"],
        },
    )
    assert_true(updated["enabled"] is False, "update_task should disable the task")

    deleted = call_tool(
        base_url,
        "scheduling",
        "delete_task",
        {"task_id": task_id},
    )
    assert_true(deleted["success"] is True, "delete_task failed")


def exercise_subagents(base_url, skill_name):
    listed = call_tool(base_url, "subagents", "list_agents", {"filter_type": "all"})
    listed_ids = {item["id"] for item in listed}
    assert_true("mock-base-model" in listed_ids, "base model missing")
    assert_true("portico_agent_mock-agent" in listed_ids, "derived model missing")

    tools = call_tool(base_url, "subagents", "list_available_tools", {})
    assert_true(any(item["id"] == "server:web-tools" for item in tools), "web-tools missing from tool list")

    created = call_tool(
        base_url,
        "subagents",
        "create_agent",
        {
            "name": "Demo Agent",
            "base_model_id": "mock-base-model",
            "system_prompt": "Be concise.",
            "tool_server_ids": ["server:web-tools"],
            "description": "Demo agent for e2e",
        },
    )
    agent_id = created["id"]
    assert_true(agent_id == "demo-agent", "unexpected agent id")

    fetched = call_tool(base_url, "subagents", "get_agent", {"model_id": agent_id})
    assert_true(fetched["id"] == agent_id, "get_agent mismatch")

    system_prompt = call_tool(
        base_url,
        "subagents",
        "get_agent_system_prompt",
        {"model_id": agent_id},
    )
    assert_true(system_prompt["system_prompt"] == "Be concise.", "system prompt mismatch")

    updated = call_tool(
        base_url,
        "subagents",
        "update_agent",
        {
            "model_id": agent_id,
            "name": "Demo Agent Updated",
            "system_prompt": "Updated prompt.",
            "tool_server_ids": ["server:web-tools", "server:skills"],
            "description": "Updated agent",
        },
    )
    assert_true(updated["name"] == "Demo Agent Updated", "update_agent failed")

    run_result = call_tool(
        base_url,
        "subagents",
        "run_subagent",
        {
            "model": agent_id,
            "prompt": "Say hello from the subagent.",
            "tool_server_ids": ["server:web-tools"],
            "skill_ids": [skill_name],
            "parent_tool_call_id": "tool-call-demo",
        },
    )
    assert_true("Subagent response to:" in run_result["response"], "run_subagent response mismatch")

    deleted = call_tool(base_url, "subagents", "delete_agent", {"model_id": agent_id})
    assert_true(deleted["success"] is True, "delete_agent failed")


def exercise_web_tools(base_url):
    result = call_tool(
        base_url,
        "web-tools",
        "web_search",
        {
            "query": "rust core mcp e2e",
            "allowed_domains": ["example.com"],
            "user_location": {
                "country": "US",
                "city": "New York",
                "region": "New York",
                "timezone": "America/New_York",
            },
        },
    )
    assert_true(result["success"] is True, "web_search failed")
    assert_true(result["usage"]["web_search_calls"] == 1, "expected one web_search_call")


def exercise_agent_vm(base_url, chat_id, skill_name):
    created = call_tool(
        base_url,
        "agent-vm",
        "create",
        {"chat_id": chat_id, "timeout_hours": 1},
    )
    vm_id = created["vm_id"]
    assert_true(created["success"] is True, "create failed")

    status = call_tool(base_url, "agent-vm", "get_status", {"vm_id": vm_id})
    assert_true(status["vm_id"] == vm_id, "get_status mismatch")

    bash = call_tool(
        base_url,
        "agent-vm",
        "bash",
        {"vm_id": vm_id, "command": "printf 'bash-ok'"},
    )
    assert_true("bash-ok" in bash["stdout"], "bash failed")

    jq_version = call_tool(
        base_url,
        "agent-vm",
        "bash",
        {"vm_id": vm_id, "command": "jq --version"},
    )
    assert_true(jq_version["success"] is True, "jq should be installed in Agent VM")
    assert_true("jq-" in jq_version["stdout"], "unexpected jq --version output")

    python_result = call_tool(
        base_url,
        "agent-vm",
        "python",
        {"vm_id": vm_id, "script": 'print("py-ok")'},
    )
    assert_true(
        "py-ok" in python_result.get("stdout", ""),
        f"python failed: {json.dumps(python_result, sort_keys=True)}",
    )

    created_file = call_tool(
        base_url,
        "agent-vm",
        "create_file",
        {"vm_id": vm_id, "path": "notes.txt", "content": "hello"},
    )
    assert_true(created_file["success"] is True, "create_file failed")

    chunk_source = call_tool(
        base_url,
        "agent-vm",
        "create_file",
        {"vm_id": vm_id, "path": "chunk.txt", "content": "0123456789abcdef"},
    )
    assert_true(chunk_source["success"] is True, "chunk source file creation failed")

    chunk = call_tool(
        base_url,
        "agent-vm",
        "read_fragment",
        {"vm_id": vm_id, "path": "chunk.txt", "offset_chars": 4, "max_chars": 6},
    )
    assert_true(chunk["success"] is True, "read_fragment failed")
    assert_true(chunk["content"] == "456789", "read_fragment content mismatch")
    assert_true(chunk["offset_chars"] == 4, "read_fragment offset mismatch")
    assert_true(chunk["chars_returned"] == 6, "read_fragment chars_returned mismatch")
    assert_true(chunk["next_offset_chars"] == 10, "read_fragment next offset mismatch")
    assert_true(chunk["truncated"] is True, "read_fragment should report truncation")

    match_source = call_tool(
        base_url,
        "agent-vm",
        "create_file",
        {"vm_id": vm_id, "path": "match-source.txt", "content": "0123beta7890betaXYZ"},
    )
    assert_true(match_source["success"] is True, "match source file creation failed")

    file_matches = call_tool(
        base_url,
        "agent-vm",
        "grep_file",
        {
            "vm_id": vm_id,
            "path": "match-source.txt",
            "patterns": ["beta", "7890", "beta"],
            "before_chars": 2,
            "after_chars": 3,
            "max_results_per_pattern": 1,
        },
    )
    assert_true(file_matches["success"] is True, "grep_file failed")
    assert_true(file_matches["path"] == "/work/match-source.txt", "grep_file path mismatch")
    beta_matches = file_matches["results_by_pattern"]["beta"]
    assert_true(beta_matches["total_matches"] == 2, "grep_file total_matches mismatch")
    assert_true(beta_matches["returned_matches"] == 1, "grep_file returned_matches mismatch")
    assert_true(beta_matches["truncated"] is True, "grep_file truncation mismatch")
    assert_true(
        beta_matches["matches"][0]["start_offset_chars"] == 4,
        "grep_file start offset mismatch",
    )

    json_file = call_tool(
        base_url,
        "agent-vm",
        "create_file",
        {
            "vm_id": vm_id,
            "path": "data.json",
            "content": '{"items":[{"id":1},{"id":2}],"message":"hello"}',
        },
    )
    assert_true(json_file["success"] is True, "JSON file creation failed")

    jq_query = call_tool(
        base_url,
        "agent-vm",
        "bash",
        {"vm_id": vm_id, "command": "jq -r '.items[1].id' /work/data.json"},
    )
    assert_true(jq_query["success"] is True, "jq query failed")
    assert_true(jq_query["stdout"].strip() == "2", "jq query result mismatch")

    batch_create = call_tool(
        base_url,
        "agent-vm",
        "create_files",
        {
            "vm_id": vm_id,
            "files": [
                {"path": "dir/a.txt", "content": "A"},
                {"path": "dir/b.txt", "content": "B"},
            ],
        },
    )
    assert_true(batch_create["success"] is True, "create_files failed")

    read_one = call_tool(
        base_url,
        "agent-vm",
        "read_file",
        {"vm_id": vm_id, "path": "notes.txt"},
    )
    assert_true(read_one["content"] == "hello", "read_file mismatch")

    read_many = call_tool(
        base_url,
        "agent-vm",
        "read_files",
        {"vm_id": vm_id, "paths": ["notes.txt", "dir/a.txt"]},
    )
    assert_true(read_many["success"] is True, "read_files failed")

    edit_one = call_tool(
        base_url,
        "agent-vm",
        "edit_file",
        {
            "vm_id": vm_id,
            "file_path": "notes.txt",
            "old_string": "hello",
            "new_string": "hello world",
        },
    )
    assert_true(edit_one["success"] is True, "edit_file failed")

    edit_many = call_tool(
        base_url,
        "agent-vm",
        "edit_files",
        {
            "vm_id": vm_id,
            "edits": [
                {
                    "file_path": "dir/a.txt",
                    "old_string": "A",
                    "new_string": "AA",
                }
            ],
        },
    )
    assert_true(edit_many["success"] is True, "edit_files failed")

    listed = call_tool(
        base_url,
        "agent-vm",
        "list_files",
        {"vm_id": vm_id, "directory": "/work", "recursive": True},
    )
    assert_true(len(listed["files"]) >= 3, "list_files should list created files")

    found = call_tool(
        base_url,
        "agent-vm",
        "find_files",
        {"vm_id": vm_id, "pattern": "**/*.txt"},
    )
    found_paths = found.get("files")
    if found_paths is None:
        found_paths = found.get("matches", [])
    assert_true(
        any(path.endswith("notes.txt") for path in found_paths),
        "find_files missing notes.txt",
    )

    searched = call_tool(
        base_url,
        "agent-vm",
        "grep",
        {"vm_id": vm_id, "pattern": "hello|AA"},
    )
    if "results" in searched:
        total_matches = sum(item.get("match_count", 0) for item in searched.get("results", []))
    elif "matches" in searched:
        total_matches = len(searched.get("matches", []))
    else:
        total_matches = searched.get("total", searched.get("count", 0))
    assert_true(total_matches >= 2, "grep should find matches")

    wrote_workspace = call_tool(
        base_url,
        "agent-vm",
        "create_file",
        {
            "vm_id": vm_id,
            "path": "output/message.txt",
            "content": "workspace hello",
        },
    )
    assert_true(wrote_workspace["success"] is True, "workspace output create_file failed")

    listed_workspace = call_tool(
        base_url,
        "agent-vm",
        "list_files",
        {"vm_id": vm_id, "directory": "output", "recursive": False},
    )
    assert_true(
        any(
            (item.get("name") if isinstance(item, dict) else item).endswith("message.txt")
            for item in listed_workspace["files"]
        ),
        "workspace file missing",
    )

    copied_from_workspace = call_tool(
        base_url,
        "agent-vm",
        "bash",
        {
            "vm_id": vm_id,
            "command": "mkdir -p /work/copied && cp /work/output/message.txt /work/copied/message.txt",
        },
    )
    assert_true(copied_from_workspace["success"] is True, "workspace copy from shared path failed")

    copied_to_workspace = call_tool(
        base_url,
        "agent-vm",
        "bash",
        {
            "vm_id": vm_id,
            "command": "cp /work/notes.txt /work/output/notes-copy.txt",
        },
    )
    assert_true(copied_to_workspace["success"] is True, "workspace copy to shared path failed")

    workspace_link = call_tool(
        base_url,
        "agent-vm",
        "get_workspace_file_link",
        {
            "chat_id": chat_id,
            "vm_id": vm_id,
            "file_path": "output/message.txt",
        },
    )
    assert_true("download_url" in workspace_link, "workspace file link missing download_url")

    executed_skill = call_tool(
        base_url,
        "agent-vm",
        "execute_skill_script",
        {
            "skill_name": skill_name,
            "script_name": "echo.py",
            "chat_id": chat_id,
        },
    )
    assert_true("script-updated" in executed_skill["stdout"], "execute_skill_script failed")

    zipped = call_tool(
        base_url,
        "agent-vm",
        "python",
        {
            "vm_id": vm_id,
            "script": (
                "import zipfile\n"
                "with zipfile.ZipFile('/work/archive.zip', 'w') as z:\n"
                "    z.write('/work/notes.txt', 'nested/notes.txt')\n"
                "print('zip-ok')\n"
            ),
        },
    )
    assert_true("zip-ok" in zipped["stdout"], "zip creation failed")

    unzipped = call_tool(
        base_url,
        "agent-vm",
        "unzip_file",
        {
            "vm_id": vm_id,
            "zip_path": "archive.zip",
            "dest_path": "/work/unpacked",
            "strip_components": 1,
        },
    )
    assert_true(unzipped["success"] is True, "unzip_file failed")

    deleted = call_tool(
        base_url,
        "agent-vm",
        "delete_file",
        {"vm_id": vm_id, "path": "dir/b.txt"},
    )
    assert_true(deleted["success"] is True, "delete_file failed")

    return {"vm_id": vm_id}


def exercise_artifacts(base_url, chat_id, vm_id):
    index_created = call_tool(
        base_url,
        "agent-vm",
        "create_file",
        {
            "vm_id": vm_id,
            "path": "index.html",
            "content": "<!doctype html><h1>Artifact version one</h1>",
        },
    )
    assert_true(index_created["success"] is True, "artifact index file creation failed")

    created = call_tool(
        base_url,
        "artifacts",
        "create_artifact",
        {
            "chat_id": chat_id,
            "name": "Demo Artifact",
            "start_command": "python -m http.server 8000",
            "container_port": 8000,
            "vm_id": vm_id,
            "version_note": "initial snapshot",
        },
    )
    artifact_id = created["artifact_id"]
    assert_true(
        created["success"] is True,
        f"create_artifact failed: {json.dumps(created, sort_keys=True)}",
    )
    assert_true(created["status"] == "running", "create_artifact should report running")
    assert_true(created.get("preview_url"), "create_artifact missing preview_url")
    assert_true(
        "Artifact version one" in get_text(created["preview_url"]),
        "artifact preview did not serve version one content",
    )

    listed = call_tool(
        base_url,
        "artifacts",
        "list_artifacts",
        {"chat_id": chat_id, "include_all_versions": True},
    )
    assert_true(listed["count"] == 1, "expected one artifact")

    status = call_tool(
        base_url,
        "artifacts",
        "get_artifact_status",
        {"artifact_id": artifact_id},
    )
    assert_true(status["artifact_id"] == artifact_id, "artifact status mismatch")

    updated_index = call_tool(
        base_url,
        "agent-vm",
        "bash",
        {
            "vm_id": vm_id,
            "command": "cat > /work/index.html <<'EOF'\n<!doctype html><h1>Artifact version two</h1>\nEOF",
        },
    )
    assert_true(updated_index["success"] is True, "artifact index update failed")

    versioned = call_tool(
        base_url,
        "artifacts",
        "create_artifact_version",
        {
            "artifact_id": artifact_id,
            "chat_id": chat_id,
            "source_vm_id": vm_id,
            "version_note": "second snapshot",
        },
    )
    assert_true(versioned["success"] is True, "create_artifact_version failed")
    assert_true(versioned["version"] == 2, "create_artifact_version version mismatch")
    assert_true(
        "Artifact version two" in get_text(versioned["preview_url"]),
        "artifact preview did not serve version two content",
    )

    opened = call_tool(
        base_url,
        "artifacts",
        "open_artifact",
        {"artifact_id": artifact_id, "version": 1},
    )
    assert_true(opened["success"] is True, "open_artifact failed")
    assert_true(
        "Artifact version one" in get_text(opened["preview_url"]),
        "open_artifact did not serve version one content",
    )

    switched = call_tool(
        base_url,
        "artifacts",
        "switch_artifact_version",
        {"artifact_id": artifact_id, "version": 2},
    )
    assert_true(switched["success"] is True, "switch_artifact_version failed")
    assert_true(switched["version"] == 2, "switch_artifact_version version mismatch")
    assert_true(
        "Artifact version two" in get_text(switched["preview_url"]),
        "switch_artifact_version did not serve version two content",
    )

    running = call_tool(
        base_url,
        "artifacts",
        "get_artifact_running_versions",
        {"artifact_id": artifact_id},
    )
    assert_true(running["current_version"] == 2, "running version mismatch")

    restored = call_tool(
        base_url,
        "artifacts",
        "restore_artifact_version",
        {"artifact_id": artifact_id, "version": 1, "chat_id": chat_id},
    )
    assert_true(restored["success"] is True, "restore_artifact_version failed")
    assert_true("version 1" in restored["message"], "restore_artifact_version message mismatch")
    restored_status = call_tool(
        base_url,
        "artifacts",
        "get_artifact_status",
        {"artifact_id": artifact_id},
    )
    assert_true(
        "Artifact version one" in get_text(restored_status["preview_url"]),
        "restore_artifact_version did not serve version one content",
    )

    downloaded = call_tool(
        base_url,
        "artifacts",
        "download_artifact",
        {"artifact_id": artifact_id, "chat_id": chat_id, "version": 1},
    )
    assert_true(downloaded["success"] is True, "download_artifact failed")
    assert_true(downloaded["file_path"].startswith("output/"), "download_artifact missing file_path")

    closed = call_tool(
        base_url,
        "artifacts",
        "close_artifact",
        {"artifact_id": artifact_id},
    )
    assert_true(closed["success"] is True, "close_artifact failed")

    deleted = call_tool(
        base_url,
        "artifacts",
        "delete_artifact",
        {"artifact_id": artifact_id, "chat_id": chat_id, "confirm": True},
    )
    assert_true(deleted["success"] is True, "delete_artifact failed")


def cleanup_skills(base_url, chat_id, skill_name):
    deactivated = call_tool(
        base_url,
        "skills",
        "deactivate_skill",
        {"skill_name": skill_name, "chat_id": chat_id},
    )
    assert_true(deactivated["success"] is True, "deactivate_skill failed")

    deleted_ref = call_tool(
        base_url,
        "skills",
        "delete_skill_reference",
        {"skill_name": skill_name, "reference_path": "guide.md"},
    )
    assert_true(deleted_ref["success"] is True, "delete_skill_reference failed")

    deleted_script = call_tool(
        base_url,
        "skills",
        "delete_skill_script",
        {"skill_name": skill_name, "script_path": "echo.py"},
    )
    assert_true(deleted_script["success"] is True, "delete_skill_script failed")

    deleted_skill = call_tool(
        base_url,
        "skills",
        "delete_skill",
        {"skill_name": skill_name, "confirm": True},
    )
    assert_true(deleted_skill["success"] is True, "delete_skill failed")


def cleanup_mcp_assistant(base_url):
    deleted = call_tool(
        base_url,
        "mcp-assistant",
        "delete_user_mcp_server",
        {"server_id": "demo-user-http", "confirm": True},
    )
    assert_true(
        deleted.get("success") is True,
        f"delete_user_mcp_server failed: {deleted}",
    )


def cleanup_vm(base_url, chat_id, vm_id):
    destroyed = call_tool(
        base_url,
        "agent-vm",
        "destroy",
        {"vm_id": vm_id, "requester_chat_id": chat_id},
    )
    assert_true(destroyed["success"] is True, "destroy failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--chat-id", required=True)
    parser.add_argument("--project-root", required=True)
    args = parser.parse_args()

    log_step("verifying aggregator health and server readiness")
    verify_server_health(args.base_url)
    log_step("verifying aggregated OpenAPI document")
    verify_openapi(args.base_url, args.project_root)
    log_step("exercising mcp-assistant")
    exercise_mcp_assistant(args.base_url, args.chat_id)
    log_step("exercising scheduling")
    exercise_scheduling(args.base_url)
    log_step("exercising skills")
    skills_state = exercise_skills(args.base_url, args.chat_id)
    log_step("exercising subagents")
    exercise_subagents(args.base_url, skills_state["skill_name"])
    log_step("exercising web-tools")
    exercise_web_tools(args.base_url)
    log_step("exercising agent-vm")
    vm_state = exercise_agent_vm(args.base_url, args.chat_id, skills_state["skill_name"])
    log_step("exercising artifacts")
    exercise_artifacts(args.base_url, args.chat_id, vm_state["vm_id"])
    log_step("cleaning up skills")
    cleanup_skills(args.base_url, args.chat_id, skills_state["skill_name"])
    log_step("cleaning up mcp-assistant state")
    cleanup_mcp_assistant(args.base_url)
    log_step("cleaning up agent-vm state")
    cleanup_vm(args.base_url, args.chat_id, vm_state["vm_id"])
    print("Rust core MCP E2E suite passed")


if __name__ == "__main__":
    main()
