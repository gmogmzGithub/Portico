import ast
import asyncio
import copy
import json
import re
import urllib.parse
from pathlib import Path
from typing import Any, Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"


class _HTMLResponse:
    pass


async def _passthrough_spill(**kwargs):
    return kwargs.get("tool_result")


def _load_tool_result_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_is_get_skill_assets_tool_name",
        "_sanitize_skill_asset_tool_result_for_model",
        "_is_displayable_image_tool_file",
        "_inline_image_file_count",
        "_is_chrome_devtools_screenshot_tool",
        "_parse_tool_result_for_enrichment",
        "_render_tool_result_enrichment",
        "_build_tool_result_inline_image_metadata",
        "_extract_saved_screenshot_host_path",
        "_enrich_chrome_screenshot_file_path_result",
        "_enrich_tool_result_for_inline_image_files",
        "_tool_name_for_call_id",
        "_is_agent_vm_workspace_file_tool_name",
        "_tool_result_payload",
        "_agent_vm_display_file_attachment",
        "_iter_agent_vm_display_file_payloads",
        "_extract_agent_vm_display_file_attachments",
        "_display_files_tool_result_files_for_serialization",
        "_iter_agent_vm_request_image_payloads",
        "_extract_agent_vm_request_image_urls_from_result",
        "_collect_agent_vm_request_image_urls",
        "_build_agent_vm_request_images_followup_message",
        "_build_agent_vm_request_images_unavailable_message",
        "_model_supports_vision",
        "_tool_result_content_for_model_replay",
        "_workspace_image_url_belongs_to_chat",
        "_collect_workspace_inline_image_urls",
        "_inline_tool_workspace_image_urls",
        "_strip_markdown_images_for_urls",
        "_dedupe_inline_tool_image_markdown",
        "_tool_file_identity",
        "_merge_distinct_tool_files",
        "_collect_content_block_tool_result_files",
        "process_tool_result",
    }
    wanted_assigns = {
        "_SKILL_ASSET_MARKDOWN_DATA_IMAGE_RE",
        "_SKILL_ASSET_DATA_IMAGE_RE",
    }
    selected_nodes = []
    for node in tree.body:
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name in wanted_names
        ):
            selected_nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {
                target.id
                for target in node.targets
                if isinstance(target, ast.Name)
            }
            if names & wanted_assigns:
                selected_nodes.append(node)

    module = ast.Module(body=selected_nodes, type_ignores=[])
    namespace = {
        "Any": Any,
        "Optional": Optional,
        "HTMLResponse": _HTMLResponse,
        "copy": copy,
        "json": json,
        "re": re,
        "urllib": __import__("urllib"),
        "_normalize_server_id": lambda value: str(value or "").strip(),
        "_load_server_metadata": lambda _server_id: {},
        "get_file_url_from_base64": (
            lambda _request, _data_url, _metadata, _user: "http://files.local/extracted.png"
        ),
        "_maybe_spill_large_tool_result": _passthrough_spill,
    }
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_tool_result_helpers()
process_tool_result = HELPERS["process_tool_result"]
dedupe_inline_tool_image_markdown = HELPERS["_dedupe_inline_tool_image_markdown"]
_tool_result_content_for_model_replay = HELPERS["_tool_result_content_for_model_replay"]
_collect_content_block_tool_result_files = HELPERS["_collect_content_block_tool_result_files"]
_display_files_tool_result_files_for_serialization = HELPERS[
    "_display_files_tool_result_files_for_serialization"
]
_collect_workspace_inline_image_urls = HELPERS[
    "_collect_workspace_inline_image_urls"
]


def test_get_skill_assets_tool_result_removes_model_visible_base64():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="skills_get_skill_assets",
            tool_type="mcp",
            tool_result=[
                {
                    "type": "image",
                    "mimeType": "image/png",
                    "data": "ZmFrZSBwbmc=",
                },
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "success": True,
                            "download_url": (
                                "http://localhost:9876/workspace/chat-assets/"
                                "skill-assets/asset-skill/terminal.png"
                            ),
                            "markdown_image": "![terminal.png](data:image/png;base64,ZmFrZSBwbmc=)",
                            "nested": ["data:image/png;base64,AAAA"],
                        }
                    ),
                },
            ],
            metadata={"chat_id": "chat-assets"},
        )

    tool_text, files, embeds = asyncio.run(run())

    assert "data:image" not in tool_text
    assert "ZmFrZSBwbmc" not in tool_text
    assert (
        "http://localhost:9876/workspace/chat-assets/"
        "skill-assets/asset-skill/terminal.png"
    ) in tool_text
    assert files == [{"type": "image", "url": "http://files.local/extracted.png"}]
    assert embeds == []


