from pathlib import Path
import ast
import sys

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))

from open_webui.utils.mcp_runtime import (  # noqa: E402
    normalize_tool_execution_error,
)


ORIGINAL_TIMEOUT_ERROR = (
    "tool call failed: Transport send error: Transport "
    "[rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::"
    "StreamableHttpClientWorker<mcp_orc::oauth::binding::OAuthStreamableHttpClient<"
    "mcp_orc::streamable_http_reqwest_compat::CompatibleReqwestStreamableHttpClient>>>] "
    "error: unexpected server response: HTTP 504 Gateway Timeout: <html>\r\n"
    "<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n"
    "<center><h1>504 Gateway Time-out</h1></center>\r\n"
    "<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"
)


def _load_retry_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_coerce_status_code",
        "_extract_error_message",
        "_get_response_status_code",
        "_is_model_access_denied_error",
        "_is_context_window_error",
        "_is_multimodal_unsupported_error",
        "_is_bedrock_malformed_tool_use_error",
        "_is_bedrock_stream_inactive_error",
        "_retryable_chat_completion_error_reason",
        "_is_retryable_chat_completion_error",
        "_is_retryable_tool_execution_error",
        "_is_retryable_tool_execution_result",
    }
    selected_nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted_names
    ]

    module = ast.Module(body=selected_nodes, type_ignores=[])
    namespace = {
        "Any": object,
        "Optional": __import__("typing").Optional,
        "re": __import__("re"),
        "JSONResponse": type("JSONResponse", (), {}),
        "Response": type("Response", (), {}),
        "normalize_tool_execution_error": normalize_tool_execution_error,
        "_TRANSIENT_CHAT_COMPLETION_RETRYABLE_STATUS_CODES": frozenset(
            {408, 409, 425, 429, 500, 502, 503, 504}
        ),
        "_TRANSIENT_CHAT_COMPLETION_RETRYABLE_MESSAGE_FRAGMENTS": (
            "server disconnected",
            "service unavailable",
            "temporarily unavailable",
            "upstream model provider stream failed",
            "connection reset",
            "connection aborted",
            "connection closed",
            "remote protocol error",
            "timed out",
            "timeout",
            "broken pipe",
            "transport closed",
            "try again",
        ),
        "_BEDROCK_UNEXPECTED_PROCESSING_ERROR_FRAGMENTS": (
            "unexpected error during processing",
            "try your request again",
        ),
        "BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND": "bedrock_malformed_tool_use",
        "_CONTEXT_WINDOW_ERROR_FRAGMENTS": (
            "context window",
            "maximum context length",
            "maximum context window",
            "prompt is too long",
            "context_length_exceeded",
        ),
        "_MODEL_ACCESS_DENIED_FRAGMENTS": (
            "model not found",
            "model access denied",
            "does not have access to model",
            "permission denied for model",
            "not authorized to access model",
        ),
        "_MULTIMODAL_UNSUPPORTED_FRAGMENTS": (
            "multimodal content (images, audio, video) is not supported",
            "multimodal content is not supported",
        ),
        "_HTTP_ERROR_STATUS_RE": __import__("re").compile(
            r"\bhttp(?:\s+error)?\s+(\d{3})\b", __import__("re").IGNORECASE
        ),
        "re": __import__("re"),
    }
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_retry_helpers()
_is_retryable_tool_execution_error = HELPERS["_is_retryable_tool_execution_error"]
_is_retryable_tool_execution_result = HELPERS["_is_retryable_tool_execution_result"]


def test_retryable_tool_execution_error_does_not_retry_observed_gateway_timeout_wrapper():
    assert not _is_retryable_tool_execution_error(ORIGINAL_TIMEOUT_ERROR)


def test_retryable_tool_execution_result_does_not_retry_observed_gateway_timeout_wrapper():
    assert not _is_retryable_tool_execution_result({"error": ORIGINAL_TIMEOUT_ERROR})


@pytest.mark.parametrize(
    "message",
    [
        "Tool call exceeded configured timeout.",
        "tool call exceeded configured timeout of 600s",
        "TOOL CALL EXCEEDED CONFIGURED TIMEOUT OF 600S.",
        "request timed out after 600s",
    ],
)
def test_retryable_tool_execution_error_does_not_retry_timeout_variants(message):
    assert not _is_retryable_tool_execution_error({"error": {"message": message}})


def test_retryable_tool_execution_result_keeps_retrying_502_failures():
    assert _is_retryable_tool_execution_result(
        {
            "error": (
                'HTTP error 502: {"message":"failed to connect sse server '
                '\'mcp-atlassian\'","authorization_url":null}'
            )
        }
    )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "status_code": 503,
            "message": "MCP recovery is in progress",
            "retry_policy_owner": "mcp-orc",
        },
        {
            "error": {
                "status_code": 502,
                "message": "transport closed",
                "retry_policy_owner": "mcp-orc",
            }
        },
        {
            "error": (
                'HTTP error 503: {"message":"MCP recovery is in progress",'
                '"retry_policy_owner":"mcp-orc"}'
            )
        },
    ],
)
def test_mcp_orc_owned_failures_are_never_retried_by_middleware(payload):
    assert not _is_retryable_tool_execution_error(payload)
    assert not _is_retryable_tool_execution_result(payload)


def test_streaming_native_mcp_dispatch_is_single_attempt_but_external_tools_keep_policy():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    assert '1\n                                                    if tool_type == "mcp"' in source
    assert 'else _get_transient_tool_execution_retry_max_attempts()' in source
