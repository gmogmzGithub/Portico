"""Private authenticated admission for GPT-5.6 Sol multi-agent requests.

Only opaque digests leave Open WebUI. Raw user, chat, and message identifiers are
used transiently to derive a domain-separated HMAC and are never returned in
headers or audit metadata.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import HTTPException

KEY_VERSION = "v1"
REQUEST_METHOD = "POST"
REQUEST_PATH = "/v1/chat/completions"
SECRET_PREFIX = "ultra-sign-v1-"
MIN_SECRET_LENGTH = 70
RUN_TTL_SECONDS = 60 * 60
HEADER_KEY_VERSION = "X-PORTICO-Ultra-Key-Version"
HEADER_TIMESTAMP = "X-PORTICO-Ultra-Timestamp"
HEADER_CONTEXT = "X-PORTICO-Ultra-Context"
HEADER_FINGERPRINT = "X-PORTICO-Ultra-Fingerprint"
HEADER_SIGNATURE = "X-PORTICO-Ultra-Signature"
OPAQUE_HEX_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class UltraAdmission:
    context_digest: str
    fingerprint: str


@dataclass(frozen=True)
class _ServerUltraOrigin:
    user_id: str
    chat_id: str
    message_id: str


def create_server_owned_origin(user_id: str, chat_id: str, message_id: str) -> Any:
    if not all(
        isinstance(value, str) and value.strip()
        for value in (user_id, chat_id, message_id)
    ):
        raise RuntimeError("Ultra server origin is incomplete")
    return _ServerUltraOrigin(user_id.strip(), chat_id.strip(), message_id.strip())


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _read_secret_from_env() -> str:
    secret_file = str(
        os.environ.get("ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE") or ""
    ).strip()
    if secret_file:
        try:
            secret = Path(secret_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RuntimeError("Ultra signing secret file is unreadable") from exc
    else:
        secret = str(os.environ.get("ULTRA_MULTI_AGENT_SIGNING_SECRET") or "").strip()
    validate_signing_secret(secret)
    return secret


def _read_internal_gateway_key() -> str:
    key_file = str(os.environ.get("OPENAI_API_KEY_FILE") or "").strip()
    if key_file:
        try:
            key = Path(key_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise HTTPException(
                status_code=503,
                detail="Ultra private gateway credentials are unavailable",
            ) from exc
    else:
        key = str(os.environ.get("OPENAI_API_KEY") or "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="Ultra private gateway credentials are unavailable",
        )
    return key


def build_private_gateway_transport(
    selected_base_url: str,
    selected_key: str,
    request_url: str,
) -> tuple[dict[str, str], dict[str, str]]:
    runtime_base_url = (
        str(os.environ.get("OPENAI_API_BASE_URL") or "").strip().rstrip("/")
    )
    selected_base_url = str(selected_base_url or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(runtime_base_url)
    if (
        not runtime_base_url
        or parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") != "/v1"
        or selected_base_url != runtime_base_url
        or request_url != f"{runtime_base_url}/chat/completions"
    ):
        raise HTTPException(
            status_code=400,
            detail="Ultra requires the exact app-owned private gateway origin",
        )
    runtime_key = _read_internal_gateway_key()
    if not hmac.compare_digest(str(selected_key or ""), runtime_key):
        raise HTTPException(
            status_code=403,
            detail="Ultra private gateway credential reconciliation failed",
        )
    return (
        {"Content-Type": "application/json", "Authorization": f"Bearer {runtime_key}"},
        {},
    )


def validate_signing_secret(secret: str) -> None:
    if not secret.startswith(SECRET_PREFIX) or len(secret) < MIN_SECRET_LENGTH:
        raise RuntimeError("Ultra signing secret is missing or weak")


def background_tasks_enabled(tasks: Any) -> bool:
    if isinstance(tasks, dict):
        return any(bool(value) for value in tasks.values())
    return bool(tasks)


def is_ultra_request(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("reasoning_effort") == "ultra":
        return True
    params = payload.get("params")
    return isinstance(params, dict) and params.get("reasoning_effort") == "ultra"


def _verified_user_id(user: Any) -> str:
    user_id = str(getattr(user, "id", "") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Ultra requires a verified user")
    return user_id


def derive_context_digest(
    secret: str,
    user_id: str,
    chat_id: str,
    message_id: str,
) -> str:
    validate_signing_secret(secret)
    mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
    mac.update(b"portico-ultra-origin-v1\n")
    mac.update(user_id.encode("utf-8"))
    mac.update(b"\n")
    mac.update(chat_id.encode("utf-8"))
    mac.update(b"\n")
    mac.update(message_id.encode("utf-8"))
    return _b64url(mac.digest())


def derive_run_fingerprint(
    secret: str, context_digest: str, model: str, exact_body: bytes
) -> str:
    validate_signing_secret(secret)
    mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
    mac.update(b"portico-ultra-run-v1\n")
    mac.update(context_digest.encode("ascii"))
    mac.update(b"\n")
    mac.update(str(model or "").strip().lower().encode("utf-8"))
    mac.update(b"\n")
    mac.update(hashlib.sha256(exact_body).digest())
    return mac.hexdigest()


def _canonical_request(
    timestamp: int,
    context_digest: str,
    fingerprint: str,
    exact_body: bytes,
) -> bytes:
    body_digest = hashlib.sha256(exact_body).hexdigest()
    return "\n".join(
        (
            KEY_VERSION,
            REQUEST_METHOD,
            REQUEST_PATH,
            KEY_VERSION,
            str(timestamp),
            context_digest,
            fingerprint,
            body_digest,
        )
    ).encode("utf-8")


def sign_exact_body(
    secret: str,
    exact_body: bytes,
    context_digest: str,
    fingerprint: str,
    *,
    timestamp: int | None = None,
) -> dict[str, str]:
    validate_signing_secret(secret)
    if not context_digest or not OPAQUE_HEX_RE.fullmatch(fingerprint):
        raise RuntimeError("Ultra admission digests are invalid")
    timestamp = int(time.time()) if timestamp is None else int(timestamp)
    signature = _b64url(
        hmac.new(
            secret.encode("utf-8"),
            _canonical_request(timestamp, context_digest, fingerprint, exact_body),
            hashlib.sha256,
        ).digest()
    )
    return {
        HEADER_KEY_VERSION: KEY_VERSION,
        HEADER_TIMESTAMP: str(timestamp),
        HEADER_CONTEXT: context_digest,
        HEADER_FINGERPRINT: fingerprint,
        HEADER_SIGNATURE: signature,
    }


async def _admit_run(redis: Any, context_digest: str, fingerprint: str) -> None:
    if redis is None:
        raise HTTPException(
            status_code=503, detail="Ultra admission state is unavailable"
        )
    key = f"portico:ultra:run:{context_digest}"
    try:
        admitted = await redis.set(key, fingerprint, nx=True, ex=RUN_TTL_SECONDS)
        if admitted:
            return
        raise HTTPException(status_code=409, detail="Duplicate Ultra run admission")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail="Ultra admission state is unavailable"
        ) from exc


async def admit_and_sign_request(
    request: Any,
    headers: dict[str, str],
    exact_body: str,
    payload: dict[str, Any],
    user: Any,
) -> UltraAdmission:
    if payload.get("stream") is not True:
        raise HTTPException(status_code=400, detail="Ultra requires stream=true")
    request_state = getattr(getattr(request, "app", None), "state", None)
    origin = getattr(getattr(request, "state", None), "portico_ultra_origin", None)
    if getattr(request, "state", None) is not None and hasattr(
        request.state, "portico_ultra_origin"
    ):
        delattr(request.state, "portico_ultra_origin")
    if not isinstance(origin, _ServerUltraOrigin):
        raise HTTPException(status_code=403, detail="Ultra server origin is missing")
    user_id = _verified_user_id(user)
    if not hmac.compare_digest(user_id, origin.user_id):
        raise HTTPException(status_code=403, detail="Ultra request identity mismatch")
    chat_id = origin.chat_id
    message_id = origin.message_id
    redis = getattr(request_state, "redis", None)
    if redis is not None:
        try:
            if await redis.exists(f"subagent_chat:{chat_id}"):
                raise HTTPException(
                    status_code=403,
                    detail="Ultra is restricted to interactive root chats",
                )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail="Ultra admission state is unavailable",
            ) from exc

    secret = _read_secret_from_env()
    context_digest = derive_context_digest(secret, user_id, chat_id, message_id)
    exact_body_bytes = exact_body.encode("utf-8")
    fingerprint = derive_run_fingerprint(
        secret,
        context_digest,
        payload.get("model", ""),
        exact_body_bytes,
    )
    await _admit_run(redis, context_digest, fingerprint)
    signed = sign_exact_body(
        secret,
        exact_body_bytes,
        context_digest,
        fingerprint,
    )
    headers.update(signed)
    return UltraAdmission(context_digest=context_digest, fingerprint=fingerprint)


__all__ = [
    "UltraAdmission",
    "background_tasks_enabled",
    "admit_and_sign_request",
    "build_private_gateway_transport",
    "create_server_owned_origin",
    "derive_context_digest",
    "derive_run_fingerprint",
    "is_ultra_request",
    "sign_exact_body",
    "validate_signing_secret",
]
