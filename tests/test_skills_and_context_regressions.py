import json
import io
import asyncio
import datetime
import logging
import os
from pathlib import Path
import re
import sys
import time
from contextlib import nullcontext
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from filters.unified_context import Filter
from managers.skill_manager import SkillManager


def _make_filter_stub():
    filter_obj = Filter.__new__(Filter)
    filter_obj.valves = SimpleNamespace(
        mcpo_url="http://mcpo:8765",
        mcpo_core_url="http://mcpo-core:8765",
    )
    filter_obj.redis_client = None
    filter_obj._cached_unauthenticated = []
    filter_obj._unauthenticated_server_ids = set()
    filter_obj._unconfigured_server_ids = set()
    filter_obj._get_disabled_integrations = lambda: []
    filter_obj._get_unconfigured_integrations = lambda: []
    filter_obj._is_server_toggled_on = lambda server_id: True
    filter_obj._should_auto_enable_skill_server = lambda _chat_id, _server_id: False
    filter_obj._is_server_auto_enable_eligible = lambda _server_id: True
    filter_obj._get_auto_enable_skill_servers = lambda _chat_id: []
    filter_obj._store_auto_enable_skill_servers = lambda _chat_id, _server_ids: None
    filter_obj._snapshot_skill_auto_enable_servers = lambda _chat_id, _skill_name: None
    filter_obj._health_status_snapshot_cache = _health_snapshot({})
    return filter_obj


def _health_snapshot(servers: dict | None = None, *, timestamp: float | None = None) -> dict:
    return {
        "timestamp": time.time() if timestamp is None else timestamp,
        "servers": servers or {},
    }


def _set_health_snapshot(filter_obj, servers: dict | None = None, *, timestamp: float | None = None) -> None:
    filter_obj._health_status_snapshot_cache = _health_snapshot(servers, timestamp=timestamp)


def _fail_live_readiness_methods(filter_obj) -> None:
    filter_obj._get_server_readiness = lambda server_id: pytest.fail(
        f"unexpected live readiness fetch for {server_id}"
    )
    filter_obj._get_server_readiness_bulk = lambda server_ids: pytest.fail(
        f"unexpected bulk readiness fetch for {server_ids}"
    )


def _read_text(*parts: str) -> str:
    return (ROOT.joinpath(*parts)).read_text()


def _load_json(*parts: str):
    return json.loads(_read_text(*parts))


def test_atlassian_fragment_uses_authv2_endpoint():
    fragment = _load_json("mcp-configs", "mcp-atlassian", "mcp-atlassian.fragment")

    assert fragment["url"] == "https://mcp.atlassian.com/v1/mcp/authv2"
    assert fragment["oauth"]["resource"] == "https://mcp.atlassian.com/v1/mcp/authv2"


def test_yaml_declared_oauth_servers_include_runtime_oauth_fragment():
    missing = []
    for base in (ROOT / "mcp-configs", ROOT / "mcp-configs-user"):
        if not base.exists():
            continue
        for server_dir in sorted(entry for entry in base.iterdir() if entry.is_dir()):
            server_id = server_dir.name
            yaml_path = server_dir / f"{server_id}.yaml"
            fragment_path = server_dir / f"{server_id}.fragment"
            if not yaml_path.exists() or not fragment_path.exists():
                continue
            yaml_text = yaml_path.read_text()
            if not re.search(r"(?m)^oauth\s*:", yaml_text):
                continue
            fragment = json.loads(fragment_path.read_text())
            if not isinstance(fragment.get("oauth"), dict) or not fragment["oauth"]:
                missing.append(str(fragment_path.relative_to(ROOT)))

    assert missing == []


def _system_mcp_server_ids() -> set[str]:
    inventory = set()
    for entry in (ROOT / "mcp-configs").iterdir():
        if entry.is_dir() and (entry / f"{entry.name}.yaml").exists():
            inventory.add(entry.name)
    return inventory


def _assert_no_unprefixed_tool_call(text: str, bare_name: str, prefixed_prefix: str) -> None:
    pattern = rf"(?<!{re.escape(prefixed_prefix)}){re.escape(bare_name)}\("
    assert re.search(pattern, text) is None


def test_base_prompt_uses_actual_skill_tool_names():
    prompt = _read_text("agents", "base_system_prompt.md")
    docs = _read_text("docs", "architecture", "skills", "skills.md")

    assert "skills_activate_skill" in prompt
    assert "skills_get_skill_reference" in prompt
    assert "reference_path=\"pptxgenjs.md\"" in prompt
    assert "editing.md" in prompt
    assert "references/file.md" in prompt
    assert "skills_list_skills" in prompt
    assert "skills_deactivate_skill" in prompt
    assert "mcp_assistant_activate_skill" not in prompt
    assert "mcp_assistant_get_skill_reference" not in prompt
    assert "Maximum 4 skills can be active simultaneously" not in prompt
    assert "Maximum activated skills per chat" not in docs
    assert "max_activated_skills" not in docs
    assert '"max_skills"' not in docs


def test_base_prompt_guides_brief_user_facing_progress_updates():
    prompt = _read_text("agents", "base_system_prompt.md")

    assert "## User-Facing Progress Updates" in prompt
    assert "tools or multiple meaningful steps" in prompt
    assert "Before starting substantial work" in prompt
    assert "At meaningful phase transitions" in prompt
    assert "what was completed and what you will do next" in prompt
    assert "results change the plan" in prompt
    assert "a tool fails and you choose a recovery path" in prompt
    assert "Do not narrate every tool call" in prompt
    assert "simple requests that can be answered directly" in prompt
    assert "Never expose private chain-of-thought or hidden reasoning" in prompt
    assert "do not present it as the final answer" in prompt


def test_base_prompt_guides_sensitive_information_tool_for_agent_vm_secrets():
    prompt = _read_text("agents", "base_system_prompt.md")

    assert "agent_vm_request_sensitive_information" in prompt
    assert "Never ask users to paste API keys" in prompt
    assert "without reading, printing, echoing" in prompt
    assert "temporary `/work/.sensitive/...` file" in prompt


def test_base_prompt_gates_delegation_and_cross_chat_tools_on_explicit_request():
    prompt = _read_text("agents", "base_system_prompt.md")

    # run_subagent is consent-gated: no self-justified delegation loopholes.
    assert "off-limits unless the user explicitly asked" in prompt
    assert "Parallelism is NOT a reason to delegate on your own" in prompt
    assert (
        'Task size, complexity, or "context isolation" is NOT a reason to delegate'
        in prompt
    )
    assert "say so and ask" in prompt

    # Cross-chat tools follow the same consent rule and are never swapped for
    # delegation mid-workflow.
    assert "### Cross-Chat Tools Are Not Delegation" in prompt
    assert "Never substitute `subagents_run_subagent` for a cross-chat workflow" in prompt
    assert "follow-up rounds of a workflow the user already established" in prompt


def test_subagents_tool_spec_gates_run_subagent_on_explicit_request():
    spec = json.loads(
        _read_text(
            "src", "core-mcp-rust", "crates", "subagents-server", "tool_spec.json"
        )
    )
    by_name = {tool["name"]: tool for tool in spec}

    run_subagent_description = by_name["run_subagent"]["description"]
    assert "ONLY use this when the user explicitly asked" in run_subagent_description
    assert "NOT reasons to delegate on your own" in run_subagent_description

    start_chat_description = by_name["start_chat"]["description"]
    assert "do NOT substitute subagents_run_subagent" in start_chat_description
    assert "ALL rounds of a user-requested multi-chat workflow" in start_chat_description


def test_base_prompt_defaults_subagents_to_parent_base_model():
    prompt = _read_text("agents", "base_system_prompt.md")

    # Base-model chats inherit the exact active session model and always pass it.
    assert "### Default Model Inheritance" in prompt
    assert "Read the exact active model or agent ID from `<session><model>`" in prompt
    assert "use the exact `<session><model>` value" in prompt
    assert "Always populate the `model` argument explicitly" in prompt
    assert "never omit it or rely on the subagent server's system-default fallback" in prompt

    # Custom-agent chats inherit the plain underlying base model, with a lookup
    # fallback when the injected inventory is truncated.
    assert "use its exact `base_model_id`, not the custom agent wrapper" in prompt
    assert "call `subagents_get_agent` with the `<session><model>` ID" in prompt
    assert "Use its non-empty `base_model_id`" in prompt

    # Fan-outs stay consistent unless the user explicitly authorizes an override.
    assert "Apply the resolved inherited model to every subagent in the same fan-out" in prompt
    assert "only when the user explicitly names one or explicitly delegates model selection" in prompt
    assert "MUST NOT switch models autonomously for speed, cost, volume, task complexity, or perceived quality" in prompt
    assert "A user-directed override takes precedence over inheritance" in prompt
    assert "### Override-Only Model Selection Guidelines" in prompt
    assert "It never supersedes Default Model Inheritance" in prompt


def test_dynamic_skills_context_reference_guidance_accepts_skill_relative_paths():
    filter_obj = _make_filter_stub()

    instructions = Filter._build_skill_instructions(filter_obj, [])

    assert "available_references or SKILL.md links" in instructions
    assert 'reference_path="pptxgenjs.md"' in instructions
    assert "editing.md" in instructions
    assert "references/file.md" in instructions


def test_base_prompt_distinguishes_chat_activation_from_toggle():
    prompt = _read_text("agents", "base_system_prompt.md")

    assert '"Available Tool Servers:"' in prompt
    assert '"Currently Enabled Tool Servers for This Chat:"' in prompt
    assert "That is **not the same as disabled**" in prompt
    assert "Use `mcp_assistant_activate_integration` to attach it to the current chat" in prompt
    assert "Do **NOT** call `mcp_assistant_toggle_integration` unless the system context explicitly marks it disabled" in prompt
    assert "use them directly instead of calling `mcp_assistant_activate_integration`" in prompt


def test_base_prompt_forbids_public_tunnels_for_local_services():
    prompt = _read_text("agents", "base_system_prompt.md")
    prompt_lower = prompt.lower()

    assert "## CRITICAL: Local Service Exposure" in prompt
    assert "Never recommend exposing a localhost-only or private local service to the public internet" in prompt
    assert "Do not suggest public tunnel, public reverse-proxy, or internet-exposed endpoint tools" in prompt
    assert "`ngrok`, Cloudflare Tunnel, localtunnel, Serveo" in prompt
    assert "ad hoc port forwarding, or public DNS for local services" in prompt
    assert "expose prompts, responses, local APIs, and potentially confidential data" in prompt
    assert "approved local-only, app-managed, or company-managed setup paths" in prompt
    assert prompt.count("ngrok") == 1
    assert "ngrok http" not in prompt_lower
    assert "install ngrok" not in prompt_lower
    assert "set up ngrok" not in prompt_lower


def test_base_prompt_guides_container_workspace_urls_and_preview_freshness():
    prompt = _read_text("agents", "base_system_prompt.md")

    assert "Workspace file links returned to users are browser-facing" in prompt
    assert "http://localhost:9876/workspace/..." in prompt
    assert "http://host.docker.internal:9876/workspace/..." in prompt
    assert "Docker container, Agent VM, Google Workspace MCP server, or subagent" in prompt
    assert "Do not tell users to open `host.docker.internal` links" in prompt
    assert "new unique filename or versioned directory" in prompt
    assert "has not been used earlier in the chat" in prompt
    assert "browser caches may show stale pixels" in prompt


def test_base_prompt_and_shipped_skills_do_not_use_stale_unprefixed_tool_calls():
    prompt = _read_text("agents", "base_system_prompt.md")
    web_search = _read_text("skills", "web-search", "SKILL.md")
    code_execution = _read_text("skills", "code-execution", "SKILL.md")
    artifacts = _read_text("skills", "artifacts", "SKILL.md")
    mcp_management = _read_text("skills", "mcp-server-management", "SKILL.md")

    _assert_no_unprefixed_tool_call(prompt, "run_subagent", "subagents_")
    _assert_no_unprefixed_tool_call(prompt, "activate_skill", "skills_")
    _assert_no_unprefixed_tool_call(prompt, "get_skill_reference", "skills_")
    _assert_no_unprefixed_tool_call(prompt, "ask_user_question", "skills_")

    assert "web_tools_web_search" in web_search
    _assert_no_unprefixed_tool_call(web_search, "web_search", "web_tools_")

    assert "agent_vm_bash" in code_execution
    assert "agent_vm_python" in code_execution
    assert "agent_vm_request_sensitive_information" in code_execution
    _assert_no_unprefixed_tool_call(code_execution, "bash", "agent_vm_")
    _assert_no_unprefixed_tool_call(code_execution, "python", "agent_vm_")

    assert "agent_vm_create" in artifacts
    assert "artifacts_create_artifact" in artifacts
    assert "enable_tools" not in artifacts
    _assert_no_unprefixed_tool_call(artifacts, "create", "agent_vm_")
    _assert_no_unprefixed_tool_call(artifacts, "create_artifact", "artifacts_")
    _assert_no_unprefixed_tool_call(artifacts, "open_artifact", "artifacts_")
    _assert_no_unprefixed_tool_call(artifacts, "close_artifact", "artifacts_")

    assert "subagents_run_subagent" in mcp_management
    _assert_no_unprefixed_tool_call(mcp_management, "run_subagent", "subagents_")


def test_company_knowledge_auto_activates_for_weekly_portico_summary():
    manager = SkillManager(base_dir=str(ROOT))

    activated = manager.check_auto_activation("What's going on at Portico this week?")

    assert "company-knowledge" in activated


def test_company_knowledge_auto_activation_is_punctuation_insensitive():
    manager = SkillManager(base_dir=str(ROOT))

    activated = manager.check_auto_activation("Whats going on at Portico this week")

    assert "company-knowledge" in activated


def test_skill_manager_does_not_log_user_message_content(caplog):
    manager = SkillManager(base_dir=str(ROOT))
    message = "What's going on at Portico this week?"

    with caplog.at_level(logging.INFO, logger="managers.skill_manager"):
        activated = manager.check_auto_activation(message)

    assert "company-knowledge" in activated
    assert message not in caplog.text
    assert "Message preview:" not in caplog.text
    assert "Message length:" in caplog.text


def test_code_execution_auto_activates_for_pdf_report_requests():
    manager = SkillManager(base_dir=str(ROOT))

    activated = manager.check_auto_activation(
        "When all subagents are done, build me a PDF report with your findings."
    )

    assert "code-execution" in activated
    assert "office-artifact-workflow" in activated


def test_slack_skill_auto_activates_for_slack_conversation_requests():
    manager = SkillManager(base_dir=str(ROOT))

    activated = manager.check_auto_activation(
        "Search Slack for recent conversations in #ejs-dev and summarize the main themes."
    )

    assert "slack" in activated


def test_host_mode_setup_auto_activates_for_browser_automation_setup_requests():
    manager = SkillManager(base_dir=str(ROOT))

    activated = manager.check_auto_activation("Help me set up browser automation")

    assert "host-mode-setup" in activated


def test_host_mode_setup_does_not_auto_activate_for_generic_browser_automation_requests():
    manager = SkillManager(base_dir=str(ROOT))

    activated = manager.check_auto_activation("Use browser automation to inspect this site")

    assert "browser-automation" in activated
    assert "host-mode-setup" not in activated


