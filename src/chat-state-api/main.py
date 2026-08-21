"""
Chat State API - Lightweight persistence service for chat session state.

Provides CRUD operations for storing context usage and reasoning effort
per chat session. Designed to work with both browser-based Open WebUI
sessions and headless subagent sessions.
"""

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel
from typing import Dict, Optional, Tuple
from datetime import datetime
from urllib import error as urllib_error
from urllib import request as urllib_request
import asyncio
import json
import os
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Chat State API",
    description="Persistence service for Open WebUI chat session state",
    version="1.0.0"
)

# MongoDB connection
MONGODB_URL = os.getenv("MONGODB_URL", "mongodb://mongodb:27017")
MONGODB_DB = os.getenv("MONGODB_DB", "portico_chat_state")
OPENWEBUI_BASE_URL = os.getenv("OPENWEBUI_BASE_URL", "http://open-webui:8080").rstrip("/")
CHAT_STATE_AUTH_TIMEOUT_SECONDS = float(
    os.getenv("CHAT_STATE_AUTH_TIMEOUT_SECONDS", "3.0")
)


def parse_allowed_origins(raw_value: Optional[str]) -> list[str]:
    defaults = [
        "http://localhost:3789",
        "http://127.0.0.1:3789",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]
    if not raw_value:
        return defaults

    parsed = [origin.strip() for origin in raw_value.split(",") if origin.strip()]
    return parsed or defaults


CHAT_STATE_ALLOWED_ORIGINS = parse_allowed_origins(
    os.getenv("CHAT_STATE_ALLOWED_ORIGINS")
)

# CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=CHAT_STATE_ALLOWED_ORIGINS,
    allow_methods=["GET", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

client: AsyncIOMotorClient = None
db = None
collection = None
VALID_REASONING_EFFORTS = {"none", "low", "medium", "high", "xhigh", "max"}
ULTRA_REASONING_EFFORT = "ultra"


def is_gpt_56_sol_model(model_name: Optional[str]) -> bool:
    """Return whether a model identifier is the ordinary GPT-5.6 Sol alias."""
    if not isinstance(model_name, str):
        return False

    normalized = model_name.strip().lower()
    if not normalized:
        return False
    if normalized.endswith(":latest"):
        normalized = normalized[: -len(":latest")].rstrip()
    for prefix in ("openai/responses/", "openai/"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix) :]
            break
    normalized = "-".join(normalized.replace("_", " ").replace("-", " ").split())
    return normalized == "gpt-5.6-sol"


def infer_model_context_window(model_name: Optional[str]) -> int:
    """Return the known max context window for supported models."""
    if not model_name:
        return 0

    normalized = model_name.strip().lower()
    if not normalized:
        return 0

    if "gpt-5.6" in normalized or "gpt 5.6" in normalized:
        return 1_050_000
    if "gpt-5.4 pro" in normalized or "gpt 5.4 pro" in normalized:
        return 1_050_000
    if "gpt-5.5" in normalized or "gpt 5.5" in normalized:
        return 1_050_000
    if "gpt-5.4" in normalized or "gpt 5.4" in normalized:
        return 1_050_000
    if "gpt-4.1" in normalized or "gpt 4.1" in normalized:
        return 1_000_000
    if "atlas sonnet 5" in normalized:
        return 1_000_000
    if "atlas sonnet 4.6" in normalized:
        return 1_000_000
    if "atlas opus 5" in normalized or "atlas-opus-5" in normalized:
        return 1_000_000
    if "atlas opus 4.8" in normalized:
        return 1_000_000
    if "atlas opus 4.7" in normalized:
        return 1_000_000
    if "atlas opus 4.6" in normalized:
        return 1_000_000
    if "atlas haiku 4.5" in normalized:
        return 200_000

    return 0


