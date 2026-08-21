import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from managers.workspace_manager import WorkspaceManager


WEATHER_UPLOAD_SIZE_BYTES = 64_434_334


def _make_sparse_file(path: Path, size_bytes: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as file_handle:
        if size_bytes > 0:
            file_handle.seek(size_bytes - 1)
            file_handle.write(b"\0")
    return path


def test_copy_to_workspace_accepts_upload_larger_than_old_50mb_limit(tmp_path: Path):
    manager = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    source_path = _make_sparse_file(
        tmp_path / "uploads" / "weather_data.csv",
        WEATHER_UPLOAD_SIZE_BYTES,
    )

    copied_path = manager.copy_to_workspace(
        chat_id="chat-large-upload",
        source_path=str(source_path),
        target_name="weather_data.csv",
    )

    assert copied_path is not None
    copied_file = Path(copied_path)
    assert copied_file == tmp_path / "workspaces" / "chat-large-upload" / "weather_data.csv"
    assert copied_file.is_file()
    assert copied_file.stat().st_size == WEATHER_UPLOAD_SIZE_BYTES


def test_copy_to_workspace_rejects_files_over_500mb_limit(tmp_path: Path):
    manager = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    source_path = _make_sparse_file(
        tmp_path / "uploads" / "too-large.bin",
        manager.MAX_FILE_SIZE + 1,
    )

    copied_path = manager.copy_to_workspace(
        chat_id="chat-too-large",
        source_path=str(source_path),
        target_name="too-large.bin",
    )

    assert copied_path is None
    assert not (tmp_path / "workspaces" / "chat-too-large" / "too-large.bin").exists()


def test_copy_to_workspace_rejects_when_total_workspace_limit_would_be_exceeded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    manager = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    source_path = _make_sparse_file(tmp_path / "uploads" / "tiny.txt", 32)

    monkeypatch.setattr(
        manager,
        "_get_directory_size",
        lambda _path: manager.MAX_WORKSPACE_SIZE - 16,
    )

    copied_path = manager.copy_to_workspace(
        chat_id="chat-total-limit",
        source_path=str(source_path),
        target_name="tiny.txt",
    )

    assert copied_path is None
    assert not (tmp_path / "workspaces" / "chat-total-limit" / "tiny.txt").exists()


def test_auto_copy_files_to_workspace_stages_large_upload_for_vm_use(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    try:
        from filters.unified_context import Filter
    except ModuleNotFoundError as error:
        pytest.skip(f"unified_context import unavailable: {error}")

    uploads_dir = tmp_path / "uploads"
    source_path = _make_sparse_file(
        uploads_dir / "upload-123_weather_data.csv",
        WEATHER_UPLOAD_SIZE_BYTES,
    )
    manager = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    filter_obj = Filter.__new__(Filter)
    filter_obj.OWUI_UPLOAD_DIR = str(uploads_dir)

    monkeypatch.setattr("filters.unified_context.WORKSPACE_MANAGER_AVAILABLE", True)
    monkeypatch.setattr("filters.unified_context.get_workspace_manager", lambda: manager)

    copied_files = Filter._auto_copy_files_to_workspace(
        filter_obj,
        chat_id="chat-with-vm",
        files=[
            {
                "type": "file",
                "id": "upload-123",
                "name": "weather_data.csv",
                "size": WEATHER_UPLOAD_SIZE_BYTES,
                "content_type": "text/csv",
            }
        ],
        vm_id="vm-1",
    )

    assert len(copied_files) == 1
    assert copied_files[0]["name"] == "weather_data.csv"
    assert copied_files[0]["workspace_path"] == "weather_data.csv"
    assert copied_files[0]["size"] == WEATHER_UPLOAD_SIZE_BYTES

    chat_file = tmp_path / "workspaces" / "chat-with-vm" / "weather_data.csv"
    vm_file = tmp_path / "workspaces" / "chat-with-vm" / "vm-1" / "weather_data.csv"
    assert chat_file.is_file()
    assert chat_file.stat().st_size == WEATHER_UPLOAD_SIZE_BYTES
    assert not vm_file.exists()


def test_list_files_treats_vm_named_directories_as_shared_workspace_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manager = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    chat_root = Path(manager.ensure_workspace("chat-private"))
    (chat_root / "visible").mkdir(parents=True)
    (chat_root / "visible" / "note.txt").write_text("shared")
    (chat_root / "vm-private").mkdir(parents=True)
    (chat_root / "vm-private" / "secret.txt").write_text("private")

    monkeypatch.setattr(manager, "_live_vm_ids_for_chat", lambda _chat_id: {"vm-private"})

    listed = manager.list_files("chat-private", recursive=False)
    assert [entry.name for entry in listed] == ["visible", "vm-private"]

    private_entries = manager.list_files("chat-private", path="vm-private")
    assert [entry.name for entry in private_entries] == ["secret.txt"]


def test_shared_workspace_explicit_vm_named_paths_are_allowed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    manager = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    monkeypatch.setattr(manager, "_live_vm_ids_for_chat", lambda _chat_id: {"vm-private"})

    written_path = manager.write_to_workspace(
        chat_id="chat-private",
        path="vm-private/allowed.txt",
        content=b"ok",
    )
    assert written_path is not None

    assert manager.get_file_path(
        chat_id="chat-private",
        path="vm-private/allowed.txt",
    ) == written_path


def test_copy_to_workspace_allows_vm_named_shared_workspace_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    manager = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    source_path = _make_sparse_file(tmp_path / "uploads" / "tiny.txt", 8)
    monkeypatch.setattr(manager, "_live_vm_ids_for_chat", lambda _chat_id: {"vm-private"})

    copied_path = manager.copy_to_workspace(
        chat_id="chat-private",
        source_path=str(source_path),
        target_path="vm-private/tiny.txt",
    )

    assert copied_path is not None
    assert (tmp_path / "workspaces" / "chat-private" / "vm-private" / "tiny.txt").is_file()