def test_current_discovery_includes_installed_anthropic_office_marketplace_skills():
    manager = SkillManager(base_dir=str(ROOT))

    skill_names = {skill.name for skill in manager.discover_skills(force_refresh=True)}

    # Round 9 migrates installed anthropic office skills into the plugin
    # layout on the next app launch; discovery must find each leaf in either
    # layout ("anthropic-agent-skills/pdf" or
    # "anthropic-agent-skills/document-skills/pdf") during the transition.
    for leaf in ("pdf", "pptx", "docx", "xlsx"):
        assert any(
            name == f"anthropic-agent-skills/{leaf}"
            or (
                name.startswith("anthropic-agent-skills/")
                and name.endswith(f"/{leaf}")
                and len(name.split("/")) == 3
            )
            for name in skill_names
        ), f"missing anthropic office skill: {leaf}"


@pytest.mark.parametrize(
    "message",
    [
        "Build a PowerPoint for the leadership review.",
        "Build a deck for the leadership review.",
        "Create a slide deck about the roadmap.",
        "Draft a doc from this outline.",
        "Draft a Word document from this outline.",
        "Create a beautiful google doc.",
        "Create a Google document for the launch plan.",
        "Make a Google Slides presentation for tomorrow.",
        "Build a Google Slides deck for tomorrow.",
        "Create an Excel budget model.",
        "Create a Google Sheets tracker for these launches.",
        "Create a Google Sheets workbook for these launches.",
    ],
)
def test_office_artifact_workflow_auto_activates_for_common_office_requests(message: str):
    manager = SkillManager(base_dir=str(ROOT))

    activated = manager.check_auto_activation(message)

    assert "office-artifact-workflow" in activated


def test_office_artifact_workflow_routes_to_marketplace_skills_and_google_drive():
    skill_text = _read_text("skills", "office-artifact-workflow", "SKILL.md")

    assert "anthropic-agent-skills/pptx" in skill_text
    assert "anthropic-agent-skills/docx" in skill_text
    assert "anthropic-agent-skills/xlsx" in skill_text
    assert "anthropic-agent-skills/pdf" in skill_text
    assert "For any PDF task" in skill_text
    assert 'skills_activate_skill(skill_name="anthropic-agent-skills/pdf", chat_id="<chat_id>")' in skill_text
    assert "creating, editing, filling, analyzing, or generating" in skill_text
    assert "a PDF report" in skill_text
    assert "Agent VM or `reportlab` PDF generation is a fallback" in skill_text
    assert "Create a beautiful google doc" in skill_text
    assert "new Google Doc" in skill_text
    assert "Google document" in skill_text
    assert "Google Slides deck" in skill_text
    assert "Google Sheets workbook" in skill_text
    assert "Generate the Office artifact locally first" in skill_text
    assert "Copy the finished file to the chat workspace" in skill_text
    assert "google_workspace_create_drive_file(fileUrl=...)" in skill_text
    assert "Direct native Google creation/editing alone is incomplete" in skill_text
    assert "creating a blank Google Doc and batch-editing it directly" in skill_text
    assert "workspace download link alone is incomplete" in skill_text
    assert "If Google Workspace auth, server availability, or upload tooling blocks the Drive upload" in skill_text
    assert "http://host.docker.internal:9876/workspace/..." in skill_text
    assert "Do not use the local-artifact upload route when the user provides an existing Google Docs, Slides, or Sheets link" in skill_text
    assert "use Google Workspace directly on the existing file/link" in skill_text
    assert "must be passed to a vision-capable model as actual image inputs" in skill_text
    assert "Downloading images, copying them to the workspace, inspecting file sizes, or putting markdown image links in a prompt does not give the model pixels" in skill_text
    assert "subagents_run_subagent(image_urls=[...])" in skill_text
    assert "If a visual QA subagent call fails" in skill_text
    assert "do not treat that as visual QA" in skill_text
    assert "accepts at most 20 images per call" in skill_text
    assert "slides/pages 1-20, 21-40" in skill_text
    assert "## User Questions" in skill_text
    assert "skills_ask_user_question" in skill_text
    assert "Chat ID: {id}" in skill_text
    assert "If you have any question for the user" in skill_text
    assert "Do not ask a numbered inline clarification bundle" in skill_text
    assert "freeform notes" in skill_text
    assert "concrete, distinct options" in skill_text
    assert "only purpose is for the user to describe, specify, or customize" in skill_text
    assert "built-in `Something else` choice" in skill_text
    assert "I will provide details" not in skill_text


def test_pptx_marketplace_skill_does_not_contain_proprietary_guidance():
    skill_text = _read_text(
        "skills-marketplace",
        "anthropic-agent-skills",
        "pptx",
        "SKILL.md",
    )

    assert "skills_ask_user_question" not in skill_text
    assert "Chat ID: {id}" not in skill_text
    assert "Do not ask a numbered inline clarification bundle" not in skill_text
    assert "office-artifact-workflow" not in skill_text
    assert "google_workspace_create_drive_file" not in skill_text
    assert "host.docker.internal" not in skill_text
    assert "subagents_run_subagent" not in skill_text
    assert "USE SUBAGENTS" not in skill_text


def test_pdf_marketplace_skill_does_not_contain_proprietary_routing_guidance():
    skill_text = _read_text(
        "skills-marketplace",
        "anthropic-agent-skills",
        "pdf",
        "SKILL.md",
    )

    assert "skills_ask_user_question" not in skill_text
    assert "Chat ID: {id}" not in skill_text
    assert "office-artifact-workflow" not in skill_text
    assert "skills_activate_skill" not in skill_text
    assert "Agent VM or `reportlab` PDF generation is a fallback" not in skill_text


def test_company_knowledge_skill_prefers_search_and_routes_service_specific_requests():
    skill_text = _read_text("skills", "company-knowledge", "SKILL.md")

    assert "`glean_search` by default" in skill_text
    assert "`glean_chat` only as a last resort" in skill_text
    assert "glean_fetch_document" not in skill_text
    assert "Slack MCP for Slack content" in skill_text
    assert "Slack is DISABLED, fall back to Glean" in skill_text
    assert "Google Workspace" in skill_text
    assert "Avoid `glean_gmail_search`, `glean_meeting_lookup`" in skill_text
    assert "acceptable to enable/auth/activate" in skill_text


def test_code_execution_skill_prefers_local_workspace_deliverable_files():
    skill_text = _read_text("skills", "code-execution", "SKILL.md")

    assert "downloadable file deliverable" in skill_text
    assert "Prefer creating the file locally in Agent VM." in skill_text
    assert "Do **not** default to remote file creation" in skill_text
    assert "Save the file under `/work`" in skill_text
    assert "do not start with local `reportlab` generation" in skill_text
    assert "follow `office-artifact-workflow` and activate `anthropic-agent-skills/pdf`" in skill_text
    assert "Use Agent VM or `reportlab` only as a fallback" in skill_text
    assert "link the resulting `.pdf` from `/work`" in skill_text
    assert "For PDF reports, prefer Python-based local generation" not in skill_text
    assert "agent_vm_display_files" in skill_text
    assert "agent_vm_request_images" in skill_text
    assert "agent_vm_request_sensitive_information" in skill_text
    assert "link-only" in skill_text
    assert "workspace `output/`" not in skill_text


def test_skill_publishing_skill_sets_new_marketplace_author_from_current_user_context():
    # GitLab mechanics live in the on-demand reference file (loaded via
    # get_skill_reference) so the per-turn injected body stays lean.
    fallback_text = _read_text(
        "skills", "skill-publishing", "references", "gitlab-marketplace-fallback.md"
    )

    assert "author.name" in fallback_text
    assert "author.email" in fallback_text
    assert "PORTICO_USER_NAME" in fallback_text
    assert "${PORTICO_USER_ID}@example.invalid" in fallback_text
    assert "(ask if unavailable)" in fallback_text


def test_skill_publishing_defaults_to_native_ai_marketplace():
    skill_text = _read_text("skills", "skill-publishing", "SKILL.md")

    assert "required_mcp_servers: []" in skill_text
    assert "Always prefer the AI Marketplace path." in skill_text
    assert "no GitLab, no repo, no merge request, and no SSH key" in skill_text
    assert "only when the user explicitly asks or the AI Marketplace is unavailable" in skill_text
    assert "`copy_skill`, `publish_skill`, `unpublish_skill`, `list_published_skills`" in skill_text
    assert "`copy_agent`, `publish_agent`, `unpublish_agent`, `search_marketplace_agents`" in skill_text
    assert "Never fabricate or retype a solution id" in skill_text


def test_skill_publishing_teaches_owner_reclaim_before_copy():
    # PORTICO-347: an installed copy of a listing the viewer authored converts in
    # place (reclaim), never forks a duplicate via copy_* by default.
    skill_text = _read_text("skills", "skill-publishing", "SKILL.md")

    assert "`reclaim_skill`" in skill_text
    assert "`reclaim_agent`" in skill_text
    assert "Workflow D — Make an installed copy editable (reclaim vs copy)" in skill_text
    normalized = " ".join(skill_text.split())
    assert "convert it in place with `reclaim_skill` (Workflow D)" in normalized
    assert "convert it in place with `reclaim_agent` (Workflow D)" in normalized
    assert "Reclaim it in place when the viewer authored the listing" in normalized

    prompt = _read_text("agents", "base_system_prompt.md")
    assert "subagents_reclaim_agent" in prompt
    assert "skills_reclaim_skill" in prompt
    normalized_prompt = " ".join(prompt.split())
    assert "convert the installed copy in place" in normalized_prompt
    assert "only for third-party listings or an explicitly requested fork" in normalized_prompt


def test_skill_publishing_routes_portico_ai_marketplace_contributions_without_forks():
    skill_text = _read_text("skills", "skill-publishing", "SKILL.md")
    assert '- "contribute skill"' in skill_text

    fallback_text = _read_text(
        "skills", "skill-publishing", "references", "gitlab-marketplace-fallback.md"
    )
    normalized = " ".join(fallback_text.split())
    assert "never create a fork as the contribution path" in normalized
    assert "fork MRs fail because the CI needs internal variables" in normalized
    assert "Create a branch in the target project and open the MR from there" in normalized
    assert "missing project permission, GitLab token, or SSH key" in normalized
    assert "Do not route around it with a fork" in normalized
    assert "`community/portico-ai-marketplace`" in fallback_text


def test_base_prompt_mentions_skills_ask_user_question_for_any_user_question():
    prompt = _read_text("agents", "base_system_prompt.md")

    assert "skills_ask_user_question" in prompt
    assert "use `skills_ask_user_question` instead of asking in plain chat" in prompt
    assert "When you have any question for the user" in prompt
    assert "clarifications, confirmations, choices, missing information, preferences, and permission checks" in prompt
    assert "Convert question lists into modal questions" in prompt
    assert "concrete, distinct options" in prompt
    assert "1-5 single-choice questions" in prompt
    assert "optional freeform notes" in prompt
    assert 'automatically adds a generic "Something else" option' in prompt
    assert 'Do not add fallback choices such as "Something else", "Other", or "None of the above"' in prompt
    assert "only purpose is for the user to describe, specify, or customize" in prompt
    assert "Open-ended details belong in freeform notes" in prompt
    assert "I will provide details" not in prompt
    assert "Always pass `chat_id`" in prompt
    assert "Chat ID: {id}" in prompt
    assert "Ask inline only when `skills_ask_user_question` is not present" in prompt


def test_base_prompt_says_specific_workflow_skill_controls_completion_route():
    prompt = _read_text("agents", "base_system_prompt.md")

    assert "When multiple activated skills or tools could satisfy a request" in prompt
    assert "follow the most specific activated workflow skill" in prompt
    assert "Generic tool availability does not override" in prompt
    assert "explicit completion route" in prompt


def test_skill_publishing_prefers_ask_user_question_for_discrete_choices():
    skill_text = _read_text("skills", "skill-publishing", "SKILL.md")

    assert "ask_user_question" in skill_text
    assert "chat_id" in skill_text
    assert "Chat ID: {id}" in skill_text
    normalized = " ".join(skill_text.split())
    assert "pick from 2–5 concrete options" in normalized
    assert "Batch tightly related choices into one call" in skill_text
    assert "Default to the AI Marketplace" in skill_text


def test_skill_publishing_guides_merge_request_format_links_and_signature():
    fallback_text = _read_text(
        "skills", "skill-publishing", "references", "gitlab-marketplace-fallback.md"
    )

    normalized = " ".join(fallback_text.split())
    assert "real multiline Markdown" in normalized
    assert "no literal `\\n`/`\\r\\n`" in normalized
    assert "Generated by Portico" in normalized
    assert "clickable Markdown link to every MR as soon as it is opened" in normalized


def test_skill_management_covers_git_install_and_environment():
    # Chat 96399731: asked to install a git-marketplace skill, the model
    # activated a Atlas-Code-targeted helper skill and ran the `atlas` CLI in
    # an Agent VM instead of the native install chain. The generalized Skill
    # Management skill must advertise install in its always-injected catalog
    # description, carry the native git-install workflow, and inoculate
    # against foreign atlas-CLI instructions.
    skill_text = _read_text("skills", "skill-publishing", "SKILL.md")

    assert "display_name: Skill Management" in skill_text
    assert "## Environment" in skill_text
    assert "**not Atlas Code**" in skill_text
    assert '- "install this skill"' in skill_text
    assert '- "add this skill"' in skill_text
    assert "Workflow E — Install from a named git marketplace" in skill_text
    normalized = " ".join(skill_text.split())
    assert (
        "Resolve the human name to a `marketplace_id` with `list_marketplaces`"
        in normalized
    )
    assert (
        "install_marketplace_skill(marketplace_id, skill_id, skill_path[, plugin_name])"
        in normalized
    )
    assert "MERGE the new skill id into the EXISTING `skill_ids` list" in normalized
    assert "references/gitlab-marketplace-fallback.md" in skill_text


def test_base_prompt_inoculates_against_atlas_code_cli():
    prompt = _read_text("agents", "base_system_prompt.md")

    assert "This app is not Atlas Code." in prompt
    assert "`atlas` CLI" in prompt
    assert "skills_install_marketplace_skill" in prompt
    assert "These four servers" in prompt


def test_skill_manager_can_disable_company_knowledge_restrictions(monkeypatch):
    monkeypatch.setenv("OWUI_OPT_SUBAGENT_INTEGRATION_ACTIVATION_RESTRICTION", "false")
    monkeypatch.setenv("OWUI_OPT_COMPANY_KNOWLEDGE_PREFER_GOOGLE_WORKSPACE_DOC_READS", "false")
    manager = SkillManager(base_dir=str(ROOT))

    skill_text = manager.get_skill_content("company-knowledge")

    assert skill_text is not None
    assert "Do not activate Google Workspace from inside a delegated subagent" not in skill_text
    assert "Usually disabled by default. Prefer Google Workspace document tools" not in skill_text


def _write_minimal_skill(skill_dir: Path, name: str) -> None:
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} skill\n---\n# {name}\n",
        encoding="utf-8",
    )