def normalize_chat_state_values(
    context_tokens: int, max_context_tokens: int, model_name: Optional[str]
) -> Tuple[int, int]:
    """Normalize persisted state against the model's real context window."""
    normalized_context_tokens = max(0, int(context_tokens or 0))
    normalized_max_context_tokens = max(0, int(max_context_tokens or 0))
    inferred_window = infer_model_context_window(model_name)

    if inferred_window > 0:
        normalized_max_context_tokens = max(normalized_max_context_tokens, inferred_window)

    if normalized_max_context_tokens > 0:
        normalized_context_tokens = min(normalized_context_tokens, normalized_max_context_tokens)

    return normalized_context_tokens, normalized_max_context_tokens


def normalize_reasoning_effort_value(
    value: Optional[str], model_name: Optional[str] = None
) -> Optional[str]:
    if not isinstance(value, str):
        return None

    normalized = value.strip().lower()
    if not normalized:
        return None

    if normalized == ULTRA_REASONING_EFFORT:
        return normalized if is_gpt_56_sol_model(model_name) else None

    return normalized if normalized in VALID_REASONING_EFFORTS else None


def normalize_reasoning_effort_by_model(
    reasoning_effort_by_model: Optional[Dict[str, str]],
    model_name: Optional[str] = None,
) -> Optional[Dict[str, str]]:
    if reasoning_effort_by_model is None:
        return None

    if not isinstance(reasoning_effort_by_model, dict):
        return {}

    normalized = {}
    for key, value in reasoning_effort_by_model.items():
        if not isinstance(key, str):
            continue

        normalized_key = key.strip()
        # model_name identifies the primary model only. Ultra is root-only and
        # must never survive for an unidentifiable secondary model.
        normalized_value = normalize_reasoning_effort_value(
            value, model_name if normalized_key == "0" else None
        )
        if not normalized_key or normalized_value is None:
            continue

        normalized[normalized_key] = normalized_value

    return dict(sorted(normalized.items()))


def canonicalize_reasoning_state(
    reasoning_effort: Optional[str],
    reasoning_effort_by_model: Optional[Dict[str, str]],
    model_name: Optional[str] = None,
) -> Tuple[Optional[str], Optional[Dict[str, str]]]:
    normalized_by_model = normalize_reasoning_effort_by_model(
        reasoning_effort_by_model, model_name
    )
    if normalized_by_model is not None:
        return normalized_by_model.get("0"), normalized_by_model

    return normalize_reasoning_effort_value(reasoning_effort, model_name), None


def normalize_fast_mode_flag(value) -> Optional[bool]:
    """Strict-bool normalizer for the per-chat fast-mode (lightning) toggle."""
    return value if isinstance(value, bool) else None


@app.on_event("startup")
async def startup_db_client():
    """Initialize MongoDB connection on startup."""
    global client, db, collection
    logger.info(f"Connecting to MongoDB at {MONGODB_URL}")
    client = AsyncIOMotorClient(MONGODB_URL)
    db = client[MONGODB_DB]
    collection = db["chat_states"]

    # Create index on _id (chat_id) - MongoDB does this automatically
    # but we can add TTL index for cleanup if needed
    logger.info("MongoDB connection established")


@app.on_event("shutdown")
async def shutdown_db_client():
    """Close MongoDB connection on shutdown."""
    global client
    if client:
        client.close()
        logger.info("MongoDB connection closed")


class ChatStateInput(BaseModel):
    """Input model for creating/updating chat state."""
    context_tokens: int = 0
    max_context_tokens: int = 128000
    reasoning_effort: Optional[str] = None
    reasoning_effort_by_model: Optional[Dict[str, str]] = None
    # Per-chat fast-mode toggle. None means "not specified" and must never
    # overwrite a stored value (writers that predate the field omit it).
    fast_mode: Optional[bool] = None
    model_name: Optional[str] = None


