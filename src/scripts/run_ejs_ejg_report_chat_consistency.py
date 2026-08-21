#!/usr/bin/env python3
"""
Run a headless Open WebUI load test for the EJS/EJG quarterly report scenario.

Each wave:
1. creates N fresh parent chats
2. starts all completions in parallel
3. validates that every parent chat:
   - spawns exactly 3 subagents
   - each subagent uses the expected model
   - each child chat completes successfully with no tool-level failures
   - the parent writes a real PDF to its local workspace
   - the PDF text covers the core requirements from the prompt
"""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import importlib.util
import json
import re
import statistics
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = REPO_ROOT / "src" / "scripts" / "run_google_workspace_chat_consistency.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("owui_runner_base", RUNNER_PATH)
if RUNNER_SPEC is None or RUNNER_SPEC.loader is None:
    raise RuntimeError(f"Failed to load runner base from {RUNNER_PATH}")
RUNNER_MODULE = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(RUNNER_MODULE)

OWUIClient = RUNNER_MODULE.OWUIClient
_detect_openwebui_base_url = RUNNER_MODULE._detect_openwebui_base_url
_restart_counts = RUNNER_MODULE._restart_counts

try:
    from pypdf import PdfReader
except ImportError as exc:  # pragma: no cover - runtime dependency
    raise RuntimeError(
        "Missing dependency 'pypdf'. Run this script with `uv run --with httpx --with pypdf ...`."
    ) from exc


PROMPT_TEMPLATE = """My teams are the Employer Jobs Platform Search & Groups teams (EJS and EJG).

We are actively working on commitments for AI Advanced Screening, Basic Screening, and AI Job Management

Spawn (3) subagents in parallel. Each subagent should use the {subagent_model} model.

The first subagent should focus on searching company knowledge for these (3) major projects, and should synthesize a detailed report on the high level requirements for each project, what has been delivered thus far, and what the plans are for this quarter.

The second subagent should focus on searching JIRA for work related to these projects (look in the EJSEARCH and EJGROUP projects), and synthesize a detailed report on all the tickets grouped by major theme grouped by project.

The third subagent should search Slack for conversations that have happened in the last 2 weeks across the following channels: #ejp-nexus, ejp-job-search-groups-team, ejp-ai-job-mgmt-collab, #ejp-ai-job-management, #advancedscreening-ejp-all, employer-job-groups-dev, and ejs-dev, and should synthesize a detailed report on each major conversation theme. Ensure to read conversation threads as well.

When all subagents are done, build me a PDF report with your findings. Cover the projects, the goals for the quarter, the associated work for said goals (on my teams specifically), an analysis of team velocity and likelihood of successful delivery on our commitments, and highlight any noteworthy accomplishments or challenges based on what was found on Slack.
"""

DEFAULT_PARENT_MODEL = "Claude Sonnet 4.6"
DEFAULT_SUBAGENT_MODEL = "Claude Opus 5"
DEFAULT_PARALLELISM = 5
DEFAULT_WAVES = 10
DEFAULT_CHAT_TIMEOUT_SECONDS = 1200
DEFAULT_HTTP_TIMEOUT_SECONDS = 180.0
MAX_REASONABLE_CHILD_TOKENS = 500_000
MAX_REASONABLE_PARENT_TOKENS = 700_000

EXPECTED_SUBAGENT_SKILLS = {
    "company-knowledge",
    "atlassian-portico",
}
EXPECTED_PROJECT_NAMES = {
    "AI Advanced Screening",
    "Basic Screening",
    "AI Job Management",
}
EXPECTED_PDF_TOPICS = {
    "velocity",
    "slack",
    "jira",
    "delivery",
}


def _has_delivery_confidence_analysis(lower_text: str) -> bool:
    if not lower_text:
        return False

    exact_markers = (
        "likelihood of successful delivery",
        "delivery confidence",
        "delivery likelihood",
        "confidence assessment",
    )
    if any(marker in lower_text for marker in exact_markers):
        return True

    confidence_markers = ("confidence", "likelihood", "on track", "at risk", "at-risk")
    delivery_markers = ("delivery", "deliver", "commitment", "quarter")
    return any(marker in lower_text for marker in confidence_markers) and any(
        marker in lower_text for marker in delivery_markers
    )