def test_skill_manager_discovers_plugin_layout_marketplace_skills(tmp_path: Path):
    # Plugin layout: skills-marketplace/{mp}/{plugin}/{skill}/SKILL.md.
    _write_minimal_skill(
        tmp_path / "skills-marketplace" / "kwp" / "document-skills" / "pdf", "pdf"
    )
    # Flat layout still works alongside.
    _write_minimal_skill(tmp_path / "skills-marketplace" / "kwp" / "solo", "solo")
    # The same leaf id in two plugins stays two distinct skills.
    _write_minimal_skill(
        tmp_path / "skills-marketplace" / "kwp" / "plugin-a" / "android", "android"
    )
    _write_minimal_skill(
        tmp_path / "skills-marketplace" / "kwp" / "plugin-b" / "android", "android"
    )

    manager = SkillManager(base_dir=str(tmp_path))
    names = {skill.name for skill in manager.discover_skills()}

    assert names == {
        "kwp/document-skills/pdf",
        "kwp/solo",
        "kwp/plugin-a/android",
        "kwp/plugin-b/android",
    }


def test_skill_manager_never_recurses_past_a_skill_directory(tmp_path: Path):
    # A flat skill whose reference material contains its own SKILL.md
    # (zoom-plugin ships platform subtrees like this): the nested file is
    # NOT a second skill — the outermost SKILL.md wins.
    flat = tmp_path / "skills-marketplace" / "kwp" / "contact-center"
    _write_minimal_skill(flat, "contact-center")
    _write_minimal_skill(flat / "android", "android")
    # Depth 5+ under a plugin skill never registers either.
    plugin_leaf = tmp_path / "skills-marketplace" / "kwp" / "plugin" / "leaf"
    _write_minimal_skill(plugin_leaf, "leaf")
    _write_minimal_skill(plugin_leaf / "references" / "nested", "nested")

    manager = SkillManager(base_dir=str(tmp_path))
    names = {skill.name for skill in manager.discover_skills()}

    assert names == {"kwp/contact-center", "kwp/plugin/leaf"}


def test_skill_manager_accepts_duplicate_frontmatter_keys_with_last_one_wins(tmp_path: Path):
    skill_dir = tmp_path / "skills-marketplace" / "trust-kit" / "shared-trino"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: shared-trino",
                "description: Shared Trino skill",
                "version: 2.1",
                "priority: low",
                "priority: high",
                "author: first-author",
                "author: second-author",
                "triggers:",
                "  - trino",
                "---",
                "# Shared Trino",
                "",
            ]
        ),
        encoding="utf-8",
    )

    manager = SkillManager(base_dir=str(tmp_path))

    skills = manager.discover_skills()

    assert [skill.name for skill in skills] == ["trust-kit/shared-trino"]
    metadata = skills[0]
    assert metadata.priority == "high"
    assert metadata.version == "2.1"
    assert metadata.author == "second-author"
    assert metadata.triggers == ["trino"]


def test_skill_manager_normalizes_structured_and_malformed_trigger_metadata(
    tmp_path: Path, caplog
):
    office_skill_dir = tmp_path / "skills" / "office-artifact-workflow"
    office_skill_dir.mkdir(parents=True)
    (office_skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: office-artifact-workflow",
                "description: Route Office artifact requests",
                "triggers:",
                "  - deck",
                "---",
                "# Office Artifact Workflow",
                "",
            ]
        ),
        encoding="utf-8",
    )
    skill_dir = (
        tmp_path
        / "skills-marketplace"
        / "zstevens-portico-skills"
        / "smart-slides-iql-metrics"
    )
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: smart-slides-iql-metrics",
                "description: Smart Slides metric definitions",
                "triggers:",
                "  - keywords:",
                "      - iql query",
                '      - " data pull "',
                "      - CTR",
                "      - ctr",
                '      - ""',
                "      - 42",
                "  - keywords: single trigger",
                "  - unsupported: ignored",
                "  - false",
                "---",
                "# Smart Slides IQL Metrics",
                "",
            ]
        ),
        encoding="utf-8",
    )

    manager = SkillManager(base_dir=str(tmp_path))
    with caplog.at_level(logging.WARNING, logger="managers.skill_manager"):
        skills = manager.discover_skills()

    assert [skill.name for skill in skills] == [
        "office-artifact-workflow",
        "zstevens-portico-skills/smart-slides-iql-metrics"
    ]
    assert skills[1].triggers == [
        "iql query",
        "data pull",
        "CTR",
        "single trigger",
    ]
    assert manager.check_auto_activation("Generate a deck") == [
        "office-artifact-workflow"
    ]
    assert manager.check_auto_activation("Run an IQL query") == [
        "zstevens-portico-skills/smart-slides-iql-metrics"
    ]
    assert "Ignored unsupported trigger metadata" in caplog.text
    assert "smart-slides-iql-metrics" in caplog.text
    assert "Generate a deck" not in caplog.text


def test_skill_manager_accepts_scalar_trigger_metadata(tmp_path: Path):
    skill_dir = tmp_path / "skills-user" / "single-trigger"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: single-trigger",
                "description: Scalar trigger compatibility",
                "triggers: create brief",
                "---",
                "# Single Trigger",
                "",
            ]
        ),
        encoding="utf-8",
    )

    manager = SkillManager(base_dir=str(tmp_path))
    skills = manager.discover_skills()

    assert skills[0].triggers == ["create brief"]
    assert manager.check_auto_activation("Create brief for leadership") == ["single-trigger"]


def test_skill_manager_skips_non_string_trigger_that_reaches_runtime_cache(
    tmp_path: Path, caplog
):
    skill_dir = tmp_path / "skills-user" / "office-artifact-workflow"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: office-artifact-workflow",
                "description: Office artifact routing",
                "triggers:",
                "  - deck",
                "---",
                "# Office Artifact Workflow",
                "",
            ]
        ),
        encoding="utf-8",
    )

    manager = SkillManager(base_dir=str(tmp_path))
    manager.discover_skills()
    manager._skills_cache["office-artifact-workflow"].triggers = [
        {"keywords": ["broken cached value"]},
        "deck",
    ]

    with caplog.at_level(logging.WARNING, logger="managers.skill_manager"):
        activated = manager.check_auto_activation("Generate a deck")

    assert activated == ["office-artifact-workflow"]
    assert "Skipping non-string cached trigger" in caplog.text


def test_skill_manager_loads_sibling_yaml_skill_metadata(tmp_path: Path):
    skill_dir = tmp_path / "skills-marketplace" / "data-plat-skills" / "trino-query-writing"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Trino Query Writing\n", encoding="utf-8")
    (skill_dir / "trino-query-writing.yaml").write_text(
        "\n".join(
            [
                "skill_name: trino-query-writing",
                "domain: data platform",
                "topic: trino",
                "description: Write Trino queries for Portico datasets",
                "owner: Data Platform",
                "",
            ]
        ),
        encoding="utf-8",
    )

    manager = SkillManager(base_dir=str(tmp_path))

    skills = manager.discover_skills()

    assert [skill.name for skill in skills] == ["data-plat-skills/trino-query-writing"]
    metadata = skills[0]
    assert metadata.description == "Write Trino queries for Portico datasets"
    assert metadata.author == "Data Platform"
    assert metadata.priority == "medium"
    assert metadata.required_mcp_servers == []
    assert metadata.triggers == ["trino", "data platform"]


def test_skill_manager_refreshes_when_marketplace_skill_added_under_existing_vendor(tmp_path: Path):
    vendor_dir = tmp_path / "skills-marketplace" / "anthropic-agent-skills"
    pdf_dir = vendor_dir / "pdf"
    pdf_dir.mkdir(parents=True)
    (pdf_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: pdf",
                "description: PDF toolkit",
                "---",
                "# PDF",
                "",
            ]
        ),
        encoding="utf-8",
    )

    manager = SkillManager(base_dir=str(tmp_path))

    assert [skill.name for skill in manager.get_all_metadata()] == [
        "anthropic-agent-skills/pdf"
    ]

    cached_vendor_mtime = vendor_dir.stat().st_mtime
    pptx_dir = vendor_dir / "pptx"
    pptx_dir.mkdir()
    (pptx_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: pptx",
                "description: PowerPoint toolkit",
                "---",
                "# PPTX",
                "",
            ]
        ),
        encoding="utf-8",
    )
    os.utime(vendor_dir, (cached_vendor_mtime + 1, cached_vendor_mtime + 1))

    refreshed_skill_names = sorted(skill.name for skill in manager.get_all_metadata())

    assert refreshed_skill_names == [
        "anthropic-agent-skills/pdf",
        "anthropic-agent-skills/pptx",
    ]


def test_skill_manager_get_skill_reference_reads_root_files_and_reference_fallback(tmp_path: Path):
    skill_dir = tmp_path / "skills-marketplace" / "anthropic-agent-skills" / "pptx"
    references_dir = skill_dir / "references"
    references_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: pptx",
                "description: PowerPoint toolkit",
                "---",
                "# PPTX",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (skill_dir / "pptxgenjs.md").write_text("root-level pptxgenjs guide", encoding="utf-8")
    (references_dir / "guide.md").write_text("references guide", encoding="utf-8")

    manager = SkillManager(base_dir=str(tmp_path))

    assert (
        manager.get_skill_reference("anthropic-agent-skills/pptx", "pptxgenjs.md")
        == "root-level pptxgenjs guide"
    )
    assert (
        manager.get_skill_reference("anthropic-agent-skills/pptx", "guide.md")
        == "references guide"
    )
    assert (
        manager.get_skill_reference("anthropic-agent-skills/pptx", "references/guide.md")
        == "references guide"
    )


def test_skill_manager_get_skill_reference_rejects_unsafe_non_file_and_non_text_paths(tmp_path: Path):
    skill_dir = tmp_path / "skills" / "safe-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: safe-skill",
                "description: Safe skill",
                "---",
                "# Safe",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (tmp_path / "outside.md").write_text("outside", encoding="utf-8")
    (skill_dir / "folder.md").mkdir()
    (skill_dir / "binary.md").write_bytes(b"\xff\xfe")

    manager = SkillManager(base_dir=str(tmp_path))

    assert manager.get_skill_reference("safe-skill", "../outside.md") is None
    assert manager.get_skill_reference("safe-skill", str(tmp_path / "outside.md")) is None
    assert manager.get_skill_reference("safe-skill", "folder.md") is None
    assert manager.get_skill_reference("safe-skill", "binary.md") is None


def test_skill_manager_rejects_sibling_yaml_without_skill_name(tmp_path: Path):
    skill_dir = tmp_path / "skills-marketplace" / "data-plat-skills" / "trino-query-writing"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Trino Query Writing\n", encoding="utf-8")
    (skill_dir / "trino-query-writing.yaml").write_text(
        "\n".join(
            [
                "domain: data platform",
                "topic: trino",
                "description: Missing skill_name should reject this skill",
                "",
            ]
        ),
        encoding="utf-8",
    )

    manager = SkillManager(base_dir=str(tmp_path))

    assert manager.discover_skills() == []


def test_skill_manager_rejects_plain_skill_without_frontmatter_or_sibling_yaml(tmp_path: Path):
    skill_dir = tmp_path / "skills-user" / "plain-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Plain Skill\n", encoding="utf-8")

    manager = SkillManager(base_dir=str(tmp_path))

    assert manager.discover_skills() == []


def test_integrations_status_distinguishes_active_from_available_to_activate():
    filter_obj = _make_filter_stub()

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "glean": {"display_name": "Glean", "oauth": True},
            "google_workspace": {"display_name": "Google Workspace", "oauth": True},
        },
        enabled_tool_ids=["server:google_workspace"],
    )

    assert "ACTIVE for this chat and currently attached" in context
    assert "google_workspace | Google Workspace | auth=oauth" in context
    assert "<available_to_activate>" in context
    assert "glean | auth=oauth | phase=tool_ready" in context
    assert "ENABLED but not active for this chat" in context
    assert "Do NOT toggle" in context
    assert "Auth-like tool errors on active" in context
    assert "authorize(server_id, chat_id, force_auth=true)" in context


def test_integrations_status_demotes_attached_server_that_needs_auth():
    filter_obj = _make_filter_stub()
    _fail_live_readiness_methods(filter_obj)
    _set_health_snapshot(
        filter_obj,
        {
            "data-plat-mcp": {
                "status": "needs_oauth",
                "oauth_state": "active",
                "configured": True,
            },
            "glean": {"status": "healthy", "configured": True},
        },
    )

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "data-plat-mcp": {
                "display_name": "Data Platform",
                "oauth": True,
                "description": "Portico Data Platform",
            },
            "glean": {"display_name": "Glean", "oauth": True},
        },
        enabled_tool_ids=["server:data-plat-mcp"],
    )

    assert "<needs_auth>" in context
    assert "data-plat-mcp | Portico Data Platform" in context
    assert "<active>" not in context or "data-plat-mcp | Data Platform | auth=oauth" not in context


def test_integrations_status_keeps_attached_server_active_for_non_terminal_cached_health():
    filter_obj = _make_filter_stub()
    _fail_live_readiness_methods(filter_obj)
    _set_health_snapshot(
        filter_obj,
        {
            "data-plat-mcp": {
                "status": "starting",
                "error": "server still initializing",
                "configured": True,
            },
        },
    )

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "data-plat-mcp": {"display_name": "Data Platform", "oauth": True},
        },
        enabled_tool_ids=["server:data-plat-mcp"],
    )

    assert "<active>" in context
    assert "data-plat-mcp | Data Platform | auth=oauth" in context
    assert "<needs_auth>" not in context


def test_integrations_status_emits_activatable_guidance_for_new_chat():
    filter_obj = _make_filter_stub()

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "glean": {"display_name": "Glean", "oauth": True},
        },
        enabled_tool_ids=[],
    )

    assert "<active>" not in context
    assert "<available_to_activate>" in context
    assert "glean | auth=oauth | phase=tool_ready" in context
    assert "available     → activate(chat_id, [\"server:id\"]) regardless of auth type;" in context
    assert "follow the returned readiness_phase and next_steps" in context
    assert "trust its returned readiness_phase and next_steps over auth_type heuristics" in context
    assert "Do NOT toggle" in context


def test_integrations_status_can_split_dynamic_active_from_stable_setup_inventory():
    filter_obj = _make_filter_stub()
    metadata = {
        "glean": {"display_name": "Glean", "oauth": True},
        "google_workspace": {"display_name": "Google Workspace", "oauth": True},
    }

    static_context = Filter._build_integrations_status_context(
        filter_obj,
        metadata,
        enabled_tool_ids=["server:google_workspace"],
        include_active=False,
        include_inactive=True,
        include_setup_guidance=True,
    )
    dynamic_context = Filter._build_integrations_status_context(
        filter_obj,
        metadata,
        enabled_tool_ids=["server:google_workspace"],
        include_active=True,
        include_inactive=False,
        include_setup_guidance=False,
    )

    assert "<active>" not in static_context
    assert "<available_to_activate>" in static_context
    assert "glean | auth=oauth | phase=tool_ready" in static_context
    assert "Auth-like tool errors on active" in static_context

    assert "<active>" in dynamic_context
    assert "google_workspace | Google Workspace | auth=oauth" in dynamic_context
    assert "<available_to_activate>" not in dynamic_context
    assert "<instructions>" not in dynamic_context


def test_integrations_status_uses_cached_health_snapshot_without_live_readiness_calls():
    filter_obj = _make_filter_stub()
    _fail_live_readiness_methods(filter_obj)
    _set_health_snapshot(
        filter_obj,
        {
            "glean": {"status": "healthy", "configured": True},
            "google_workspace": {"status": "healthy", "configured": True},
        },
    )
    metadata = {
        "glean": {"display_name": "Glean", "oauth": True},
        "google_workspace": {"display_name": "Google Workspace", "oauth": True},
    }
    readiness_cache = {}

    Filter._build_integrations_status_context(
        filter_obj,
        metadata,
        enabled_tool_ids=["server:google_workspace"],
        include_active=False,
        include_inactive=True,
        include_setup_guidance=True,
        readiness_cache=readiness_cache,
    )
    Filter._build_integrations_status_context(
        filter_obj,
        metadata,
        enabled_tool_ids=["server:google_workspace"],
        include_active=True,
        include_inactive=False,
        include_setup_guidance=False,
        readiness_cache=readiness_cache,
    )

    assert set(readiness_cache) == {"glean", "google_workspace"}


