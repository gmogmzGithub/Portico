#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat and verify Marketplace ownership semantics.

The runner resolves the two foreign PORTICO-272 fixtures at runtime, installs a
temporary local copy when necessary, and asks the model for a read-only
assessment. A perfect run must:

- inspect authoritative local provenance for both the agent and the skill
- call both list_published_agents and list_published_skills
- avoid every Marketplace/local mutation tool
- explain that installed copies are read-only and recommend creating a copy

Any fixture installed by this runner is deleted locally in a finally block.
The foreign remote solutions are never unpublished or deleted.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import time
from typing import Any

import httpx

from run_google_workspace_chat_consistency import (
    MODEL,
    OWUIClient,
    _count_tool_call_batches,
    _detect_openwebui_base_url,
    _parse_tool_calls,
    _wait_for_main_request_details,
    ensure_debug_monitor_healthy,
)


AGENT_FIXTURE = "zzz-portico272-repro-agent-test"
SKILL_FIXTURE = "zzz-portico272-repro-skill-test"
AGENT_TYPE = "portico-agents"
SKILL_TYPE = "skills"
TARGET_STREAK = 3
DEFAULT_TIMEOUT_SECONDS = int(
    os.getenv("OWUI_MARKETPLACE_PROVENANCE_TIMEOUT_SECONDS", "300")
)
CORE_MCP_BASE_URL = os.getenv(
    "MCPO_CORE_PROXY_BASE_URL", "http://127.0.0.1:8766"
).rstrip("/")

PROMPT = (
    f"I have local Marketplace installations named {AGENT_FIXTURE} and "
    f"{SKILL_FIXTURE}. Use the Subagents and Skills read tools to inspect their "
    "local provenance and use the authoritative list_published_agents and "
    "list_published_skills tools to determine whether I own the remote listings. "
    "Do not create, edit, install, publish, republish, unpublish, or delete "
    "anything. Tell me whether either installed artifact can be customized or "
    "published in place, and explain the safe way to customize it."
)

REQUIRED_READ_TOOLS = {
    "subagents_get_agent",
    "subagents_list_published_agents",
    "skills_read_skill",
    "skills_list_published_skills",
}
FORBIDDEN_MUTATION_TOOLS = {
    "subagents_copy_agent",
    "subagents_create_agent",
    "subagents_update_agent",
    "subagents_delete_agent",
    "subagents_publish_agent",
    "subagents_unpublish_agent",
    "subagents_install_agent",
    "skills_copy_skill",
    "skills_create_skill",
    "skills_update_skill",
    "skills_delete_skill",
    "skills_create_skill_reference",
    "skills_update_skill_reference",
    "skills_delete_skill_reference",
    "skills_create_skill_script",
    "skills_update_skill_script",
    "skills_delete_skill_script",
    "skills_publish_skill",
    "skills_unpublish_skill",
    "skills_install_marketplace_solution",
}