def _build_prompt(subagent_model: str) -> str:
    return PROMPT_TEMPLATE.format(subagent_model=subagent_model)


def _decode_embedded_json(value: str | None) -> Any:
    if not value:
        return None
    text = html.unescape(value)
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(decoded, str):
        try:
            return json.loads(decoded)
        except json.JSONDecodeError:
            return decoded
    return decoded


def _parse_tool_calls(content: str) -> list[dict[str, Any]]:
    tool_calls: list[dict[str, Any]] = []
    for attrs_blob in re.findall(r'<details\s+type="tool_calls"\s+([^>]*)>', content or ""):
        attrs = {
            key: value
            for key, value in re.findall(r'([a-zA-Z_]+)="([^"]*)"', attrs_blob)
        }
        duration_raw = attrs.get("duration", "0")
        try:
            duration = float(duration_raw)
        except ValueError:
            duration = 0.0
        tool_calls.append(
            {
                "id": attrs.get("id"),
                "name": html.unescape(attrs.get("name", "")),
                "duration_seconds": duration,
                "arguments": _decode_embedded_json(attrs.get("arguments")),
                "result": _decode_embedded_json(attrs.get("result")),
            }
        )
    return tool_calls


def _strip_details_blocks(content: str) -> str:
    without_details = re.sub(r"<details\b.*?</details>", "", content or "", flags=re.DOTALL)
    without_tags = re.sub(r"<[^>]+>", "", without_details)
    return html.unescape(without_tags).strip()


def _is_tool_failure(result: Any) -> bool:
    if isinstance(result, dict):
        if result.get("error"):
            return True
        if result.get("success") is False:
            return True
    if isinstance(result, str):
        lowered = result.lower()
        if lowered.startswith("error:"):
            return True
    return False


def _read_pdf_text(path: Path) -> tuple[int, str]:
    reader = PdfReader(str(path))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    return len(reader.pages), text


def _find_workspace_pdfs(chat_id: str) -> list[Path]:
    root = REPO_ROOT / "workspaces" / chat_id
    if not root.exists():
        return []
    pdfs = sorted(root.rglob("*.pdf"))
    preferred = [
        path
        for path in pdfs
        if "/output/" in str(path).replace("\\", "/")
    ]
    return preferred or pdfs


