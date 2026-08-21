from __future__ import annotations

import json
from typing import Any


CODE_EXECUTION_SKILL_ID = "code-execution"
AGENT_VM_TOOL_ID = "server:agent-vm"


def _coerce_id_list(raw_ids: Any) -> list[str]:
    if raw_ids is None:
        return []

    if isinstance(raw_ids, str):
        stripped = raw_ids.strip()
        if not stripped:
            return []
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except Exception:
                return [stripped]
            return _coerce_id_list(parsed)
        return [stripped]

    if isinstance(raw_ids, (list, tuple, set)):
        normalized: list[str] = []
        for item in raw_ids:
            if not isinstance(item, str):
                continue
            stripped = item.strip()
            if stripped:
                normalized.append(stripped)
        return normalized

    return []


def maybe_add_code_execution_to_subagent(
    *,
    skill_ids: list[str] | None,
    tool_server_ids: list[str] | None,
    max_skill_ids: int = 4,
) -> tuple[list[str], list[str], bool]:
    normalized_skill_ids = _coerce_id_list(skill_ids)
    normalized_tool_ids = _coerce_id_list(tool_server_ids)
    changed = False

    if AGENT_VM_TOOL_ID not in normalized_tool_ids:
        normalized_tool_ids.append(AGENT_VM_TOOL_ID)
        changed = True

    if (
        CODE_EXECUTION_SKILL_ID not in normalized_skill_ids
        and len(normalized_skill_ids) < max_skill_ids
    ):
        normalized_skill_ids.append(CODE_EXECUTION_SKILL_ID)
        changed = True

    return normalized_skill_ids, normalized_tool_ids, changed
