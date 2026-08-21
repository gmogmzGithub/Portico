import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from src.managers.agent_vm_manager import AgentVMManager, ExecResult


def _build_manager():
    return AgentVMManager.__new__(AgentVMManager)


def test_copy_to_workspace_targets_shared_workspace_mount():
    manager = _build_manager()
    calls = []

    def fake_execute_bash(vm_id, command):
        calls.append((vm_id, command))
        return ExecResult(success=True, exit_code=0, stdout="", stderr="")

    manager.execute_bash = fake_execute_bash

    assert manager.copy_to_workspace(
        "vm-1",
        "/work/report.pdf",
        "report.pdf",
    )
    assert calls == [("vm-1", "cp -r /work/report.pdf /work/report.pdf")]


def test_copy_from_workspace_targets_shared_workspace_mount():
    manager = _build_manager()
    calls = []

    def fake_execute_bash(vm_id, command):
        calls.append((vm_id, command))
        return ExecResult(success=True, exit_code=0, stdout="", stderr="")

    manager.execute_bash = fake_execute_bash

    assert manager.copy_from_workspace(
        "vm-1",
        "source.txt",
        "/work/source.txt",
    )
    assert calls == [("vm-1", "cp -r /work/source.txt /work/source.txt")]


def test_copy_to_workspace_quotes_shell_paths():
    manager = _build_manager()
    commands = []

    def fake_execute_bash(vm_id, command):
        commands.append((vm_id, command))
        return ExecResult(success=True, exit_code=0, stdout="", stderr="")

    manager.execute_bash = fake_execute_bash

    assert manager.copy_to_workspace(
        "vm-1",
        "report final.pdf",
        "reports/report final.pdf",
    )
    assert commands == [
        (
            "vm-1",
                "cp -r '/work/report final.pdf' '/work/reports/report final.pdf'",
        )
    ]