class ChatStateResponse(BaseModel):
    """Response model for chat state."""
    chat_id: str
    context_tokens: int = 0
    max_context_tokens: int = 128000
    reasoning_effort: Optional[str] = None
    reasoning_effort_by_model: Optional[Dict[str, str]] = None
    fast_mode: Optional[bool] = None
    model_name: Optional[str] = None
    last_updated: datetime
    created_at: datetime


def extract_bearer_token(authorization_header: Optional[str]) -> str:
    if not authorization_header:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    scheme, _, token = authorization_header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Invalid Authorization header")

    return token.strip()


def fetch_openwebui_user_sync(token: str) -> dict:
    request = urllib_request.Request(
        f"{OPENWEBUI_BASE_URL}/api/v1/auths/",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="GET",
    )

    try:
        with urllib_request.urlopen(
            request,
            timeout=CHAT_STATE_AUTH_TIMEOUT_SECONDS,
        ) as response:
            payload = response.read().decode("utf-8")
            if response.status != 200:
                raise HTTPException(status_code=401, detail="Authentication failed")
            return json.loads(payload or "{}")
    except urllib_error.HTTPError as exc:
        raise HTTPException(status_code=401, detail="Authentication failed") from exc
    except TimeoutError as exc:
        logger.error("Timed out reaching Open WebUI auth endpoint")
        raise HTTPException(
            status_code=503,
            detail="Authentication service unavailable",
        ) from exc
    except urllib_error.URLError as exc:
        logger.error(f"Failed to reach Open WebUI auth endpoint: {exc}")
        raise HTTPException(
            status_code=503,
            detail="Authentication service unavailable",
        ) from exc
    except json.JSONDecodeError as exc:
        logger.error(f"Open WebUI auth endpoint returned invalid JSON: {exc}")
        raise HTTPException(status_code=503, detail="Authentication service error") from exc


async def require_authenticated_user(
    authorization: Optional[str] = Header(None),
) -> dict:
    token = extract_bearer_token(authorization)
    user = await asyncio.to_thread(fetch_openwebui_user_sync, token)
    if not isinstance(user, dict):
        raise HTTPException(status_code=503, detail="Authentication service error")
    user_id = user.get("id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Authenticated user not found")
    return user


async def claim_or_validate_chat_owner(doc: dict, chat_id: str, user_id: str) -> dict:
    owner_user_id = doc.get("owner_user_id")
    if owner_user_id and owner_user_id != user_id:
        raise HTTPException(status_code=404, detail="Chat state not found")

    if not owner_user_id:
        await collection.update_one(
            {"_id": chat_id},
            {"$set": {"owner_user_id": user_id}},
        )
        doc["owner_user_id"] = user_id

    return doc


@app.get("/health")
async def health_check():
    """Health check endpoint for Docker healthcheck."""
    try:
        await client.admin.command('ping')
        return {"status": "healthy", "mongodb": "connected"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=503, detail=f"MongoDB unhealthy: {e}")


