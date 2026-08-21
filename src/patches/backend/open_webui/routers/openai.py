import asyncio
import hashlib
import json
import logging
import os
import random
import re
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional
from urllib.parse import urlparse

import aiohttp
from aiocache import cached
import requests

try:
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider
except ImportError:
    DefaultAzureCredential = None
    get_bearer_token_provider = None

from fastapi import Depends, HTTPException, Request, APIRouter
from fastapi.responses import (
    FileResponse,
    StreamingResponse,
    JSONResponse,
    PlainTextResponse,
)
from pydantic import BaseModel
from starlette.background import BackgroundTask

from open_webui.models.models import Models
from open_webui.config import (
    CACHE_DIR,
)
from open_webui.env import (
    MODELS_CACHE_TTL,
    AIOHTTP_CLIENT_SESSION_SSL,
    AIOHTTP_CLIENT_TIMEOUT,
    AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST,
    ENABLE_FORWARD_USER_INFO_HEADERS,
    BYPASS_MODEL_ACCESS_CONTROL,
)
from open_webui.models.users import UserModel

from open_webui.constants import ERROR_MESSAGES


from open_webui.utils.payload import (
    apply_model_params_to_body_openai,
    apply_system_prompt_to_body,
)
from open_webui.utils.misc import (
    convert_logit_bias_input_to_json,
    stream_chunks_handler,
)
from open_webui.utils.system_prompt_merge import (
    merge_model_and_request_system_prompt,
)
from open_webui.utils.llm_debug import is_auxiliary_task_name
from open_webui.utils.ultra_multi_agent import (
    admit_and_sign_request as admit_and_sign_ultra_request,
    build_private_gateway_transport,
    is_ultra_request,
)

from open_webui.utils.auth import get_admin_user, get_verified_user
from open_webui.utils.access_control import has_access
from open_webui.utils.delegated_events import get_event_emitter
from open_webui.utils.rate_limit_retry import (
    build_rate_limit_cancel_key,
    clear_rate_limit_cancel,
    register_rate_limit_cancel,
    wait_for_rate_limit_cancel,
)

CONTAINER_SRC_DIR = "/app/src"
if CONTAINER_SRC_DIR not in sys.path:
    sys.path.insert(0, CONTAINER_SRC_DIR)

try:
    from event_publisher import (
        publish_request_payload as _publish_request_payload_impl,
        publish_request_start as _publish_request_start_impl,
    )

    LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = True
except ImportError:
    LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = False
    _publish_request_start_impl = None
    _publish_request_payload_impl = None


def _ensure_llm_debug_event_publisher_available() -> bool:
    global LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE
    global _publish_request_start_impl
    global _publish_request_payload_impl

    if _publish_request_start_impl and _publish_request_payload_impl:
        return True

    try:
        from event_publisher import (
            publish_request_payload as publish_request_payload_impl,
            publish_request_start as publish_request_start_impl,
        )

        _publish_request_start_impl = publish_request_start_impl
        _publish_request_payload_impl = publish_request_payload_impl
        LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = True
        return True
    except ImportError:
        LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = False
        return False

async def publish_request_start(*args, **kwargs):
    if not _ensure_llm_debug_event_publisher_available():
        return False
    return await _publish_request_start_impl(*args, **kwargs)

async def publish_request_payload(*args, **kwargs):
    if not _ensure_llm_debug_event_publisher_available():
        return False
    return await _publish_request_payload_impl(*args, **kwargs)


def extract_error_message(error_json: dict) -> str:
    """Extract user-friendly error message from gateway/proxy error responses.

    Handles various nested error formats from different providers:
    - {"error": {"message": "..."}} - OpenAI-compatible format
    - {"error": "..."} - Simple error string
    - {"detail": "..."} - FastAPI format
    - {"message": "..."} - Generic format
    """
    if "error" in error_json:
        err = error_json["error"]
        if isinstance(err, dict):
            if "message" in err:
                return err["message"]
        elif isinstance(err, str):
            return err
    if "detail" in error_json:
        return error_json["detail"]
    if "message" in error_json:
        return error_json["message"]
    return json.dumps(error_json)


from open_webui.utils.headers import include_user_info_headers


log = logging.getLogger(__name__)
INTERNAL_AIOHTTP_PROXY_BYPASS_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "open-webui",
    "portico-open-webui",
    "llm-gateway",
    "mcpo",
    "mcpo-core",
    "redis",
    "portico-redis",
    "mongodb",
    "portico-mongodb",
    "chat-state-api",
    "open-webui-health-check",
    "host.docker.internal",
}

RATE_LIMIT_TEST_RATE_ENV = "OWUI_RATE_LIMIT_TEST_RATE"