def test_get_skill_assets_tool_result_preserves_url_markdown_image():
    markdown_image = (
        "![terminal.png](http://localhost:9876/workspace/chat-assets/"
        "skill-assets/asset-skill/terminal.png)"
    )

    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="get_skill_assets",
            tool_type="mcp",
            tool_result=[
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "success": True,
                            "markdown_image": markdown_image,
                        }
                    ),
                }
            ],
            metadata={"chat_id": "chat-assets"},
        )

    tool_text, files, embeds = asyncio.run(run())

    assert markdown_image in tool_text
    assert "data:image" not in tool_text
    assert files == []
    assert embeds == []


def test_mcp_image_attachment_enriches_model_visible_tool_text_without_base64():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="chart_tool",
            tool_type="mcp",
            tool_result=[
                {
                    "type": "image",
                    "mimeType": "image/png",
                    "data": "ZmFrZSBwbmc=",
                }
            ],
            metadata={"chat_id": "chat-images"},
        )

    tool_text, files, embeds = asyncio.run(run())
    payload = json.loads(tool_text)

    assert payload["inline_image_attached"] is True
    assert "inline_image_rendered" not in payload
    assert payload["inline_image_count"] == 1
    assert payload["message"] == "The image is attached for inline display in the chat."
    assert "data:image" not in tool_text
    assert "ZmFrZSBwbmc" not in tool_text
    assert files == [{"type": "image", "url": "http://files.local/extracted.png"}]
    assert embeds == []


def test_agent_vm_get_workspace_file_link_remains_link_only():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="agent_vm_get_workspace_file_link",
            tool_type="mcp",
            tool_result=[
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "success": True,
                            "file_name": "chart.png",
                            "file_path": "chart.png",
                            "mime_type": "image/png",
                            "is_image": True,
                            "download_url": "http://localhost:9876/workspace/chat-1/chart.png",
                        }
                    ),
                }
            ],
            metadata={"chat_id": "chat-1"},
            server_id="agent-vm",
        )

    tool_text, files, embeds = asyncio.run(run())
    payload = json.loads(tool_text)

    assert payload["success"] is True
    assert payload["is_image"] is True
    assert "inline_image_attached" not in payload
    assert files == []
    assert embeds == []


def test_agent_vm_display_files_attaches_chat_files_without_base64():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="agent_vm_display_files",
            tool_type="mcp",
            tool_result=[
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "success": True,
                            "display_files": True,
                            "files": [
                                {
                                    "file_name": "chart.png",
                                    "mime_type": "image/png",
                                    "is_image": True,
                                    "download_url": "http://localhost:9876/workspace/chat-1/chart.png",
                                },
                                {
                                    "file_name": "report.pdf",
                                    "mime_type": "application/pdf",
                                    "is_image": False,
                                    "download_url": "http://localhost:9876/workspace/chat-1/report.pdf",
                                },
                            ],
                        }
                    ),
                }
            ],
            metadata={"chat_id": "chat-1"},
            server_id="agent-vm",
        )

    tool_text, files, embeds = asyncio.run(run())
    payload = json.loads(tool_text)

    assert payload["inline_image_attached"] is True
    assert payload["inline_image_count"] == 1
    assert "data:image" not in tool_text
    assert "base64" not in tool_text
    assert files == [
        {
            "type": "image",
            "url": "http://localhost:9876/workspace/chat-1/chart.png",
            "name": "chart.png",
            "content_type": "image/png",
        },
        {
            "type": "file",
            "url": "http://localhost:9876/workspace/chat-1/report.pdf",
            "name": "report.pdf",
            "content_type": "application/pdf",
        },
    ]
    assert embeds == []


