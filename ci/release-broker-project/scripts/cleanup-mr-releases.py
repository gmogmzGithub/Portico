#!/usr/bin/env python3
"""Delete expired MR Cloudsmith releases, then their MR-specific Harbor tags."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass


PACKAGE_RE = re.compile(r"^portico_mr-([1-9][0-9]*)$")
VERSION_RE = re.compile(r"^[0-9]{8}-([a-f0-9]{8})$")
IMAGE_NAMES = (
    "agent-vm", "bifrost-bridge", "chat-state-api", "health-check",
    "mcp-orc-rust", "mcpo-control-plane-rust", "open-webui-patched",
)


class CleanupError(RuntimeError):
    pass


@dataclass(frozen=True)
class Package:
    name: str
    version: str
    slug: str
    filename: str
    uploaded_at: dt.datetime
    iid: int


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise CleanupError(f"missing required environment variable: {name}")
    return value


def parse_timestamp(value: object, label: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise CleanupError(f"{label} is missing a timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CleanupError(f"{label} has an invalid timestamp") from error
    if parsed.tzinfo is None:
        raise CleanupError(f"{label} timestamp must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def command_json(command: list[str]) -> object:
    completed = subprocess.run(command, check=False, text=True, capture_output=True)
    if completed.returncode != 0:
        raise CleanupError(f"command failed without applying cleanup: {command[0]}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise CleanupError(f"command returned invalid JSON: {command[0]}") from error


def list_packages(owner: str, repository: str) -> list[Package]:
    payload = command_json([
        "cloudsmith", "list", "packages", f"{owner}/{repository}",
        "-q", "format:raw", "-F", "json",
    ])
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise CleanupError("Cloudsmith package list has an unexpected shape")
    packages: list[Package] = []
    for row in rows:
        if not isinstance(row, dict):
            raise CleanupError("Cloudsmith package list contains a non-object")
        name = row.get("name")
        match = PACKAGE_RE.fullmatch(name) if isinstance(name, str) else None
        if not match:
            continue
        version = row.get("version")
        slug = row.get("slug")
        filename = row.get("filename")
        if not all(isinstance(value, str) and value for value in (version, slug, filename)):
            raise CleanupError(f"Cloudsmith MR package has incomplete identity: {name}")
        if not VERSION_RE.fullmatch(version):
            raise CleanupError(f"Cloudsmith MR package has invalid version: {name}@{version}")
        if filename != f"{name}-{version}.zip":
            raise CleanupError(f"Cloudsmith MR package filename mismatch: {filename}")
        packages.append(Package(
            name=name,
            version=version,
            slug=slug,
            filename=filename,
            uploaded_at=parse_timestamp(row.get("uploaded_at") or row.get("created_at"), slug),
            iid=int(match.group(1)),
        ))
    return packages


def gitlab_mr(project_id: str, iid: int) -> dict[str, object]:
    api = require_env("CI_API_V4_URL")
    token = require_env("CI_JOB_TOKEN")
    request = urllib.request.Request(
        f"{api}/projects/{project_id}/merge_requests/{iid}",
        headers={"JOB-TOKEN": token},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise CleanupError(f"unable to resolve merge request !{iid}") from error
    if not isinstance(payload, dict) or payload.get("iid") != iid:
        raise CleanupError(f"GitLab returned an invalid merge request response for !{iid}")
    return payload


def resolve_image_tag(registry: str, package: Package) -> str:
    short_sha = VERSION_RE.fullmatch(package.version).group(1)  # validated earlier
    prefix = f"mr-{package.iid}-{short_sha}"
    resolved: set[str] = set()
    for image in IMAGE_NAMES:
        completed = subprocess.run(
            ["krane", "ls", f"{registry}/{image}"],
            check=False,
            text=True,
            capture_output=True,
        )
        if completed.returncode != 0:
            raise CleanupError(f"unable to enumerate Harbor tags for {image}")
        matches = sorted(
            tag for tag in completed.stdout.splitlines()
            if re.fullmatch(re.escape(prefix) + r"[a-f0-9]{32}", tag)
        )
        if len(matches) != 1:
            raise CleanupError(
                f"expected one Harbor tag for {package.name}@{package.version} in {image}"
            )
        resolved.add(matches[0])
    if len(resolved) != 1:
        raise CleanupError(f"Harbor tag identity differs across images for {package.slug}")
    return next(iter(resolved))


def select_deletion_candidates(
    packages: list[Package],
    cutoff: dt.datetime,
    mr_lookup=gitlab_mr,
) -> list[Package]:
    grouped: dict[int, list[Package]] = {}
    for package in packages:
        grouped.setdefault(package.iid, []).append(package)

    candidates: list[Package] = []
    for iid, group in sorted(grouped.items()):
        mr = mr_lookup(iid)
        state = mr.get("state")
        ordered = sorted(group, key=lambda package: package.uploaded_at, reverse=True)
        if state == "opened":
            candidates.extend(package for package in ordered[1:] if package.uploaded_at <= cutoff)
        elif state in {"closed", "merged"}:
            closed_at = parse_timestamp(mr.get("merged_at") or mr.get("closed_at"), f"MR !{iid}")
            if closed_at <= cutoff:
                candidates.extend(ordered)
        else:
            raise CleanupError(f"merge request !{iid} has unsupported state: {state!r}")
    return candidates


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--retention-days", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.retention_days <= 0:
        raise CleanupError("retention days must be positive")

    project_id = require_env("portico_SOURCE_PROJECT_ID")
    owner = os.environ.get("CLOUDSMITH_OWNER", "portico")
    repository = os.environ.get("CLOUDSMITH_REPO", "portico")
    registry = os.environ.get("portico_RUNTIME_IMAGE_REGISTRY", "harbor.example.invalid/portico")
    require_env("CLOUDSMITH_API_KEY")
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.retention_days)
    packages = list_packages(owner, repository)
    deletion_candidates = select_deletion_candidates(
        packages,
        cutoff,
        mr_lookup=lambda iid: gitlab_mr(project_id, iid),
    )

    # Resolve every Harbor reference before deleting anything. Any ambiguity aborts
    # the entire run and preserves both Cloudsmith and Harbor state.
    plan = [(package, resolve_image_tag(registry, package)) for package in deletion_candidates]
    if not plan:
        print("No expired MR releases require cleanup.")
        return

    for package, tag in plan:
        print(f"Cleanup candidate: {package.name}@{package.version} -> {tag}")
    if args.dry_run:
        return

    deleted_tags: set[str] = set()
    for package, tag in plan:
        completed = subprocess.run(
            ["cloudsmith", "delete", f"{owner}/{repository}/{package.slug}", "-y"],
            check=False,
        )
        if completed.returncode != 0:
            raise CleanupError("Cloudsmith deletion failed; no Harbor tag was deleted for that package")
        if tag in deleted_tags:
            continue
        for image in IMAGE_NAMES:
            completed = subprocess.run(
                ["krane", "delete", f"{registry}/{image}:{tag}"],
                check=False,
            )
            if completed.returncode != 0:
                raise CleanupError(f"Harbor deletion failed after Cloudsmith cleanup for {image}:{tag}")
        deleted_tags.add(tag)
    print(f"Deleted {len(plan)} expired MR releases and {len(deleted_tags)} runtime image sets.")


if __name__ == "__main__":
    try:
        main()
    except CleanupError as error:
        raise SystemExit(f"Error: {error}")