def _url_hostname(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().rstrip(".")
    except Exception:
        return ""


def _should_bypass_env_proxy_for_url(url: str) -> bool:
    return _url_hostname(url) in INTERNAL_AIOHTTP_PROXY_BYPASS_HOSTS


def _aiohttp_trust_env_for_url(url: str) -> bool:
    return not _should_bypass_env_proxy_for_url(url)


# Release packaging can set LLM_GATEWAY_MULTIMODAL_INPUT=false when the
# app-owned LLM gateway upstream cannot accept image/audio/video input on
# every provider route. The Jupiter security-stack LLM routing service
# rejects multimodal content on its OpenAI and Gemini routes ("not
# supported in the current MVP", verified empirically 2026-07-11) but
# accepts image blocks on its Bedrock/Atlas route. Atlas-family models
# therefore keep vision=true, while other app-owned gateway models
# advertise vision=false so the chat UI blocks image attachments before
# send instead of surfacing an upstream provider error after send.
LLM_GATEWAY_MULTIMODAL_INPUT_ENV = "LLM_GATEWAY_MULTIMODAL_INPUT"
_ENV_FALSE_VALUES = {"false", "0", "no", "off"}
_INTERNAL_LLM_GATEWAY_HOSTNAMES = {"llm-gateway", "litellm", "bifrost"}
# Model families whose upstream proxy route accepts multimodal input even
# while LLM_GATEWAY_MULTIMODAL_INPUT=false. Fails closed: families not
# listed here are treated as text-only on the app-owned gateway.
_GATEWAY_MULTIMODAL_CAPABLE_FAMILY_NEEDLES = ("atlas",)


def _is_internal_gateway_multimodal_input_disabled() -> bool:
    value = (
        os.environ.get(LLM_GATEWAY_MULTIMODAL_INPUT_ENV, "").strip().lower()
    )
    return value in _ENV_FALSE_VALUES


def _is_gateway_multimodal_capable_model(model: dict) -> bool:
    haystack = " ".join(
        str(value)
        for value in (model.get("id"), model.get("name"))
        if isinstance(value, str)
    ).lower()
    return any(
        needle in haystack
        for needle in _GATEWAY_MULTIMODAL_CAPABLE_FAMILY_NEEDLES
    )


def _apply_internal_gateway_capability_overrides(model: dict, base_url: str) -> dict:
    """Mark app-owned gateway models as not vision capable when multimodal
    input is disabled for the gateway, except families whose proxy route
    accepts image input (Atlas via Bedrock). User-added connections are
    untouched, and models with their own Open WebUI model record keep their
    configured capabilities because the database merge replaces this info
    entry."""
    if not _is_internal_gateway_multimodal_input_disabled():
        return model
    if _url_hostname(base_url) not in _INTERNAL_LLM_GATEWAY_HOSTNAMES:
        return model
    if "info" in model:
        return model
    if _is_gateway_multimodal_capable_model(model):
        return model
    model["info"] = {"meta": {"capabilities": {"vision": False}}}
    return model


def _summarize_system_messages(messages: Any) -> dict[str, int]:
    summary = {
        "system_messages": 0,
        "system_chars": 0,
        "system_messages_with_portico_context": 0,
    }
    if not isinstance(messages, list):
        return summary

    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "system":
            continue

        summary["system_messages"] += 1
        content = msg.get("content")
        if isinstance(content, str):
            summary["system_chars"] += len(content)
            if "<portico_context>" in content:
                summary["system_messages_with_portico_context"] += 1

    return summary


def _log_system_prompt_debug_summary(
    stage: str, model_id: str, system_prompt: Optional[str], messages: Any
) -> None:
    system_summary = _summarize_system_messages(messages)
    log.info(
        "[SYSTEM-PROMPT-DEBUG] stage=%s model=%s system_prompt_chars=%d system_msgs=%d total_chars=%d with_portico_context=%d",
        stage,
        model_id,
        len(system_prompt) if isinstance(system_prompt, str) else 0,
        system_summary["system_messages"],
        system_summary["system_chars"],
        system_summary["system_messages_with_portico_context"],
    )
RATE_LIMIT_TEST_RETRY_AFTER_ENV = "OWUI_RATE_LIMIT_TEST_RETRY_AFTER_SEC"
RATE_LIMIT_TEST_DEFAULT_RETRY_AFTER_SEC = 5
RATE_LIMIT_MAX_RETRIES_ENV = "OWUI_RATE_LIMIT_MAX_RETRIES"
RATE_LIMIT_BASE_DELAY_ENV = "OWUI_RATE_LIMIT_BASE_DELAY_MS"
RATE_LIMIT_MAX_DELAY_ENV = "OWUI_RATE_LIMIT_MAX_DELAY_MS"
RATE_LIMIT_DEFAULT_MAX_RETRIES = 10
RATE_LIMIT_DEFAULT_BASE_DELAY_MS = 2000
RATE_LIMIT_DEFAULT_MAX_DELAY_MS = 8000
LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED = True


##########################################
#
# Utility functions
#
##########################################


def get_rate_limit_test_rate() -> float:
    raw_value = os.getenv(RATE_LIMIT_TEST_RATE_ENV, "").strip()
    if not raw_value:
        return 0.0
    try:
        rate = float(raw_value)
    except ValueError:
        return 0.0
    return max(0.0, min(1.0, rate))


def get_rate_limit_retry_after_sec() -> int:
    raw_value = os.getenv(RATE_LIMIT_TEST_RETRY_AFTER_ENV, "").strip()
    if not raw_value:
        return RATE_LIMIT_TEST_DEFAULT_RETRY_AFTER_SEC
    try:
        retry_after = int(float(raw_value))
    except ValueError:
        return RATE_LIMIT_TEST_DEFAULT_RETRY_AFTER_SEC
    return max(0, retry_after)


def get_rate_limit_max_retries() -> int:
    raw_value = os.getenv(RATE_LIMIT_MAX_RETRIES_ENV, "").strip()
    if not raw_value:
        return RATE_LIMIT_DEFAULT_MAX_RETRIES
    try:
        retries = int(float(raw_value))
    except ValueError:
        return RATE_LIMIT_DEFAULT_MAX_RETRIES
    return max(0, retries)


def get_rate_limit_base_delay_ms() -> int:
    raw_value = os.getenv(RATE_LIMIT_BASE_DELAY_ENV, "").strip()
    if not raw_value:
        return RATE_LIMIT_DEFAULT_BASE_DELAY_MS
    try:
        delay_ms = int(float(raw_value))
    except ValueError:
        return RATE_LIMIT_DEFAULT_BASE_DELAY_MS
    return max(0, delay_ms)


def get_rate_limit_max_delay_ms() -> int:
    raw_value = os.getenv(RATE_LIMIT_MAX_DELAY_ENV, "").strip()
    if not raw_value:
        return RATE_LIMIT_DEFAULT_MAX_DELAY_MS
    try:
        delay_ms = int(float(raw_value))
    except ValueError:
        return RATE_LIMIT_DEFAULT_MAX_DELAY_MS
    return max(0, delay_ms)


def should_publish_bifrost_debug_request_payload(
    metadata: Optional[dict], payload: Optional[dict]
) -> bool:
    if not (
        LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED
        and _ensure_llm_debug_event_publisher_available()
    ):
        return False
    if not isinstance(metadata, dict) or not isinstance(payload, dict):
        return False
    if not metadata.get("session_id") or not metadata.get("chat_id"):
        return False
    return True


def _is_bifrost_gateway_mode() -> bool:
    return True


def _inject_openwebui_affinity_headers(
    headers: dict, metadata: Optional[dict]
) -> dict:
    if not isinstance(metadata, dict):
        return headers

    chat_id = metadata.get("chat_id")
    if chat_id:
        headers["X-OpenWebUI-Chat-Id"] = str(chat_id)

    session_id = metadata.get("session_id")
    if session_id:
        headers["X-OpenWebUI-Session-Id"] = str(session_id)

    message_id = metadata.get("message_id")
    if message_id:
        headers["X-OpenWebUI-Message-Id"] = str(message_id)

    debug_request_id = metadata.get("debug_request_id")
    if debug_request_id:
        headers["X-OpenWebUI-Debug-Request-Id"] = str(debug_request_id)

    upstream_request_id = metadata.get("upstream_request_id")
    if upstream_request_id:
        headers["X-OpenWebUI-Upstream-Request-Id"] = str(upstream_request_id)

    request_phase = metadata.get("request_phase")
    if request_phase:
        headers["X-OpenWebUI-Request-Phase"] = str(request_phase)

    followup_index = metadata.get("followup_index")
    if followup_index is not None:
        headers["X-OpenWebUI-Followup-Index"] = str(followup_index)

    outer_message_id = metadata.get("outer_message_id")
    if outer_message_id:
        headers["X-OpenWebUI-Outer-Message-Id"] = str(outer_message_id)

    trigger_message_id = metadata.get("trigger_message_id")
    if trigger_message_id:
        headers["X-OpenWebUI-Trigger-Message-Id"] = str(trigger_message_id)

    transcript_anchor_kind = metadata.get("transcript_anchor_kind")
    if transcript_anchor_kind:
        headers["X-OpenWebUI-Transcript-Anchor-Kind"] = str(
            transcript_anchor_kind
        )

    transcript_anchor_message_id = metadata.get("transcript_anchor_message_id")
    if transcript_anchor_message_id:
        headers["X-OpenWebUI-Transcript-Anchor-Message-Id"] = str(
            transcript_anchor_message_id
        )

    transcript_anchor_tool_block_index = metadata.get(
        "transcript_anchor_tool_block_index"
    )
    if transcript_anchor_tool_block_index is not None:
        headers["X-OpenWebUI-Transcript-Anchor-Tool-Block-Index"] = str(
            transcript_anchor_tool_block_index
        )

    prompt_submitted_at_ms = metadata.get("prompt_submitted_at_ms")
    if prompt_submitted_at_ms is not None:
        headers["X-OpenWebUI-Prompt-Submitted-At-Ms"] = str(prompt_submitted_at_ms)

    return headers


def _should_embed_metadata_in_payload() -> bool:
    return False


def _inject_trace_headers(headers: dict, request: Request) -> dict:
    for header_name in ("traceparent", "tracestate", "baggage"):
        header_value = request.headers.get(header_name)
        if header_value:
            headers[header_name] = header_value
    return headers


def parse_retry_after_header(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        seconds = int(float(value))
        return max(0, seconds * 1000)
    except ValueError:
        pass

    try:
        parsed_date = parsedate_to_datetime(value)
        if parsed_date.tzinfo is None:
            parsed_date = parsed_date.replace(tzinfo=timezone.utc)
        delta = parsed_date - datetime.now(timezone.utc)
        return max(0, int(delta.total_seconds() * 1000))
    except Exception:
        return None


def parse_retry_after_from_text(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    match = re.search(
        r"(?:try again in|retry in|retry after)\s*(\d+)\s*s",
        text,
        re.IGNORECASE,
    )
    if not match:
        match = re.search(r"(\d+)\s*seconds", text, re.IGNORECASE)
    if match:
        try:
            return max(0, int(match.group(1)) * 1000)
        except ValueError:
            return None
    return None


def compute_backoff_delay_ms(retry_after_ms: Optional[int], attempt: int) -> int:
    base_delay = retry_after_ms if retry_after_ms is not None else get_rate_limit_base_delay_ms()
    scaled_delay = base_delay * pow(2, max(0, attempt - 1))
    return min(get_rate_limit_max_delay_ms(), scaled_delay)


def is_rate_limit_error(status: int, error_payload) -> bool:
    if status == 429:
        return True

    if isinstance(error_payload, dict):
        err = error_payload.get("error", {})
        error_type = err.get("type") or error_payload.get("type")
        error_code = err.get("code") or error_payload.get("code")
        if error_type and "rate_limit" in str(error_type):
            return True
        if error_code in (429, "apptokenratelimit", "rate_limit_exceeded"):
            return True
        message = extract_error_message(error_payload).lower()
        return "rate limit" in message or "ratelimit" in message

    if isinstance(error_payload, str):
        lowered = error_payload.lower()
        return "rate limit" in lowered or "ratelimit" in lowered

    return False


def build_rate_limit_error_response(
    message: str,
    error_type: str = "rate_limit_exceeded",
    status_code: int = 429,
    retry_after_ms: Optional[int] = None,
) -> JSONResponse:
    headers = {}
    if retry_after_ms is not None:
        headers["Retry-After"] = str(int(max(0, round(retry_after_ms / 1000))))
    return JSONResponse(
        status_code=status_code,
        headers=headers or None,
        content={
            "error": {
                "message": message,
                "type": error_type,
                "code": status_code,
            }
        },
    )


async def emit_rate_limit_event(
    event_emitter,
    phase: str,
    attempt: int,
    max_attempts: int,
    retry_after_ms: Optional[int] = None,
    wait_ms: Optional[int] = None,
):
    if not event_emitter:
        return
    payload = {
        "type": "chat:rate_limit",
        "data": {
            "phase": phase,
            "attempt": attempt,
            "max_attempts": max_attempts,
            "retry_after_ms": retry_after_ms,
            "wait_ms": wait_ms,
        },
    }
    await event_emitter(payload)


async def send_get_request(url, key=None, user: UserModel = None):
    timeout = aiohttp.ClientTimeout(total=AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST)
    try:
        async with aiohttp.ClientSession(
            timeout=timeout, trust_env=_aiohttp_trust_env_for_url(url)
        ) as session:
            headers = {
                **({"Authorization": f"Bearer {key}"} if key else {}),
            }

            if ENABLE_FORWARD_USER_INFO_HEADERS and user:
                headers = include_user_info_headers(headers, user)

            async with session.get(
                url,
                headers=headers,
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
            ) as response:
                return await response.json()
    except Exception as e:
        # Handle connection error here
        log.error(f"Connection error: {e}")
        return None


async def cleanup_response(
    response: Optional[aiohttp.ClientResponse],
    session: Optional[aiohttp.ClientSession],
):
    if response:
        response.close()
    if session:
        await session.close()


def openai_reasoning_model_handler(payload):
    """
    Handle reasoning model specific parameters
    """
    if "max_tokens" in payload:
        # Convert "max_tokens" to "max_completion_tokens" for all reasoning models
        payload["max_completion_tokens"] = payload["max_tokens"]
        del payload["max_tokens"]

    # PORTICO PATCH: Removed system→developer role conversion
    # OpenAI's "developer" role was causing issues:
    # 1. Only first system message was converted, leaving others as "system"
    # 2. Debug monitor filters for "system" role, missing "developer" messages
    # 3. Inconsistent behavior between Atlas and GPT models
    # Standard "system" role works fine for all GPT models via the bridge

    return payload


def _is_lm_studio_api_config(api_config: Optional[dict]) -> bool:
    if not isinstance(api_config, dict):
        return False
    provider_values = [
        api_config.get("portico_provider"),
        api_config.get("local_provider"),
        api_config.get("connection_type"),
    ]
    return any(
        str(value or "").strip().lower().replace("-", "_") in {"lm_studio", "lmstudio"}
        for value in provider_values
    )


def _strip_lm_studio_generated_token_limits(payload: dict, model_params: Optional[dict]) -> None:
    if not isinstance(payload, dict):
        return
    explicit_model_limit = isinstance(model_params, dict) and any(
        key in model_params for key in ("max_tokens", "max_completion_tokens")
    )
    if explicit_model_limit:
        return
    payload.pop("max_tokens", None)
    payload.pop("max_completion_tokens", None)


AUTHORIZATION_SCHEME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9._~+\-/]*\s+.+$")


def _normalize_authorization_header(headers: dict[str, str] | None) -> dict[str, str]:
    normalized = dict(headers or {})
    auth_key = next(
        (
            key
            for key in normalized
            if isinstance(key, str) and key.lower() == "authorization"
        ),
        None,
    )
    if not auth_key:
        return normalized

    auth_value = normalized.get(auth_key)
    if not isinstance(auth_value, str):
        return normalized

    auth_value = auth_value.strip()
    if not auth_value:
        return normalized

    if auth_value.lower() in {"bearer", "basic"}:
        return normalized

    if AUTHORIZATION_SCHEME_PATTERN.match(auth_value):
        return normalized

    normalized[auth_key] = f"Bearer {auth_value}"
    return normalized


def _is_malformed_authorization_override(value: Any) -> bool:
    if not isinstance(value, str):
        return True
    normalized = value.strip()
    if not normalized:
        return True
    return normalized.lower() in {"bearer", "basic"}


def _merge_config_headers(
    base_headers: dict[str, str],
    config_headers: dict[str, Any] | None,
) -> dict[str, str]:
    merged = dict(base_headers or {})
    if not isinstance(config_headers, dict):
        return merged

    for key, value in config_headers.items():
        if isinstance(key, str) and key.lower() == "authorization":
            if _is_malformed_authorization_override(value):
                continue
            merged["Authorization"] = str(value).strip()
            continue
        merged[key] = value
    return merged



async def get_headers_and_cookies(
    request: Request,
    url,
    key=None,
    config=None,
    metadata: Optional[dict] = None,
    user: UserModel = None,
):
    cookies = {}
    headers = {
        "Content-Type": "application/json",
        **(
            {
                "HTTP-Referer": "https://openwebui.com/",
                "X-Title": "Open WebUI",
            }
            if "openrouter.ai" in url
            else {}
        ),
    }

    if ENABLE_FORWARD_USER_INFO_HEADERS and user:
        headers = include_user_info_headers(headers, user)
        if metadata and metadata.get("chat_id"):
            headers["X-OpenWebUI-Chat-Id"] = metadata.get("chat_id")

    headers = _inject_openwebui_affinity_headers(headers, metadata)
    headers = _inject_trace_headers(headers, request)

    token = None
    auth_type = config.get("auth_type")

    if auth_type == "bearer" or auth_type is None:
        # Default to bearer if not specified
        token = f"{key}"
    elif auth_type == "none":
        token = None
    elif auth_type == "session":
        cookies = request.cookies
        token = request.state.token.credentials
    elif auth_type == "system_oauth":
        cookies = request.cookies

        oauth_token = None
        try:
            if request.cookies.get("oauth_session_id", None):
                oauth_token = await request.app.state.oauth_manager.get_oauth_token(
                    user.id,
                    request.cookies.get("oauth_session_id", None),
                )
        except Exception as e:
            log.error(f"Error getting OAuth token: {e}")

        if oauth_token:
            token = f"{oauth_token.get('access_token', '')}"

    elif auth_type in ("azure_ad", "microsoft_entra_id"):
        token = get_microsoft_entra_id_access_token()

    token = token.strip() if isinstance(token, str) else token
    if token:
        headers["Authorization"] = f"Bearer {token}"

    headers = _merge_config_headers(headers, config.get("headers"))
    headers = _normalize_authorization_header(headers)

    return headers, cookies


def get_microsoft_entra_id_access_token():
    """
    Get Microsoft Entra ID access token using DefaultAzureCredential for Azure OpenAI.
    Returns the token string or None if authentication fails.
    """
    if DefaultAzureCredential is None or get_bearer_token_provider is None:
        log.error(
            "azure-identity is not installed but Microsoft Entra ID auth was requested"
        )
        return None

    try:
        token_provider = get_bearer_token_provider(
            DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default"
        )
        return token_provider()
    except Exception as e:
        log.error(f"Error getting Microsoft Entra ID access token: {e}")
        return None


##########################################
#
# API routes
#
##########################################

router = APIRouter()


_LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE = (
    "Internal tool follow-up for the same assistant turn. "
    "No new user message was sent. Continue the current answer using the "
    "existing conversation and the tool results below."
)


def _strip_legacy_followup_system_fragment(text: str | None) -> str:
    if not isinstance(text, str) or not text:
        return text or ""
    cleaned = text.replace(_LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE, "")
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _sanitize_legacy_followup_system_messages(
    messages: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return messages or []

    cleaned_messages: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            cleaned_messages.append(message)
            continue
        if message.get("role") != "system":
            cleaned_messages.append(message)
            continue
        next_message = dict(message)
        next_message["content"] = _strip_legacy_followup_system_fragment(
            next_message.get("content")
        )
        cleaned_messages.append(next_message)
    return cleaned_messages


@router.get("/config")
async def get_config(request: Request, user=Depends(get_admin_user)):
    return {
        "ENABLE_OPENAI_API": request.app.state.config.ENABLE_OPENAI_API,
        "OPENAI_API_BASE_URLS": request.app.state.config.OPENAI_API_BASE_URLS,
        "OPENAI_API_KEYS": request.app.state.config.OPENAI_API_KEYS,
        "OPENAI_API_CONFIGS": request.app.state.config.OPENAI_API_CONFIGS,
    }


class OpenAIConfigForm(BaseModel):
    ENABLE_OPENAI_API: Optional[bool] = None
    OPENAI_API_BASE_URLS: list[str]
    OPENAI_API_KEYS: list[str]
    OPENAI_API_CONFIGS: dict


@router.post("/config/update")
async def update_config(
    request: Request, form_data: OpenAIConfigForm, user=Depends(get_admin_user)
):
    request.app.state.config.ENABLE_OPENAI_API = form_data.ENABLE_OPENAI_API
    request.app.state.config.OPENAI_API_BASE_URLS = form_data.OPENAI_API_BASE_URLS
    request.app.state.config.OPENAI_API_KEYS = form_data.OPENAI_API_KEYS

    # Check if API KEYS length is same than API URLS length
    if len(request.app.state.config.OPENAI_API_KEYS) != len(
        request.app.state.config.OPENAI_API_BASE_URLS
    ):
        if len(request.app.state.config.OPENAI_API_KEYS) > len(
            request.app.state.config.OPENAI_API_BASE_URLS
        ):
            request.app.state.config.OPENAI_API_KEYS = (
                request.app.state.config.OPENAI_API_KEYS[
                    : len(request.app.state.config.OPENAI_API_BASE_URLS)
                ]
            )
        else:
            request.app.state.config.OPENAI_API_KEYS += [""] * (
                len(request.app.state.config.OPENAI_API_BASE_URLS)
                - len(request.app.state.config.OPENAI_API_KEYS)
            )

    request.app.state.config.OPENAI_API_CONFIGS = form_data.OPENAI_API_CONFIGS

    # Remove the API configs that are not in the API URLS
    keys = list(map(str, range(len(request.app.state.config.OPENAI_API_BASE_URLS))))
    request.app.state.config.OPENAI_API_CONFIGS = {
        key: value
        for key, value in request.app.state.config.OPENAI_API_CONFIGS.items()
        if key in keys
    }

    return {
        "ENABLE_OPENAI_API": request.app.state.config.ENABLE_OPENAI_API,
        "OPENAI_API_BASE_URLS": request.app.state.config.OPENAI_API_BASE_URLS,
        "OPENAI_API_KEYS": request.app.state.config.OPENAI_API_KEYS,
        "OPENAI_API_CONFIGS": request.app.state.config.OPENAI_API_CONFIGS,
    }


@router.post("/audio/speech")
async def speech(request: Request, user=Depends(get_verified_user)):
    idx = None
    try:
        idx = request.app.state.config.OPENAI_API_BASE_URLS.index(
            "https://api.openai.com/v1"
        )

        body = await request.body()
        name = hashlib.sha256(body).hexdigest()

        SPEECH_CACHE_DIR = CACHE_DIR / "audio" / "speech"
        SPEECH_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        file_path = SPEECH_CACHE_DIR.joinpath(f"{name}.mp3")
        file_body_path = SPEECH_CACHE_DIR.joinpath(f"{name}.json")

        # Check if the file already exists in the cache
        if file_path.is_file():
            return FileResponse(file_path)

        url = request.app.state.config.OPENAI_API_BASE_URLS[idx]
        key = request.app.state.config.OPENAI_API_KEYS[idx]
        api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
            str(idx),
            request.app.state.config.OPENAI_API_CONFIGS.get(url, {}),  # Legacy support
        )

        headers, cookies = await get_headers_and_cookies(
            request, url, key, api_config, user=user
        )

        r = None
        try:
            r = requests.post(
                url=f"{url}/audio/speech",
                data=body,
                headers=headers,
                cookies=cookies,
                stream=True,
            )

            r.raise_for_status()

            # Save the streaming content to a file
            with open(file_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)

            with open(file_body_path, "w") as f:
                json.dump(json.loads(body.decode("utf-8")), f)

            # Return the saved file
            return FileResponse(file_path)

        except Exception as e:
            log.exception(e)

            detail = None
            if r is not None:
                try:
                    res = r.json()
                    if "error" in res:
                        detail = f"External: {res['error']}"
                except Exception:
                    detail = f"External: {e}"

            raise HTTPException(
                status_code=r.status_code if r else 500,
                detail=detail if detail else "Open WebUI: Server Connection Error",
            )

    except ValueError:
        raise HTTPException(status_code=401, detail=ERROR_MESSAGES.OPENAI_NOT_FOUND)


async def get_all_models_responses(request: Request, user: UserModel) -> list:
    if not request.app.state.config.ENABLE_OPENAI_API:
        return []

    # Check if API KEYS length is same than API URLS length
    num_urls = len(request.app.state.config.OPENAI_API_BASE_URLS)
    num_keys = len(request.app.state.config.OPENAI_API_KEYS)

    if num_keys != num_urls:
        # if there are more keys than urls, remove the extra keys
        if num_keys > num_urls:
            new_keys = request.app.state.config.OPENAI_API_KEYS[:num_urls]
            request.app.state.config.OPENAI_API_KEYS = new_keys
        # if there are more urls than keys, add empty keys
        else:
            request.app.state.config.OPENAI_API_KEYS += [""] * (num_urls - num_keys)

    request_tasks = []
    for idx, url in enumerate(request.app.state.config.OPENAI_API_BASE_URLS):
        if (str(idx) not in request.app.state.config.OPENAI_API_CONFIGS) and (
            url not in request.app.state.config.OPENAI_API_CONFIGS  # Legacy support
        ):
            request_tasks.append(
                send_get_request(
                    f"{url}/models",
                    request.app.state.config.OPENAI_API_KEYS[idx],
                    user=user,
                )
            )
        else:
            api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
                str(idx),
                request.app.state.config.OPENAI_API_CONFIGS.get(
                    url, {}
                ),  # Legacy support
            )

            enable = api_config.get("enable", True)
            model_ids = api_config.get("model_ids", [])

            if enable:
                if len(model_ids) == 0:
                    request_tasks.append(
                        send_get_request(
                            f"{url}/models",
                            request.app.state.config.OPENAI_API_KEYS[idx],
                            user=user,
                        )
                    )
                else:
                    model_list = {
                        "object": "list",
                        "data": [
                            {
                                "id": model_id,
                                "name": model_id,
                                "owned_by": "openai",
                                "openai": {"id": model_id},
                                "urlIdx": idx,
                            }
                            for model_id in model_ids
                        ],
                    }

                    request_tasks.append(
                        asyncio.ensure_future(asyncio.sleep(0, model_list))
                    )
            else:
                request_tasks.append(asyncio.ensure_future(asyncio.sleep(0, None)))

    responses = await asyncio.gather(*request_tasks)

    for idx, response in enumerate(responses):
        if response:
            url = request.app.state.config.OPENAI_API_BASE_URLS[idx]
            api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
                str(idx),
                request.app.state.config.OPENAI_API_CONFIGS.get(
                    url, {}
                ),  # Legacy support
            )

            connection_type = api_config.get("connection_type", "external")
            prefix_id = api_config.get("prefix_id", None)
            tags = api_config.get("tags", [])

            model_list = (
                response if isinstance(response, list) else response.get("data", [])
            )
            if not isinstance(model_list, list):
                # Catch non-list responses
                model_list = []

            for model in model_list:
                # Remove name key if its value is None #16689
                if "name" in model and model["name"] is None:
                    del model["name"]

                if prefix_id:
                    model["id"] = (
                        f"{prefix_id}.{model.get('id', model.get('name', ''))}"
                    )

                if tags:
                    model["tags"] = tags

                if connection_type:
                    model["connection_type"] = connection_type

    log.debug(f"get_all_models:responses() {responses}")
    return responses


