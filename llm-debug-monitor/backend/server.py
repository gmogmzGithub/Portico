"""FastAPI server for LLM Debug Monitor"""

import os
import asyncio
import logging
import copy
import hmac
import re
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, WebSocket, WebSocketDisconnect, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
import httpx

from backend.redis_subscriber import RedisSubscriber, EventStore
from backend.websocket_manager import WebSocketManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Configuration
REDIS_HOST = os.environ.get("REDIS_HOST", "redis")
REDIS_PORT = int(os.environ.get("REDIS_PORT", 6379))
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
# Electron API server (runs on host machine, accessed via host.docker.internal from container)
ELECTRON_API_HOST = os.environ.get("ELECTRON_API_HOST", "host.docker.internal")
ELECTRON_API_PORT = int(os.environ.get("ELECTRON_API_PORT", 9876))
DEBUG_MONITOR_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "DEBUG_MONITOR_ALLOWED_ORIGINS",
        "http://localhost:8879,http://127.0.0.1:8879,http://localhost:3789,http://127.0.0.1:3789",
    ).split(",")
    if origin.strip()
]


def read_secret_env(name: str) -> str:
    direct_value = os.environ.get(name, "").strip()
    if direct_value:
        return direct_value

    file_path = os.environ.get(f"{name}_FILE", "").strip()
    if not file_path:
        return ""
    try:
        with open(file_path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def resolve_debug_monitor_token() -> str:
    return (
        read_secret_env("DEBUG_MONITOR_TOKEN")
        or read_secret_env("BIFROST_BRIDGE_LOCAL_API_KEY")
        or read_secret_env("LOCAL_STACK_API_KEY")
    ).strip()


DEBUG_MONITOR_TOKEN = resolve_debug_monitor_token()
SENSITIVE_KEY_PATTERN = re.compile(
    r"(^token$|authorization|cookie|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token)",
    re.IGNORECASE,
)

# Global instances
redis_subscriber = RedisSubscriber(REDIS_HOST, REDIS_PORT)
event_store = EventStore(REDIS_HOST, REDIS_PORT)
ws_manager = WebSocketManager()

# Background task handles
_event_listener_task: Optional[asyncio.Task] = None


def redact_sensitive_payload(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if SENSITIVE_KEY_PATTERN.search(str(key)):
                redacted[key] = "[REDACTED]"
            else:
                redacted[key] = redact_sensitive_payload(item)
        return redacted

    if isinstance(value, list):
        return [redact_sensitive_payload(item) for item in value]

    return value


def sanitize_monitor_event(event: dict) -> dict:
    sanitized = redact_sensitive_payload(copy.deepcopy(event))
    data = sanitized.get("data")
    if isinstance(data, dict):
        data.pop("provider_headers_raw", None)
        data.pop("providerHeadersRaw", None)
    return sanitized


def verify_debug_monitor_token(provided_token: Optional[str]) -> None:
    if not DEBUG_MONITOR_TOKEN:
        raise HTTPException(status_code=503, detail="Debug monitor token is not configured")

    candidate = (provided_token or "").strip()
    if not candidate or not hmac.compare_digest(candidate, DEBUG_MONITOR_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid debug monitor token")


def require_debug_monitor_access(
    token: Optional[str] = Query(None),
    header_token: Optional[str] = Header(None, alias="X-Debug-Monitor-Token"),
) -> None:
    verify_debug_monitor_token(header_token or token)


async def require_debug_monitor_websocket_access(
    websocket: WebSocket,
    token: Optional[str],
) -> bool:
    try:
        verify_debug_monitor_token(token)
        return True
    except HTTPException as exc:
        await websocket.close(
            code=1011 if exc.status_code >= 500 else 4401,
            reason=exc.detail,
        )
        return False


async def dispatch_monitor_event(event: dict, *, store=event_store, manager=ws_manager) -> bool:
    event_type = event.get("event_type", "unknown")
    if event_type == "llm_request_transformed":
        logger.warning("Ignoring deprecated transformed request event")
        return False

    chat_id = event.get("chat_id", "unknown")
    logger.info("📨 Received event: %s for chat %s", event_type, chat_id)
    if event_type == "llm_request_start":
        data = event.get("data", {})
        logger.info(
            "📨 llm_request_start data: model=%s, base_model=%s",
            data.get("model"),
            data.get("base_model"),
        )
    sanitized_event = sanitize_monitor_event(event)
    await store.process_event(sanitized_event)
    await manager.broadcast(sanitized_event)
    logger.info("📡 Broadcast event to %s clients", manager.connection_count)
    return True


async def event_listener():
    """Background task to listen for Redis events and broadcast them"""
    logger.info("Starting event listener...")
    reconnect_delay_seconds = 1.0
    while True:
        try:
            await redis_subscriber.connect()
            await event_store.connect()
            await redis_subscriber.subscribe()
            reconnect_delay_seconds = 1.0

            async for event in redis_subscriber.listen():
                await dispatch_monitor_event(event)

            logger.warning(
                "Redis event stream ended unexpectedly; reconnecting in %.1fs",
                reconnect_delay_seconds,
            )
        except asyncio.CancelledError:
            logger.info("Event listener cancelled")
            await redis_subscriber.disconnect()
            raise
        except Exception as e:
            logger.error(f"Event listener error: {e}")
        finally:
            await redis_subscriber.disconnect()

        await asyncio.sleep(reconnect_delay_seconds)
        reconnect_delay_seconds = min(reconnect_delay_seconds * 2, 5.0)



@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    global _event_listener_task

    # Startup
    logger.info("Starting LLM Debug Monitor...")
    _event_listener_task = asyncio.create_task(event_listener())

    yield

    # Shutdown
    logger.info("Shutting down LLM Debug Monitor...")
    for task in (_event_listener_task,):
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


# Create FastAPI app
app = FastAPI(
    title="LLM Debug Monitor API",
    description="Real-time monitoring for LLM requests",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=DEBUG_MONITOR_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET"],
    allow_headers=["X-Debug-Monitor-Token", "Content-Type"],
)


# ============================================================================
# REST API Endpoints
# ============================================================================

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "llm-debug-monitor",
        "redis_host": REDIS_HOST,
        "websocket_connections": ws_manager.connection_count
    }


@app.get("/api/sessions")
async def list_sessions(_: None = Depends(require_debug_monitor_access)):
    """List all active debug sessions"""
    sessions = event_store.get_sessions()
    return {"sessions": sessions}


@app.get("/api/sessions/{session_id}/chats")
async def get_session_chats(
    session_id: str,
    _: None = Depends(require_debug_monitor_access),
):
    """Get all chats for a session"""
    chats = event_store.get_session_chats(session_id)
    return {"chats": chats}


@app.get("/api/chats/{chat_id}/requests")
async def get_chat_requests(
    chat_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: None = Depends(require_debug_monitor_access),
):
    """Get LLM requests for a chat (paginated)"""
    requests, total = event_store.get_chat_requests(chat_id, limit, offset)
    requests = [
        await event_store.hydrate_request(request)
        for request in requests
        if request is not None
    ]

    # Convert to summary format
    summaries = [
        {
            "request_id": req["request_id"],
            "timestamp": req["timestamp"],
            "chat_id": req.get("chat_id"),
            "message_id": req.get("message_id"),
            "debug_request_id": req.get("debug_request_id"),
            "upstream_request_id": req.get("upstream_request_id"),
            "model": req["model"],
            "base_model": req.get("base_model"),
            "task_name": req.get("task_name"),
            "is_auxiliary": req.get("is_auxiliary", False),
            "request_phase": req.get("request_phase"),
            "followup_index": req.get("followup_index"),
            "outer_message_id": req.get("outer_message_id"),
            "trigger_message_id": req.get("trigger_message_id"),
            "transcript_anchor_kind": req.get("transcript_anchor_kind"),
            "transcript_anchor_message_id": req.get(
                "transcript_anchor_message_id"
            ),
            "transcript_anchor_tool_block_index": req.get(
                "transcript_anchor_tool_block_index"
            ),
            "message_count": len(req.get("messages", [])),
            "tool_count": len(req.get("tools", [])),
            "status": req["status"],
            "duration_ms": req.get("duration_ms"),
            "usage": req.get("usage"),
            "tool_ids": req.get("tool_ids", []),
            "skills": req.get("skills", []),
        }
        for req in requests
    ]

    return {
        "requests": summaries,
        "total": total,
        "offset": offset,
        "limit": limit
    }


@app.get("/api/requests/{request_id}")
async def get_request_detail(
    request_id: str,
    _: None = Depends(require_debug_monitor_access),
):
    """Get full request payload for inspection"""
    request = await event_store.get_request_detail(request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    return {"request": sanitize_monitor_event({"data": request}).get("data")}


@app.get("/api/chats/{chat_id}/capabilities")
async def get_chat_capabilities(
    chat_id: str,
    _: None = Depends(require_debug_monitor_access),
):
    """Get current capabilities for a chat"""
    capabilities = event_store.get_chat_capabilities(chat_id)
    return capabilities


@app.get("/api/events")
async def get_recent_events(
    limit: int = Query(100, ge=1, le=1000),
    _: None = Depends(require_debug_monitor_access),
):
    """Get recent events"""
    events = event_store.get_recent_events(limit)
    return {
        "events": [sanitize_monitor_event(event) for event in events],
        "count": len(events),
    }


@app.get("/api/stats")
async def get_stats(_: None = Depends(require_debug_monitor_access)):
    """Get system statistics"""
    return {
        "websocket": ws_manager.get_stats(),
        "events_cached": len(event_store._events),
        "sessions_tracked": len(event_store._sessions),
        "chats_tracked": len(event_store._chats),
        "requests_tracked": len(event_store._requests)
    }


@app.get("/api/mcp/servers/{server_id}/icon")
async def get_mcp_server_icon(
    server_id: str,
    _: None = Depends(require_debug_monitor_access),
):
    """
    Proxy MCP server icons from the Electron app's API server.
    Icons are served by Electron at port 9876 on the host machine.
    """
    electron_url = f"http://{ELECTRON_API_HOST}:{ELECTRON_API_PORT}/api/mcp/servers/{server_id}/icon"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(electron_url)

            if response.status_code == 200:
                # Return the icon with appropriate content type
                content_type = response.headers.get("content-type", "image/png")
                return Response(
                    content=response.content,
                    media_type=content_type,
                    headers={"Cache-Control": "public, max-age=3600"}  # Cache for 1 hour
                )
            else:
                raise HTTPException(status_code=response.status_code, detail="Icon not found")

    except httpx.ConnectError:
        logger.warning(f"Cannot connect to Electron API at {electron_url}")
        raise HTTPException(status_code=503, detail="Electron API not available")
    except httpx.TimeoutException:
        logger.warning(f"Timeout fetching icon from {electron_url}")
        raise HTTPException(status_code=504, detail="Timeout fetching icon")
    except Exception as e:
        logger.error(f"Error fetching icon: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# WebSocket Endpoint
# ============================================================================

@app.websocket("/ws/events")
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: Optional[str] = Query(None),
    chat_id: Optional[str] = Query(None),
    token: Optional[str] = Query(None),
):
    """
    WebSocket endpoint for real-time event streaming.

    Query params:
    - session_id: Filter events to specific session
    - chat_id: Filter events to specific chat (optional)
    - token: Internal debug monitor access token
    """
    if not await require_debug_monitor_websocket_access(websocket, token):
        return

    await ws_manager.connect(websocket, session_id, chat_id)

    try:
        # Keep connection alive and handle any incoming messages
        while True:
            try:
                # We don't expect client messages, but need to read to detect disconnection
                data = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=30.0
                )
                # Could handle client commands here if needed
                logger.debug(f"Received WebSocket message: {data}")
            except asyncio.TimeoutError:
                # Send ping to keep connection alive
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        await ws_manager.disconnect(websocket)


# ============================================================================
# Static Files (Frontend)
# ============================================================================

# Check if static files exist (they will after frontend build)
STATIC_DIR = "/app/static"
if os.path.exists(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=f"{STATIC_DIR}/assets"), name="assets")

    @app.get("/")
    async def serve_frontend():
        """Serve the React frontend"""
        return FileResponse(f"{STATIC_DIR}/index.html")

    @app.get("/{path:path}")
    async def serve_static(path: str):
        """Serve static files or fallback to index.html for SPA routing"""
        file_path = f"{STATIC_DIR}/{path}"
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(f"{STATIC_DIR}/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8879)
