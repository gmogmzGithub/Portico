"""Shared Agent VM image-resolution helpers."""

from __future__ import annotations

import json
import os
from typing import Iterable, Optional

AGENT_VM_IMAGE_NAME = "agent-vm"


def extract_build_number(build_info_paths: Iterable[str]) -> Optional[str]:
    """Read the Electron build number if available."""
    for build_info_path in build_info_paths:
        if not os.path.exists(build_info_path):
            continue
        try:
            with open(build_info_path, "r", encoding="utf-8") as handle:
                build_info = json.load(handle)
            build_number = build_info.get("buildNumber")
            if build_number and build_number not in {"dev-build", "null"}:
                return build_number
        except (OSError, json.JSONDecodeError):
            continue
    return None


def build_info_to_agent_vm_image_refs(
    build_number: Optional[str],
    harbor_registry: str,
    harbor_project: str,
    image_name: str = AGENT_VM_IMAGE_NAME,
) -> list[str]:
    """Return candidate image refs for the single published Agent VM image."""
    refs: list[str] = []

    if build_number:
        refs.append(f"{harbor_registry}/{harbor_project}/{image_name}:{build_number}")

    refs.append(f"{image_name}:latest")
    return refs


def get_agent_vm_local_build_command(image_name: str = AGENT_VM_IMAGE_NAME) -> str:
    """Return the local docker build command for the Agent VM image."""
    return f"docker build -f Dockerfile.agent-vm -t {image_name}:latest ."