async def get_filtered_models(models, user):
    # Filter models based on user access control
    filtered_models = []
    for model in models.get("data", []):
        model_info = Models.get_model_by_id(model["id"])
        if model_info:
            if user.id == model_info.user_id or has_access(
                user.id, type="read", access_control=model_info.access_control
            ):
                filtered_models.append(model)
    return filtered_models


@cached(
    ttl=MODELS_CACHE_TTL,
    key=lambda _, user: f"openai_all_models_{user.id}" if user else "openai_all_models",
)
async def get_all_models(request: Request, user: UserModel) -> dict[str, list]:
    log.info("get_all_models()")

    if not request.app.state.config.ENABLE_OPENAI_API:
        return {"data": []}

    responses = await get_all_models_responses(request, user=user)

    def extract_data(response):
        if response and "data" in response:
            return response["data"]
        if isinstance(response, list):
            return response
        return None

    def is_supported_openai_models(model_id):
        if any(
            name in model_id
            for name in [
                "babbage",
                "dall-e",
                "davinci",
                "embedding",
                "tts",
                "whisper",
            ]
        ):
            return False
        return True

    def is_lm_studio_embedding_model_id(model_id):
        normalized = str(model_id or "").strip().lower()
        return (
            "embedding" in normalized
            or "text-embedding" in normalized
            or "embed" in normalized
            or "rerank" in normalized
            or "ranker" in normalized
        )

    def get_merged_models(model_lists):
        log.debug(f"merge_models_lists {model_lists}")
        models = {}
        rag_embedding_model_id = (request.app.state.config.RAG_EMBEDDING_MODEL or "").strip().lower()

        def is_rag_embedding_model(model_id: str) -> bool:
            if not rag_embedding_model_id:
                return False

            candidate = str(model_id or "").strip().lower()
            return (
                candidate == rag_embedding_model_id
                or candidate.endswith(f"/{rag_embedding_model_id}")
                or candidate.endswith(f":{rag_embedding_model_id}")
            )

        for idx, model_list in enumerate(model_lists):
            if model_list is not None and "error" not in model_list:
                for model in model_list:
                    model_id = model.get("id") or model.get("name")

                    if is_rag_embedding_model(model_id):
                        continue

                    if (
                        "api.openai.com"
                        in request.app.state.config.OPENAI_API_BASE_URLS[idx]
                        and not is_supported_openai_models(model_id)
                    ):
                        # Skip unwanted OpenAI models
                        continue

                    api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
                        str(idx),
                        request.app.state.config.OPENAI_API_CONFIGS.get(
                            request.app.state.config.OPENAI_API_BASE_URLS[idx], {}
                        ),
                    )
                    if _is_lm_studio_api_config(api_config) and is_lm_studio_embedding_model_id(model_id):
                        continue

                    if model_id and model_id not in models:
                        models[model_id] = _apply_internal_gateway_capability_overrides(
                            {
                                **model,
                                "name": model.get("name", model_id),
                                "owned_by": "openai",
                                "openai": model,
                                "connection_type": model.get(
                                    "connection_type", "external"
                                ),
                                "urlIdx": idx,
                            },
                            request.app.state.config.OPENAI_API_BASE_URLS[idx],
                        )

        return models

    models = get_merged_models(map(extract_data, responses))
    log.debug(f"models: {models}")

    request.app.state.OPENAI_MODELS = models
    return {"data": list(models.values())}


