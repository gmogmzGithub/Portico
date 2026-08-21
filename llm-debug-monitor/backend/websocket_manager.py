"""WebSocket connection manager for real-time event broadcasting"""

import asyncio
import json
import logging
from typing import Dict, Set, Optional
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebSocketManager:
    """Manages WebSocket connections and broadcasts events"""

    def __init__(self):
        # All connected clients
        self._connections: Set[WebSocket] = set()
        # Session-filtered connections: session_id -> set of websockets
        self._session_connections: Dict[str, Set[WebSocket]] = {}
        # Chat-filtered connections: chat_id -> set of websockets
        self._chat_connections: Dict[str, Set[WebSocket]] = {}
        # Lock for thread-safe operations
        self._lock = asyncio.Lock()

    async def connect(
        self,
        websocket: WebSocket,
        session_id: Optional[str] = None,
        chat_id: Optional[str] = None
    ) -> None:
        """Accept and register a WebSocket connection"""
        await websocket.accept()

        async with self._lock:
            self._connections.add(websocket)

            if session_id:
                if session_id not in self._session_connections:
                    self._session_connections[session_id] = set()
                self._session_connections[session_id].add(websocket)

            if chat_id:
                if chat_id not in self._chat_connections:
                    self._chat_connections[chat_id] = set()
                self._chat_connections[chat_id].add(websocket)

        logger.info(f"WebSocket connected (session={session_id}, chat={chat_id})")

    async def disconnect(self, websocket: WebSocket) -> None:
        """Remove a WebSocket connection"""
        async with self._lock:
            self._connections.discard(websocket)

            # Remove from session connections
            for session_id, connections in list(self._session_connections.items()):
                connections.discard(websocket)
                if not connections:
                    del self._session_connections[session_id]

            # Remove from chat connections
            for chat_id, connections in list(self._chat_connections.items()):
                connections.discard(websocket)
                if not connections:
                    del self._chat_connections[chat_id]

        logger.info("WebSocket disconnected")

    async def broadcast(self, event: dict) -> None:
        """
        Broadcast an event to all connected clients.

        All events are sent to all connected WebSocket clients.
        Session/chat filtering is now handled client-side for flexibility.
        """
        message = json.dumps(event)

        # Send to ALL connected clients
        targets: Set[WebSocket] = set()

        async with self._lock:
            targets = self._connections.copy()

        # Send to all targets
        disconnected = []
        for websocket in targets:
            try:
                await websocket.send_text(message)
            except Exception as e:
                logger.warning(f"Failed to send to WebSocket: {e}")
                disconnected.append(websocket)

        # Clean up disconnected
        for ws in disconnected:
            await self.disconnect(ws)

    async def send_to_session(self, session_id: str, event: dict) -> None:
        """Send event to all connections for a specific session"""
        async with self._lock:
            connections = self._session_connections.get(session_id, set())

        message = json.dumps(event)
        disconnected = []

        for websocket in connections:
            try:
                await websocket.send_text(message)
            except Exception:
                disconnected.append(websocket)

        for ws in disconnected:
            await self.disconnect(ws)

    async def send_to_chat(self, chat_id: str, event: dict) -> None:
        """Send event to all connections for a specific chat"""
        async with self._lock:
            connections = self._chat_connections.get(chat_id, set())

        message = json.dumps(event)
        disconnected = []

        for websocket in connections:
            try:
                await websocket.send_text(message)
            except Exception:
                disconnected.append(websocket)

        for ws in disconnected:
            await self.disconnect(ws)

    @property
    def connection_count(self) -> int:
        """Get total number of connections"""
        return len(self._connections)

    def get_stats(self) -> dict:
        """Get connection statistics"""
        return {
            "total_connections": len(self._connections),
            "session_subscriptions": len(self._session_connections),
            "chat_subscriptions": len(self._chat_connections)
        }
