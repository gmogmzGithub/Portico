from pathlib import Path
import ast
import json
from typing import Any, Optional

try:
    from starlette.responses import JSONResponse, PlainTextResponse, Response
except ModuleNotFoundError:
    class Response:  # pragma: no cover - local test shim
        def __init__(self, content=None, status_code: int = 200, **_kwargs):
            self.body = content
            self.status_code = status_code

    class JSONResponse(Response):  # pragma: no cover - local test shim
        def __init__(self, content=None, status_code: int = 200, **kwargs):
            serialized = json.dumps(content).encode("utf-8")
            super().__init__(serialized, status_code=status_code, **kwargs)

    class PlainTextResponse(Response):  # pragma: no cover - local test shim
        def __init__(self, content="", status_code: int = 200, **kwargs):
            super().__init__(content.encode("utf-8"), status_code=status_code, **kwargs)


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)


def _load_error_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "CONTEXT_WINDOW_ERROR_MESSAGE",
        "_CONTEXT_WINDOW_ERROR_FRAGMENTS",
        "MODEL_ACCESS_DENIED_MESSAGE",
        "_MODEL_ACCESS_DENIED_FRAGMENTS",
        "MULTIMODAL_UNSUPPORTED_MESSAGE",
        "_MULTIMODAL_UNSUPPORTED_FRAGMENTS",
        "BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND",
        "MALFORMED_TOOL_USE_USER_MESSAGE",
        "_is_bedrock_malformed_tool_use_error",
        "_coerce_status_code",
        "_is_context_window_error",
        "_is_model_access_denied_error",
        "_is_multimodal_unsupported_error",
        "_format_error_message",
        "_extract_error_message",
        "_get_response_status_code",
        "_normalize_non_streaming_response_payload",
        "_get_non_streaming_response_error_source",
    }
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in wanted_names:
                    selected_nodes.append(node)
                    break
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in wanted_names:
                selected_nodes.append(node)

    module = ast.Module(body=selected_nodes, type_ignores=[])
    namespace = {
        "Any": Any,
        "Optional": Optional,
        "json": json,
        "_HTTP_ERROR_STATUS_RE": __import__("re").compile(
            r"\bhttp(?:\s+error)?\s+(\d{3})\b", __import__("re").IGNORECASE
        ),
        "JSONResponse": JSONResponse,
        "Response": Response,
    }
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_error_helpers()
CONTEXT_WINDOW_ERROR_MESSAGE = HELPERS["CONTEXT_WINDOW_ERROR_MESSAGE"]
MULTIMODAL_UNSUPPORTED_MESSAGE = HELPERS["MULTIMODAL_UNSUPPORTED_MESSAGE"]
_extract_error_message = HELPERS["_extract_error_message"]
_format_error_message = HELPERS["_format_error_message"]
_get_response_status_code = HELPERS["_get_response_status_code"]
_normalize_non_streaming_response_payload = HELPERS[
    "_normalize_non_streaming_response_payload"
]
_get_non_streaming_response_error_source = HELPERS[
    "_get_non_streaming_response_error_source"
]


def test_extract_error_message_reads_plain_text_response_body():
    response = PlainTextResponse(
        "Failed to buffer the request body: length limit exceeded",
        status_code=413,
    )

    assert (
        _extract_error_message(response)
        == "Failed to buffer the request body: length limit exceeded"
    )


def test_extract_error_message_reads_json_response_body():
    response = JSONResponse({"error": {"message": "payload too large"}}, status_code=413)

    assert _extract_error_message(response) == "payload too large"


def test_extract_error_message_falls_back_to_status_code_for_empty_response():
    response = Response(status_code=413)

    assert _extract_error_message(response) == "HTTP 413"


def test_extract_error_message_prefers_nested_error_and_detail_fields():
    assert _extract_error_message({"error": {"detail": "provider timed out"}}) == "provider timed out"
    assert _extract_error_message({"error": "simple error"}) == "simple error"
    assert _extract_error_message({"detail": "outer detail"}) == "outer detail"
    assert _extract_error_message({"message": "outer message"}) == "outer message"


def test_format_error_message_maps_plain_text_body_limit_errors():
    response = PlainTextResponse(
        "Failed to buffer the request body: length limit exceeded",
        status_code=413,
    )

    assert _format_error_message(_extract_error_message(response)) == (
        CONTEXT_WINDOW_ERROR_MESSAGE
    )


def test_format_error_message_maps_jupiter_multimodal_rejection():
    # Exact upstream rejection observed on Jupiter security-stack builds (PORTICO-156).
    response = JSONResponse(
        {
            "error": {
                "message": (
                    "multimodal content (images, audio, video) is not supported "
                    "in the current MVP"
                ),
                "type": "api_error",
                "code": 400,
            }
        },
        status_code=400,
    )

    assert _format_error_message(_extract_error_message(response)) == (
        MULTIMODAL_UNSUPPORTED_MESSAGE
    )


def test_format_error_message_maps_multimodal_rejection_wording_variants():
    assert _format_error_message(
        "Multimodal content is not supported in this environment"
    ) == MULTIMODAL_UNSUPPORTED_MESSAGE


def test_format_error_message_keeps_unrelated_multimodal_mentions():
    message = "multimodal embeddings request failed: connection reset"

    assert _format_error_message(message) == message


def test_non_streaming_error_source_detects_plain_text_response():
    response = PlainTextResponse("Payload Too Large", status_code=413)

    response_data = _normalize_non_streaming_response_payload(response)

    assert _get_non_streaming_response_error_source(response, response_data) is response


def test_non_streaming_error_source_detects_json_error_payload():
    response = JSONResponse({"error": {"message": "payload too large"}}, status_code=413)

    response_data = _normalize_non_streaming_response_payload(response)

    assert response_data == {"error": {"message": "payload too large"}}
    assert _get_non_streaming_response_error_source(response, response_data) == {
        "error": {"message": "payload too large"}
    }


def test_normalize_non_streaming_response_payload_handles_invalid_json_bodies():
    response = Response(content=b"{bad json", status_code=500)

    assert _normalize_non_streaming_response_payload(response) is response


def test_non_streaming_error_source_returns_none_for_successful_payload_without_error():
    response = JSONResponse({"ok": True}, status_code=200)
    response_data = _normalize_non_streaming_response_payload(response)

    assert response_data == {"ok": True}
    assert _get_non_streaming_response_error_source(response, response_data) is None


def test_get_response_status_code_extracts_direct_nested_and_textual_status_codes():
    assert _get_response_status_code({"status_code": "429"}) == 429
    assert _get_response_status_code({"error": {"status_code": "503"}}) == 503
    assert _get_response_status_code({"error": {"code": "504"}}) == 504
    assert _get_response_status_code("HTTP error 502: gateway timeout") == 502
    assert (
        _get_response_status_code(
            "tool call failed: unexpected server response: HTTP 504 Gateway Timeout"
        )
        == 504
    )
    assert _get_response_status_code({"error": {"message": "validation failed"}}) is None