def test_agent_vm_display_files_attaches_chat_files_from_dict_result():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="agent_vm_display_files",
            tool_type="mcp",
            tool_result={
                "success": True,
                "display_files": True,
                "files": [
                    {
                        "file_name": "chart.png",
                        "mime_type": "image/png",
                        "is_image": True,
                        "browser_url": "http://localhost:9876/workspace/chat-1/chart.png",
                    }
                ],
            },
            metadata={"chat_id": "chat-1"},
            server_id="agent-vm",
        )

    tool_text, files, embeds = asyncio.run(run())
    payload = json.loads(tool_text)

    assert payload["inline_image_attached"] is True
    assert files == [
        {
            "type": "image",
            "url": "http://localhost:9876/workspace/chat-1/chart.png",
            "name": "chart.png",
            "content_type": "image/png",
        }
    ]
    assert embeds == []


def test_agent_vm_display_files_attaches_chat_files_from_json_string_result():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="agent_vm_display_files",
            tool_type="mcp",
            tool_result=json.dumps(
                {
                    "success": True,
                    "display_files": True,
                    "files": [
                        {
                            "file_name": "chart.png",
                            "mime_type": "image/png",
                            "is_image": True,
                            "download_url": "http://localhost:9876/workspace/chat-1/chart.png",
                        }
                    ],
                }
            ),
            metadata={"chat_id": "chat-1"},
            server_id="agent-vm",
        )

    tool_text, files, embeds = asyncio.run(run())
    payload = json.loads(tool_text)

    assert payload["inline_image_attached"] is True
    assert files == [
        {
            "type": "image",
            "url": "http://localhost:9876/workspace/chat-1/chart.png",
            "name": "chart.png",
            "content_type": "image/png",
        }
    ]
    assert embeds == []


def test_display_files_serialization_prefers_current_payload_over_cumulative_files():
    current_payload = json.dumps(
        {
            "success": True,
            "display_files": True,
            "files": [
                {
                    "file_name": "current.png",
                    "mime_type": "image/png",
                    "is_image": True,
                    "download_url": "http://localhost:9876/workspace/chat-1/current.png",
                }
            ],
        }
    )
    cumulative_files = [
        {
            "type": "image",
            "url": "http://localhost:9876/workspace/chat-1/old.png",
            "name": "old.png",
            "content_type": "image/png",
        },
        {
            "type": "image",
            "url": "http://localhost:9876/workspace/chat-1/current.png",
            "name": "current.png",
            "content_type": "image/png",
        },
    ]

    files = _display_files_tool_result_files_for_serialization(
        tool_function_name="agent_vm_display_files",
        server_id="agent-vm",
        tool_result=current_payload,
        fallback_files=cumulative_files,
    )

    assert files == [
        {
            "type": "image",
            "url": "http://localhost:9876/workspace/chat-1/current.png",
            "name": "current.png",
            "content_type": "image/png",
        }
    ]


def test_display_files_serialization_uses_legacy_fallback_without_payload_files():
    legacy_files = [
        {
            "type": "image",
            "url": "http://localhost:9876/workspace/chat-1/legacy.png",
            "name": "legacy.png",
            "content_type": "image/png",
        }
    ]

    files = _display_files_tool_result_files_for_serialization(
        tool_function_name="agent_vm_display_files",
        server_id="agent-vm",
        tool_result={"success": True, "message": "old record"},
        fallback_files=legacy_files,
    )

    assert files == legacy_files


