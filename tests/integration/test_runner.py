"""
Integration Test Runner

Main pytest test file that runs agentic integration test specifications.
"""

import asyncio
import json
from pathlib import Path
from typing import List

import pytest

from framework import IntegrationTestRunner, TestResult
from framework.tools.assertions import get_all_assertions, get_assertion_summary
from conftest import get_spec_files, get_spec_ids


# =============================================================================
# Parametrized Test for All Specs
# =============================================================================

@pytest.mark.asyncio
@pytest.mark.parametrize("spec_file", get_spec_files(), ids=get_spec_ids())
async def test_spec(spec_file: Path):
    """
    Run a single test specification.

    This test is parametrized to run once for each spec file in the specs/ directory.
    """
    runner = IntegrationTestRunner(spec_file)
    result = await runner.run()

    # Print summary for visibility
    print(f"\n{'='*60}")
    print(f"Test: {result.spec.name}")
    print(f"Description: {result.spec.description}")
    print(f"Duration: {result.duration_seconds:.2f}s")
    print(f"{'='*60}")

    # Print assertion results
    for assertion in result.assertions:
        status = "✅ PASS" if assertion.passed else "❌ FAIL"
        severity = f"[{assertion.severity.upper()}]"
        print(f"  {status} {severity} {assertion.message}")

    # Print summary
    summary = result.summary
    print(f"\nSummary: {summary['passed']}/{summary['total']} passed")
    if summary['critical_failures'] > 0:
        print(f"  Critical failures: {summary['critical_failures']}")
    if summary['warnings'] > 0:
        print(f"  Warnings: {summary['warnings']}")

    # Assert based on results
    if result.error and "manual mode" not in result.error.lower():
        pytest.fail(f"Test execution error: {result.error}")

    # Check critical assertions
    critical_failures = [
        a for a in result.assertions
        if not a.passed and a.severity == "critical"
    ]

    if critical_failures:
        failure_messages = "\n".join(
            f"  - {a.message}" for a in critical_failures
        )
        pytest.fail(f"Critical assertions failed:\n{failure_messages}")

    # Warn about non-critical failures
    warnings = [
        a for a in result.assertions
        if not a.passed and a.severity == "warning"
    ]

    for warning in warnings:
        pytest.warns(UserWarning, match=warning.message)


# =============================================================================
# Individual Spec Tests (for targeted running)
# =============================================================================

@pytest.mark.asyncio
@pytest.mark.smoke
@pytest.mark.filters
async def test_filter_chain_execution():
    """Test the filter chain execution spec."""
    spec_path = Path(__file__).parent / "specs" / "01_filter_chain_execution.md"
    if not spec_path.exists():
        pytest.skip("Spec file not found")

    runner = IntegrationTestRunner(spec_path)
    result = await runner.run()

    assert result.summary["critical_passed"], "Critical assertions failed"


@pytest.mark.asyncio
@pytest.mark.critical
@pytest.mark.agent_vm
async def test_auto_agent_vm_creation():
    """Test the auto agent VM creation spec."""
    spec_path = Path(__file__).parent / "specs" / "02_auto_agent_vm_creation.md"
    if not spec_path.exists():
        pytest.skip("Spec file not found")

    runner = IntegrationTestRunner(spec_path)
    result = await runner.run()

    assert result.summary["critical_passed"], "Critical assertions failed"


@pytest.mark.asyncio
@pytest.mark.skills
async def test_skills_auto_activation():
    """Test the skills auto-activation spec."""
    spec_path = Path(__file__).parent / "specs" / "03_skills_auto_activation.md"
    if not spec_path.exists():
        pytest.skip("Spec file not found")

    runner = IntegrationTestRunner(spec_path)
    result = await runner.run()

    assert result.summary["critical_passed"], "Critical assertions failed"


@pytest.mark.asyncio
@pytest.mark.critical
@pytest.mark.mcp
async def test_mcp_server_enabling():
    """Test the MCP server enabling spec."""
    spec_path = Path(__file__).parent / "specs" / "04_mcp_server_enabling.md"
    if not spec_path.exists():
        pytest.skip("Spec file not found")

    runner = IntegrationTestRunner(spec_path)
    result = await runner.run()

    assert result.summary["critical_passed"], "Critical assertions failed"


@pytest.mark.asyncio
@pytest.mark.slow
async def test_artifacts_workflow():
    """Test the complete artifacts workflow spec."""
    spec_path = Path(__file__).parent / "specs" / "05_artifacts_workflow.md"
    if not spec_path.exists():
        pytest.skip("Spec file not found")

    runner = IntegrationTestRunner(spec_path)
    result = await runner.run()

    assert result.summary["critical_passed"], "Critical assertions failed"


# =============================================================================
# CLI Runner
# =============================================================================

async def run_all_specs(verbose: bool = True) -> List[TestResult]:
    """
    Run all test specs and return results.

    This can be called directly for non-pytest usage.
    """
    specs_dir = Path(__file__).parent / "specs"
    results = []

    for spec_file in sorted(specs_dir.glob("*.md")):
        print(f"\n{'='*60}")
        print(f"Running: {spec_file.name}")
        print(f"{'='*60}")

        runner = IntegrationTestRunner(spec_file)
        result = await runner.run()
        results.append(result)

        if verbose:
            status = "✅ PASSED" if result.success else "❌ FAILED"
            print(f"\nResult: {status}")
            print(f"Duration: {result.duration_seconds:.2f}s")
            print(f"Assertions: {result.summary['passed']}/{result.summary['total']} passed")

    # Print overall summary
    print(f"\n{'='*60}")
    print("OVERALL SUMMARY")
    print(f"{'='*60}")

    total_specs = len(results)
    passed_specs = sum(1 for r in results if r.success)
    failed_specs = total_specs - passed_specs

    print(f"Specs: {passed_specs}/{total_specs} passed")

    if failed_specs > 0:
        print("\nFailed specs:")
        for result in results:
            if not result.success:
                print(f"  ❌ {result.spec.name}")
                if result.error:
                    print(f"     Error: {result.error}")

    return results


if __name__ == "__main__":
    # Allow running directly: python test_runner.py
    import sys

    async def main():
        results = await run_all_specs()
        failed = sum(1 for r in results if not r.success)
        sys.exit(1 if failed > 0 else 0)

    asyncio.run(main())
