#!/usr/bin/env python3
"""Create and validate the credential-free MR release staging contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath


SCHEMA_VERSION = 1
SHA_RE = re.compile(r"^[a-f0-9]{40}$")
PROJECT_PATH_RE = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$")
CHANNEL_RE = re.compile(r"^mr-([1-9][0-9]*)$")
IMAGE_TAG_RE = re.compile(r"^mr-([1-9][0-9]*)-([a-f0-9]{40})$")
BUILD_RE = re.compile(r"^[0-9]{8}-[a-f0-9]{8}$")
PLACEHOLDER = "mr-preview-disabled"


class ContractError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_relative_path(value: str, label: str) -> str:
    candidate = PurePosixPath(value)
    if not value or candidate.is_absolute() or str(candidate) != value:
        raise ContractError(f"{label} must be a normalized relative path")
    if any(part in {"", ".", ".."} for part in candidate.parts):
        raise ContractError(f"{label} contains an unsafe path component")
    return value


def sha256_tree(root: Path) -> str:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ContractError(f"tree input is not a directory: {root}")

    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        validate_relative_path(relative, "tree entry")
        metadata = path.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        if stat.S_ISLNK(metadata.st_mode):
            target = os.readlink(path)
            if not target or os.path.isabs(target):
                raise ContractError(f"tree symlink has unsafe target: {relative}")
            resolved = (path.parent / target).resolve(strict=False)
            try:
                resolved.relative_to(root)
            except ValueError as error:
                raise ContractError(f"tree symlink escapes staging root: {relative}") from error
            entry_type = "symlink"
            payload = target.encode("utf-8")
        elif stat.S_ISDIR(metadata.st_mode):
            entry_type = "directory"
            payload = b""
        elif stat.S_ISREG(metadata.st_mode):
            entry_type = "file"
            payload = bytes.fromhex(sha256_file(path))
        else:
            raise ContractError(f"tree contains unsupported filesystem entry: {relative}")

        digest.update(f"{entry_type}\0{mode:o}\0{relative}\0".encode("utf-8"))
        digest.update(payload)
        digest.update(b"\0")
    return digest.hexdigest()


def expected_contract(args: argparse.Namespace, root: Path) -> dict[str, object]:
    channel = f"mr-{args.mr_iid}"
    package = f"portico_{channel}"
    image_tag = f"{channel}-{args.source_revision}"
    app_paths = {
        "darwin-arm64": "apps/darwin-arm64/Portico.app.zip",
        "darwin-x64": "apps/darwin-x64/Portico.app.zip",
    }
    apps: dict[str, object] = {}
    for architecture, relative in app_paths.items():
        path = root / relative
        if not path.is_file() or path.is_symlink():
            raise ContractError(f"missing staged app archive: {relative}")
        apps[architecture] = {"archive": relative, "sha256": sha256_file(path)}

    managed_relative = "managed-root"
    host_relative = "host-mcp-binaries"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceProject": {"id": args.project_id, "path": args.project_path},
        "mergeRequest": {"iid": args.mr_iid, "targetBranch": args.target_branch},
        "sourceRevision": args.source_revision,
        "channel": channel,
        "channelPackageName": package,
        "buildNumber": args.build_number,
        "releaseTimestamp": args.release_timestamp,
        "runtimeImageTag": image_tag,
        "apps": apps,
        "managedRoot": {
            "path": managed_relative,
            "sha256": sha256_tree(root / managed_relative),
        },
        "hostMcpBinaries": {
            "path": host_relative,
            "sha256": sha256_tree(root / host_relative),
            "sourceRevision": args.source_revision,
        },
    }


def validate_arguments(args: argparse.Namespace) -> None:
    if args.project_id <= 0:
        raise ContractError("project id must be positive")
    if not PROJECT_PATH_RE.fullmatch(args.project_path):
        raise ContractError("project path is invalid")
    if args.mr_iid <= 0:
        raise ContractError("merge request iid must be positive")
    if not SHA_RE.fullmatch(args.source_revision):
        raise ContractError("source revision must be a full lowercase git SHA")
    if not BUILD_RE.fullmatch(args.build_number):
        raise ContractError("build number must be MMDDYYYY-<8 lowercase hex>")
    if args.build_number.split("-", 1)[1] != args.source_revision[:8]:
        raise ContractError("build number does not match source revision")
    if not args.target_branch or "\x00" in args.target_branch:
        raise ContractError("target branch is invalid")


def validate_shape(value: object) -> None:
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion", "sourceProject", "mergeRequest", "sourceRevision",
        "channel", "channelPackageName", "buildNumber", "releaseTimestamp",
        "runtimeImageTag", "apps", "managedRoot", "hostMcpBinaries",
    }:
        raise ContractError("MR release input contains unexpected fields")
    if value.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError("MR release input schemaVersion must be 1")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--project-id", type=int, required=True)
    parser.add_argument("--project-path", required=True)
    parser.add_argument("--mr-iid", type=int, required=True)
    parser.add_argument("--target-branch", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--build-number", required=True)
    parser.add_argument("--release-timestamp", required=True)
    parser.add_argument("--validate", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    validate_arguments(args)
    root = args.root.resolve(strict=True)
    expected = expected_contract(args, root)
    if args.validate:
        try:
            actual = json.loads(args.output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ContractError(f"unable to read MR release input: {error}") from error
        validate_shape(actual)
        if actual != expected:
            raise ContractError("MR release input does not match staged content or expected identity")
        print(f"Validated MR release input for {expected['channel']}.")
        return

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(f".{args.output.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(args.output)
    print(f"Wrote MR release input: {args.output}")


if __name__ == "__main__":
    try:
        main()
    except ContractError as error:
        raise SystemExit(f"Error: {error}")
