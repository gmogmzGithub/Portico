from __future__ import annotations

import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "tests" / "integration" / "run_tests.sh"
AGENT_RUNNER = REPO_ROOT / "tests" / "integration" / "framework" / "agent_runner.py"


def _write_fake_docker(tmp_path: Path) -> Path:
    docker_path = tmp_path / "docker"
    docker_path.write_text(
        """#!/bin/sh
cmd="$1"
shift
case "$cmd" in
  inspect)
    if [ -n "${TEST_DOCKER_INSPECT_OUTPUT:-}" ]; then
      printf '%s\\n' "$TEST_DOCKER_INSPECT_OUTPUT"
    fi
    exit "${TEST_DOCKER_INSPECT_STATUS:-0}"
    ;;
  port)
    if [ -n "${TEST_DOCKER_PORT_OUTPUT:-}" ]; then
      printf '%s\\n' "$TEST_DOCKER_PORT_OUTPUT"
    fi
    exit "${TEST_DOCKER_PORT_STATUS:-0}"
    ;;
  *)
    exit 1
    ;;
esac
""",
        encoding="utf-8",
    )
    docker_path.chmod(0o755)
    return docker_path


def _resolve_redis_endpoint(tmp_path: Path, *, env_updates: dict[str, str | None] | None = None) -> str:
    _write_fake_docker(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{tmp_path}:{env['PATH']}"
    if env_updates:
        for key, value in env_updates.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
    command = (
        f'source "{RUNNER}" >/dev/null 2>&1; '
        'REDIS_HOST="${REDIS_HOST:-}"; '
        'REDIS_PORT="${REDIS_PORT:-6379}"; '
        'resolve_redis_connection; '
        'printf "%s:%s" "$REDIS_HOST" "$REDIS_PORT"'
    )
    result = subprocess.run(
        ["bash", "-c", command],
        cwd=REPO_ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def test_integration_runner_preserves_explicit_redis_override(tmp_path: Path) -> None:
    endpoint = _resolve_redis_endpoint(
        tmp_path,
        env_updates={
            "REDIS_HOST": "10.0.0.9",
            "REDIS_PORT": "6380",
            "TEST_DOCKER_INSPECT_OUTPUT": "192.168.97.3",
        },
    )

    assert endpoint == "10.0.0.9:6380"


def test_integration_runner_discovers_live_redis_container_ip(tmp_path: Path) -> None:
    endpoint = _resolve_redis_endpoint(
        tmp_path,
        env_updates={
            "REDIS_HOST": None,
            "REDIS_PORT": None,
            "TEST_DOCKER_INSPECT_OUTPUT": "192.168.97.3",
            "TEST_DOCKER_INSPECT_STATUS": "0",
            "TEST_DOCKER_PORT_OUTPUT": "",
        },
    )

    assert endpoint == "192.168.97.3:6379"


def test_integration_runner_falls_back_to_published_redis_port(tmp_path: Path) -> None:
    endpoint = _resolve_redis_endpoint(
        tmp_path,
        env_updates={
            "REDIS_HOST": None,
            "REDIS_PORT": None,
            "TEST_DOCKER_INSPECT_OUTPUT": "",
            "TEST_DOCKER_INSPECT_STATUS": "1",
            "TEST_DOCKER_PORT_OUTPUT": "0.0.0.0:6381",
            "TEST_DOCKER_PORT_STATUS": "0",
        },
    )

    assert endpoint == "127.0.0.1:6381"


def test_agentic_integration_runner_enforces_declared_spec_timeout() -> None:
    source = AGENT_RUNNER.read_text(encoding="utf-8")

    assert "await asyncio.wait_for(" in source
    assert "timeout=self.spec.timeout" in source
    assert "except asyncio.TimeoutError:" in source
    assert "exceeded its declared" in source