def test_agent_vm_request_images_does_not_attach_chat_files_and_builds_followup_message():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="agent_vm_request_images",
            tool_type="mcp",
            tool_result=[
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "success": True,
                            "request_images": True,
                            "images": [
                                {
                                    "file_name": "chart.png",
                                    "mime_type": "image/png",
                                    "is_image": True,
                                    "download_url": "http://localhost:9876/workspace/chat-1/chart.png",
                                    "model_image_url": "http://host.docker.internal:9876/workspace/chat-1/chart.png",
                                }
                            ],
                        }
                    ),
                }
            ],
            metadata={"chat_id": "chat-1"},
            server_id="agent-vm",
        )

    tool_text, files, embeds = asyncio.run(run())
    result = {
        "tool_call_id": "call-1",
        "content": tool_text,
        "server_id": "agent-vm",
    }
    image_urls = HELPERS["_collect_agent_vm_request_image_urls"](
        [{"id": "call-1", "function": {"name": "agent_vm_request_images"}}],
        [result],
    )
    followup_message = HELPERS["_build_agent_vm_request_images_followup_message"](
        image_urls
    )

    assert files == []
    assert embeds == []
    assert image_urls == [
        "http://host.docker.internal:9876/workspace/chat-1/chart.png"
    ]
    assert followup_message == {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "Workspace images requested for visual inspection.",
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": "http://host.docker.internal:9876/workspace/chat-1/chart.png"
                },
            },
        ],
    }


def test_model_supports_vision_defaults_to_true_without_capability_metadata():
    _model_supports_vision = HELPERS["_model_supports_vision"]

    assert _model_supports_vision(None)
    assert _model_supports_vision({})
    assert _model_supports_vision({"info": {}})
    assert _model_supports_vision({"info": {"meta": {}}})
    assert _model_supports_vision({"info": {"meta": {"capabilities": {}}}})
    assert _model_supports_vision(
        {"info": {"meta": {"capabilities": {"vision": True}}}}
    )


def test_model_supports_vision_honors_explicit_false():
    _model_supports_vision = HELPERS["_model_supports_vision"]

    assert not _model_supports_vision(
        {"info": {"meta": {"capabilities": {"vision": False}}}}
    )


def test_request_images_unavailable_message_replaces_pixels_with_text_notice():
    build = HELPERS["_build_agent_vm_request_images_unavailable_message"]

    assert build(None) is None
    assert build([]) is None
    assert build(["", "   "]) is None

    message = build(
        [
            "http://host.docker.internal:9876/workspace/chat-1/chart.png",
            "http://host.docker.internal:9876/workspace/chat-1/plot.png",
        ]
    )
    assert message["role"] == "user"
    assert len(message["content"]) == 1
    assert message["content"][0]["type"] == "text"
    assert "2 workspace image(s)" in message["content"][0]["text"]
    assert "PORTICO-156" in message["content"][0]["text"]
    assert all(
        part.get("type") != "image_url" for part in message["content"]
    )


def test_workspace_inline_image_collection_accepts_new_and_legacy_attachment_markers():
    current_url = "http://localhost:9876/workspace/chat-1/current.svg"
    legacy_url = "http://localhost:9876/workspace/chat-1/legacy.svg"
    payload = {
        "results": [
            {
                "inline_image_attached": True,
                "files": [{"download_url": current_url}],
            },
            {
                "inline_image_rendered": True,
                "files": [{"download_url": legacy_url}],
            },
        ]
    }

    assert _collect_workspace_inline_image_urls(payload, "chat-1") == {
        current_url,
        legacy_url,
    }


def test_agent_vm_request_images_collects_wrapped_payload_shapes_and_prefers_model_url():
    payload = {
        "success": True,
        "request_images": True,
        "images": [
            {
                "download_url": "http://localhost:9876/workspace/chat-1/direct.png",
                "model_image_url": "http://host.docker.internal:9876/workspace/chat-1/direct.png",
            }
        ],
    }
    wrapped_payload = {
        "results": [
            {
                "success": True,
                "request_images": True,
                "images": [
                    {
                        "download_url": "http://localhost:9876/workspace/chat-1/wrapped.png",
                        "model_image_url": "http://host.docker.internal:9876/workspace/chat-1/wrapped.png",
                    }
                ],
            }
        ]
    }
    mcp_list_payload = [
        {
            "type": "text",
            "text": json.dumps(
                {
                    "success": True,
                    "request_images": True,
                    "images": [
                        {
                            "download_url": "http://localhost:9876/workspace/chat-1/list.png",
                            "model_image_url": "http://host.docker.internal:9876/workspace/chat-1/list.png",
                        }
                    ],
                }
            ),
        }
    ]
    results = [
        {
            "tool_call_id": "call-1",
            "content": json.dumps(payload),
            "server_id": "agent-vm",
        },
        {
            "tool_call_id": "call-2",
            "content": wrapped_payload,
            "server_id": "agent-vm",
        },
        {
            "tool_call_id": "call-3",
            "content": mcp_list_payload,
            "server_id": "agent-vm",
        },
    ]

    image_urls = HELPERS["_collect_agent_vm_request_image_urls"](
        [
            {"id": "call-1", "function": {"name": "agent_vm_request_images"}},
            {"id": "call-2", "function": {"name": "request_images"}},
            {"id": "call-3", "function": {"name": "agent_vm_request_images"}},
        ],
        results,
    )

    assert image_urls == [
        "http://host.docker.internal:9876/workspace/chat-1/direct.png",
        "http://host.docker.internal:9876/workspace/chat-1/wrapped.png",
        "http://host.docker.internal:9876/workspace/chat-1/list.png",
    ]