@router.get("/models")
@router.get("/models/{url_idx}")
async def get_models(
    request: Request, url_idx: Optional[int] = None, user=Depends(get_verified_user)
):
    models = {
        "data": [],
    }

    if url_idx is None:
        models = await get_all_models(request, user=user)
    else:
        url = request.app.state.config.OPENAI_API_BASE_URLS[url_idx]
        key = request.app.state.config.OPENAI_API_KEYS[url_idx]

        api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
            str(url_idx),
            request.app.state.config.OPENAI_API_CONFIGS.get(url, {}),  # Legacy support
        )

        r = None
        async with aiohttp.ClientSession(
            trust_env=_aiohttp_trust_env_for_url(url),
            timeout=aiohttp.ClientTimeout(total=AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST),
        ) as session:
            try:
                headers, cookies = await get_headers_and_cookies(
                    request, url, key, api_config, user=user
                )

                if api_config.get("azure", False):
                    models = {
                        "data": api_config.get("model_ids", []) or [],
                        "object": "list",
                    }
                else:
                    async with session.get(
                        f"{url}/models",
                        headers=headers,
                        cookies=cookies,
                        ssl=AIOHTTP_CLIENT_SESSION_SSL,
                    ) as r:
                        if r.status != 200:
                            # Extract response error details if available
                            error_detail = f"HTTP Error: {r.status}"
                            res = await r.json()
                            if "error" in res:
                                error_detail = f"External Error: {res['error']}"
                            raise Exception(error_detail)

                        response_data = await r.json()

                        # Check if we're calling OpenAI API based on the URL
                        if "api.openai.com" in url:
                            # Filter models according to the specified conditions
                            response_data["data"] = [
                                model
                                for model in response_data.get("data", [])
                                if not any(
                                    name in model["id"]
                                    for name in [
                                        "babbage",
                                        "dall-e",
                                        "davinci",
                                        "embedding",
                                        "tts",
                                        "whisper",
                                    ]
                                )
                            ]

                        models = response_data
            except aiohttp.ClientError as e:
                # ClientError covers all aiohttp requests issues
                log.exception(f"Client error: {str(e)}")
                raise HTTPException(
                    status_code=500, detail="Open WebUI: Server Connection Error"
                )
            except Exception as e:
                log.exception(f"Unexpected error: {e}")
                error_detail = f"Unexpected error: {str(e)}"
                raise HTTPException(status_code=500, detail=error_detail)

    if user.role == "user" and not BYPASS_MODEL_ACCESS_CONTROL:
        models["data"] = await get_filtered_models(models, user)

    return models