@app.get("/api/v1/chat-state/{chat_id}", response_model=ChatStateResponse)
async def get_chat_state(
    chat_id: str,
    current_user: dict = Depends(require_authenticated_user),
):
    """
    Fetch chat state by chat_id.

    Returns 404 if chat state doesn't exist.
    """
    doc = await collection.find_one({"_id": chat_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Chat state not found")

    await claim_or_validate_chat_owner(doc, chat_id, current_user["id"])

    context_tokens, max_context_tokens = normalize_chat_state_values(
        doc.get("context_tokens", 0),
        doc.get("max_context_tokens", 128000),
        doc.get("model_name"),
    )

    if (
        context_tokens != doc.get("context_tokens", 0)
        or max_context_tokens != doc.get("max_context_tokens", 128000)
    ):
        await collection.update_one(
            {"_id": chat_id},
            {
                "$set": {
                    "context_tokens": context_tokens,
                    "max_context_tokens": max_context_tokens,
                    "last_updated": datetime.utcnow(),
                }
            },
        )

    reasoning_effort, reasoning_effort_by_model = canonicalize_reasoning_state(
        doc.get("reasoning_effort"),
        doc.get("reasoning_effort_by_model"),
        doc.get("model_name"),
    )

    return ChatStateResponse(
        chat_id=doc["_id"],
        context_tokens=context_tokens,
        max_context_tokens=max_context_tokens,
        reasoning_effort=reasoning_effort,
        reasoning_effort_by_model=reasoning_effort_by_model,
        fast_mode=normalize_fast_mode_flag(doc.get("fast_mode")),
        model_name=doc.get("model_name"),
        last_updated=doc.get("last_updated", datetime.utcnow()),
        created_at=doc.get("created_at", datetime.utcnow())
    )


@app.put("/api/v1/chat-state/{chat_id}", response_model=ChatStateResponse)
async def upsert_chat_state(
    chat_id: str,
    state: ChatStateInput,
    current_user: dict = Depends(require_authenticated_user),
):
    """
    Create or update chat state.

    Uses upsert semantics - creates if not exists, updates if exists.
    """
    now = datetime.utcnow()
    context_tokens, max_context_tokens = normalize_chat_state_values(
        state.context_tokens, state.max_context_tokens, state.model_name
    )
    reasoning_effort, reasoning_effort_by_model = canonicalize_reasoning_state(
        state.reasoning_effort,
        state.reasoning_effort_by_model,
        state.model_name,
    )
    existing_doc = await collection.find_one({"_id": chat_id}, {"owner_user_id": 1})
    if (
        existing_doc
        and existing_doc.get("owner_user_id")
        and existing_doc.get("owner_user_id") != current_user["id"]
    ):
        raise HTTPException(status_code=404, detail="Chat state not found")

    update_doc = {
        "$set": {
            "context_tokens": context_tokens,
            "max_context_tokens": max_context_tokens,
            "reasoning_effort": reasoning_effort,
            "reasoning_effort_by_model": reasoning_effort_by_model,
            "model_name": state.model_name,
            "owner_user_id": current_user["id"],
            "last_updated": now
        },
        "$setOnInsert": {
            "_id": chat_id,
            "created_at": now
        }
    }
    # Only write fast_mode when the caller explicitly sent a boolean, so PUTs
    # from writers that omit the field never clobber the stored toggle.
    fast_mode = normalize_fast_mode_flag(getattr(state, "fast_mode", None))
    if fast_mode is not None:
        update_doc["$set"]["fast_mode"] = fast_mode

    await collection.update_one({"_id": chat_id}, update_doc, upsert=True)
    doc = await collection.find_one({"_id": chat_id})

    logger.info(f"Upserted chat state for {chat_id}")

    stored_reasoning_effort, stored_reasoning_effort_by_model = canonicalize_reasoning_state(
        doc.get("reasoning_effort"),
        doc.get("reasoning_effort_by_model"),
        doc.get("model_name"),
    )

    return ChatStateResponse(
        chat_id=doc["_id"],
        context_tokens=context_tokens,
        max_context_tokens=max_context_tokens,
        reasoning_effort=stored_reasoning_effort,
        reasoning_effort_by_model=stored_reasoning_effort_by_model,
        fast_mode=normalize_fast_mode_flag(doc.get("fast_mode")),
        model_name=doc.get("model_name"),
        last_updated=doc["last_updated"],
        created_at=doc["created_at"]
    )


@app.delete("/api/v1/chat-state/{chat_id}")
async def delete_chat_state(
    chat_id: str,
    current_user: dict = Depends(require_authenticated_user),
):
    """
    Delete chat state by chat_id.

    Returns 404 if chat state doesn't exist.
    """
    doc = await collection.find_one({"_id": chat_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Chat state not found")

    await claim_or_validate_chat_owner(doc, chat_id, current_user["id"])

    result = await collection.delete_one({"_id": chat_id})

    logger.info(f"Deleted chat state for {chat_id}")
    return {"status": "deleted", "chat_id": chat_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
