#!/usr/bin/env python3
"""
Manual test runner for Filter Chain Execution test.
"""

import asyncio
import sys
import os

# Add framework to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framework.tools.redis_checker import delete_redis_keys, check_redis
from framework.tools.chat_simulator import simulate_chat
from framework.tools.docker_logs import check_docker_logs
from framework.tools.transcript_verifier import verify_system_messages
from framework.tools.capabilities_checker import verify_enabled_tools
from framework.tools.assertions import assert_condition, get_assertion_summary


async def run_filter_chain_test():
    """Run the filter chain execution test."""
    print("=" * 60)
    print("TEST: Filter Chain Execution")
    print("=" * 60)

    # Step 1: Clear Previous State
    print("\n[Step 1] Clearing previous state...")
    cleanup_result = await delete_redis_keys([
        "chat_tools:test-*",
        "chat_skills:test-*",
        "agent_vm:test-*"
    ])
    print(f"  Cleanup: {cleanup_result}")

    # Step 2: Simulate Chat
    print("\n[Step 2] Simulating chat...")
    chat_result = await simulate_chat(
        prompt="Hello, what time is it?",
        model="Atlas Sonnet 4.6",
        wait_for_completion=True,
        timeout_seconds=120
    )
    print(f"  Chat result: success={chat_result.get('success')}")

    chat_id = chat_result.get("chat_id")
    if not chat_id:
        print(f"  ERROR: No chat_id returned: {chat_result}")
        await assert_condition(False, "Chat was created successfully", "critical")
        return

    print(f"  Chat ID: {chat_id}")
    await assert_condition(
        chat_result.get("success", False),
        "Chat was created successfully",
        "critical"
    )

    # Step 3: Verify Filter Logs (IN ORDER)
    print("\n[Step 3] Verifying filter logs...")
    log_patterns = [
        "UNIFIED_CONTEXT_FILTER - Processing Request",
        r"Phase 1 complete: Skills - 0 activated, 0 required server\(s\) reconciled",
        "Phase 1b complete: Model inventory done",
        "Phase 2 complete: VM - not needed",
        "Phase 3 complete: Tools management done",
        "Phase 4 complete: Session mapping done",
        "Phase 5 complete: Workspace files processed",
        "UNIFIED_CONTEXT_FILTER - Completed Successfully",
    ]

    log_result = await check_docker_logs(
        patterns=log_patterns,
        container="portico-open-webui",
        since="5m",
        check_order=True
    )

    print(f"  Logs found: {log_result.get('found')}")
    print(f"  Missing patterns: {log_result.get('missing_patterns')}")
    print(f"  Order correct: {log_result.get('order_correct')}")

    await assert_condition(
        log_result.get("found", False),
        f"All unified filter phase patterns found in correct order (missing: {log_result.get('missing_patterns', [])})",
        "critical"
    )

    # Step 4: Verify Core Tools Enabled
    print("\n[Step 4] Verifying core tools enabled...")
    expected_tools = [
        "server:mcp-assistant",
        "server:subagents",
        "server:skills",
        "server:agent-vm",
    ]

    tools_result = await verify_enabled_tools(
        chat_id=chat_id,
        expected_tools=expected_tools
    )

    print(f"  Tools enabled: {tools_result.get('enabled')}")
    print(f"  Missing tools: {tools_result.get('missing')}")

    await assert_condition(
        tools_result.get("success", False),
        f"All 4 always-on core tools are enabled (missing: {tools_result.get('missing', [])})",
        "critical"
    )

    # Step 5: Verify Agent VM not created for simple prompt
    print("\n[Step 5] Verifying Agent VM was not created...")
    vm_result = await check_redis(
        key=f"agent_vm:{chat_id}",
        should_exist=False
    )

    print(f"  VM exists: {vm_result.get('exists')}")
    print(f"  VM ID: {vm_result.get('value')}")

    await assert_condition(
        not vm_result.get("exists", False),
        "Agent VM was not created for a simple prompt",
        "critical"
    )

    # Print summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)

    summary = get_assertion_summary()
    print(f"Total assertions: {summary['total']}")
    print(f"Passed: {summary['passed']}")
    print(f"Failed: {summary['failed']}")
    print(f"Critical failures: {summary['critical_failures']}")

    if summary['all_passed']:
        print("\n✅ ALL TESTS PASSED")
        return 0
    else:
        print("\n❌ TESTS FAILED")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(run_filter_chain_test())
    sys.exit(exit_code)