class ConnectionVerificationForm(BaseModel):
    url: str
    key: str

    config: Optional[dict] = None


@router.post("/verify")
async def verify_connection(
    request: Request,
    form_data: ConnectionVerificationForm,
    user=Depends(get_admin_user),
):
    url = form_data.url
    key = form_data.key

    api_config = form_data.config or {}

    async with aiohttp.ClientSession(
        trust_env=_aiohttp_trust_env_for_url(url),
        timeout=aiohttp.ClientTimeout(total=AIOHTTP_CLIENT_TIMEOUT_MODEL_LIST),
    ) as session:
        try:
            headers, cookies = await get_headers_and_cookies(
                request, url, key, api_config, user=user
            )

            if api_config.get("azure", False):
                # Only set api-key header if not using Azure Entra ID authentication
                auth_type = api_config.get("auth_type", "bearer")
                if auth_type not in ("azure_ad", "microsoft_entra_id"):
                    headers["api-key"] = key

                api_version = api_config.get("api_version", "") or "2023-03-15-preview"
                async with session.get(
                    url=f"{url}/openai/models?api-version={api_version}",
                    headers=headers,
                    cookies=cookies,
                    ssl=AIOHTTP_CLIENT_SESSION_SSL,
                ) as r:
                    try:
                        response_data = await r.json()
                    except Exception:
                        response_data = await r.text()

                    if r.status != 200:
                        if isinstance(response_data, (dict, list)):
                            return JSONResponse(
                                status_code=r.status, content=response_data
                            )
                        else:
                            return PlainTextResponse(
                                status_code=r.status, content=response_data
                            )

                    return response_data
            else:
                async with session.get(
                    f"{url}/models",
                    headers=headers,
                    cookies=cookies,
                    ssl=AIOHTTP_CLIENT_SESSION_SSL,
                ) as r:
                    try:
                        response_data = await r.json()
                    except Exception:
                        response_data = await r.text()

                    if r.status != 200:
                        if isinstance(response_data, (dict, list)):
                            return JSONResponse(
                                status_code=r.status, content=response_data
                            )
                        else:
                            return PlainTextResponse(
                                status_code=r.status, content=response_data
                            )

                    return response_data

        except aiohttp.ClientError as e:
            # ClientError covers all aiohttp requests issues
            log.exception(f"Client error: {str(e)}")
            raise HTTPException(
                status_code=500, detail="Open WebUI: Server Connection Error"
            )
        except Exception as e:
            log.exception(f"Unexpected error: {e}")
            raise HTTPException(
                status_code=500, detail="Open WebUI: Server Connection Error"
            )


def get_azure_allowed_params(api_version: str) -> set[str]:
    allowed_params = {
        "messages",
        "temperature",
        "role",
        "content",
        "contentPart",
        "contentPartImage",
        "enhancements",
        "dataSources",
        "n",
        "stream",
        "stop",
        "max_tokens",
        "presence_penalty",
        "frequency_penalty",
        "logit_bias",
        "user",
        "function_call",
        "functions",
        "tools",
        "tool_choice",
        "top_p",
        "log_probs",
        "top_logprobs",
        "response_format",
        "seed",
        "max_completion_tokens",
        "reasoning_effort",
    }

    try:
        if api_version >= "2024-09-01-preview":
            allowed_params.add("stream_options")
    except ValueError:
        log.debug(
            f"Invalid API version {api_version} for Azure OpenAI. Defaulting to allowed parameters."
        )

    return allowed_params


