#!/usr/bin/env python3
"""
Integration test for follow-up request skill activation.

Tests that skills activated mid-turn appear in follow-up LLM requests.
"""

import asyncio
import sys
import os

# Add framework to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framework.tools.redis_checker import check_redis
from framework.tools.chat_simulator import simulate_chat
from framework.tools.docker_logs import check_docker_logs
from framework.tools.transcript_verifier import verify_system_messages
from framework.tools.assertions import assert_condition, get_assertion_summary, clear_assertions


async def run_followup_skill_test():
    """Run the follow-up request skill activation test."""
    print("=" * 70)
    print("TEST: Follow-up Request Skill Activation")
    print("=" * 70)

    # Clear previous assertions
    clear_assertions()

    # Step 1: Send prompt that triggers code execution
    print("\n[Step 1] Sending prompt to trigger code-execution skill...")
    print("  Prompt: 'Write a Python script to compute the first 50 prime numbers. Tell me the numbers.'")

    chat_result = await simulate_chat(
        prompt="Write a Python script to compute the first 50 prime numbers. Tell me the numbers.",
        model="Claude Sonnet 4.6",
        wait_for_completion=True,
        timeout_seconds=300,
        auto_assert=False  # We'll assert manually
    )

    chat_id = chat_result.get("chat_id")
    print(f"  Chat ID: {chat_id}")
    print(f"  Success: {chat_result.get('success')}")
    print(f"  Completed: {chat_result.get('completed')}")

    if chat_result.get("error"):
        print(f"  Error: {chat_result.get('error')}")

    if chat_result.get("tool_calls"):
        print(f"  Tool calls: {len(chat_result.get('tool_calls'))} calls")
        for tc in chat_result.get("tool_calls", []):
            print(f"    - {tc.get('function', {}).get('name', 'unknown')}")

    await assert_condition(
        chat_id is not None,
        "Chat was created with valid ID",
        "critical"
    )

    if not chat_id:
        print("\n❌ FATAL: No chat_id, cannot continue test")
        return 1

    # Step 2: Verify skill auto-activated
    print("\n[Step 2] Verifying code-execution skill was auto-activated...")

    log_result = await check_docker_logs(
        patterns=[
            r"Auto-activated skill: code-execution",
            r"UNIFIED_CONTEXT_FILTER"
        ],
        container="portico-open-webui",
        since="5m",
        check_order=False
    )

    print(f"  Found patterns: {log_result.get('found_patterns', [])}")
    print(f"  Missing patterns: {log_result.get('missing_patterns', [])}")

    await assert_condition(
        "Auto-activated skill: code-execution" in str(log_result.get("found_patterns", [])),
        "code-execution skill was auto-activated",
        "critical"
    )

    # Step 3: Verify initial request has skill in system messages
    print("\n[Step 3] Verifying initial request has activated skill content...")

    system_result = await verify_system_messages(
        chat_id=chat_id,
        expected_patterns=[
            r"<activated_skill.*code-execution",
            r"python",
            r"<skills>"
        ]
    )

    print(f"  Found patterns: {system_result.get('found', [])}")
    print(f"  Missing patterns: {system_result.get('missing', [])}")

    await assert_condition(
        len(system_result.get("missing", [])) == 0,
        f"All skill patterns found in system messages (missing: {system_result.get('missing', [])})",
        "critical"
    )

    # Step 4: Verify tool call was made
    print("\n[Step 4] Checking if tool calls were made...")

    tool_log_result = await check_docker_logs(
        patterns=[
            r"python|bash|tool_calls",
            r"Processing tool|execute_tool"
        ],
        container="portico-open-webui",
        since="5m",
        check_order=False
    )

    print(f"  Found tool patterns: {tool_log_result.get('found_patterns', [])}")

    tool_call_made = bool(chat_result.get("tool_calls")) or len(tool_log_result.get("found_patterns", [])) > 0
    await assert_condition(
        tool_call_made,
        "Model made tool calls using code-execution skill",
        "warning"  # May not always make tool calls
    )

    # Step 5: Verify follow-up request processing
    print("\n[Step 5] Checking for follow-up request processing...")

    followup_log_result = await check_docker_logs(
        patterns=[
            r"FOLLOW-UP Request|__is_followup_request__",
            r"Applied inlet filters to follow-up"
        ],
        container="portico-open-webui",
        since="5m",
        check_order=False
    )

    print(f"  Found follow-up patterns: {followup_log_result.get('found_patterns', [])}")
    print(f"  Missing patterns: {followup_log_result.get('missing_patterns', [])}")

    # This is critical - if tool calls were made, follow-up should have been processed
    if tool_call_made:
        await assert_condition(
            len(followup_log_result.get("found_patterns", [])) > 0,
            "Follow-up request was processed with inlet filters",
            "critical"
        )
    else:
        await assert_condition(
            True,  # Skip if no tool calls
            "No tool calls made, skipping follow-up verification",
            "info"
        )

    # Step 6: Verify LLM gateway debug monitor events
    print("\n[Step 6] Checking LLM gateway debug monitor events...")

    gateway_log_result = await check_docker_logs(
        patterns=[
            rf"Published llm_request_payload event for chat {chat_id}",
            r"Published llm_request_payload event for chat (?!unknown)"
        ],
        container="llm-gateway",
        since="5m",
        check_order=False
    )

    print(f"  Found LLM gateway patterns: {gateway_log_result.get('found_patterns', [])}")

    # Check for "unknown" chat_id which indicates metadata not passed
    unknown_check = await check_docker_logs(
        patterns=[r"Published llm_request_payload event for chat unknown"],
        container="llm-gateway",
        since="5m",
        check_order=False
    )

    has_unknown = len(unknown_check.get("found_patterns", [])) > 0
    print(f"  Has 'unknown' chat_id: {has_unknown}")

    await assert_condition(
        not has_unknown,
        "LLM gateway received proper chat_id (not 'unknown')",
        "critical"
    )

    # Step 7: Verify response completed
    print("\n[Step 7] Checking if response completed...")

    response_log_result = await check_docker_logs(
        patterns=[r"Published llm_response_complete event"],
        container="llm-gateway",
        since="5m",
        check_order=False
    )

    print(f"  Response complete events: {len(response_log_result.get('found_patterns', []))}")

    await assert_condition(
        len(response_log_result.get("found_patterns", [])) > 0,
        "LLM response completed (not stuck streaming)",
        "critical"
    )

    # Step 8: Verify Redis state
    print("\n[Step 8] Verifying Redis skill state...")

    redis_result = await check_redis(
        key=f"chat_skills:{chat_id}",
        should_exist=True
    )

    print(f"  Redis key exists: {redis_result.get('exists')}")
    print(f"  Redis value: {redis_result.get('value')}")

    has_skill = "code-execution" in str(redis_result.get("value", ""))
    await assert_condition(
        has_skill,
        "code-execution skill stored in Redis",
        "critical"
    )

    # Print summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)

    summary = get_assertion_summary()
    print(f"Total assertions: {summary['total']}")
    print(f"Passed: {summary['passed']}")
    print(f"Failed: {summary['failed']}")
    print(f"Critical failures: {summary['critical_failures']}")

    # Print individual results
    print("\nAssertion Details:")
    for a in summary.get('assertions', []):
        status = "✅" if a['passed'] else "❌"
        print(f"  {status} [{a['severity']}] {a['message']}")

    if summary['all_passed']:
        print("\n✅ ALL TESTS PASSED")
        return 0
    else:
        print("\n❌ TESTS FAILED")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(run_followup_skill_test())
    sys.exit(exit_code)