def _ensure_owui_auth_bridge_secret() -> None:
    """Load the running source app's file-backed auth secret without logging it."""
    if os.getenv("OWUI_AUTH_BRIDGE_SECRET") or os.getenv("OWUI_AUTH_BRIDGE_SECRET_FILE"):
        return

    container_name = os.getenv("OPENWEBUI_CONTAINER_NAME", "portico-open-webui")
    inspect = subprocess.run(
        [
            "docker",
            "inspect",
            container_name,
            "--format",
            "{{range .Config.Env}}{{println .}}{{end}}",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    secret_file = ""
    for line in inspect.stdout.splitlines():
        if line.startswith("OWUI_AUTH_BRIDGE_SECRET_FILE="):
            secret_file = line.split("=", 1)[1].strip()
            break
    if not secret_file:
        raise RuntimeError(
            f"{container_name} did not expose its auth bridge secret file"
        )

    result = subprocess.run(
        [
            "docker",
            "exec",
            container_name,
            "sh",
            "-lc",
            'cat "$1"',
            "sh",
            secret_file,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    secret = result.stdout.strip()
    if not secret:
        raise RuntimeError("Open WebUI auth bridge secret file was empty")
    os.environ["OWUI_AUTH_BRIDGE_SECRET"] = secret


def _unwrap_tool_output(payload: Any) -> Any:
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
    return json.loads(content[0]["text"])


def _call_core_tool(server_id: str, tool_name: str, payload: dict[str, Any]) -> Any:
    prefix = server_id.replace("-", "_")
    url = f"{CORE_MCP_BASE_URL}/{server_id}/{prefix}_{tool_name}"
    response = httpx.post(url, json=payload, timeout=300.0)
    response.raise_for_status()
    result = _unwrap_tool_output(response.json())
    if isinstance(result, dict) and result.get("success") is False:
        raise RuntimeError(
            f"{prefix}_{tool_name} failed: "
            f"{result.get('code') or 'unknown'}: {result.get('error') or result!r}"
        )
    return result


def _solution_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("solutions", "results", "items"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    data = payload.get("data")
    return _solution_items(data) if data is not payload else []


def _agent_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict) and isinstance(payload.get("agents"), list):
        return [item for item in payload["agents"] if isinstance(item, dict)]
    return []


def _skill_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("skills"), list):
        return [item for item in payload["skills"] if isinstance(item, dict)]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _find_exact_solution(
    payload: Any, *, name: str, expected_type: str
) -> dict[str, Any]:
    matches = [
        solution
        for solution in _solution_items(payload)
        if str(solution.get("name") or "").strip() == name
        and str(solution.get("type") or "").strip() == expected_type
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly one {expected_type} solution named {name!r}; "
            f"found {len(matches)}"
        )
    if not str(matches[0].get("id") or "").strip():
        raise RuntimeError(f"Marketplace fixture {name!r} has no solution id")
    return matches[0]


def _installed_agent(
    payload: Any, *, solution_id: str
) -> dict[str, Any] | None:
    matches = [
        item
        for item in _agent_items(payload)
        if item.get("marketplace_solution_id") == solution_id
    ]
    if len(matches) > 1:
        raise RuntimeError(
            f"Multiple local agents are linked to foreign solution {solution_id}"
        )
    return matches[0] if matches else None


def _assert_foreign(
    solution: dict[str, Any], published_payload: Any, fixture_name: str
) -> None:
    published_ids = {
        str(item.get("id") or "").strip()
        for item in _solution_items(published_payload)
    }
    solution_id = str(solution["id"])
    if solution_id in published_ids:
        raise RuntimeError(
            f"Fixture {fixture_name!r} is owned by the current viewer; "
            "the foreign-provenance scenario would be invalid"
        )


def ensure_fixture_precondition() -> dict[str, Any]:
    agent_solution = _find_exact_solution(
        _call_core_tool(
            "subagents", "search_marketplace_agents", {"query": AGENT_FIXTURE}
        ),
        name=AGENT_FIXTURE,
        expected_type=AGENT_TYPE,
    )
    skill_solution = _find_exact_solution(
        _call_core_tool(
            "skills", "search_marketplace_solutions", {"query": SKILL_FIXTURE}
        ),
        name=SKILL_FIXTURE,
        expected_type=SKILL_TYPE,
    )
    _assert_foreign(
        agent_solution,
        _call_core_tool("subagents", "list_published_agents", {}),
        AGENT_FIXTURE,
    )
    _assert_foreign(
        skill_solution,
        _call_core_tool("skills", "list_published_skills", {}),
        SKILL_FIXTURE,
    )

    setup = {
        "agent_solution_id": str(agent_solution["id"]),
        "skill_solution_id": str(skill_solution["id"]),
        "agent_installed_by_runner": False,
        "skill_installed_by_runner": False,
        "local_agent_id": None,
        "local_skill_id": f"ai-marketplace/{SKILL_FIXTURE}",
    }

    agents = _call_core_tool("subagents", "list_agents", {})
    local_agent = _installed_agent(
        agents, solution_id=setup["agent_solution_id"]
    )
    if local_agent is None:
        _call_core_tool(
            "subagents",
            "install_agent",
            {"solution_id": setup["agent_solution_id"]},
        )
        setup["agent_installed_by_runner"] = True
        agents = _call_core_tool("subagents", "list_agents", {})
        local_agent = _installed_agent(
            agents, solution_id=setup["agent_solution_id"]
        )
    if local_agent is None:
        raise RuntimeError("Foreign agent install did not become visible")
    if (
        local_agent.get("marketplace_relationship") != "installed"
        or local_agent.get("is_read_only") is not True
    ):
        raise RuntimeError(
            f"Foreign agent has contradictory local provenance: {local_agent!r}"
        )
    setup["local_agent_id"] = str(local_agent.get("id") or "")

    skills = _call_core_tool(
        "skills", "list_skills", {"filter_source": "marketplace"}
    )
    local_skill_matches = [
        item
        for item in _skill_items(skills)
        if item.get("marketplace_solution_id") == setup["skill_solution_id"]
    ]
    if len(local_skill_matches) > 1:
        raise RuntimeError(
            "Multiple local skills are linked to the foreign fixture"
        )
    if not local_skill_matches:
        _call_core_tool(
            "skills",
            "install_marketplace_solution",
            {"solution_id": setup["skill_solution_id"]},
        )
        setup["skill_installed_by_runner"] = True
    skill_read = _call_core_tool(
        "skills",
        "read_skill",
        {"skill_name": setup["local_skill_id"]},
    )
    if (
        not isinstance(skill_read, dict)
        or skill_read.get("success") is not True
        or skill_read.get("marketplace_relationship") != "installed"
        or skill_read.get("marketplace_solution_id") != setup["skill_solution_id"]
        or skill_read.get("is_read_only") is not True
    ):
        raise RuntimeError(
            f"Foreign skill has contradictory local provenance: {skill_read!r}"
        )
    return setup


def cleanup_fixture_precondition(setup: dict[str, Any]) -> None:
    errors: list[str] = []
    if setup.get("agent_installed_by_runner") and setup.get("local_agent_id"):
        try:
            _call_core_tool(
                "subagents",
                "delete_agent",
                {"model_id": setup["local_agent_id"]},
            )
        except Exception as error:  # pragma: no cover - live cleanup diagnostic
            errors.append(f"agent cleanup failed: {error}")
    if setup.get("skill_installed_by_runner"):
        try:
            _call_core_tool(
                "skills",
                "delete_skill",
                {"skill_name": setup["local_skill_id"], "confirm": True},
            )
        except Exception as error:  # pragma: no cover - live cleanup diagnostic
            errors.append(f"skill cleanup failed: {error}")

    # Remote fixtures must remain readable after local cleanup.
    for server_id, tool_name, solution_id in (
        (
            "subagents",
            "get_marketplace_agent",
            setup.get("agent_solution_id"),
        ),
        (
            "skills",
            "get_marketplace_solution",
            setup.get("skill_solution_id"),
        ),
    ):
        try:
            _call_core_tool(
                server_id, tool_name, {"solution_id": solution_id}
            )
        except Exception as error:  # pragma: no cover - live cleanup diagnostic
            errors.append(f"remote fixture verification failed: {error}")
    if errors:
        raise RuntimeError("; ".join(errors))


def _result_mentions(call: dict[str, Any], *needles: str) -> bool:
    text = json.dumps(call.get("result"), sort_keys=True).lower()
    return all(needle.lower() in text for needle in needles)


def _assistant_final_text(assistant_html: str) -> str:
    without_details = re.sub(
        r"<details\b.*?</details>",
        "",
        str(assistant_html or ""),
        flags=re.DOTALL | re.IGNORECASE,
    )
    without_tags = re.sub(r"<[^>]+>", "", without_details)
    return html.unescape(without_tags).strip()


def _summarize_tool_call(call: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "name": str(call.get("name") or ""),
        "arguments": call.get("arguments"),
    }
    result = call.get("result")
    if isinstance(result, list):
        summary["result_count"] = len(result)
        return summary
    if not isinstance(result, dict):
        summary["result_type"] = type(result).__name__
        return summary

    result_summary = {
        key: result[key]
        for key in (
            "success",
            "code",
            "source",
            "creation_source",
            "marketplace_relationship",
            "marketplace_solution_id",
            "is_read_only",
            "viewer_email",
        )
        if key in result
    }
    for collection_key in ("solutions", "agents", "skills"):
        collection = result.get(collection_key)
        if isinstance(collection, list):
            result_summary[f"{collection_key}_count"] = len(collection)
    summary["result"] = result_summary
    return summary


def _validate_perfect_run(
    *,
    completion: dict[str, Any],
    setup: dict[str, Any],
    request_details: list[dict[str, Any]],
) -> dict[str, Any]:
    assistant_html = completion.get("content", "")
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [str(call.get("name") or "") for call in tool_calls]
    failures: list[str] = []

    missing_reads = sorted(REQUIRED_READ_TOOLS.difference(tool_names))
    if missing_reads:
        failures.append(f"required ownership/provenance reads were missing: {missing_reads}")
    mutations = [name for name in tool_names if name in FORBIDDEN_MUTATION_TOOLS]
    if mutations:
        failures.append(f"mutation tools were called for foreign installed artifacts: {mutations}")
    if not any(
        call.get("name") == "subagents_get_agent"
        and _result_mentions(
            call, setup["agent_solution_id"], "installed", "is_read_only"
        )
        for call in tool_calls
    ):
        failures.append("get_agent did not prove installed/read-only agent provenance")
    if not any(
        call.get("name") == "skills_read_skill"
        and _result_mentions(
            call, setup["skill_solution_id"], "installed", "is_read_only"
        )
        for call in tool_calls
    ):
        failures.append("read_skill did not prove installed/read-only skill provenance")
    if any(
        _result_mentions(call, setup["agent_solution_id"])
        for call in tool_calls
        if call.get("name") == "subagents_list_published_agents"
    ):
        failures.append("foreign agent appeared in list_published_agents")
    if any(
        _result_mentions(call, setup["skill_solution_id"])
        for call in tool_calls
        if call.get("name") == "skills_list_published_skills"
    ):
        failures.append("foreign skill appeared in list_published_skills")

    final_text = _assistant_final_text(assistant_html)
    answer = final_text.lower()
    if "copy" not in answer:
        failures.append("final answer did not recommend creating a copy")
    if "read-only" not in answer and "read only" not in answer:
        failures.append("final answer did not explain that installed artifacts are read-only")
    ownership_phrases = (
        "do not own",
        "don't own",
        "not the owner",
        "not owned",
        "not yours",
        "isn't yours",
        "aren't yours",
        "foreign",
    )
    if "publish" not in answer or not any(
        phrase in answer for phrase in ownership_phrases
    ):
        failures.append("final answer did not explain publication ownership")
    if not request_details:
        failures.append("llm-debug-monitor did not capture the chat requests")

    return {
        "perfect": not failures,
        "failures": failures,
        "tool_names": tool_names,
        "tool_call_summaries": [
            _summarize_tool_call(call) for call in tool_calls
        ],
        "final_text": final_text,
        "request_ids": [
            request.get("request_id") for request in request_details
        ],
    }


def run_once(
    client: OWUIClient,
    *,
    model: str,
    prompt: str,
    timeout_seconds: int,
    setup: dict[str, Any],
) -> dict[str, Any]:
    created = client.create_chat(model=model, prompt=prompt)
    chat_id = created["chat_id"]
    user_message_id = created["user_message_id"]
    client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=user_message_id,
        stream=True,
    )
    completion = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=user_message_id,
        timeout_seconds=timeout_seconds,
        poll_interval=2,
    )
    if not completion.get("complete"):
        return {
            "chat_id": chat_id,
            "perfect": False,
            "failures": [completion.get("error", "chat did not complete")],
        }
    request_details = _wait_for_main_request_details(
        chat_id,
        expected_main_request_count=_count_tool_call_batches(
            completion.get("content_blocks", [])
        )
        + 1,
    )
    verdict = _validate_perfect_run(
        completion=completion,
        setup=setup,
        request_details=request_details,
    )
    verdict["chat_id"] = chat_id
    return verdict


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=TARGET_STREAK)
    parser.add_argument("--max-attempts", type=int, default=TARGET_STREAK)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()

    _ensure_owui_auth_bridge_secret()
    ensure_debug_monitor_healthy()
    setup = ensure_fixture_precondition()
    perfect_runs = 0
    attempts = 0
    results: list[dict[str, Any]] = []
    cleanup_error: str | None = None
    try:
        with OWUIClient(base_url=_detect_openwebui_base_url(), timeout=60.0) as client:
            while perfect_runs < args.runs and attempts < args.max_attempts:
                attempts += 1
                started = time.time()
                result = run_once(
                    client,
                    model=args.model,
                    prompt=args.prompt,
                    timeout_seconds=args.timeout_seconds,
                    setup=setup,
                )
                result["attempt"] = attempts
                result["elapsed_seconds"] = round(time.time() - started, 1)
                results.append(result)
                print(json.dumps(result, indent=2, sort_keys=True))
                if result.get("perfect") is True:
                    perfect_runs += 1
                else:
                    perfect_runs = 0
                    break
    finally:
        try:
            cleanup_fixture_precondition(setup)
        except Exception as error:  # pragma: no cover - live cleanup diagnostic
            cleanup_error = str(error)

    summary = {
        "perfect": perfect_runs >= args.runs and cleanup_error is None,
        "perfect_runs": perfect_runs,
        "attempts": attempts,
        "target_runs": args.runs,
        "cleanup_error": cleanup_error,
        "results": results,
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["perfect"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
