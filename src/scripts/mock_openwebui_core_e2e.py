#!/usr/bin/env python3

import json
import threading
import uuid
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


TOOLS = [
    {"id": "server:mcp-assistant", "name": "MCP Assistant"},
    {"id": "server:skills", "name": "Skills"},
    {"id": "server:subagents", "name": "Subagents"},
    {"id": "server:agent-vm", "name": "Agent VM"},
    {"id": "server:web-tools", "name": "Web Tools"},
]

LOCK = threading.Lock()
STATE = {
    "folders": {},
    "chats": {},
    "models": {},
}


def base_models():
    return {
        "mock-base-model": {
            "id": "mock-base-model",
            "name": "Mock Base Model",
            "meta": {
                "description": "Base model for e2e",
                "toolIds": ["server:mcp-assistant", "server:skills"],
            },
            "params": {"system": ""},
            "info": {
                "base_model_id": None,
                "meta": {"toolIds": ["server:mcp-assistant", "server:skills"]},
            },
            "base_model_id": None,
            "is_active": True,
            "is_default": True,
        },
        "portico_agent_mock-agent": {
            "id": "portico_agent_mock-agent",
            "name": "Mock Derived Agent",
            "meta": {
                "description": "Derived agent for e2e",
                "toolIds": ["server:mcp-assistant", "server:skills", "server:subagents", "server:agent-vm"],
            },
            "params": {"system": "System prompt for mock derived agent"},
            "info": {
                "base_model_id": "mock-base-model",
                "meta": {
                    "toolIds": [
                        "server:mcp-assistant",
                        "server:skills",
                        "server:subagents",
                        "server:agent-vm",
                    ]
                },
            },
            "base_model_id": "mock-base-model",
            "is_active": True,
        },
    }


STATE["models"] = base_models()


def parse_body(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length).decode("utf-8") if length else "{}"
    return json.loads(raw or "{}")


def build_model(payload):
    model_id = payload.get("id") or f"model-{uuid.uuid4().hex[:8]}"
    meta = dict(payload.get("meta") or {})
    params = dict(payload.get("params") or {})
    tool_ids = list(meta.get("toolIds") or [])
    base_model_id = payload.get("base_model_id")
    return {
        "id": model_id,
        "name": payload.get("name", model_id),
        "meta": meta,
        "params": params,
        "info": {
            "base_model_id": base_model_id,
            "meta": {"toolIds": tool_ids},
        },
        "base_model_id": base_model_id,
        "is_active": payload.get("is_active", True),
    }


def get_model(model_id):
    with LOCK:
        return deepcopy(STATE["models"].get(model_id))


def upsert_model(model):
    with LOCK:
        STATE["models"][model["id"]] = deepcopy(model)
        return deepcopy(STATE["models"][model["id"]])


def remove_model(model_id):
    with LOCK:
        return STATE["models"].pop(model_id, None) is not None


def ensure_folder(name):
    with LOCK:
        for folder in STATE["folders"].values():
            if folder["name"] == name:
                return deepcopy(folder)
        folder = {"id": f"folder-{uuid.uuid4().hex[:8]}", "name": name}
        STATE["folders"][folder["id"]] = folder
        return deepcopy(folder)


def create_chat(payload):
    chat_id = f"chat-{uuid.uuid4().hex[:8]}"
    chat = deepcopy(payload.get("chat") or {})
    chat["id"] = chat_id
    with LOCK:
        STATE["chats"][chat_id] = chat
    return chat_id


def append_assistant_message(chat_id, model, prompt):
    response_text = f"Subagent response to: {prompt}"
    assistant_id = f"assistant-{uuid.uuid4().hex[:8]}"
    message = {
        "id": assistant_id,
        "role": "assistant",
        "content": response_text,
        "lastSentence": response_text,
        "done": True,
        "timestamp": 1760000000,
        "models": [model],
    }
    with LOCK:
        chat = STATE["chats"][chat_id]
        chat.setdefault("models", [model])
        chat.setdefault("messages", []).append(message)
        chat.setdefault("history", {}).setdefault("messages", {})[assistant_id] = message
        chat["history"]["currentId"] = assistant_id


class Handler(BaseHTTPRequestHandler):
    server_version = "mock-open-webui/2.0"

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._send_json({"ok": True})
            return
        if path == "/api/models":
            with LOCK:
                self._send_json({"data": list(deepcopy(STATE["models"]).values())})
            return
        if path == "/api/v1/tools/":
            self._send_json(TOOLS)
            return
        if path == "/api/v1/auths/":
            self._send_json({"id": "mock-user-id"})
            return
        if path == "/api/v1/folders/":
            with LOCK:
                self._send_json(list(deepcopy(STATE["folders"]).values()))
            return
        if path == "/api/v1/models/model":
            model_id = parse_qs(parsed.query).get("id", [""])[0]
            model = get_model(model_id)
            if model is None:
                self._send_json({"error": "model not found"}, status=404)
                return
            self._send_json(model)
            return
        if path.startswith("/api/models/") or path.startswith("/api/v1/models/"):
            model_id = path.rsplit("/", 1)[-1]
            model = get_model(model_id)
            if model is None:
                self._send_json({"error": "model not found"}, status=404)
                return
            self._send_json(model)
            return
        if path.startswith("/api/v1/chats/"):
            chat_id = path.rsplit("/", 1)[-1]
            with LOCK:
                chat = deepcopy(STATE["chats"].get(chat_id))
            if chat is None:
                self._send_json({"error": "chat not found"}, status=404)
                return
            self._send_json({"chat": chat})
            return

        self._send_json({"error": f"not found: {self.path}"}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        payload = parse_body(self)

        if path == "/api/v1/models/create":
            self._send_json(upsert_model(build_model(payload)))
            return

        if path == "/api/v1/models/model/update":
            model_id = parse_qs(parsed.query).get("id", [""])[0] or payload.get("id", "")
            existing = get_model(model_id)
            if existing is None:
                self._send_json({"error": "model not found"}, status=404)
                return
            updated = build_model({**existing, **payload, "id": model_id})
            self._send_json(upsert_model(updated))
            return

        if path == "/api/v1/models/model/delete":
            deleted = remove_model(payload.get("id", ""))
            self._send_json({"success": deleted})
            return

        if path == "/api/v1/folders/":
            name = payload.get("name", "Sub-agents")
            self._send_json(ensure_folder(name))
            return

        if path == "/api/v1/chats/new":
            chat_id = create_chat(payload)
            self._send_json({"id": chat_id})
            return

        if path == "/api/chat/completions":
            chat_id = payload.get("chat_id", "")
            model = payload.get("model", "mock-base-model")
            prompt = ""
            messages = payload.get("messages") or []
            if messages:
                prompt = messages[0].get("content", "")
            append_assistant_message(chat_id, model, prompt)
            self._send_json({"task_id": f"task-{uuid.uuid4().hex[:8]}"})
            return

        if path.endswith("/capabilities-changed"):
            self._send_json({"success": True})
            return

        self._send_json({"error": f"not found: {self.path}"}, status=404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/v1/models/") and path.endswith("/delete"):
            model_id = path.split("/")[-2]
            self._send_json({"success": remove_model(model_id)})
            return

        self._send_json({"error": f"not found: {self.path}"}, status=404)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