def test_inline_workspace_image_markdown_is_removed_when_tool_already_attached_image():
    content_blocks = [
        {
            "type": "tool_calls",
            "results": [
                {
                    "content": json.dumps(
                        {
                            "download_url": "http://localhost:9876/workspace/chat-1/normal_distribution.png",
                            "inline_image_included": True,
                        }
                    ),
                    "files": [{"type": "data", "content": "data:image/png;base64,AAAA"}],
                }
            ],
        },
        {
            "type": "text",
            "content": (
                "Here is the chart:\n\n"
                "![normal_distribution.png](http://localhost:9876/workspace/chat-1/normal_distribution.png)\n\n"
                "The distribution is bell shaped."
            ),
        },
    ]

    assert dedupe_inline_tool_image_markdown(content_blocks, "chat-1") is True
    assert "![normal_distribution.png]" not in content_blocks[1]["content"]
    assert "The distribution is bell shaped." in content_blocks[1]["content"]


def test_inline_workspace_image_markdown_dedupe_keeps_distinct_images():
    content_blocks = [
        {
            "type": "tool_calls",
            "results": [
                {
                    "content": json.dumps(
                        {
                            "download_url": "http://localhost:9876/workspace/chat-1/a.png",
                            "inline_image_included": True,
                        }
                    ),
                    "files": [{"type": "data", "content": "data:image/png;base64,AAAA"}],
                }
            ],
        },
        {
            "type": "text",
            "content": (
                "![a.png](http://localhost:9876/workspace/chat-1/a.png)\n"
                "![b.png](http://localhost:9876/workspace/chat-1/b.png)\n"
                "![external.png](http://localhost:9876/workspace/other-chat/a.png)"
            ),
        },
    ]

    assert dedupe_inline_tool_image_markdown(content_blocks, "chat-1") is True
    assert "![a.png]" not in content_blocks[1]["content"]
    assert "![b.png](http://localhost:9876/workspace/chat-1/b.png)" in content_blocks[1]["content"]
    assert (
        "![external.png](http://localhost:9876/workspace/other-chat/a.png)"
        in content_blocks[1]["content"]
    )


def test_collect_content_block_tool_result_files_preserves_distinct_images_in_order():
    content_blocks = [
        {
            "type": "tool_calls",
            "results": [
                {"files": [{"type": "data", "content": "data:image/png;base64,A"}]},
                {
                    "files": [
                        {"type": "data", "content": "data:image/png;base64,A"},
                        {"type": "data", "content": "data:image/png;base64,B"},
                    ]
                },
                {
                    "files": [
                        {"type": "image", "url": "http://localhost:9876/workspace/chat-1/c.png"},
                        {"type": "image", "url": "http://localhost:9876/workspace/chat-1/c.png"},
                        {"type": "image", "url": "http://localhost:9876/workspace/chat-1/d.png"},
                    ]
                },
            ],
        }
    ]

    files = _collect_content_block_tool_result_files(content_blocks)

    assert files == [
        {"type": "data", "content": "data:image/png;base64,A"},
        {"type": "data", "content": "data:image/png;base64,B"},
        {"type": "image", "url": "http://localhost:9876/workspace/chat-1/c.png"},
        {"type": "image", "url": "http://localhost:9876/workspace/chat-1/d.png"},
    ]