def is_openai_reasoning_model(model: str) -> bool:
    return model.lower().startswith(("o1", "o3", "o4", "gpt-5"))


def convert_to_azure_payload(url, payload: dict, api_version: str):
    model = payload.get("model", "")

    # Filter allowed parameters based on Azure OpenAI API
    allowed_params = get_azure_allowed_params(api_version)

    # Special handling for o-series models
    if is_openai_reasoning_model(model):
        # Convert max_tokens to max_completion_tokens for o-series models
        if "max_tokens" in payload:
            payload["max_completion_tokens"] = payload["max_tokens"]
            del payload["max_tokens"]

        # Remove temperature if not 1 for o-series models
        if "temperature" in payload and payload["temperature"] != 1:
            log.debug(
                f"Removing temperature parameter for o-series model {model} as only default value (1) is supported"
            )
            del payload["temperature"]

    # Filter out unsupported parameters
    payload = {k: v for k, v in payload.items() if k in allowed_params}

    url = f"{url}/openai/deployments/{model}"
    return url, payload


@router.post("/chat/completions")
async def generate_chat_completion(
    request: Request,
    form_data: dict,
    user=Depends(get_verified_user),
    bypass_filter: Optional[bool] = False,
):
    if BYPASS_MODEL_ACCESS_CONTROL:
        bypass_filter = True

    idx = 0

    payload = {**form_data}
    metadata = payload.pop("metadata", None)

    model_id = form_data.get("model")
    requested_model_id = model_id
    model_info = Models.get_model_by_id(model_id)
    model_params = {}
    resolved_base_model_id = None

    # Check model info and override the payload
    if model_info:
        if model_info.base_model_id:
            resolved_base_model_id = (
                request.base_model_id
                if hasattr(request, "base_model_id")
                else model_info.base_model_id
            )  # Use request's base_model_id if available
            payload["model"] = resolved_base_model_id
            model_id = resolved_base_model_id

        params = model_info.params.model_dump()
        model_params = dict(params or {})

        if params:
            system = params.pop("system", None)

            # PORTICO PATCH: Inject base system prompt for custom agents
            # This prepends the shared base prompt (from agents/base_system_prompt.md)
            # to the custom agent's specific system prompt
            if model_info.base_model_id and system:
                try:
                    base_prompt_path = "/app/agents/base_system_prompt.md"
                    with open(base_prompt_path, 'r') as f:
                        base_system_prompt = f.read().strip()
                    if base_system_prompt and not system.startswith("# Portico"):
                        system = f"{base_system_prompt}\n\n---\n\n## Custom Agent Instructions\n\n{system}"
                        log.info(f"Prepended base system prompt for custom agent (base_model: {model_info.base_model_id})")
                except Exception as e:
                    log.warning(f"Failed to load base system prompt: {e}")

            payload = apply_model_params_to_body_openai(params, payload)
            payload["messages"] = _sanitize_legacy_followup_system_messages(
                payload.get("messages", [])
            )

            _log_system_prompt_debug_summary(
                "before_apply_system_prompt_to_body",
                model_id,
                system,
                payload.get("messages", []),
            )

            system = merge_model_and_request_system_prompt(
                system, payload.get("messages", [])
            )
            system = _strip_legacy_followup_system_fragment(system)

            # PORTICO PATCH: Use replace=True to prevent telescoping system prompt duplication
            payload = apply_system_prompt_to_body(system, payload, metadata, user, replace=True)

            _log_system_prompt_debug_summary(
                "after_apply_system_prompt_to_body",
                model_id,
                system,
                payload.get("messages", []),
            )

        # Check if user has access to the model
        if not bypass_filter and user.role == "user":
            if not (
                user.id == model_info.user_id
                or has_access(
                    user.id, type="read", access_control=model_info.access_control
                )
            ):
                raise HTTPException(
                    status_code=403,
                    detail="Model not found",
                )
    elif not bypass_filter:
        if user.role != "admin":
            raise HTTPException(
                status_code=403,
                detail="Model not found",
            )

    await get_all_models(request, user=user)
    model = request.app.state.OPENAI_MODELS.get(model_id)
    if model:
        idx = model["urlIdx"]
    else:
        raise HTTPException(
            status_code=404,
            detail="Model not found",
        )

    # Get the API config for the model
    api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
        str(idx),
        request.app.state.config.OPENAI_API_CONFIGS.get(
            request.app.state.config.OPENAI_API_BASE_URLS[idx], {}
        ),  # Legacy support
    )

    prefix_id = api_config.get("prefix_id", None)
    if prefix_id:
        payload["model"] = payload["model"].replace(f"{prefix_id}.", "")

    model_aliases = api_config.get("model_aliases") or api_config.get(
        "lm_studio_model_aliases"
    )
    if isinstance(model_aliases, dict):
        payload["model"] = model_aliases.get(payload["model"], payload["model"])

    if _is_lm_studio_api_config(api_config):
        _strip_lm_studio_generated_token_limits(payload, model_params)

    # Add user info to the payload if the model is a pipeline
    if "pipeline" in model and model.get("pipeline"):
        payload["user"] = {
            "name": user.name,
            "id": user.id,
            "email": user.email,
            "role": user.role,
        }

    url = request.app.state.config.OPENAI_API_BASE_URLS[idx]
    key = request.app.state.config.OPENAI_API_KEYS[idx]

    # Check if model is a reasoning model that needs special handling
    if is_openai_reasoning_model(payload["model"]):
        payload = openai_reasoning_model_handler(payload)
    elif "api.openai.com" not in url:
        # Remove "max_completion_tokens" from the payload for backward compatibility
        if "max_completion_tokens" in payload:
            payload["max_tokens"] = payload["max_completion_tokens"]
            del payload["max_completion_tokens"]

    if "max_tokens" in payload and "max_completion_tokens" in payload:
        del payload["max_tokens"]

    # Convert the modified body back to JSON
    if "logit_bias" in payload and payload["logit_bias"]:
        logit_bias = convert_logit_bias_input_to_json(payload["logit_bias"])

        if logit_bias:
            payload["logit_bias"] = json.loads(logit_bias)

    ultra_candidate = is_ultra_request(payload)

    if ultra_candidate:
        headers, cookies = {}, {}
    else:
        headers, cookies = await get_headers_and_cookies(
            request, url, key, api_config, metadata, user=user
        )

    if api_config.get("azure", False):
        if ultra_candidate:
            raise HTTPException(status_code=400, detail="Ultra does not support Azure routes")
        api_version = api_config.get("api_version", "2023-03-15-preview")
        request_url, payload = convert_to_azure_payload(url, payload, api_version)

        # Only set api-key header if not using Azure Entra ID authentication
        auth_type = api_config.get("auth_type", "bearer")
        if auth_type not in ("azure_ad", "microsoft_entra_id"):
            headers["api-key"] = key

        headers["api-version"] = api_version
        request_url = f"{request_url}/chat/completions?api-version={api_version}"
    else:
        request_url = f"{url}/chat/completions"

    event_emitter = get_event_emitter(metadata) if metadata else None
    cancel_key = build_rate_limit_cancel_key(
        user.id,
        metadata.get("chat_id") if metadata else None,
        metadata.get("message_id") if metadata else None,
    )
    cancel_event = await register_rate_limit_cancel(cancel_key) if cancel_key else None
    payload_model = payload.get("model")
    debug_model = requested_model_id or payload_model or "unknown"
    debug_base_model = resolved_base_model_id or (
        model_info.base_model_id if model_info else None
    )
    task_name = metadata.get("task") if metadata else None
    suppress_rate_limit_events = is_auxiliary_task_name(task_name)
    rate_limit_emitter = None if suppress_rate_limit_events else event_emitter
    effective_stream = (
        payload.get("stream")
        if isinstance(payload, dict) and "stream" in payload
        else (
            form_data.get("stream")
            if isinstance(form_data, dict) and "stream" in form_data
            else True
        )
    )

    # Bifrost derives prompt-cache affinity from headers, while GPT-4.1 rejects
    # provider-visible body metadata unless store=true.
    if not ultra_candidate and metadata and _should_embed_metadata_in_payload():
        serializable_metadata = {}
        # Only copy the specific fields we need for debug monitoring
        for key in (
            "chat_id",
            "session_id",
            "message_id",
            "request_phase",
            "followup_index",
            "outer_message_id",
            "trigger_message_id",
            "transcript_anchor_kind",
            "transcript_anchor_message_id",
            "transcript_anchor_tool_block_index",
            "prompt_submitted_at_ms",
            "user_id",
            "debug_request_id",
            "upstream_request_id",
        ):
            if key in metadata and metadata[key] is not None:
                serializable_metadata[key] = metadata[key]
        if serializable_metadata:
            payload["metadata"] = serializable_metadata

    if (
        not ultra_candidate
        and _ensure_llm_debug_event_publisher_available()
        and isinstance(metadata, dict)
        and metadata.get("chat_id")
        and metadata.get("session_id")
    ):
        try:
            published = await publish_request_start(
                session_id=metadata.get("session_id"),
                chat_id=metadata.get("chat_id"),
                model=debug_model,
                base_model=debug_base_model,
                message_count=len(payload.get("messages", [])),
                tool_ids=metadata.get("tool_ids"),
                skills=metadata.get("skills"),
                metadata=metadata,
                debug_request_id=metadata.get("debug_request_id"),
                upstream_request_id=metadata.get("upstream_request_id"),
                task_name=task_name,
                request_phase=metadata.get("request_phase"),
                followup_index=metadata.get("followup_index"),
                outer_message_id=metadata.get("outer_message_id"),
                trigger_message_id=metadata.get("trigger_message_id"),
                transcript_anchor_kind=metadata.get("transcript_anchor_kind"),
                transcript_anchor_message_id=metadata.get(
                    "transcript_anchor_message_id"
                ),
                transcript_anchor_tool_block_index=metadata.get(
                    "transcript_anchor_tool_block_index"
                ),
                prompt_submitted_at_ms=metadata.get("prompt_submitted_at_ms"),
                traceparent=request.headers.get("traceparent"),
                tracestate_present=bool(request.headers.get("tracestate")),
                baggage_present=bool(request.headers.get("baggage")),
            )
            if not published:
                log.warning(
                    "[LLM_DEBUG_MONITOR] Request start publish returned false chat_id=%s upstream_request_id=%s",
                    metadata.get("chat_id"),
                    metadata.get("upstream_request_id"),
                )
        except Exception as exc:
            log.warning(
                "[LLM_DEBUG_MONITOR] Failed to publish request start event: %s",
                exc,
            )

    payload_for_debug = payload
    if isinstance(payload_for_debug, dict) and payload_for_debug.get("stream") is None:
        payload_for_debug = {**payload_for_debug, "stream": bool(effective_stream)}

    if (
        not ultra_candidate
        and should_publish_bifrost_debug_request_payload(metadata, payload_for_debug)
    ):
        try:
            metadata_params = metadata.get("params")
            if not isinstance(metadata_params, dict):
                metadata_params = {}
            published = await publish_request_payload(
                session_id=metadata.get("session_id"),
                chat_id=metadata.get("chat_id"),
                model=debug_model,
                messages=payload_for_debug.get("messages", []),
                tools=payload_for_debug.get("tools", []),
                temperature=payload_for_debug.get("temperature"),
                max_tokens=(
                    payload_for_debug.get("max_tokens")
                    or payload_for_debug.get("max_completion_tokens")
                    or payload_for_debug.get("max_output_tokens")
                ),
                reasoning_effort=(
                    payload_for_debug.get("reasoning_effort")
                    or metadata_params.get("reasoning_effort")
                ),
                raw_payload=payload_for_debug,
                base_model=debug_base_model,
                debug_request_id=metadata.get("debug_request_id"),
                upstream_request_id=metadata.get("upstream_request_id"),
                task_name=task_name,
                request_phase=metadata.get("request_phase"),
                followup_index=metadata.get("followup_index"),
                outer_message_id=metadata.get("outer_message_id"),
                trigger_message_id=metadata.get("trigger_message_id"),
                transcript_anchor_kind=metadata.get("transcript_anchor_kind"),
                transcript_anchor_message_id=metadata.get(
                    "transcript_anchor_message_id"
                ),
                transcript_anchor_tool_block_index=metadata.get(
                    "transcript_anchor_tool_block_index"
                ),
            )
            if not published:
                log.warning(
                    "[LLM_DEBUG_MONITOR] Request payload publish returned false chat_id=%s upstream_request_id=%s",
                    metadata.get("chat_id"),
                    metadata.get("upstream_request_id"),
                )
        except Exception as exc:
            log.warning(
                "[LLM_DEBUG_MONITOR] Failed to publish Bifrost request payload: %s",
                exc,
            )

    serialized_payload = json.dumps(payload)
    if ultra_candidate:
        headers, cookies = build_private_gateway_transport(url, key, request_url)
        await admit_and_sign_ultra_request(
            request, headers, serialized_payload, payload, user
        )
    payload = serialized_payload

    r = None
    session = None
    streaming = False
    response = None
    attempt = 1
    max_attempts = 1 if ultra_candidate else get_rate_limit_max_retries()

    try:
        session = aiohttp.ClientSession(
            trust_env=False if ultra_candidate else _aiohttp_trust_env_for_url(request_url),
            timeout=aiohttp.ClientTimeout(total=AIOHTTP_CLIENT_TIMEOUT),
            cookie_jar=(
                aiohttp.DummyCookieJar() if ultra_candidate else None
            ),
            skip_auto_headers=(
                {"User-Agent", "Accept", "Accept-Encoding"} if ultra_candidate else None
            ),
        )

        while True:
            rate_limit_status = None
            rate_limit_message = None
            rate_limit_payload = None
            retry_after_ms = None

            test_rate = 0 if ultra_candidate else get_rate_limit_test_rate()
            if test_rate > 0 and random.random() < test_rate:
                retry_after_sec = get_rate_limit_retry_after_sec()
                rate_limit_message = "Rate limit exceeded."
                rate_limit_payload = {
                    "error": {
                        "code": "apptokenratelimit",
                        "message": rate_limit_message,
                        "type": "rate_limit_exceeded",
                        "param": None,
                    }
                }
                retry_after_ms = retry_after_sec * 1000
                rate_limit_status = 429
                log.warning(
                    "[RATE-LIMIT-TEST] Injecting 429 for model %s (rate=%.2f)",
                    payload_model,
                    test_rate,
                )
            else:
                r = await session.request(
                    method="POST",
                    url=request_url,
                    allow_redirects=not ultra_candidate,
                    data=payload,
                    headers=headers,
                    cookies=cookies,
                    ssl=AIOHTTP_CLIENT_SESSION_SSL,
                )

                # Check if response is SSE
                if "text/event-stream" in r.headers.get("Content-Type", ""):
                    # PORTICO PATCH: Check for error status BEFORE creating StreamingResponse
                    # This catches rate limit (429) and other errors that would otherwise
                    # silently terminate the stream without user notification
                    if r.status >= 400:
                        status_code = r.status
                        retry_after_header = r.headers.get("Retry-After")
                        error_body = await r.content.read()
                        await cleanup_response(r, None)
                        r = None
                        try:
                            rate_limit_payload = json.loads(error_body)
                            rate_limit_message = extract_error_message(
                                rate_limit_payload
                            )
                        except Exception:
                            rate_limit_message = error_body.decode(
                                "utf-8", errors="replace"
                            )
                            rate_limit_payload = rate_limit_message

                        if is_rate_limit_error(status_code, rate_limit_payload):
                            rate_limit_status = status_code
                            retry_after_ms = parse_retry_after_header(
                                retry_after_header
                            )
                            if retry_after_ms is None:
                                retry_after_ms = parse_retry_after_from_text(
                                    rate_limit_message
                                )
                        else:
                            log.warning(
                                "LLM API error (HTTP %s): %s",
                                status_code,
                                rate_limit_message,
                            )
                            if attempt > 1:
                                await emit_rate_limit_event(
                                    rate_limit_emitter,
                                    "failed",
                                    attempt,
                                    max_attempts,
                                )
                            return JSONResponse(
                                status_code=status_code,
                                content={
                                    "error": {
                                        "message": rate_limit_message,
                                        "type": "api_error",
                                        "code": status_code,
                                    }
                                },
                            )
                    else:
                        if attempt > 1:
                            await emit_rate_limit_event(
                                rate_limit_emitter,
                                "succeeded",
                                attempt,
                                max_attempts,
                            )
                        streaming = True
                        return StreamingResponse(
                            stream_chunks_handler(r.content),
                            status_code=r.status,
                            headers=dict(r.headers),
                            background=BackgroundTask(
                                cleanup_response, response=r, session=session
                            ),
                        )
                else:
                    try:
                        response = await r.json()
                    except Exception as e:
                        log.error(e)
                        response = await r.text()

                    if r.status >= 400:
                        rate_limit_payload = response
                        if is_rate_limit_error(r.status, rate_limit_payload):
                            rate_limit_status = r.status
                            rate_limit_message = (
                                extract_error_message(rate_limit_payload)
                                if isinstance(rate_limit_payload, dict)
                                else str(rate_limit_payload)
                            )
                            retry_after_ms = parse_retry_after_header(
                                r.headers.get("Retry-After")
                            )
                            if retry_after_ms is None:
                                retry_after_ms = parse_retry_after_from_text(
                                    rate_limit_message
                                )
                        else:
                            if attempt > 1:
                                await emit_rate_limit_event(
                                    rate_limit_emitter,
                                    "failed",
                                    attempt,
                                    max_attempts,
                                )
                            if isinstance(response, (dict, list)):
                                return JSONResponse(
                                    status_code=r.status, content=response
                                )
                            else:
                                return PlainTextResponse(
                                    status_code=r.status, content=response
                                )
                    else:
                        if attempt > 1:
                            await emit_rate_limit_event(
                                rate_limit_emitter,
                                "succeeded",
                                attempt,
                                max_attempts,
                            )
                        return response

            if rate_limit_status is None:
                continue

            if r:
                await cleanup_response(r, None)

            if rate_limit_message:
                log.warning(
                    "LLM rate limit (HTTP %s): %s",
                    rate_limit_status,
                    rate_limit_message,
                )

            if cancel_event and cancel_event.is_set():
                await emit_rate_limit_event(
                    rate_limit_emitter,
                    "canceled",
                    attempt,
                    max_attempts,
                )
                return build_rate_limit_error_response(
                    "Rate limit retry canceled.",
                    error_type="rate_limit_canceled",
                    status_code=499,
                )

            if attempt >= max_attempts:
                if attempt > 1:
                    await emit_rate_limit_event(
                        rate_limit_emitter,
                        "failed",
                        attempt,
                        max_attempts,
                    )
                return build_rate_limit_error_response(
                    "Rate limit exceeded.",
                    retry_after_ms=retry_after_ms,
                )

            next_attempt = attempt + 1
            retry_index = next_attempt - 1
            wait_ms = compute_backoff_delay_ms(retry_after_ms, retry_index)
            log.warning(
                "[RATE-LIMIT] Backoff attempt %s/%s, waiting %sms",
                next_attempt,
                max_attempts,
                wait_ms,
            )
            await emit_rate_limit_event(
                rate_limit_emitter,
                "waiting",
                next_attempt,
                max_attempts,
                retry_after_ms=retry_after_ms,
                wait_ms=wait_ms,
            )

            if wait_ms > 0:
                if cancel_event:
                    canceled = await wait_for_rate_limit_cancel(
                        cancel_event, wait_ms / 1000
                    )
                else:
                    await asyncio.sleep(wait_ms / 1000)
                    canceled = False
            else:
                canceled = cancel_event.is_set() if cancel_event else False

            if canceled:
                await emit_rate_limit_event(
                    rate_limit_emitter,
                    "canceled",
                    next_attempt,
                    max_attempts,
                )
                return build_rate_limit_error_response(
                    "Rate limit retry canceled.",
                    error_type="rate_limit_canceled",
                    status_code=499,
                )

            await emit_rate_limit_event(
                rate_limit_emitter,
                "retrying",
                next_attempt,
                max_attempts,
            )
            attempt = next_attempt
    except Exception as e:
        log.exception(e)

        raise HTTPException(
            status_code=r.status if r else 500,
            detail="Open WebUI: Server Connection Error",
        )
    finally:
        if not streaming:
            await cleanup_response(r, session)
        if cancel_key:
            await clear_rate_limit_cancel(cancel_key, cancel_event)