def test_integrations_status_dynamic_active_context_skips_inactive_readiness():
    filter_obj = _make_filter_stub()
    _fail_live_readiness_methods(filter_obj)
    _set_health_snapshot(
        filter_obj,
        {
            "glean": {"status": "healthy", "configured": True},
            "google_workspace": {"status": "healthy", "configured": True},
        },
    )
    metadata = {
        "glean": {"display_name": "Glean", "oauth": True},
        "google_workspace": {"display_name": "Google Workspace", "oauth": True},
    }

    context = Filter._build_integrations_status_context(
        filter_obj,
        metadata,
        enabled_tool_ids=["server:google_workspace"],
        include_active=True,
        include_inactive=False,
        include_setup_guidance=False,
        readiness_cache={},
    )

    assert "google_workspace | Google Workspace | auth=oauth" in context
    assert "glean" not in context


def test_integrations_status_normalizes_inactive_starting_phase_for_cache_stability():
    filter_obj = _make_filter_stub()
    _fail_live_readiness_methods(filter_obj)
    _set_health_snapshot(
        filter_obj,
        {
            "chrome-devtools": {
                "status": "starting",
                "configured": True,
            },
            "google_workspace": {"status": "healthy", "configured": True},
        },
    )

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "chrome-devtools": {"display_name": "Chrome DevTools", "oauth": False},
            "google_workspace": {"display_name": "Google Workspace", "oauth": True},
        },
        enabled_tool_ids=["server:google_workspace"],
        include_active=False,
        include_inactive=True,
        include_setup_guidance=False,
    )

    assert "chrome-devtools | auth=token | phase=tool_ready" in context
    assert "phase=starting" not in context


def test_cached_health_snapshot_classifies_healthy_servers_as_ready():
    filter_obj = _make_filter_stub()
    _fail_live_readiness_methods(filter_obj)
    _set_health_snapshot(
        filter_obj,
        {
            "google_workspace": {"status": "healthy", "configured": True},
            "glean": {"status": "healthy", "configured": True},
        },
    )

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "google_workspace": {"display_name": "Google Workspace", "oauth": True},
            "glean": {"display_name": "Glean", "oauth": True},
        },
        enabled_tool_ids=["server:google_workspace"],
    )

    assert "<active>" in context
    assert "google_workspace | Google Workspace | auth=oauth" in context
    assert "<available_to_activate>" in context
    assert "glean | auth=oauth | phase=tool_ready" in context


@pytest.mark.parametrize(
    ("health_entry", "expected_section", "expected_line"),
    [
        (
            {"status": "needs_oauth", "oauth_state": "active", "configured": True},
            "<needs_auth>",
            "data-plat-mcp | Portico Data Platform",
        ),
        (
            {"status": "waiting_callback", "oauth_state": "waiting_callback", "configured": True},
            "<needs_auth>",
            "data-plat-mcp | Portico Data Platform",
        ),
        (
            {"status": "not_configured", "configured": False},
            "<needs_config>",
            "data-plat-mcp | Portico Data Platform",
        ),
        (
            {"status": "disabled", "disabled_by_user": True, "configured": True},
            "<disabled>",
            "data-plat-mcp | auth=oauth | Portico Data Platform",
        ),
    ],
)
def test_cached_health_snapshot_terminal_statuses_demote_attached_tools(
    health_entry,
    expected_section,
    expected_line,
):
    filter_obj = _make_filter_stub()
    _fail_live_readiness_methods(filter_obj)
    _set_health_snapshot(filter_obj, {"data-plat-mcp": health_entry})

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "data-plat-mcp": {
                "display_name": "Data Platform",
                "oauth": True,
                "description": "Portico Data Platform",
            },
        },
        enabled_tool_ids=["server:data-plat-mcp"],
    )

    assert expected_section in context
    assert expected_line in context
    assert "data-plat-mcp | Data Platform | auth=oauth" not in context


def test_missing_stale_unknown_and_failed_cached_health_do_not_demote_active_tools():
    scenarios = [
        ("missing", _health_snapshot({})),
        (
            "unknown",
            _health_snapshot({"data-plat-mcp": {"status": "mystery", "configured": True}}),
        ),
        (
            "failed",
            _health_snapshot({"data-plat-mcp": {"status": "failed", "configured": True}}),
        ),
        (
            "stale_terminal",
            _health_snapshot(
                {"data-plat-mcp": {"status": "needs_oauth", "configured": True}},
                timestamp=time.time() - 9999,
            ),
        ),
    ]

    for scenario, snapshot in scenarios:
        filter_obj = _make_filter_stub()
        _fail_live_readiness_methods(filter_obj)
        filter_obj._health_status_snapshot_cache = snapshot

        context = Filter._build_integrations_status_context(
            filter_obj,
            {
                "data-plat-mcp": {
                    "display_name": "Data Platform",
                    "oauth": True,
                    "description": "Portico Data Platform",
                },
            },
            enabled_tool_ids=["server:data-plat-mcp"],
        )

        assert "<active>" in context, scenario
        assert "data-plat-mcp | Data Platform | auth=oauth" in context, scenario
        assert "<needs_auth>" not in context, scenario
        assert "<needs_config>" not in context, scenario
        assert "<disabled>" not in context, scenario


def test_build_time_context_uses_date_only_granularity(monkeypatch):
    class _FixedDateTime(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            fixed = datetime.datetime(
                2026, 4, 2, 15, 37, tzinfo=datetime.timezone.utc
            )
            return fixed if tz is None else fixed.astimezone(tz)

    monkeypatch.setattr("filters.unified_context.datetime.datetime", _FixedDateTime)

    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        auto_detect_timezone=False,
        timezone_hours=-4,
        timezone_minutes=0,
        southern_hemisphere=False,
    )

    context = Filter._build_time_context(filter_obj)

    assert "Current local date is Thursday, April 02, 2026, Spring" in context
    assert "timezone UTC-4." in context
    assert "local time is" not in context


def test_shipped_skills_required_mcp_servers_exist_in_system_inventory():
    manager = SkillManager(base_dir=str(ROOT))
    system_inventory = _system_mcp_server_ids()

    missing = []
    for skill in manager.discover_skills(force_refresh=True):
        if skill.source != "system":
            continue
        for server_id in skill.required_mcp_servers or []:
            bare_server_id = server_id.replace("server:", "", 1)
            if bare_server_id not in system_inventory:
                missing.append((skill.name, server_id))

    assert missing == []


def test_zoom_is_a_system_skill_backed_by_glean_and_asana_is_not_shipped():
    manager = SkillManager(base_dir=str(ROOT))

    zoom = manager.get_skill_metadata("using-zoom")
    asana = manager.get_skill_metadata("using-asana")
    zoom_text = _read_text("skills", "using-zoom", "SKILL.md")

    assert zoom is not None
    assert asana is None
    assert zoom.source == "system"
    assert zoom.required_mcp_servers == ["server:glean"]
    assert zoom.priority == "high"
    assert "zoom" in zoom.triggers
    assert "using-zoom" in manager.check_auto_activation(
        "Find yesterday's Zoom recording"
    )
    assert "using-asana" not in manager.check_auto_activation(
        "Update this Asana task with a comment"
    )
    assert "glean_zoom_mcp_search_meetings" in zoom_text
    assert "glean_zoom_mcp_get_meeting_assets" in zoom_text
    assert "glean_zoom_mcp_get_recording_resource" in zoom_text
    assert "## Using from the MCP bridge" in zoom_text


def test_browser_automation_skill_uses_chrome_devtools_and_keeps_browser_use_only_in_triggers():
    manager = SkillManager(base_dir=str(ROOT))
    metadata = manager.get_skill_metadata("browser-automation")
    skill_text = _read_text("skills", "browser-automation", "SKILL.md")

    assert metadata is not None
    assert metadata.required_mcp_servers == ["server:chrome-devtools"]
    assert "browser-use" in metadata.triggers
    assert skill_text.count("browser-use") == 1
    assert "server:browser-use" not in skill_text
    assert "server:google-workspace" not in skill_text
    assert "Chrome DevTools" in skill_text
    assert "chrome_devtools_take_screenshot" in skill_text
    assert "Do not pass `filePath` for inline chat display" in skill_text
    assert "Use `filePath` only when the user explicitly asks" in skill_text
    assert "use the `host-mode-setup` skill first" in skill_text
    assert "Do not immediately activate `server:chrome-devtools` for setup requests" in skill_text
    assert "data:image" not in skill_text


def test_host_mode_setup_skill_has_browser_automation_setup_triggers_without_chrome_devtools_requirement():
    manager = SkillManager(base_dir=str(ROOT))
    metadata = manager.get_skill_metadata("host-mode-setup")

    assert metadata is not None
    assert metadata.required_mcp_servers == []
    assert "set up browser automation" in metadata.triggers
    assert "setup browser automation" in metadata.triggers
    assert "enable browser automation" in metadata.triggers
    assert "configure browser automation" in metadata.triggers
    assert "install browser automation" in metadata.triggers


def test_meeting_scheduler_skill_uses_injected_time_context_not_time_server():
    manager = SkillManager(base_dir=str(ROOT))
    metadata = manager.get_skill_metadata("meeting-scheduler")
    skill_text = _read_text("skills", "meeting-scheduler", "SKILL.md")

    assert metadata is not None
    assert metadata.required_mcp_servers == ["server:google_workspace"]
    assert "server:time" not in skill_text
    assert "injected current local date/timezone context" in skill_text


def test_data_platform_skill_requires_data_plat_mcp_and_documents_async_query_discipline():
    manager = SkillManager(base_dir=str(ROOT))
    metadata = manager.get_skill_metadata("data-platform")
    skill_text = _read_text("skills", "data-platform", "SKILL.md")
    continue_waiting_gate = skill_text.split("## Continue Waiting Gate\n", 1)[1].split(
        "\n## ", 1
    )[0]
    pacing_pattern = continue_waiting_gate.split(
        "Use this exact pacing pattern for async queries:\n", 1
    )[1].split("\n\nAfter five polls", 1)[0].strip()

    assert metadata is not None
    assert metadata.required_mcp_servers == ["server:data-plat-mcp"]
    assert metadata.priority == "high"
    assert "trino" in metadata.triggers
    assert "iql" in metadata.triggers
    assert "maxWait: 120" in skill_text
    assert "maxWait: 300" not in skill_text
    assert "Never use `maxWait` greater than `120`." in skill_text
    assert "skills_ask_user_question" in skill_text
    assert "Interactive" in skill_text
    assert "Prod" in skill_text
    assert pacing_pattern == (
        "1. Immediately call `data_plat_mcp_get_query_status(executionId=...)`; "
        "do not wait first.\n"
        "2. If status is `QUEUED` or `IN_PROGRESS`, call "
        "`skills_wait(seconds=30)`.\n"
        "3. After waiting, repeat from step 1."
    )
    assert pacing_pattern.count("skills_wait(seconds=30)") == 1
    assert "1. `skills_wait(seconds=30)`" not in pacing_pattern
    assert (
        "After five polls, increase the wait to `skills_wait(seconds=60)`."
        in continue_waiting_gate
    )
    assert "Never submit the same query text more than once in a row unless the user explicitly asks for a fresh re-run." in skill_text
    assert "data_plat_mcp_search_data_assets" in skill_text
    assert "data-plat-skills/trino-query-writing" in skill_text
    assert "executionId" in skill_text
    assert "id.id == queryId" in skill_text
    assert "Parse the query object's `contents` JSON string" in skill_text
    assert "Re-submit the identical query text exactly once" not in skill_text
    assert "Only start polling if the user explicitly chooses `Continue waiting`." in skill_text
    assert "hard 10 minute timeout" in skill_text
    assert "Retry in Prod" in skill_text
    assert "Optimize the query" in skill_text
    assert "Stop" in skill_text
    assert "60 minutes before timing out" in skill_text


def test_data_platform_skill_documents_forced_reauth_for_missing_oauth_scopes():
    skill_text = _read_text("skills", "data-platform", "SKILL.md")

    assert "## OAuth Scope Recovery" in skill_text
    assert "under-scoped OAuth token" in skill_text
    assert "HTTP `401`" in skill_text
    assert "`OAuth re-authorization required`" in skill_text
    assert "`oauth_recovery_required`" in skill_text
    assert "`force_auth_recommended`" in skill_text
    assert "`workforce.data_platform.idash_workspace.read`" in skill_text
    assert 'server_id: "data-plat-mcp"' in skill_text
    assert "force_auth: true" in skill_text
    assert "clears the persisted OAuth token and client files" in skill_text
    assert "Do not recommend restarting Data Platform" in skill_text
    assert "retry the original blocked Data Platform action once" in skill_text
    assert "Control Plane -> Integrations -> Data Platform -> Re-auth" in skill_text


def test_browser_use_special_case_removed_from_shipped_guidance():
    management_skill = _read_text("skills", "mcp-server-management", "SKILL.md")
    server_types = _read_text(
        "skills", "mcp-server-management", "references", "server-types.md"
    )
    prompt = _read_text("agents", "base_system_prompt.md")

    assert "Special Case: browser-use" not in management_skill
    assert "except browser-use fragment" not in management_skill
    assert "browser-use fragment only" not in prompt
    assert "except browser-use fragment" not in prompt
    assert "browser-use" not in server_types


def test_unavailable_tool_guidance_mentions_service_not_found_terminal_case():
    middleware = _read_text(
        "src", "patches", "backend", "open_webui", "utils", "middleware.py"
    )
    entrypoint_patch = _read_text(
        "src", "patches", "patch-openwebui-entrypoint.sh"
    )

    for text in (middleware, entrypoint_patch):
        assert "service_not_found" in text
        assert "Do NOT wait" in text
        assert "retry activation" in text


def test_live_activation_guidance_uses_30_second_waits_and_missing_server_terminal_copy():
    skills_server = {
        spec["name"]: spec
        for spec in _load_json(
            "src", "core-mcp-rust", "crates", "skills-server", "tool_spec.json"
        )
    }
    mcp_assistant = {
        spec["name"]: spec
        for spec in _load_json(
            "src", "core-mcp-rust", "crates", "mcp-assistant-server", "tool_spec.json"
        )
    }
    skills_source = _read_text(
        "src", "core-mcp-rust", "crates", "skills-server", "src", "native", "skills.rs"
    )

    assert "service_not_found" in skills_source
    assert "service_not_found" in skills_server["activate_skill"]["description"]
    assert "30 seconds" in skills_server["activate_skill"]["description"]
    assert "30s" in mcp_assistant["activate_integration"]["description"]


