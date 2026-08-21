#!/usr/bin/env python3
"""Mock Open WebUI (+ chat-state-api + host-bridge status) for scheduled-task
end-to-end runs.

Serves just enough of the OWUI surface for the real `scheduling-daemon`
binary (via subagents-server's SubagentTaskRunner) to claim and drive runs:

    GET  /api/models                 -> {"data": [model items]}
    GET  /api/v1/auths/              -> {"id": user id}
    GET  /api/v1/folders/            -> [folders]
    POST /api/v1/folders/            -> create folder
    POST /api/v1/chats/new           -> create chat (captures chat.meta)
    POST /api/chat/completions       -> captures payload (incl. system prompt)
    GET  /api/v1/chats/{id}          -> poll payload; assistant msg appears
                                        once the chat is marked complete
    PUT  /api/v1/chat-state/{id}     -> 200 {}
    GET  /bridge/status              -> host-bridge readiness (controllable)

Harness control plane (used by run_scenarios.py, never by the daemon):

    GET  /__control/state            -> everything captured so far
    POST /__control/bridge           -> {"ready": bool}
    POST /__control/complete         -> {"chat_id": ..., "content": ...}
    POST /__control/reset            -> wipe chats/folders/captures

Run: python3 mock_owui.py <port>
"""

import json
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_LOCK = threading.Lock()
STATE = {
    "bridge_ready": True,
    "folders": [],
    "chats": {},          # chat_id -> {model, meta, user_message, completed, assistant_content}
    "completions": [],    # captured /api/chat/completions payloads
    "requests": [],       # (method, path) log
}

MODEL_ID = "Atlas Sonnet 5"
USER_ID = "user-e2e"


def chat_payload(chat_id, chat):
    user_message_id = chat["user_message_id"]
    messages = {
        user_message_id: {
            "id": user_message_id,
            "parentId": None,
            "childrenIds": [],
            "role": "user",
            "content": chat["user_message"],
            "timestamp": 1,
            "models": [chat["model"]],
        }
    }
    if chat["completed"]:
        assistant_id = chat["assistant_message_id"]
        messages[assistant_id] = {
            "id": assistant_id,
            "parentId": user_message_id,
            "childrenIds": [],
            "role": "assistant",
            "content": chat["assistant_content"],
            "timestamp": 2,
            "done": True,
        }
    return {
        "id": chat_id,
        "chat": {
            "models": [chat["model"]],
            "history": {"messages": messages, "currentId": user_message_id},
            "messages": list(messages.values()),
        },
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet
        pass

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        with STATE_LOCK:
            STATE["requests"].append(("GET", self.path))
            if self.path.startswith("/api/models"):
                return self._send({"data": [{"id": MODEL_ID, "name": MODEL_ID, "info": {}}]})
            if self.path.startswith("/api/v1/auths/"):
                return self._send({"id": USER_ID})
            if self.path.startswith("/api/v1/folders/"):
                return self._send(STATE["folders"])
            if self.path.startswith("/api/v1/chats/"):
                chat_id = self.path.rsplit("/", 1)[-1]
                chat = STATE["chats"].get(chat_id)
                if chat is None:
                    return self._send({"detail": "not found"}, status=404)
                return self._send(chat_payload(chat_id, chat))
            if self.path.startswith("/bridge/status"):
                if STATE["bridge_ready"]:
                    return self._send(
                        {"success": True, "bridgeReady": True, "brokerAuthReady": True}
                    )
                return self._send(
                    {
                        "success": True,
                        "bridgeReady": False,
                        "brokerAuthReady": False,
                        "reason": "mock bridge held down by scenario",
                    }
                )
            if self.path.startswith("/__control/state"):
                return self._send(
                    {
                        "folders": STATE["folders"],
                        "chats": STATE["chats"],
                        "completions": STATE["completions"],
                        "requests": STATE["requests"][-200:],
                    }
                )
        self._send({"detail": f"unmocked GET {self.path}"}, status=404)

    def do_POST(self):
        body = self._body()
        with STATE_LOCK:
            STATE["requests"].append(("POST", self.path))
            if self.path.startswith("/api/v1/folders/"):
                folder = {
                    "id": f"folder-{len(STATE['folders']) + 1}",
                    "name": body.get("name", ""),
                    "parent_id": None,
                    "data": body.get("data", {}),
                }
                STATE["folders"].append(folder)
                return self._send(folder)
            if self.path.startswith("/api/v1/chats/new"):
                chat_id = str(uuid.uuid4())
                chat_object = body.get("chat", {})
                history = chat_object.get("history", {})
                user_message_id = history.get("currentId") or str(uuid.uuid4())
                user_message = ""
                for message in (history.get("messages") or {}).values():
                    user_message = message.get("content", "")
                STATE["chats"][chat_id] = {
                    "model": (chat_object.get("models") or [MODEL_ID])[0],
                    "meta": chat_object.get("meta"),
                    "folder_id": body.get("folder_id"),
                    "user_message_id": user_message_id,
                    "user_message": user_message,
                    "assistant_message_id": str(uuid.uuid4()),
                    "assistant_content": "",
                    "completed": False,
                }
                return self._send({"id": chat_id})
            if self.path.startswith("/api/chat/completions"):
                STATE["completions"].append(body)
                return self._send({"task_id": f"task-{len(STATE['completions'])}"})
            if self.path.startswith("/__control/bridge"):
                STATE["bridge_ready"] = bool(body.get("ready", True))
                return self._send({"ok": True, "bridge_ready": STATE["bridge_ready"]})
            if self.path.startswith("/__control/complete"):
                chat = STATE["chats"].get(body.get("chat_id", ""))
                if chat is None:
                    return self._send({"ok": False, "error": "unknown chat"}, status=404)
                chat["assistant_content"] = body.get("content", "done")
                chat["completed"] = True
                return self._send({"ok": True})
            if self.path.startswith("/__control/reset"):
                STATE["folders"] = []
                STATE["chats"] = {}
                STATE["completions"] = []
                STATE["requests"] = []
                STATE["bridge_ready"] = True
                return self._send({"ok": True})
        self._send({"detail": f"unmocked POST {self.path}"}, status=404)

    def do_PUT(self):
        self._body()
        with STATE_LOCK:
            STATE["requests"].append(("PUT", self.path))
            if self.path.startswith("/api/v1/chat-state/"):
                return self._send({})
        self._send({"detail": f"unmocked PUT {self.path}"}, status=404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18990
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"mock-owui listening on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