async def embeddings(request: Request, form_data: dict, user):
    """
    Calls the embeddings endpoint for OpenAI-compatible providers.

    Args:
        request (Request): The FastAPI request context.
        form_data (dict): OpenAI-compatible embeddings payload.
        user (UserModel): The authenticated user.

    Returns:
        dict: OpenAI-compatible embeddings response.
    """
    idx = 0
    # Prepare payload/body
    body = json.dumps(form_data)
    # Find correct backend url/key based on model
    await get_all_models(request, user=user)
    model_id = form_data.get("model")
    models = request.app.state.OPENAI_MODELS
    if model_id in models:
        idx = models[model_id]["urlIdx"]

    url = request.app.state.config.OPENAI_API_BASE_URLS[idx]
    key = request.app.state.config.OPENAI_API_KEYS[idx]
    api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
        str(idx),
        request.app.state.config.OPENAI_API_CONFIGS.get(url, {}),  # Legacy support
    )

    r = None
    session = None
    streaming = False

    headers, cookies = await get_headers_and_cookies(
        request, url, key, api_config, user=user
    )
    request_url = f"{url}/embeddings"
    try:
        session = aiohttp.ClientSession(
            trust_env=_aiohttp_trust_env_for_url(request_url)
        )
        r = await session.request(
            method="POST",
            url=request_url,
            data=body,
            headers=headers,
            cookies=cookies,
        )

        if "text/event-stream" in r.headers.get("Content-Type", ""):
            streaming = True
            return StreamingResponse(
                r.content,
                status_code=r.status,
                headers=dict(r.headers),
                background=BackgroundTask(
                    cleanup_response, response=r, session=session
                ),
            )
        else:
            try:
                response_data = await r.json()
            except Exception:
                response_data = await r.text()

            if r.status >= 400:
                if isinstance(response_data, (dict, list)):
                    return JSONResponse(status_code=r.status, content=response_data)
                else:
                    return PlainTextResponse(
                        status_code=r.status, content=response_data
                    )

            return response_data
    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=r.status if r else 500,
            detail="Open WebUI: Server Connection Error",
        )
    finally:
        if not streaming:
            await cleanup_response(r, session)


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy(path: str, request: Request, user=Depends(get_verified_user)):
    """
    Deprecated: proxy all requests to OpenAI API
    """

    body = await request.body()

    idx = 0
    url = request.app.state.config.OPENAI_API_BASE_URLS[idx]
    key = request.app.state.config.OPENAI_API_KEYS[idx]
    api_config = request.app.state.config.OPENAI_API_CONFIGS.get(
        str(idx),
        request.app.state.config.OPENAI_API_CONFIGS.get(
            request.app.state.config.OPENAI_API_BASE_URLS[idx], {}
        ),  # Legacy support
    )

    r = None
    session = None
    streaming = False

    try:
        headers, cookies = await get_headers_and_cookies(
            request, url, key, api_config, user=user
        )

        if api_config.get("azure", False):
            api_version = api_config.get("api_version", "2023-03-15-preview")

            # Only set api-key header if not using Azure Entra ID authentication
            auth_type = api_config.get("auth_type", "bearer")
            if auth_type not in ("azure_ad", "microsoft_entra_id"):
                headers["api-key"] = key

            headers["api-version"] = api_version

            payload = json.loads(body)
            url, payload = convert_to_azure_payload(url, payload, api_version)
            body = json.dumps(payload).encode()

            request_url = f"{url}/{path}?api-version={api_version}"
        else:
            request_url = f"{url}/{path}"

        session = aiohttp.ClientSession(
            trust_env=_aiohttp_trust_env_for_url(request_url)
        )
        r = await session.request(
            method=request.method,
            url=request_url,
            data=body,
            headers=headers,
            cookies=cookies,
            ssl=AIOHTTP_CLIENT_SESSION_SSL,
        )

        # Check if response is SSE
        if "text/event-stream" in r.headers.get("Content-Type", ""):
            streaming = True
            return StreamingResponse(
                r.content,
                status_code=r.status,
                headers=dict(r.headers),
                background=BackgroundTask(
                    cleanup_response, response=r, session=session
                ),
            )
        else:
            try:
                response_data = await r.json()
            except Exception:
                response_data = await r.text()

            if r.status >= 400:
                if isinstance(response_data, (dict, list)):
                    return JSONResponse(status_code=r.status, content=response_data)
                else:
                    return PlainTextResponse(
                        status_code=r.status, content=response_data
                    )

            return response_data

    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=r.status if r else 500,
            detail="Open WebUI: Server Connection Error",
        )
    finally:
        if not streaming:
            await cleanup_response(r, session)
