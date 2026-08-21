"""
Pytest Configuration and Fixtures for Integration Tests

Provides fixtures for setup/teardown and common test utilities.
"""

import asyncio
import os
from pathlib import Path
from typing import Generator

import pytest

from framework.utils.redis_client import RedisClient
from framework.utils.api_client import OWUIClient
from framework.tools.assertions import clear_assertions


# =============================================================================
# Pytest Configuration
# =============================================================================

def pytest_configure(config):
    """Configure pytest with custom markers."""
    config.addinivalue_line("markers", "smoke: quick smoke tests")
    config.addinivalue_line("markers", "critical: critical path tests")
    config.addinivalue_line("markers", "slow: tests that take longer than 60s")
    config.addinivalue_line("markers", "agent_vm: tests involving Agent VMs")
    config.addinivalue_line("markers", "skills: tests involving skills system")
    config.addinivalue_line("markers", "filters: tests involving filter chain")
    config.addinivalue_line("markers", "mcp: tests involving MCP servers")


def pytest_collection_modifyitems(config, items):
    """Modify test collection to add markers based on spec tags."""
    for item in items:
        # Add markers based on test name patterns
        if "filter" in item.name.lower():
            item.add_marker(pytest.mark.filters)
        if "vm" in item.name.lower() or "agent" in item.name.lower():
            item.add_marker(pytest.mark.agent_vm)
        if "skill" in item.name.lower():
            item.add_marker(pytest.mark.skills)
        if "mcp" in item.name.lower() or "tool" in item.name.lower():
            item.add_marker(pytest.mark.mcp)


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def redis_client() -> Generator[RedisClient, None, None]:
    """Provide a Redis client for the test session."""
    client = RedisClient()
    try:
        # Verify connection
        client.client.ping()
        yield client
    finally:
        client.close()


@pytest.fixture(scope="session")
def owui_client() -> Generator[OWUIClient, None, None]:
    """Provide an OWUI client for the test session."""
    client = OWUIClient()
    yield client
    client.close()


@pytest.fixture(autouse=True)
def reset_assertions():
    """Clear assertions before each test."""
    clear_assertions()
    yield
    # Assertions are collected by the test runner after the test


@pytest.fixture
def specs_dir() -> Path:
    """Get the path to the specs directory."""
    return Path(__file__).parent / "specs"


@pytest.fixture
def test_prefix() -> str:
    """Get a unique prefix for test-related Redis keys."""
    import uuid
    return f"test-{uuid.uuid4().hex[:8]}"


@pytest.fixture
async def clean_test_state(redis_client: RedisClient, test_prefix: str):
    """Clean up test-related Redis state before and after test."""
    # Cleanup before
    patterns = [
        f"agent_vm:{test_prefix}*",
        f"chat_tools:{test_prefix}*",
        f"chat_skills:{test_prefix}*",
    ]
    for pattern in patterns:
        keys = redis_client.keys(pattern)
        if keys:
            redis_client.delete(*keys)

    yield test_prefix

    # Cleanup after
    for pattern in patterns:
        keys = redis_client.keys(pattern)
        if keys:
            redis_client.delete(*keys)


# =============================================================================
# Environment Checks
# =============================================================================

@pytest.fixture(scope="session", autouse=True)
def check_environment():
    """Verify the test environment is properly configured."""
    errors = []

    # Check Redis connectivity
    try:
        client = RedisClient()
        client.client.ping()
        client.close()
    except Exception as e:
        errors.append(f"Redis not accessible: {e}")

    # Check OWUI API
    try:
        owui = OWUIClient()
        # Just check we can get a token
        _ = owui.token
        owui.close()
    except Exception as e:
        errors.append(f"OWUI API not accessible: {e}")

    # Check Docker is available
    import subprocess
    try:
        result = subprocess.run(
            ["docker", "ps"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode != 0:
            errors.append("Docker not accessible")
    except Exception as e:
        errors.append(f"Docker command failed: {e}")

    if errors:
        pytest.skip(f"Environment not ready: {'; '.join(errors)}")


# =============================================================================
# Helper Functions
# =============================================================================

def get_spec_files() -> list[Path]:
    """Get all spec files in the specs directory."""
    specs_dir = Path(__file__).parent / "specs"
    return sorted(specs_dir.glob("*.md"))


def get_spec_ids() -> list[str]:
    """Get IDs for parametrized tests."""
    return [f.stem for f in get_spec_files()]
