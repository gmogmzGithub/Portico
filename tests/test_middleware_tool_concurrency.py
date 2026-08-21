import ast
import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)


def _load_concurrency_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_positive_int_from_env",
        "GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT",
    }
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in wanted_names:
                    selected_nodes.append(node)
                    break
        elif isinstance(node, ast.FunctionDef) and node.name in wanted_names:
            selected_nodes.append(node)

    module = ast.Module(body=selected_nodes, type_ignores=[])
    namespace = {"os": os}
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace


def test_global_tool_execution_concurrency_limit_defaults_to_100(monkeypatch):
    monkeypatch.delenv("OPENWEBUI_GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT", raising=False)

    helpers = _load_concurrency_helpers()

    assert helpers["GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT"] == 100


def test_global_tool_execution_concurrency_limit_ignores_invalid_values(monkeypatch):
    monkeypatch.setenv("OPENWEBUI_GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT", "bad")
    helpers = _load_concurrency_helpers()
    assert helpers["GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT"] == 100

    monkeypatch.setenv("OPENWEBUI_GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT", "0")
    helpers = _load_concurrency_helpers()
    assert helpers["GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT"] == 100


def test_middleware_uses_shared_concurrency_limit_for_both_tool_paths():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")

    assert "asyncio.Semaphore(\n                GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT\n            )" in source
    assert source.count("GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT") >= 3
    assert "asyncio.Semaphore(10)" not in source
