import json
import logging
from typing import Any
from uuid import uuid4


log = logging.getLogger(__name__)


def get_tool_argument_schema(tool_spec):
    if not isinstance(tool_spec, dict):
        return None

    parameters = tool_spec.get("parameters")
    if isinstance(parameters, dict):
        return parameters

    input_schema = tool_spec.get("inputSchema")
    if isinstance(input_schema, dict):
        return input_schema

    return None


def tool_spec_accepts_empty_arguments(tool_spec):
    schema = get_tool_argument_schema(tool_spec)
    if not isinstance(schema, dict):
        return False

    schema_type = schema.get("type")
    if schema_type not in (None, "object"):
        return False

    required = schema.get("required")
    if required is None:
        required = []
    if not isinstance(required, list):
        return False

    return len([name for name in required if isinstance(name, str) and name]) == 0


def normalize_blank_tool_call_arguments(raw_arguments, tool_spec):
    if raw_arguments is None:
        raw_arguments = ""
    if not isinstance(raw_arguments, str):
        raw_arguments = str(raw_arguments)

    if raw_arguments.strip() in {"", "null"} and tool_spec_accepts_empty_arguments(
        tool_spec
    ):
        return "{}", True

    return raw_arguments, False


def split_concatenated_json_objects(text):
    if not text or not isinstance(text, str):
        return None
    try:
        json.loads(text)
        return None
    except Exception:
        pass

    segments = []
    depth = 0
    in_string = False
    escape = False
    start = None

    for idx, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            continue

        if ch == "{":
            if depth == 0:
                start = idx
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    segments.append((start, idx + 1))
                    start = None

    if depth != 0 or not segments:
        return None
    if len(segments) <= 1:
        return None

    prev_end = 0
    for seg_start, seg_end in segments:
        if any(not c.isspace() for c in text[prev_end:seg_start]):
            return None
        prev_end = seg_end
    if any(not c.isspace() for c in text[prev_end:]):
        return None

    objects = []
    for seg_start, seg_end in segments:
        segment = text[seg_start:seg_end]
        try:
            json.loads(segment)
        except Exception:
            return None
        objects.append(segment)
    return objects


def normalize_tool_calls_for_execution(tool_calls_list, model_name):
    if not tool_calls_list:
        return tool_calls_list

    normalized = []
    max_index = -1
    for tool_call in tool_calls_list:
        idx = tool_call.get("index")
        if isinstance(idx, int) and idx > max_index:
            max_index = idx

    for tool_call in tool_calls_list:
        args = tool_call.get("function", {}).get("arguments", "")
        if not isinstance(args, str):
            args = str(args)
        split_args = split_concatenated_json_objects(args)
        if not split_args:
            normalized.append(tool_call)
            continue

        log.warning(
            "[TOOL-CALL] model=%s splitting concatenated tool arguments into %d calls (tool=%s id=%s)",
            model_name,
            len(split_args),
            tool_call.get("function", {}).get("name"),
            tool_call.get("id"),
        )

        base_id = tool_call.get("id") or ""
        for part_index, part in enumerate(split_args):
            new_call = {
                **tool_call,
                "function": {
                    **tool_call.get("function", {}),
                    "arguments": part,
                },
            }
            if part_index > 0 or not base_id:
                new_call["id"] = (
                    f"{base_id}-part{part_index + 1}"
                    if base_id
                    else f"split-{uuid4()}"
                )
            if tool_call.get("index") is not None:
                if part_index == 0:
                    new_call["index"] = tool_call.get("index")
                else:
                    max_index += 1
                    new_call["index"] = max_index
            normalized.append(new_call)

    return normalized


def get_required_tool_arguments(tool_spec):
    parameters = get_tool_argument_schema(tool_spec)
    if not isinstance(parameters, dict):
        return []

    required = parameters.get("required")
    if not isinstance(required, list):
        return []

    return [name for name in required if isinstance(name, str) and name]


def get_missing_required_tool_arguments(tool_spec, tool_params):
    if not isinstance(tool_params, dict):
        tool_params = {}

    missing = []
    for name in get_required_tool_arguments(tool_spec):
        if name not in tool_params:
            missing.append(name)
            continue

        value = tool_params.get(name)
        if value is None:
            missing.append(name)
            continue

        if isinstance(value, str) and not value.strip():
            missing.append(name)

    return missing


def is_tool_call_only_delta(delta: Any) -> bool:
    if not isinstance(delta, dict):
        return False

    delta_tool_calls = delta.get("tool_calls")
    if not delta_tool_calls:
        return False

    for key, value in delta.items():
        if key == "tool_calls":
            continue
        if key in {"role"}:
            continue
        if value in (None, "", [], {}):
            continue
        return False

    return True


def build_tool_call_preview_content(tool_calls_list):
    preview_calls = []
    for tool_call in tool_calls_list or []:
        function = tool_call.get("function", {}) or {}
        preview_calls.append(
            {
                "id": tool_call.get("id"),
                "index": tool_call.get("index"),
                "type": tool_call.get("type", "function"),
                "function": {
                    "name": function.get("name", ""),
                    "arguments": function.get("arguments", ""),
                },
            }
        )
    return preview_calls


def tool_calls_ready_for_preview(tool_calls_list, tools=None):
    if not tool_calls_list:
        return False

    for tool_call in tool_calls_list:
        function = tool_call.get("function", {}) or {}
        name = function.get("name", "")
        arguments = function.get("arguments", "")
        tool_spec = None
        if isinstance(tools, dict):
            tool_entry = tools.get(name)
            if isinstance(tool_entry, dict):
                tool_spec = tool_entry.get("spec", {})

        arguments, _ = normalize_blank_tool_call_arguments(arguments, tool_spec)

        if not name or not arguments.strip():
            return False

        try:
            json.loads(arguments)
        except Exception:
            return False

    return True


def get_tool_call_summary_label(streaming_preview: bool) -> str:
    return "Preparing..." if streaming_preview else "Executing..."
