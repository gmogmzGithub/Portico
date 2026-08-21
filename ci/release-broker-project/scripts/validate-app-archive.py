#!/usr/bin/env python3
"""Reject unsafe ZIP paths and escaping symlinks before macOS extraction."""

from __future__ import annotations

import argparse
import os
import posixpath
import stat
import zipfile
from pathlib import Path, PurePosixPath


def fail(message: str) -> None:
    raise SystemExit(f"Error: {message}")


def safe_name(name: str) -> str:
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        fail(f"unsafe archive path: {name!r}")
    trimmed = name[:-1] if name.endswith("/") else name
    path = PurePosixPath(trimmed)
    if str(path) != trimmed or any(part in {"", ".", ".."} for part in path.parts):
        fail(f"unsafe archive traversal path: {name!r}")
    return trimmed


def validate_zip(path: Path) -> None:
    if not path.is_file() or path.is_symlink():
        fail(f"app archive is not a regular file: {path}")
    seen: set[str] = set()
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            name = safe_name(info.filename)
            folded = name.casefold()
            if folded in seen:
                fail(f"duplicate or case-colliding archive path: {name}")
            seen.add(folded)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                target = archive.read(info).decode("utf-8")
                if not target or os.path.isabs(target):
                    fail(f"unsafe archive symlink: {name}")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if resolved == ".." or resolved.startswith("../") or resolved.startswith("/"):
                    fail(f"archive symlink escapes app root: {name}")


def validate_tree(root: Path) -> None:
    resolved_root = root.resolve(strict=True)
    for path in resolved_root.rglob("*"):
        if path.is_symlink():
            try:
                path.resolve(strict=True).relative_to(resolved_root)
            except (FileNotFoundError, RuntimeError, ValueError) as error:
                fail(f"extracted symlink escapes or is broken: {path.relative_to(resolved_root)} ({error})")


parser = argparse.ArgumentParser()
group = parser.add_mutually_exclusive_group(required=True)
group.add_argument("--archive", type=Path)
group.add_argument("--tree", type=Path)
args = parser.parse_args()
if args.archive:
    validate_zip(args.archive)
else:
    validate_tree(args.tree)