def test_unified_context_initial_request_moves_stable_sections_into_static_context(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("PORTICO_WORKSPACE_CFG_DIR", str(tmp_path))

    class _FakeRedis:
        def get(self, key):
            if key == "agent_vm:chat-1":
                return "vm-123"
            return None

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=True,
        enable_workspace_files=True,
        enable_mcp_tools=False,
        enable_session_context=True,
        enable_time_context=True,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None
    filter_obj._build_user_context = lambda _user=None: "User: Name: Test User"
    filter_obj._build_time_context = (
        lambda: "Current local date is Thursday, April 02, 2026, spring, timezone UTC-4."
    )

    async def _check_vm_status(_vm_id):
        return True

    filter_obj._check_vm_status_via_mcp = _check_vm_status
    monkeypatch.setattr("filters.unified_context.WORKSPACE_MANAGER_AVAILABLE", True)
    filter_obj._auto_copy_files_to_workspace = lambda _chat_id, _files, vm_id=None: [
        {
            "name": "brief.pdf",
            "workspace_path": "input/brief.pdf",
            "size": 1024,
            "content_type": "application/pdf",
        }
    ]

    body = {
        "model": "Cluck",
        "messages": [{"role": "user", "content": "hello"}],
        "metadata": {
            "files": [
                {
                    "filename": "brief.pdf",
                    "path": "/tmp/brief.pdf",
                    "content_type": "application/pdf",
                    "size": 1024,
                }
            ]
        },
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __user__={},
            __model__={},
            __metadata__={"chat_id": "chat-1", "session_id": "session-1"},
            __is_followup_request__=False,
        )
    )

    static_context = result["messages"][1]["content"]
    dynamic_context = result["messages"][2]["content"]

    assert "<session>" in static_context
    assert "<chat_id>chat-1</chat_id>" in static_context
    assert '<chat_workspace mode="generated">' in static_context
    assert "authoritative for the current request" in static_context
    assert '<agent_vm id="vm-123">' in static_context
    assert "<workspace_files>" in static_context
    assert "<time>" not in static_context

    assert "<time>" in dynamic_context
    assert "<session>" not in dynamic_context
    assert "<agent_vm" not in dynamic_context
    assert "<workspace_files>" not in dynamic_context