def test_streaming_tool_updates_persist_merged_tool_result_files():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")

    assert "merged_tool_result_files = (" in source
    assert "_collect_content_block_tool_result_files(content_blocks)" in source
    assert 'tool_call_update["files"]' in source
    assert 'data["files"] = merged_tool_result_files' in source
    assert 'completion_update["files"] = merged_tool_result_files' in source


def test_agent_vm_request_images_followup_is_non_persisted_and_converted_before_dispatch():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")

    assert "_collect_agent_vm_request_image_urls(" in source
    assert "_build_agent_vm_request_images_followup_message(" in source
    assert "followup_messages.append(request_images_followup_message)" in source
    assert "new_form_data = await convert_url_images_to_base64(" in source
    assert "_summarize_agent_vm_request_image_url_hosts(" in source
    assert "_sanitize_workspace_image_conversion_log_error(" in source
    assert "stop_reason=\"tool_followup_image_error\"" in source
    assert "_format_agent_vm_request_images_conversion_error(" in source
    assert "await finalize_stream_assistant_error(" in source
    assert re.search(
        r"new_form_data = await convert_url_images_to_base64\(.*?run_chat_completion_with_transient_retries",
        source,
        re.DOTALL,
    )


def test_chrome_devtools_screenshot_with_files_reports_inline_visibility():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="chrome_devtools_take_screenshot",
            tool_type="mcp",
            tool_result=[
                {
                    "type": "text",
                    "text": json.dumps(
                        {"results": ["Took a screenshot of the current page's viewport."]}
                    ),
                },
                {
                    "type": "image",
                    "mimeType": "image/png",
                    "data": "ZmFrZSBwbmc=",
                },
            ],
            metadata={"chat_id": "chat-screenshot"},
            server_id="chrome-devtools",
        )

    tool_text, files, embeds = asyncio.run(run())
    payload = json.loads(tool_text)

    assert payload["inline_image_attached"] is True
    assert payload["inline_image_count"] == 1
    assert payload["message"] == "The screenshot image is attached for inline display in the chat."
    assert "data:image" not in tool_text
    assert "ZmFrZSBwbmc" not in tool_text
    assert files == [{"type": "image", "url": "http://files.local/extracted.png"}]
    assert embeds == []


def test_chrome_devtools_file_path_only_result_reports_host_local_not_inline():
    async def run():
        return await process_tool_result(
            request=None,
            tool_function_name="chrome_devtools_take_screenshot",
            tool_type="mcp",
            tool_result=(
                "Took a screenshot of the current page's viewport.\n"
                "Saved screenshot to /Users/example/project/screenshot.png."
            ),
            metadata={"chat_id": "chat-screenshot"},
            server_id="chrome-devtools",
        )

    tool_text, files, embeds = asyncio.run(run())
    payload = json.loads(tool_text)

    assert payload["host_file_saved"] is True
    assert payload["host_file_path"] == "/Users/example/project/screenshot.png"
    assert payload["inline_image_attached"] is False
    assert "did not attach an inline chat image" in payload["message"]
    assert "visible inline" not in payload["message"]
    assert files == []
    assert embeds == []


def test_replay_result_content_enriches_stored_inline_image_files():
    result = {
        "tool_call_id": "tooluse-1",
        "content": json.dumps(
            {"results": ["Took a screenshot of the current page's viewport."]}
        ),
        "server_id": "chrome-devtools",
        "files": [{"type": "data", "content": "data:image/png;base64,AAAA"}],
    }

    tool_text = _tool_result_content_for_model_replay(
        result,
        tool_function_name="chrome_devtools_take_screenshot",
    )
    payload = json.loads(tool_text)

    assert payload["inline_image_attached"] is True
    assert payload["inline_image_count"] == 1
    assert payload["message"] == "The screenshot image is attached for inline display in the chat."
    assert "data:image" not in tool_text
    assert "AAAA" not in tool_text


def test_normal_followup_replay_uses_inline_image_enrichment_helper():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")

    assert re.search(
        r"def convert_content_blocks_to_messages\(.*?_tool_result_content_for_model_replay",
        source,
        re.DOTALL,
    )