def _extract_chat_messages(chat_payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    history_messages = (
        chat_payload.get("chat", {})
        .get("history", {})
        .get("messages", {})
    )
    assistants = [
        message
        for message in history_messages.values()
        if isinstance(message, dict) and message.get("role") == "assistant"
    ]
    return history_messages, assistants


def _latest_assistant(chat_payload: dict[str, Any]) -> dict[str, Any] | None:
    _, assistants = _extract_chat_messages(chat_payload)
    if not assistants:
        return None
    return max(assistants, key=lambda message: message.get("timestamp", 0))


def _usage_for_message(message: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(message, dict):
        return {}
    info = message.get("info")
    if isinstance(info, dict) and isinstance(info.get("usage"), dict):
        return info["usage"]
    usage = message.get("usage")
    if isinstance(usage, dict):
        return usage
    return {}


def _validate_child_chat(
    *,
    client: OWUIClient,
    chat_id: str,
    expected_model: str,
    max_reasonable_child_tokens: int,
) -> tuple[list[str], dict[str, Any]]:
    failures: list[str] = []
    chat_payload = client.get_chat(chat_id)
    latest = _latest_assistant(chat_payload)
    if latest is None:
        return [f"child chat {chat_id} has no assistant message"], {}

    if not latest.get("done"):
        failures.append(f"child chat {chat_id} did not finish")

    content = latest.get("content", "")
    tool_calls = _parse_tool_calls(content)
    if not tool_calls:
        failures.append(f"child chat {chat_id} made no tool calls")

    model_names = chat_payload.get("chat", {}).get("models", []) or []
    if expected_model not in model_names:
        failures.append(
            f"child chat {chat_id} used models {model_names!r}, expected {expected_model!r}"
        )

    error_message = latest.get("error")
    if error_message:
        failures.append(f"child chat {chat_id} assistant error: {error_message}")

    usage = _usage_for_message(latest)
    total_tokens = usage.get("total_tokens")
    if isinstance(total_tokens, (int, float)) and total_tokens > max_reasonable_child_tokens:
        failures.append(
            f"child chat {chat_id} used {int(total_tokens)} tokens, exceeding {max_reasonable_child_tokens}"
        )

    for call in tool_calls:
        if _is_tool_failure(call.get("result")):
            failures.append(
                f"child chat {chat_id} tool {call['name']} failed: {call.get('result')}"
            )

    text = _strip_details_blocks(content)
    if len(text) < 400:
        failures.append(f"child chat {chat_id} response too short ({len(text)} chars)")

    return failures, {
        "chat_id": chat_id,
        "tool_names": [call["name"] for call in tool_calls],
        "tool_call_count": len(tool_calls),
        "final_text_chars": len(text),
        "usage": usage,
    }


def _validate_parent_chat(
    *,
    client: OWUIClient,
    chat_id: str,
    assistant_html: str,
    expected_subagent_model: str,
    max_reasonable_child_tokens: int,
    max_reasonable_parent_tokens: int,
) -> dict[str, Any]:
    failures: list[str] = []
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    subagent_calls = [call for call in tool_calls if call["name"] == "subagents_run_subagent"]
    parent_payload = client.get_chat(chat_id)
    parent_latest = _latest_assistant(parent_payload)
    parent_usage = _usage_for_message(parent_latest)

    if len(subagent_calls) != 3:
        failures.append(f"expected exactly 3 subagents, saw {len(subagent_calls)}")

    parent_total_tokens = parent_usage.get("total_tokens")
    if (
        isinstance(parent_total_tokens, (int, float))
        and parent_total_tokens > max_reasonable_parent_tokens
    ):
        failures.append(
            f"parent chat {chat_id} used {int(parent_total_tokens)} tokens, exceeding {max_reasonable_parent_tokens}"
        )

    child_chat_ids: list[str] = []
    child_summaries: list[dict[str, Any]] = []

    for call in subagent_calls:
        args = call.get("arguments")
        result = call.get("result")
        if not isinstance(args, dict):
            failures.append("subagent arguments were not structured JSON")
            continue
        if args.get("model") != expected_subagent_model:
            failures.append(
                f"subagent requested model {args.get('model')!r}, expected {expected_subagent_model!r}"
            )
        if not isinstance(result, dict):
            failures.append("subagent result was not structured JSON")
            continue
        if result.get("success") is False or result.get("error"):
            failures.append(f"subagent returned failure: {result}")
        if result.get("response_truncated") is True:
            failures.append(
                "subagent result was truncated: "
                f"chat_id={result.get('chat_id')!r}, "
                f"response_char_count={result.get('response_char_count')!r}"
            )
        child_chat_id = result.get("chat_id")
        if not isinstance(child_chat_id, str) or not child_chat_id:
            failures.append(f"subagent returned invalid chat_id: {result}")
            continue
        child_chat_ids.append(child_chat_id)
        child_failures, child_summary = _validate_child_chat(
            client=client,
            chat_id=child_chat_id,
            expected_model=expected_subagent_model,
            max_reasonable_child_tokens=max_reasonable_child_tokens,
        )
        failures.extend(child_failures)
        if child_summary:
            child_summaries.append(child_summary)

    if len(set(child_chat_ids)) != len(child_chat_ids):
        failures.append(f"duplicate child chat ids: {child_chat_ids}")

    pdfs = _find_workspace_pdfs(chat_id)
    if not pdfs:
        failures.append("no PDF created in the parent chat workspace")

    pdf_summaries: list[dict[str, Any]] = []
    if pdfs:
        # Inspect the first preferred PDF and require the text to satisfy the prompt.
        primary_pdf = pdfs[0]
        try:
            page_count, pdf_text = _read_pdf_text(primary_pdf)
        except Exception as exc:
            failures.append(f"failed to read PDF {primary_pdf}: {exc}")
            page_count = 0
            pdf_text = ""
        lower_text = pdf_text.lower()
        if primary_pdf.read_bytes()[:4] != b"%PDF":
            failures.append(f"file is not a valid PDF: {primary_pdf}")
        if page_count < 4:
            failures.append(f"PDF too short ({page_count} pages): {primary_pdf}")
        for project_name in EXPECTED_PROJECT_NAMES:
            if project_name.lower() not in lower_text:
                failures.append(f"PDF missing project name {project_name!r}")
        for topic in EXPECTED_PDF_TOPICS:
            if topic not in lower_text:
                failures.append(f"PDF missing expected topic {topic!r}")
        if not any(
            marker in lower_text
            for marker in (
                "quarter",
                "current quarter",
                "quarterly",
                "q1",
                "q2",
                "q3",
                "q4",
            )
        ):
            failures.append("PDF missing quarter or Qx planning language")
        if not _has_delivery_confidence_analysis(lower_text):
            failures.append("PDF missing delivery risk/confidence analysis")
        pdf_summaries.append(
            {
                "path": str(primary_pdf),
                "page_count": page_count,
                "text_chars": len(pdf_text),
                "contains_projects": {
                    project: project.lower() in lower_text
                    for project in sorted(EXPECTED_PROJECT_NAMES)
                },
            }
        )

    final_text = _strip_details_blocks(assistant_html)
    if len(final_text) < 300:
        failures.append(f"parent final response too short ({len(final_text)} chars)")

    return {
        "perfect": not failures,
        "failures": failures,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "child_chat_ids": child_chat_ids,
        "child_summaries": child_summaries,
        "pdfs": [str(path) for path in pdfs],
        "pdf_summaries": pdf_summaries,
        "final_text_chars": len(final_text),
        "parent_usage": parent_usage,
    }


def _run_single_chat(
    *,
    slot: int,
    base_url: str,
    token: str,
    parent_model: str,
    prompt: str,
    expected_subagent_model: str,
    max_reasonable_child_tokens: int,
    max_reasonable_parent_tokens: int,
    chat_id: str,
    user_message_id: str,
    start_barrier: threading.Barrier,
    timeout_seconds: int,
) -> dict[str, Any]:
    try:
        with OWUIClient(
            base_url=base_url,
            token=token,
            timeout=DEFAULT_HTTP_TIMEOUT_SECONDS,
        ) as client:
            start_barrier.wait()
            started = time.time()
            client.generate_completion(
                chat_id=chat_id,
                model=parent_model,
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
            elapsed = round(time.time() - started, 1)
    except Exception as exc:
        return {
            "slot": slot,
            "chat_id": chat_id,
            "perfect": False,
            "elapsed_seconds": None,
            "failures": [f"worker exception: {exc}"],
            "traceback": traceback.format_exc(),
        }

    if not completion.get("complete"):
        return {
            "slot": slot,
            "chat_id": chat_id,
            "perfect": False,
            "elapsed_seconds": elapsed,
            "failures": [completion.get("error", "chat did not complete")],
        }

    with OWUIClient(
        base_url=base_url,
        token=token,
        timeout=DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) as client:
        verdict = _validate_parent_chat(
            client=client,
            chat_id=chat_id,
            assistant_html=completion.get("content", ""),
            expected_subagent_model=expected_subagent_model,
            max_reasonable_child_tokens=max_reasonable_child_tokens,
            max_reasonable_parent_tokens=max_reasonable_parent_tokens,
        )
    verdict["slot"] = slot
    verdict["chat_id"] = chat_id
    verdict["elapsed_seconds"] = elapsed
    return verdict


def _create_wave_chats(
    *,
    base_url: str,
    token: str,
    parallelism: int,
    prompt: str,
    parent_model: str,
) -> list[dict[str, str]]:
    with OWUIClient(
        base_url=base_url,
        token=token,
        timeout=DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) as client:
        return [client.create_chat(model=parent_model, prompt=prompt) for _ in range(parallelism)]


def run_wave(
    *,
    wave: int,
    base_url: str,
    token: str,
    parallelism: int,
    prompt: str,
    parent_model: str,
    expected_subagent_model: str,
    max_reasonable_child_tokens: int,
    max_reasonable_parent_tokens: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    chat_specs = _create_wave_chats(
        base_url=base_url,
        token=token,
        parallelism=parallelism,
        prompt=prompt,
        parent_model=parent_model,
    )
    started = time.time()
    start_barrier = threading.Barrier(parallelism + 1)
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallelism) as executor:
        futures = [
            executor.submit(
                _run_single_chat,
                slot=index,
                base_url=base_url,
                token=token,
                parent_model=parent_model,
                prompt=prompt,
                expected_subagent_model=expected_subagent_model,
                max_reasonable_child_tokens=max_reasonable_child_tokens,
                max_reasonable_parent_tokens=max_reasonable_parent_tokens,
                chat_id=chat_spec["chat_id"],
                user_message_id=chat_spec["user_message_id"],
                start_barrier=start_barrier,
                timeout_seconds=timeout_seconds,
            )
            for index, chat_spec in enumerate(chat_specs, start=1)
        ]
        start_barrier.wait()
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())

    results.sort(key=lambda result: result["slot"])
    elapsed_values = [
        result["elapsed_seconds"]
        for result in results
        if isinstance(result.get("elapsed_seconds"), (int, float))
    ]
    failures = [
        {
            "slot": result["slot"],
            "chat_id": result.get("chat_id"),
            "failures": result.get("failures", []),
        }
        for result in results
        if not result.get("perfect")
    ]
    summary = {
        "wave": wave,
        "parallelism": parallelism,
        "success": not failures,
        "wall_clock_seconds": round(time.time() - started, 1),
        "parent_chat_count": len(results),
        "chat_elapsed_min_seconds": round(min(elapsed_values), 1) if elapsed_values else None,
        "chat_elapsed_p50_seconds": round(statistics.median(elapsed_values), 1)
        if elapsed_values
        else None,
        "chat_elapsed_max_seconds": round(max(elapsed_values), 1) if elapsed_values else None,
        "chat_ids": [result.get("chat_id") for result in results],
        "failures": failures,
    }
    return {"wave": wave, "summary": summary, "results": results}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--waves", type=int, default=DEFAULT_WAVES)
    parser.add_argument("--parallelism", type=int, default=DEFAULT_PARALLELISM)
    parser.add_argument("--parent-model", default=DEFAULT_PARENT_MODEL)
    parser.add_argument("--subagent-model", default=DEFAULT_SUBAGENT_MODEL)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_CHAT_TIMEOUT_SECONDS)
    parser.add_argument(
        "--max-child-tokens",
        type=int,
        default=MAX_REASONABLE_CHILD_TOKENS,
        help="Fail a wave if any child chat exceeds this total token budget.",
    )
    parser.add_argument(
        "--max-parent-tokens",
        type=int,
        default=MAX_REASONABLE_PARENT_TOKENS,
        help="Fail a wave if the parent chat exceeds this total token budget.",
    )
    args = parser.parse_args()

    prompt = _build_prompt(args.subagent_model)
    base_url = _detect_openwebui_base_url()
    with OWUIClient(base_url=base_url, timeout=DEFAULT_HTTP_TIMEOUT_SECONDS) as client:
        token = client.token

    restart_counts_before = _restart_counts()
    print(json.dumps({"restart_counts_before": restart_counts_before}, indent=2))

    wave_results = []
    for wave in range(1, args.waves + 1):
        result = run_wave(
            wave=wave,
            base_url=base_url,
            token=token,
            parallelism=args.parallelism,
            prompt=prompt,
            parent_model=args.parent_model,
            expected_subagent_model=args.subagent_model,
            max_reasonable_child_tokens=args.max_child_tokens,
            max_reasonable_parent_tokens=args.max_parent_tokens,
            timeout_seconds=args.timeout_seconds,
        )
        wave_results.append(result)
        print(json.dumps(result, indent=2, sort_keys=True))
        if not result["summary"]["success"]:
            break

    restart_counts_after = _restart_counts()
    successful_waves = sum(1 for result in wave_results if result["summary"]["success"])
    summary = {
        "requested_waves": args.waves,
        "parallelism": args.parallelism,
        "parent_model": args.parent_model,
        "subagent_model": args.subagent_model,
        "max_child_tokens": args.max_child_tokens,
        "max_parent_tokens": args.max_parent_tokens,
        "completed_waves": len(wave_results),
        "successful_waves": successful_waves,
        "restart_counts_before": restart_counts_before,
        "restart_counts_after": restart_counts_after,
        "success": successful_waves == args.waves
        and restart_counts_before == restart_counts_after,
        "wave_chat_ids": [
            {
                "wave": result["wave"],
                "chat_ids": result["summary"]["chat_ids"],
            }
            for result in wave_results
        ],
    }
    print(json.dumps({"summary": summary}, indent=2, sort_keys=True))
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