def test_chat_workspace_context_refreshes_custom_path_and_escapes_xml(
    monkeypatch, tmp_path
):
    settings_dir = tmp_path / "workspace-cfg"
    settings_dir.mkdir()
    settings_path = settings_dir / "chat-workspaces.json"
    first_path = tmp_path / "Projects" / "A & B"
    second_path = tmp_path / "Projects" / "C < D"
    monkeypatch.setenv("PORTICO_WORKSPACE_CFG_DIR", str(settings_dir))

    settings_path.write_text(
        json.dumps(
            {
                "chats": {
                    "cloned-chat": {
                        "source": "custom",
                        "host_path": str(first_path),
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    filter_obj = _make_filter_stub()
    first_context = filter_obj._build_chat_workspace_context("cloned-chat")
    assert '<chat_workspace mode="custom">' in first_context
    assert (
        f"<host_path>{str(first_path).replace('&', '&amp;')}</host_path>"
        in first_context
    )

    settings_path.write_text(
        json.dumps(
            {
                "chats": {
                    "cloned-chat": {
                        "source": "custom",
                        "host_path": str(second_path),
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    second_context = filter_obj._build_chat_workspace_context("cloned-chat")
    assert '<chat_workspace mode="custom">' in second_context
    assert (
        f"<host_path>{str(second_path).replace('<', '&lt;')}</host_path>"
        in second_context
    )
    assert str(first_path) not in second_context
    assert "earlier conversation or tool results" in second_context


def test_chat_workspace_context_falls_back_to_generated_for_malformed_settings(
    monkeypatch, tmp_path
):
    settings_path = tmp_path / "chat-workspaces.json"
    settings_path.write_text("{not-json", encoding="utf-8")
    monkeypatch.setenv("PORTICO_WORKSPACE_CFG_DIR", str(settings_path))

    context = _make_filter_stub()._build_chat_workspace_context("clone-chat")

    assert '<chat_workspace mode="generated">' in context
    assert "<host_path>" not in context


def test_chat_workspace_context_preserves_intentional_inheritance(
    monkeypatch, tmp_path
):
    settings_path = tmp_path / "chat-workspaces.json"
    settings_path.write_text(
        json.dumps(
            {
                "chats": {
                    "child-chat": {
                        "source": "custom",
                        "host_path": "/tmp/root workspace",
                        "inherited_workspace": True,
                        "inherited_from_chat_id": "parent-chat",
                        "root_parent_chat_id": "root-chat",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PORTICO_WORKSPACE_CFG_DIR", str(settings_path))

    context = _make_filter_stub()._build_chat_workspace_context("child-chat")

    assert '<chat_workspace mode="inherited">' in context
    assert "<host_path>/tmp/root workspace</host_path>" in context
    assert "<inherited_from_chat_id>parent-chat</inherited_from_chat_id>" in context
    assert "<root_parent_chat_id>root-chat</root_parent_chat_id>" in context


def test_chat_workspace_context_shared_follows_root_current_path(
    monkeypatch, tmp_path
):
    settings_path = tmp_path / "chat-workspaces.json"

    def write_settings(root_path):
        settings_path.write_text(
            json.dumps(
                {
                    "chats": {
                        "root-chat": {"source": "custom", "host_path": root_path},
                        "child-chat": {
                            "source": "custom",
                            "host_path": "/tmp/stale snapshot",
                            "linked_workspace": True,
                            "inherited_from_chat_id": "root-chat",
                            "root_parent_chat_id": "root-chat",
                        },
                    }
                }
            ),
            encoding="utf-8",
        )

    write_settings("/tmp/root workspace A")
    monkeypatch.setenv("PORTICO_WORKSPACE_CFG_DIR", str(settings_path))

    filter_obj = _make_filter_stub()
    first_context = filter_obj._build_chat_workspace_context("child-chat")
    assert '<chat_workspace mode="shared">' in first_context
    assert "<host_path>/tmp/root workspace A</host_path>" in first_context
    assert "<root_parent_chat_id>root-chat</root_parent_chat_id>" in first_context
    assert "<inherited_from_chat_id>root-chat</inherited_from_chat_id>" in first_context
    assert "SHARES the workspace" in first_context
    assert "/tmp/stale snapshot" not in first_context

    write_settings("/tmp/root workspace B")
    second_context = filter_obj._build_chat_workspace_context("child-chat")
    assert "<host_path>/tmp/root workspace B</host_path>" in second_context
    assert "/tmp/root workspace A" not in second_context


def test_chat_workspace_context_shared_falls_back_to_snapshot_without_root_entry(
    monkeypatch, tmp_path
):
    settings_path = tmp_path / "chat-workspaces.json"
    settings_path.write_text(
        json.dumps(
            {
                "chats": {
                    "child-chat": {
                        "source": "custom",
                        "host_path": "/tmp/workspaces/root-chat",
                        "linked_workspace": True,
                        "inherited_from_chat_id": "root-chat",
                        "root_parent_chat_id": "root-chat",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PORTICO_WORKSPACE_CFG_DIR", str(settings_path))

    context = _make_filter_stub()._build_chat_workspace_context("child-chat")

    assert '<chat_workspace mode="shared">' in context
    assert "<host_path>/tmp/workspaces/root-chat</host_path>" in context


def test_integrations_status_includes_inactive_core_servers_in_available_to_activate():
    filter_obj = _make_filter_stub()

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "mcp-assistant": {
                "display_name": "MCP Assistant",
                "is_core": True,
                "always_enabled": True,
            },
            "skills": {
                "display_name": "Skills",
                "is_core": True,
                "always_enabled": True,
            },
            "subagents": {
                "display_name": "Subagents",
                "is_core": True,
                "always_enabled": True,
            },
            "agent-vm": {
                "display_name": "Agent VM",
                "is_core": True,
                "always_enabled": True,
            },
            "artifacts": {"display_name": "Artifacts", "is_core": True},
            "web-tools": {"display_name": "Web Tools", "is_core": True},
            "scheduling": {"display_name": "Scheduling", "is_core": True},
        },
        enabled_tool_ids=[
            "server:mcp-assistant",
            "server:skills",
            "server:subagents",
            "server:agent-vm",
        ],
    )

    assert "<available_to_activate>" in context
    assert "agent-vm | Agent VM | auth=token" in context
    assert "agent-vm | auth=token | phase=tool_ready" not in context
    assert "artifacts | auth=token | phase=tool_ready" in context
    assert "web-tools | auth=token | phase=tool_ready" in context
    assert "scheduling | auth=token | phase=tool_ready" in context
    assert "mcp-assistant | auth=token | phase=tool_ready" not in context
    assert "skills | auth=token | phase=tool_ready" not in context
    assert "subagents | auth=token | phase=tool_ready" not in context


def test_integrations_status_includes_globally_enabled_core_server_when_not_attached():
    filter_obj = _make_filter_stub()

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "mcp-assistant": {
                "display_name": "MCP Assistant",
                "is_core": True,
                "always_enabled": True,
            },
        },
        enabled_tool_ids=[],
    )

    assert "<available_to_activate>" in context
    assert "mcp-assistant | auth=token | phase=tool_ready" in context
    assert "ENABLED but not active for this chat" in context


def test_integrations_status_covers_all_lifecycle_buckets_without_overlap():
    filter_obj = _make_filter_stub()
    filter_obj._get_disabled_integrations = lambda: [
        {"id": "slack", "name": "Slack", "description": "Disabled by user"}
    ]
    filter_obj._cached_unauthenticated = [
        {"id": "glean", "name": "Glean", "description": "OAuth required"}
    ]
    filter_obj._unauthenticated_server_ids = {"glean"}
    filter_obj._get_unconfigured_integrations = lambda: [
        {"id": "gitlab-mcp", "name": "GitLab", "description": "Missing token"}
    ]
    filter_obj._unconfigured_server_ids = {"gitlab-mcp"}
    filter_obj._is_server_toggled_on = lambda server_id: server_id != "slack"

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "slack": {"display_name": "Slack", "oauth": False},
            "glean": {"display_name": "Glean", "oauth": True},
            "gitlab-mcp": {"display_name": "GitLab", "oauth": False},
            "ownership-mcp": {"display_name": "Ownership", "oauth": False},
            "sourcegraph": {"display_name": "Sourcegraph", "oauth": False},
        },
        enabled_tool_ids=["server:sourcegraph"],
    )

    assert "<active>" in context
    assert "sourcegraph | Sourcegraph | auth=token" in context
    assert "<available_to_activate>" in context
    assert "ownership-mcp | auth=token" in context
    assert "<disabled>" in context
    assert "slack | auth=token | Disabled by user" in context
    assert "<needs_auth>" in context
    assert "glean | OAuth required" in context
    assert "<needs_config>" in context
    assert "gitlab-mcp | Missing token" in context
    # Verify no cross-contamination between buckets
    assert "slack | Slack | auth=" not in context
    assert "glean | Glean | auth=oauth" not in context
    assert "gitlab-mcp | GitLab | auth=" not in context


def test_integrations_status_hides_setup_recipes_for_delegated_subagents():
    filter_obj = _make_filter_stub()
    filter_obj.redis_client = SimpleNamespace(exists=lambda key: key == "subagent_chat:child-1")

    context = Filter._build_integrations_status_context(
        filter_obj,
        {
            "glean": {"display_name": "Glean", "oauth": True},
            "google_workspace": {"display_name": "Google Workspace", "oauth": True},
            "agent-vm": {"display_name": "Agent VM", "is_core": True},
        },
        enabled_tool_ids=["server:glean"],
        chat_id="child-1",
    )

    assert "<active>" in context
    assert "glean | Glean | auth=oauth" in context
    assert "<available_to_activate>" not in context
    assert "activate(chat_id" not in context
    assert "toggle(id, true)" not in context
    assert "<delegated_subagent_rule>" in context
    assert "Do NOT toggle, authorize, activate, guided_setup" in context
    assert "Treat all non-active servers as unavailable" in context


def test_capability_tools_fall_back_to_enabled_tool_ids_when_available_tools_are_missing():
    filter_obj = _make_filter_stub()

    active_tools = Filter._build_active_capability_tools(
        filter_obj,
        available_tools=[],
        enabled_tools=["server:google_workspace"],
        mcp_metadata={
            "google_workspace": {
                "display_name": "Google Workspace",
                "is_core": False,
                "user_installed": False,
            }
        },
    )

    assert active_tools == [
        {
            "server_id": "google_workspace",
            "display_name": "Google Workspace",
            "icon_url": "/api/v1/chats/mcp/servers/google_workspace/icon",
            "is_core": False,
            "user_installed": False,
        }
    ]


def test_tools_context_ignores_non_dict_available_tool_entries():
    filter_obj = _make_filter_stub()

    context = Filter._build_tools_context(
        filter_obj,
        available_tools=[
            "server:mcp-assistant",
            {
                "id": "server:subagents",
                "name": "Subagents",
                "description": "Parallel child chats",
            },
        ],
        enabled_tools=["server:subagents"],
        mcp_metadata={"subagents": {"is_core": True, "user_installed": False}},
    )

    assert 'id="server:subagents"' in context
    assert "server:mcp-assistant" not in context


def test_dynamic_context_ask_user_question_policy_includes_chat_id_when_skills_enabled():
    context = Filter._build_ask_user_question_policy(
        ["server:mcp-assistant", "server:skills"],
        "chat-1",
    )

    assert "<ask_user_question_policy>" in context
    assert "<tool>skills_ask_user_question</tool>" in context
    assert "When you have any question for the user" in context
    assert "clarifications, confirmations, choices, missing information, preferences, permission checks" in context
    assert "single-choice questions with concrete, distinct caller-supplied options" in context
    assert "freeform notes" in context
    assert 'automatically adds a generic "Something else" option' in context
    assert 'do not provide fallback options such as "Something else", "Other", or "None of the above"' in context
    assert "only purpose is for the user to describe, specify, or customize" in context
    assert "open-ended details belong in freeform notes" in context
    assert "<chat_id>chat-1</chat_id>" in context
    assert "Always pass this chat_id" in context


def test_dynamic_context_ask_user_question_policy_omits_without_skills_server():
    context = Filter._build_ask_user_question_policy(
        ["server:mcp-assistant", "server:subagents"],
        "chat-1",
    )

    assert context == ""


def test_dynamic_context_sensitive_information_policy_includes_chat_id_when_agent_vm_enabled():
    context = Filter._build_sensitive_information_policy(
        ["server:agent-vm"],
        "chat-123",
    )

    assert "<sensitive_information_policy>" in context
    assert "<tool>agent_vm_request_sensitive_information</tool>" in context
    assert "Never ask users to paste API keys" in context
    assert "without reading, printing, echoing" in context
    assert "Never use this Agent VM flow to collect credentials that a custom MCP server" in context
    assert "mcp_assistant_trigger_guided_setup" in context
    assert "only credential prompt" in context
    assert "integration-specific workflow may still use this tool" in context
    assert "<chat_id>chat-123</chat_id>" in context
    assert "Always pass this chat_id" in context


def test_dynamic_context_sensitive_information_policy_omits_without_agent_vm():
    context = Filter._build_sensitive_information_policy(
        ["server:skills"],
        "chat-123",
    )

    assert context == ""


@pytest.mark.asyncio
async def test_fetch_available_tools_uses_local_metadata_without_http(monkeypatch):
    filter_obj = _make_filter_stub()
    filter_obj._iter_local_mcp_server_configs = lambda: [
        (
            "google_workspace",
            {
                "display_name": "Google Workspace",
                "description": "Docs and Calendar",
                "oauth": {"requires_user_authorization": True},
            },
            False,
        ),
        (
            "custom-search",
            {
                "display_name": "Custom Search",
                "description": "User search server",
                "is_core": False,
            },
            True,
        ),
    ]

    class _FailAsyncClient:
        def __init__(self, *args, **kwargs):
            raise AssertionError("prompt path must not fetch live MCP tool data")

    import filters.unified_context as unified_context

    if getattr(unified_context, "httpx", None) is not None:
        monkeypatch.setattr(unified_context.httpx, "AsyncClient", _FailAsyncClient)

    available_tools = await Filter._fetch_available_tools(filter_obj)
    metadata = await Filter._fetch_mcp_server_metadata(filter_obj)

    assert available_tools == [
        {
            "id": "server:google_workspace",
            "name": "Google Workspace",
            "description": "Docs and Calendar",
        },
        {
            "id": "server:custom-search",
            "name": "Custom Search",
            "description": "User search server",
        },
    ]
    assert metadata["google_workspace"]["oauth"] is True
    assert metadata["custom-search"]["user_installed"] is True

    tools_context = Filter._build_tools_context(
        filter_obj,
        available_tools,
        ["server:google_workspace"],
        metadata,
    )
    active_capabilities = Filter._build_active_capability_tools(
        filter_obj,
        available_tools,
        ["server:google_workspace"],
        metadata,
    )

    assert 'id="server:google_workspace" name="Google Workspace"' in tools_context
    assert "<server>server:google_workspace</server>" in tools_context
    assert active_capabilities == [
        {
            "server_id": "google_workspace",
            "display_name": "Google Workspace",
            "icon_url": "/api/v1/chats/mcp/servers/google_workspace/icon",
            "is_core": False,
            "user_installed": False,
        }
    ]


def test_server_uses_external_oauth21_reads_user_fragment_fallback(monkeypatch):
    filter_obj = _make_filter_stub()
    user_fragment = "/app/mcp-configs-user/google_workspace/google_workspace.fragment"

    monkeypatch.setattr(
        "filters.unified_context.os.path.isfile",
        lambda path: path == user_fragment,
    )

    def fake_open(path, mode="r", *args, **kwargs):
        assert path == user_fragment
        assert "r" in mode
        return io.StringIO(
            json.dumps(
                {
                    "env": {
                        "MCP_ENABLE_OAUTH21": "true",
                        "EXTERNAL_OAUTH21_PROVIDER": "true",
                    }
                }
            )
        )

    monkeypatch.setattr("builtins.open", fake_open)

    assert Filter._server_uses_external_oauth21(filter_obj, "google_workspace") is True


def test_openwebui_entrypoint_patch_keeps_prompt_tool_cache_misses_nonblocking():
    text = _read_text("src", "patches", "patch-openwebui-entrypoint.sh")
    patch5_start = text.index("# Patch 5:")
    patch5_end = text.index("\nPATCH5_EOF", patch5_start)
    patch5 = text[patch5_start:patch5_end]
    new_block_match = re.search(r"new_block = '''(?P<block>.*?)'''", patch5, re.DOTALL)
    assert new_block_match is not None
    new_block = new_block_match.group("block")

    assert "PORTICO_PATCH_CACHE_ONLY" in new_block
    assert "Tool server data not found for {server_id} in cached tool_servers" in new_block
    assert "continue" in new_block
    assert "set_tool_servers(request)" not in new_block


def test_openwebui_entrypoint_patch_adds_targeted_activation_refresh_helper():
    text = _read_text("src", "patches", "patch-openwebui-entrypoint.sh")
    patch6c_start = text.index("# Patch 6c:")
    patch6c_end = text.index("\nPATCH6C_EOF", patch6c_start)
    patch6c = text[patch6c_start:patch6c_end]
    helper_match = re.search(r"helper = '''(?P<block>.*?)'''", patch6c, re.DOTALL)
    assert helper_match is not None
    helper = helper_match.group("block")

    assert "PORTICO_PATCH_TARGETED_TOOL_REFRESH" in helper
    assert "async def refresh_tool_servers_for_ids" in helper
    assert "normalized_ids" in helper
    assert "selected_connections" in helper
    assert "TOOL_SERVER_CONNECTIONS = selected_connections" in helper
    assert "TOOL_SERVER_CONNECTIONS = original_connections_value" in helper
    assert "merged_tool_servers" in helper
    assert "tool_servers\", json.dumps(merged_tool_servers)" in helper

    patch6b_start = text.index("# Patch 6b:")
    patch6b_end = text.index("\nPATCH6B_EOF", patch6b_start)
    patch6b = text[patch6b_start:patch6b_end]
    assert "tool_servers = await set_tool_servers(request)" in patch6b


def test_ensure_tool_server_connections_marks_fragment_flagged_server_as_oauth_21(
    monkeypatch,
):
    filter_obj = _make_filter_stub()
    filter_obj._server_uses_external_oauth21 = (
        lambda server_id: server_id == "google_workspace"
    )

    yaml_path = "/app/mcp-configs/google_workspace/google_workspace.yaml"
    monkeypatch.setattr(
        "filters.unified_context.os.path.isdir",
        lambda path: path == "/app/mcp-configs",
    )
    monkeypatch.setattr(
        "filters.unified_context.os.listdir",
        lambda path: ["google_workspace"] if path == "/app/mcp-configs" else [],
    )
    monkeypatch.setattr(
        "filters.unified_context.os.path.isfile",
        lambda path: path == yaml_path,
    )

    def fake_open(path, mode="r", *args, **kwargs):
        assert path == yaml_path
        assert "r" in mode
        return io.StringIO(
            "\n".join(
                [
                    "id: google_workspace",
                    "display_name: Google Workspace",
                    "description: Workspace tools",
                    "deployment_type: docker",
                ]
            )
        )

    monkeypatch.setattr("builtins.open", fake_open)

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                config=SimpleNamespace(TOOL_SERVER_CONNECTIONS=[]),
                redis=None,
            )
        )
    )

    changed = Filter._ensure_tool_server_connections(filter_obj, request)

    assert changed is True
    assert len(request.app.state.config.TOOL_SERVER_CONNECTIONS) == 1
    connection = request.app.state.config.TOOL_SERVER_CONNECTIONS[0]
    assert connection["info"]["id"] == "google_workspace"
    assert connection["type"] == "openapi"
    assert connection["auth_type"] == "oauth_2.1"


def test_ensure_tool_server_connections_includes_user_installed_servers(
    monkeypatch,
):
    filter_obj = _make_filter_stub()
    filter_obj._server_uses_external_oauth21 = lambda _server_id: False

    user_dir = "/app/mcp-configs-user"
    yaml_path = f"{user_dir}/portico-proctor/portico-proctor.yaml"
    monkeypatch.setattr(
        "filters.unified_context.os.path.isdir",
        lambda path: path in {"/app/mcp-configs", user_dir},
    )
    monkeypatch.setattr(
        "filters.unified_context.os.listdir",
        lambda path: ["portico-proctor"] if path == user_dir else [],
    )
    monkeypatch.setattr(
        "filters.unified_context.os.path.isfile",
        lambda path: path == yaml_path,
    )

    def fake_open(path, mode="r", *args, **kwargs):
        assert path == yaml_path
        assert "r" in mode
        return io.StringIO(
            "\n".join(
                [
                    "id: portico-proctor",
                    "display_name: Portico Proctor",
                    "description: Proctor tools",
                    "deployment_type: docker",
                    "user_installed: true",
                ]
            )
        )

    monkeypatch.setattr("builtins.open", fake_open)

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                config=SimpleNamespace(TOOL_SERVER_CONNECTIONS=[]),
                redis=None,
            )
        )
    )

    changed = Filter._ensure_tool_server_connections(filter_obj, request)

    assert changed is True
    assert len(request.app.state.config.TOOL_SERVER_CONNECTIONS) == 1
    connection = request.app.state.config.TOOL_SERVER_CONNECTIONS[0]
    assert connection["info"]["id"] == "portico-proctor"
    assert connection["info"]["name"] == "Portico Proctor"
    assert connection["type"] == "openapi"
    assert connection["url"].endswith("/portico-proctor")


def test_unified_context_skips_user_config_when_system_directory_reserves_id(
    monkeypatch,
):
    filter_obj = _make_filter_stub()
    filter_obj._server_uses_external_oauth21 = lambda _server_id: False
    system_root = "/app/mcp-configs"
    user_root = "/app/mcp-configs-user"
    user_yaml = f"{user_root}/collision-mcp/collision-mcp.yaml"

    monkeypatch.setattr(
        "filters.unified_context.os.path.isdir",
        lambda path: path in {
            system_root,
            user_root,
            f"{system_root}/collision-mcp",
            f"{user_root}/collision-mcp",
        },
    )
    monkeypatch.setattr(
        "filters.unified_context.os.listdir",
        lambda path: ["collision-mcp"] if path in {system_root, user_root} else [],
    )
    monkeypatch.setattr(
        "filters.unified_context.os.path.isfile",
        lambda path: path == user_yaml,
    )
    monkeypatch.setattr(
        "builtins.open",
        lambda *_args, **_kwargs: io.StringIO(
            "id: collision-mcp\ndisplay_name: User must not leak\n"
        ),
    )

    assert Filter._iter_local_mcp_server_configs(filter_obj) == []
    assert Filter._load_server_fragment_payload(filter_obj, "collision-mcp") is None

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                config=SimpleNamespace(TOOL_SERVER_CONNECTIONS=[]),
                redis=None,
            )
        )
    )
    assert Filter._ensure_tool_server_connections(filter_obj, request) is False
    assert request.app.state.config.TOOL_SERVER_CONNECTIONS == []


def test_keyword_skill_auto_activation_auto_enables_optional_server_when_it_was_ready_at_activation_time():
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.skill_manager = SimpleNamespace(
        get_skill_metadata=lambda _skill_name: SimpleNamespace(
            required_mcp_servers=["server:google_workspace"]
        )
    )
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()
    filter_obj._get_auto_enable_skill_servers = lambda _chat_id: Filter._get_auto_enable_skill_servers(
        filter_obj, _chat_id
    )
    filter_obj._store_auto_enable_skill_servers = lambda _chat_id, _server_ids: Filter._store_auto_enable_skill_servers(
        filter_obj, _chat_id, _server_ids
    )
    filter_obj._snapshot_skill_auto_enable_servers = lambda _chat_id, _skill_name: Filter._snapshot_skill_auto_enable_servers(
        filter_obj, _chat_id, _skill_name
    )
    filter_obj._is_server_auto_enable_eligible = lambda _server_id: Filter._is_server_auto_enable_eligible(
        filter_obj, _server_id
    )
    filter_obj._should_auto_enable_skill_server = lambda _chat_id, _server_id: (
        _server_id in Filter._get_auto_enable_skill_servers(filter_obj, _chat_id)
        and Filter._is_server_auto_enable_eligible(filter_obj, _server_id)
    )
    filter_obj._is_server_toggled_on = lambda _server_id: True
    filter_obj._is_server_tool_ready = lambda _server_id: True
    filter_obj._activate_skill_for_chat("google-workspace", "chat-1")

    reconciled = Filter._reconcile_activated_skill_servers(
        filter_obj,
        "chat-1",
        ["google-workspace"],
    )

    assert reconciled == ["server:google_workspace"]
    assert json.loads(
        filter_obj.redis_client.get("chat_skill_auto_enable_servers:chat-1")
    ) == ["server:google_workspace"]
    assert json.loads(filter_obj.redis_client.get("chat_tools:chat-1")) == [
        "server:google_workspace"
    ]


def test_keyword_skill_auto_activation_leaves_disabled_optional_required_mcp_servers_for_explicit_activation():
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.skill_manager = SimpleNamespace(
        get_skill_metadata=lambda _skill_name: SimpleNamespace(
            required_mcp_servers=["server:google_workspace"]
        )
    )
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()
    filter_obj._get_auto_enable_skill_servers = lambda _chat_id: Filter._get_auto_enable_skill_servers(
        filter_obj, _chat_id
    )
    filter_obj._store_auto_enable_skill_servers = lambda _chat_id, _server_ids: Filter._store_auto_enable_skill_servers(
        filter_obj, _chat_id, _server_ids
    )
    filter_obj._snapshot_skill_auto_enable_servers = lambda _chat_id, _skill_name: Filter._snapshot_skill_auto_enable_servers(
        filter_obj, _chat_id, _skill_name
    )
    filter_obj._is_server_auto_enable_eligible = lambda _server_id: Filter._is_server_auto_enable_eligible(
        filter_obj, _server_id
    )
    filter_obj._should_auto_enable_skill_server = lambda _chat_id, _server_id: (
        _server_id in Filter._get_auto_enable_skill_servers(filter_obj, _chat_id)
        and Filter._is_server_auto_enable_eligible(filter_obj, _server_id)
    )
    filter_obj._is_server_toggled_on = lambda _server_id: False
    filter_obj._is_server_tool_ready = lambda _server_id: False

    filter_obj._activate_skill_for_chat("google-workspace", "chat-1")

    filter_obj._is_server_toggled_on = lambda _server_id: True
    filter_obj._is_server_tool_ready = lambda _server_id: True

    reconciled = Filter._reconcile_activated_skill_servers(
        filter_obj,
        "chat-1",
        ["google-workspace"],
    )

    assert reconciled == ["server:google_workspace"]
    assert json.loads(
        filter_obj.redis_client.get("chat_skill_auto_enable_servers:chat-1")
    ) == []
    assert json.loads(filter_obj.redis_client.get("chat_tools:chat-1")) == []


def test_keyword_skill_auto_activation_is_unbounded():
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.redis_client.setex(
        "chat_skills:chat-1",
        604800,
        json.dumps(["one", "two", "three", "four"]),
    )
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()

    assert filter_obj._activate_skill_for_chat("five", "chat-1")
    assert json.loads(filter_obj.redis_client.get("chat_skills:chat-1")) == [
        "one",
        "two",
        "three",
        "four",
        "five",
    ]


def test_keyword_skill_auto_activation_auto_enables_ready_core_required_mcp_servers():
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.skill_manager = SimpleNamespace(
        get_skill_metadata=lambda _skill_name: SimpleNamespace(
            required_mcp_servers=["server:agent-vm"]
        )
    )
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()
    filter_obj._is_server_auto_enable_eligible = lambda _server_id: Filter._is_server_auto_enable_eligible(
        filter_obj, _server_id
    )
    filter_obj._should_auto_enable_skill_server = lambda _chat_id, _server_id: Filter._is_server_auto_enable_eligible(
        filter_obj, _server_id
    )
    filter_obj._is_server_toggled_on = lambda _server_id: True
    filter_obj._is_server_tool_ready = lambda _server_id: True

    reconciled = Filter._reconcile_activated_skill_servers(
        filter_obj,
        "chat-1",
        ["code-execution"],
    )

    assert reconciled == ["server:agent-vm"]
    assert json.loads(filter_obj.redis_client.get("chat_tools:chat-1")) == [
        "server:agent-vm"
    ]


def test_subagent_with_explicit_skills_skips_keyword_auto_activation_on_initial_prompt():
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.redis_client.setex(
        "subagent_explicit_skills:chat-1",
        604800,
        json.dumps(["company-knowledge", "code-execution"]),
    )

    assert Filter._should_skip_subagent_keyword_auto_activation(
        filter_obj,
        "chat-1",
        [{"role": "user", "content": "Search documents and produce a report."}],
    )


def test_subagent_with_explicit_skills_allows_keyword_auto_activation_after_new_user_turn():
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.redis_client.setex(
        "subagent_explicit_skills:chat-1",
        604800,
        json.dumps(["company-knowledge", "code-execution"]),
    )

    assert not Filter._should_skip_subagent_keyword_auto_activation(
        filter_obj,
        "chat-1",
        [
            {"role": "user", "content": "Search documents and produce a report."},
            {"role": "assistant", "content": "Initial answer"},
            {"role": "user", "content": "Now also check my calendar."},
        ],
    )


def test_keyword_skill_auto_activation_skips_unready_core_required_mcp_servers():
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.skill_manager = SimpleNamespace(
        get_skill_metadata=lambda _skill_name: SimpleNamespace(
            required_mcp_servers=["server:agent-vm"]
        )
    )
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()
    filter_obj._is_server_auto_enable_eligible = lambda _server_id: Filter._is_server_auto_enable_eligible(
        filter_obj, _server_id
    )
    filter_obj._should_auto_enable_skill_server = lambda _chat_id, _server_id: Filter._is_server_auto_enable_eligible(
        filter_obj, _server_id
    )
    filter_obj._is_server_toggled_on = lambda _server_id: True
    filter_obj._is_server_tool_ready = lambda _server_id: False

    reconciled = Filter._reconcile_activated_skill_servers(
        filter_obj,
        "chat-1",
        ["code-execution"],
    )

    assert reconciled == ["server:agent-vm"]
    assert json.loads(filter_obj.redis_client.get("chat_tools:chat-1")) == []


def test_persisted_chat_tool_ids_exclude_request_only_servers():
    filter_obj = _make_filter_stub()
    filter_obj._is_server_toggled_on = lambda server_id: server_id != "server:slack"

    persisted = Filter._build_persisted_chat_tool_ids(
        filter_obj,
        chat_tools=["server:agent-vm", "server:glean", "server:slack"],
        core_tool_ids=[
            "server:mcp-assistant",
            "server:subagents",
            "server:skills",
            "server:agent-vm",
        ],
        always_enabled_ids=[],
        include_tool=lambda tool_id: filter_obj._is_server_toggled_on(tool_id),
    )

    assert persisted == [
        "server:mcp-assistant",
        "server:subagents",
        "server:skills",
        "server:agent-vm",
        "server:glean",
    ]


def test_google_workspace_and_atlassian_skills_use_live_tool_names():
    google_workspace = _read_text("skills", "google-workspace", "SKILL.md")
    atlassian = _read_text("skills", "atlassian-portico", "SKILL.md")
    slack = _read_text("skills", "slack", "SKILL.md")
    atlassian_search_ref = _read_text(
        "skills", "atlassian-portico", "references", "search-company-knowledge.md"
    )
    atlassian_triage_ref = _read_text(
        "skills", "atlassian-portico", "references", "triage-issue.md"
    )
    atlassian_config = _read_text("mcp-configs", "mcp-atlassian", "mcp-atlassian.yaml")

    assert "google_workspace_list_drive_items" in google_workspace
    assert "google_workspace_search_drive_files" in google_workspace
    assert "google_workspace_create_drive_file" in google_workspace
    assert "google_workspace_share_drive_file" in google_workspace
    assert "google_workspace_send_gmail_message" in google_workspace
    assert "google_workspace_send_message" not in google_workspace
    assert "google_workspace_search_messages" not in google_workspace
    assert "google_workspace_list_files" not in google_workspace
    assert "host.docker.internal:9876" in google_workspace
    assert "localhost:9876" in google_workspace
    assert "publishOutNotPermitted" in google_workspace
    assert "example.invalid" in google_workspace
    assert "lh3.googleusercontent.com/d/" in google_workspace
    assert "drive.google.com/uc?id=" in google_workspace
    assert "true file attachments" in google_workspace
    assert "read_fragment" in google_workspace
    assert "max_chars=1500" in google_workspace

    assert "mcp_atlassian_Search_JIRA_Issues_Using_JQL" in atlassian
    assert "mcp_atlassian_Get_Confluence_Comment_Children" in atlassian
    assert "mcp_atlassian_JIRA_Read" in atlassian
    assert "mcp_atlassian_JIRA_Write" in atlassian
    assert "mcp_atlassian_Search with JQL query" not in atlassian
    assert "By Text mcp_atlassian_Search" not in atlassian
    assert "maxResults <= 10" in atlassian
    assert "compact_jira_search.py" in atlassian
    assert "compact_google_workspace_payload.py" in _read_text(
        "skills", "company-knowledge", "SKILL.md"
    )

    assert "slack_conversations_search_messages" in slack
    assert "slack_conversations_history" in slack
    assert "slack_conversations_replies" in slack
    assert "search_query=\"*\"" in slack
    assert "agent_vm_execute_skill_script" in slack
    assert "compact_slack_csv.py" in slack

    assert "# Search Company Knowledge Reference" in atlassian_search_ref
    assert "mcp_atlassian_Search Company Knowledge Reference" not in atlassian_search_ref
    assert "Use `mcp_atlassian_Search` to search across Confluence and JIRA at once" in atlassian_search_ref
    assert "mcp_atlassian_Search across Confluence and JIRA" not in atlassian_search_ref

    assert "**Search for Duplicates**" in atlassian_triage_ref
    assert "**mcp_atlassian_Search for Duplicates**" not in atlassian_triage_ref

    assert 'getConfluenceCommentChildren: "Get Confluence Comment Children"' in atlassian_config
    assert 'jiraRead: "JIRA Read"' in atlassian_config
    assert 'jiraWrite: "JIRA Write"' in atlassian_config


def test_trust_kit_mcp_tools_use_human_readable_rename_mapping():
    trust_kit_config = _read_text(
        "mcp-configs", "trust-kit-mcp", "trust-kit-mcp.yaml"
    )
    expected_renames = {
        "Aggregatejobs": "Aggregate Jobs",
        "Describemonarcheventschema": "Describe Monarch Event Schema",
        "Getadvertiserdata": "Get Advertiser Data",
        "Getadvertiserlinksinset": "Get Advertiser Links in Set",
        "Getadvertisermoderationinfo": "Get Advertiser Moderation Info",
        "Getadvertisermoderationruledetails": "Get Advertiser Moderation Rule Details",
        "Getjobdetails": "Get Job Details",
        "Getjobreports": "Get Job Reports",
        "Getjobstatus": "Get Job Status",
        "Getjobvisibility": "Get Job Visibility",
        "Getmonarchevents": "Get Monarch Events",
        "Getparentcompanylinks": "Get Parent Company Links",
        "Getruledefinitions": "Get Rule Definitions",
        "Getsupportedjobsearchlucenefieldnames": "Get Supported Job Search Lucene Field Names",
        "Getwaldorules": "Get Waldo Rules",
        "Listmonarcheventtypes": "List Monarch Event Types",
        "Searchjobs": "Search Jobs",
    }

    assert "tool_rename_mapping:" in trust_kit_config
    for tool_name, display_name in expected_renames.items():
        assert f'  {tool_name}: "{display_name}"' in trust_kit_config


def test_google_workspace_skill_defers_new_polished_office_deliverables_to_office_workflow():
    google_workspace = _read_text("skills", "google-workspace", "SKILL.md")

    assert "## New Polished Google Deliverables" in google_workspace
    assert "Create a beautiful google doc" in google_workspace
    assert "follow `office-artifact-workflow` when it is available" in google_workspace
    assert "Google Workspace is the upload/open/share step" in google_workspace
    assert "creates the `.docx`, `.pptx`, or `.xlsx` artifact locally" in google_workspace
    assert "local file is linked from the chat workspace" in google_workspace
    assert "upload the workspace file to Drive" in google_workspace
    assert "Google Docs, Slides, or Sheets editor/view link" in google_workspace
    assert "Direct Google-native creation and editing remain appropriate for existing Google Docs, Slides, or Sheets links" in google_workspace
    assert "simple native Workspace operations" in google_workspace


def test_ask_user_question_tool_spec_covers_generic_question_bundles():
    skills_server = {
        spec["name"]: spec for spec in _load_json(
            "src", "core-mcp-rust", "crates", "skills-server", "tool_spec.json"
        )
    }

    ask_user_question = skills_server["ask_user_question"]
    description = ask_user_question["description"]

    assert "whenever you have a question for the user" in description
    assert "clarifications, confirmations, choices, missing information, preferences, permission checks" in description
    assert "other question bundles" in description
    assert "Caller-supplied options must be concrete and distinct" in description
    assert "use freeform notes for extra context or open-ended details" in description
    assert "automatically appends a final generic 'Something else' choice" in description
    assert "reserved id 'none_of_the_above'" in description
    assert "fallback options such as 'Something else', 'Other', or 'None of the above'" in description
    assert "only purpose is for the user to describe, specify, or customize" in description
    question_item = ask_user_question["inputSchema"]["properties"]["questions"]["items"]
    options_description = question_item["properties"]["options"]["description"]
    assert "Concrete, distinct, mutually-exclusive caller-supplied choices" in options_description
    assert "OPTIONAL when `components` is provided" in options_description
    assert "generic 'Something else' choice" in options_description
    assert "do not add your own fallback/'Other' option" in options_description
    assert "Provide either options (2-5) or components (or both)" in options_description
    assert "components" in question_item["properties"]
    assert "options" not in question_item.get("required", [])
    assert "chat_id" in ask_user_question["inputSchema"]["properties"]


def test_core_rust_tool_spec_descriptions_reference_live_prefixed_route_names():
    mcp_assistant = {
        spec["name"]: spec for spec in _load_json(
            "src",
            "core-mcp-rust",
            "crates",
            "mcp-assistant-server",
            "tool_spec.json",
        )
    }
    skills_server = {
        spec["name"]: spec for spec in _load_json(
            "src", "core-mcp-rust", "crates", "skills-server", "tool_spec.json"
        )
    }
    subagents_server = {
        spec["name"]: spec for spec in _load_json(
            "src", "core-mcp-rust", "crates", "subagents-server", "tool_spec.json"
        )
    }
    agent_vm = {
        spec["name"]: spec for spec in _load_json(
            "src", "core-mcp-rust", "crates", "agent-vm-server", "tool_spec.json"
        )
    }
    artifacts = {
        spec["name"]: spec for spec in _load_json(
            "src", "core-mcp-rust", "crates", "artifacts-server", "tool_spec.json"
        )
    }

    assert "Enable or disable an MCP server" in mcp_assistant["toggle_integration"]["description"]
    assert "trigger_guided_setup" in mcp_assistant["toggle_integration"]["description"]
    assert "Attach enabled tool servers to the current chat" in mcp_assistant["activate_integration"]["description"]
    assert "30s" in mcp_assistant["activate_integration"]["description"]
    assert "chat_id" in mcp_assistant["authorize_integration"]["inputSchema"]["properties"]
    assert "chat window" in mcp_assistant["authorize_integration"]["description"]
    assert "chat_id" in mcp_assistant["trigger_guided_setup"]["inputSchema"]["properties"]
    assert "chat window" in mcp_assistant["trigger_guided_setup"]["description"]

    assert "mcp_assistant_toggle_integration" in skills_server["activate_skill"]["description"]
    assert "service_not_found" in skills_server["activate_skill"]["description"]
    assert "30 seconds" in skills_server["activate_skill"]["description"]
    get_reference = skills_server["get_skill_reference"]
    assert "safe skill-relative path" in get_reference["description"]
    assert "pptxgenjs.md" in get_reference["description"]
    assert "editing.md" in get_reference["inputSchema"]["properties"]["reference_path"]["description"]

    tool_server_ids_description = subagents_server["run_subagent"]["inputSchema"]["properties"]["tool_server_ids"]["description"]
    assert "subagents_list_available_tools" in tool_server_ids_description
    assert "mcp_assistant_get_chat_tools" in tool_server_ids_description
    image_urls_spec = subagents_server["run_subagent"]["inputSchema"]["properties"]["image_urls"]
    assert image_urls_spec["maxItems"] == 20
    assert "actual multimodal image inputs" in image_urls_spec["description"]
    assert "markdown links in the prompt are not enough for pixel inspection" in image_urls_spec["description"]
    assert "host.docker.internal" in image_urls_spec["description"]
    assert "tool_ids" not in subagents_server["run_subagent"]["inputSchema"]["properties"]
    parent_chat_id_spec = subagents_server["run_subagent"]["inputSchema"]["properties"]["parent_chat_id"]
    assert "host-injected" in parent_chat_id_spec["description"]
    assert "root parent chat workspace" in parent_chat_id_spec["description"]
    assert (
        subagents_server["run_subagent"]["inputSchema"]["properties"]["reasoning_effort"]["enum"]
        == ["low", "medium", "high", "max"]
    )

    batch_description = agent_vm["create_files"]["description"]
    assert "agent_vm_create_file" in batch_description
    assert "copy_to_workspace" not in agent_vm
    assert "copy_from_workspace" not in agent_vm
    assert "list_workspace_files" not in agent_vm
    assert "write_to_workspace" not in agent_vm
    workspace_link_description = agent_vm["get_workspace_file_link"]["description"]
    assert "already present under /work" in workspace_link_description
    assert "link-only" in workspace_link_description
    assert "agent_vm_display_files" in workspace_link_description
    assert "agent_vm_request_images" in workspace_link_description
    assert agent_vm["display_files"]["title"] == "Display Files"
    assert "inline in the chat" in agent_vm["display_files"]["description"]
    assert agent_vm["request_images"]["title"] == "Request Images"
    assert "actual image inputs" in agent_vm["request_images"]["description"]
    assert agent_vm["request_sensitive_information"]["title"] == "Request Sensitive Information"
    assert "response never contains the submitted secret" in agent_vm["request_sensitive_information"]["description"]
    assert "15 minutes" in agent_vm["request_sensitive_information"]["description"]
    assert "plain language" in agent_vm["request_sensitive_information"]["description"]
    assert "do not mention code execution" in agent_vm["request_sensitive_information"]["description"]
    assert "chat_id" in agent_vm["request_sensitive_information"]["inputSchema"]["required"]
    assert "prompt" in agent_vm["request_sensitive_information"]["inputSchema"]["required"]
    assert "file_path" not in agent_vm["request_sensitive_information"]["inputSchema"]["properties"]
    assert "placeholder" not in agent_vm["request_sensitive_information"]["inputSchema"]["properties"]
    preamble = agent_vm["request_sensitive_information"]["inputSchema"]["properties"]["preamble"]
    assert preamble["type"] == "string"
    assert preamble["maxLength"] == 4000
    assert "sanitized Markdown" in preamble["description"]
    assert "preamble" not in agent_vm["request_sensitive_information"]["inputSchema"]["required"]
    vm_id_description = agent_vm["destroy"]["inputSchema"]["properties"]["vm_id"]["description"]
    assert "agent_vm_create" in vm_id_description

    source_vm_description = artifacts["create_artifact_version"]["inputSchema"]["properties"]["source_vm_id"]["description"]
    assert "agent_vm_create" in source_vm_description


def test_unified_context_followup_can_preserve_existing_dynamic_context():
    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=False,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None

    original_dynamic_context = (
        "<portico_context>\n\n"
        "<dynamic_context>\n\n"
        "<preserved>keep this exact dynamic snapshot</preserved>\n\n"
        "</dynamic_context>\n\n"
        "</portico_context>"
    )
    body = {
        "messages": [
            {"role": "system", "content": ""},
            {
                "role": "system",
                "content": (
                    "<portico_context>\n\n"
                    "<static_context>\n\n"
                    "<old_static>stale</old_static>\n\n"
                    "</static_context>\n\n"
                    "</portico_context>"
                ),
            },
            {"role": "system", "content": original_dynamic_context},
            {"role": "assistant", "content": "tool call placeholder"},
            {"role": "tool", "content": '{"ok":true}'},
        ]
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=True,
        )
    )

    assert result["messages"][2]["content"] == original_dynamic_context
    assert "<static_context>" in result["messages"][1]["content"]
    assert "<old_static>" not in result["messages"][1]["content"]
    assert len([message for message in result["messages"] if message.get("role") == "system"]) == 3


def test_unified_context_followup_refreshes_dynamic_context_when_not_preserved():
    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=False,
        enable_session_context=False,
        enable_time_context=True,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None
    filter_obj._build_time_context = lambda: "2026-03-27T12:00:00Z"

    body = {
        "messages": [
            {"role": "system", "content": ""},
            {
                "role": "system",
                "content": (
                    "<portico_context>\n\n"
                    "<static_context>\n\n"
                    "</static_context>\n\n"
                    "</portico_context>"
                ),
            },
            {
                "role": "system",
                "content": (
                    "<portico_context>\n\n"
                    "<dynamic_context>\n\n"
                    "<stale>old dynamic</stale>\n\n"
                    "</dynamic_context>\n\n"
                    "</portico_context>"
                ),
            },
        ]
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=False,
        )
    )

    assert "<stale>old dynamic</stale>" not in result["messages"][2]["content"]
    assert "<time>" in result["messages"][2]["content"]
    assert "2026-03-27T12:00:00Z" in result["messages"][2]["content"]


def test_unified_context_followup_refreshes_authoritative_workspace_path(
    monkeypatch, tmp_path
):
    settings_path = tmp_path / "chat-workspaces.json"
    current_path = tmp_path / "current & workspace"
    stale_path = "/tmp/stale-original-workspace"
    settings_path.write_text(
        json.dumps(
            {
                "chats": {
                    "cloned-chat": {
                        "source": "custom",
                        "host_path": str(current_path),
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PORTICO_WORKSPACE_CFG_DIR", str(settings_path))

    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=False,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None
    original_dynamic_context = (
        "<portico_context>\n<dynamic_context>\n</dynamic_context>\n</portico_context>"
    )
    body = {
        "messages": [
            {"role": "system", "content": ""},
            {
                "role": "system",
                "content": (
                    "<portico_context>\n<static_context>\n"
                    '<chat_workspace mode="custom">\n'
                    f"<host_path>{stale_path}</host_path>\n"
                    "</chat_workspace>\n</static_context>\n</portico_context>"
                ),
            },
            {"role": "system", "content": original_dynamic_context},
            {
                "role": "tool",
                "content": json.dumps({"historical_workspace": stale_path}),
            },
        ]
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={"chat_id": "cloned-chat"},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=True,
        )
    )

    refreshed_static = result["messages"][1]["content"]
    assert str(current_path).replace("&", "&amp;") in refreshed_static
    assert stale_path not in refreshed_static
    assert "authoritative for the current request" in refreshed_static
    assert stale_path in result["messages"][3]["content"]
    assert result["messages"][2]["content"] == original_dynamic_context


def test_unified_context_followup_migrates_legacy_context_into_static_and_dynamic_messages():
    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=False,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None

    body = {
        "messages": [
            {"role": "system", "content": ""},
            {
                "role": "system",
                "content": (
                    "<portico_context>\n\n"
                    "<legacy>combined old context</legacy>\n\n"
                    "</portico_context>"
                ),
            },
            {"role": "assistant", "content": "tool call placeholder"},
        ]
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=False,
        )
    )

    system_messages = [message for message in result["messages"] if message.get("role") == "system"]
    assert len(system_messages) == 3
    assert "<static_context>" in system_messages[1]["content"]
    assert "<dynamic_context>" in system_messages[2]["content"]
    assert "<legacy>combined old context</legacy>" not in system_messages[2]["content"]


def test_unified_context_followup_inserts_missing_dynamic_context_after_static_block():
    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=False,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None

    body = {
        "messages": [
            {"role": "system", "content": ""},
            {
                "role": "system",
                "content": (
                    "<portico_context>\n\n"
                    "<static_context>\n\n"
                    "<static_only>true</static_only>\n\n"
                    "</static_context>\n\n"
                    "</portico_context>"
                ),
            },
            {"role": "assistant", "content": "tool call placeholder"},
        ]
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=True,
        )
    )

    system_messages = [message for message in result["messages"] if message.get("role") == "system"]
    assert len(system_messages) == 3
    assert "<static_context>" in system_messages[1]["content"]
    assert "<dynamic_context>" in system_messages[2]["content"]


def test_unified_context_followup_inserts_missing_static_context_before_dynamic_block():
    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=False,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None

    preserved_dynamic_context = (
        "<portico_context>\n\n"
        "<dynamic_context>\n\n"
        "<dynamic_only>true</dynamic_only>\n\n"
        "</dynamic_context>\n\n"
        "</portico_context>"
    )
    body = {
        "messages": [
            {"role": "system", "content": ""},
            {"role": "system", "content": preserved_dynamic_context},
            {"role": "assistant", "content": "tool call placeholder"},
        ]
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=True,
        )
    )

    system_messages = [message for message in result["messages"] if message.get("role") == "system"]
    assert len(system_messages) == 3
    assert "<static_context>" in system_messages[1]["content"]
    assert system_messages[2]["content"] == preserved_dynamic_context


def test_unified_context_followup_inserts_static_and_dynamic_when_no_context_exists_yet():
    filter_obj = _make_filter_stub()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=False,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=[],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None

    body = {
        "messages": [
            {"role": "assistant", "content": "tool call placeholder"},
        ]
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=False,
        )
    )

    assert result["messages"][0]["role"] == "assistant"
    assert result["messages"][1]["role"] == "system"
    assert "<static_context>" in result["messages"][1]["content"]
    assert result["messages"][2]["role"] == "system"
    assert "<dynamic_context>" in result["messages"][2]["content"]


def test_unified_context_continues_tool_injection_when_auto_activation_raises(caplog):
    class _FakeRedis:
        def __init__(self):
            self.store = {}

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    def _raise_auto_activation(_message):
        raise AttributeError("'dict' object has no attribute 'lower'")

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=True,
        enable_auto_activation=True,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=True,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=["server:mcp-assistant", "server:skills", "server:subagents"],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = SimpleNamespace(
        check_auto_activation=_raise_auto_activation,
        get_all_metadata=lambda: [],
        format_skills_for_prompt=lambda _skills: "<available_skills />",
    )
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()
    filter_obj._ensure_tool_server_connections = lambda _request: None
    filter_obj._get_unauthenticated_integrations = lambda: []

    async def _fetch_available_tools():
        return [
            {"id": "server:mcp-assistant", "name": "MCP Assistant"},
            {"id": "server:skills", "name": "Skills"},
            {"id": "server:subagents", "name": "Subagents"},
        ]

    async def _fetch_mcp_server_metadata():
        return {
            "mcp-assistant": {"display_name": "MCP Assistant", "is_core": True},
            "skills": {"display_name": "Skills", "is_core": True},
            "subagents": {"display_name": "Subagents", "is_core": True},
        }

    filter_obj._fetch_available_tools = _fetch_available_tools
    filter_obj._fetch_mcp_server_metadata = _fetch_mcp_server_metadata

    body = {
        "messages": [{"role": "user", "content": "Generate a deck"}],
        "metadata": {"chat_id": "chat-1"},
    }

    async def _emit(_event):
        return None

    with caplog.at_level(logging.WARNING, logger="filters.unified_context"):
        result = asyncio.run(
            filter_obj.inlet(
                body,
                _emit,
                object(),
                __metadata__={"chat_id": "chat-1"},
            )
        )

    assert result["tool_ids"] == [
        "server:mcp-assistant",
        "server:skills",
        "server:subagents",
    ]
    assert any(
        "<portico_context>" in message.get("content", "")
        for message in result["messages"]
        if message.get("role") == "system"
    )
    assert "Skill keyword auto-activation failed for chat chat-1" in caplog.text
    assert "continuing unified context processing" in caplog.text
    assert "Error in unified context filter" not in caplog.text


def test_unified_context_followup_refreshes_enabled_servers_and_activated_skill_content_from_redis():
    class _FakeRedis:
        def __init__(self):
            self.store = {
                "chat_tools:chat-1": json.dumps(
                    [
                        "server:mcp-assistant",
                        "server:skills",
                        "server:subagents",
                        "server:google_workspace",
                        "server:agent-vm",
                    ]
                ),
                "chat_skills:chat-1": json.dumps(["calibration-host"]),
            }

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=True,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=True,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = SimpleNamespace(
        get_all_metadata=lambda: [{"name": "calibration-host"}],
        format_skills_for_prompt=lambda _skills: "<available_skills />",
        format_activated_skill=lambda skill_name: (
            f'<activated_skill name="{skill_name}">Calibration instructions</activated_skill>'
        ),
        get_skill_metadata=lambda _skill_name: SimpleNamespace(
            required_mcp_servers=["server:google_workspace", "server:agent-vm"]
        ),
    )
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()
    filter_obj._ensure_tool_server_connections = lambda _request: pytest.fail(
        "prompt path must not register tool server connections"
    )
    _fail_live_readiness_methods(filter_obj)

    async def _fetch_available_tools():
        return [
            {"id": "server:mcp-assistant", "name": "MCP Assistant"},
            {"id": "server:skills", "name": "Skills"},
            {"id": "server:subagents", "name": "Subagents"},
            {"id": "server:google_workspace", "name": "Google Workspace"},
            {"id": "server:agent-vm", "name": "Agent VM"},
        ]

    async def _fetch_mcp_server_metadata():
        return {
            "mcp-assistant": {
                "display_name": "MCP Assistant",
                "is_core": True,
            },
            "skills": {
                "display_name": "Skills",
                "is_core": True,
            },
            "subagents": {
                "display_name": "Subagents",
                "is_core": True,
            },
            "google_workspace": {
                "display_name": "Google Workspace",
                "oauth": True,
                "is_core": False,
                "user_installed": False,
            },
            "agent-vm": {
                "display_name": "Agent VM",
                "is_core": True,
            },
        }

    filter_obj._fetch_available_tools = _fetch_available_tools
    filter_obj._fetch_mcp_server_metadata = _fetch_mcp_server_metadata

    body = {
        "messages": [
            {"role": "system", "content": ""},
            {
                "role": "system",
                "content": (
                    "<portico_context>\n\n"
                    "<static_context>\n\n"
                    "<skills>\n"
                    '  <status activated="none">Activate skills as needed.</status>\n'
                    "</skills>\n\n"
                    "</static_context>\n\n"
                    "</portico_context>"
                ),
            },
            {
                "role": "system",
                "content": (
                    "<portico_context>\n\n"
                    "<dynamic_context>\n\n"
                    "<tool_servers>\n"
                    "  <enabled>\n"
                    "    <server>server:mcp-assistant</server>\n"
                    "    <server>server:skills</server>\n"
                    "    <server>server:subagents</server>\n"
                    "  </enabled>\n"
                    "</tool_servers>\n\n"
                    "</dynamic_context>\n\n"
                    "</portico_context>"
                ),
            },
            {"role": "assistant", "content": "tool call placeholder"},
            {"role": "tool", "content": '{"success":true}'},
        ],
        "metadata": {"chat_id": "chat-1"},
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={"chat_id": "chat-1"},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=False,
        )
    )

    static_context = result["messages"][1]["content"]
    dynamic_context = result["messages"][2]["content"]

    assert 'activated="calibration-host"' in static_context
    assert '<activated_skill name="calibration-host">' in static_context
    assert "Calibration instructions" in static_context
    assert "<server>server:google_workspace</server>" in dynamic_context
    assert "<server>server:agent-vm</server>" in dynamic_context
    assert "google_workspace | Google Workspace | auth=oauth" in dynamic_context


def test_unified_context_dynamic_context_lists_inactive_core_servers_as_available_to_activate():
    class _FakeRedis:
        def __init__(self):
            self.store = {
                "chat_tools:chat-1": json.dumps(
                    [
                        "server:mcp-assistant",
                        "server:skills",
                        "server:subagents",
                        "server:agent-vm",
                    ]
                ),
            }

        def get(self, key):
            return self.store.get(key)

        def setex(self, key, _ttl, value):
            self.store[key] = value

    filter_obj = _make_filter_stub()
    filter_obj.redis_client = _FakeRedis()
    filter_obj.valves = SimpleNamespace(
        enable=True,
        enable_skills=False,
        enable_auto_activation=False,
        enable_models_context=False,
        enable_agent_vm=False,
        enable_workspace_files=False,
        enable_mcp_tools=True,
        enable_session_context=False,
        enable_time_context=False,
        core_tool_ids=["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
        fallback_always_enabled_ids=[],
    )
    filter_obj.skill_manager = None
    filter_obj._chat_capabilities_lock = lambda _chat_id: nullcontext()
    filter_obj._ensure_tool_server_connections = lambda _request: pytest.fail(
        "prompt path must not register tool server connections"
    )
    _fail_live_readiness_methods(filter_obj)

    async def _fetch_available_tools():
        return [
            {"id": "server:mcp-assistant", "name": "MCP Assistant"},
            {"id": "server:skills", "name": "Skills"},
            {"id": "server:subagents", "name": "Subagents"},
            {"id": "server:agent-vm", "name": "Agent VM"},
            {"id": "server:scheduling", "name": "Scheduling"},
        ]

    async def _fetch_mcp_server_metadata():
        return {
            "mcp-assistant": {
                "display_name": "MCP Assistant",
                "is_core": True,
                "always_enabled": True,
            },
            "skills": {
                "display_name": "Skills",
                "is_core": True,
                "always_enabled": True,
            },
            "subagents": {
                "display_name": "Subagents",
                "is_core": True,
                "always_enabled": True,
            },
            "agent-vm": {
                "display_name": "Agent VM",
                "is_core": True,
                "always_enabled": True,
            },
            "scheduling": {
                "display_name": "Scheduling",
                "is_core": True,
                "always_enabled": False,
            },
        }

    filter_obj._fetch_available_tools = _fetch_available_tools
    filter_obj._fetch_mcp_server_metadata = _fetch_mcp_server_metadata

    body = {
        "messages": [
            {"role": "assistant", "content": "tool call placeholder"},
        ],
        "metadata": {"chat_id": "chat-1"},
    }

    async def _emit(_event):
        return None

    result = asyncio.run(
        filter_obj.inlet(
            body,
            _emit,
            object(),
            __metadata__={"chat_id": "chat-1"},
            __is_followup_request__=True,
            __followup_phase__="tool_followup",
            __preserve_dynamic_context__=False,
        )
    )

    static_context = result["messages"][1]["content"]
    dynamic_context = result["messages"][2]["content"]

    assert "<available_to_activate>" in static_context
    assert "agent-vm | auth=token | phase=tool_ready" not in static_context
    assert "scheduling | auth=token | phase=tool_ready" in static_context
    assert "<available_to_activate>" not in dynamic_context
    assert "<ask_user_question_policy>" in dynamic_context
    assert "<tool>skills_ask_user_question</tool>" in dynamic_context
    assert "<chat_id>chat-1</chat_id>" in dynamic_context
