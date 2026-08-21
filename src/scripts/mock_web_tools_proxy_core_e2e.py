#!/usr/bin/env python3

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    server_version = "mock-web-tools-proxy/1.0"

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
        if self.path == "/health":
            self._send_json({"ok": True})
            return
        self._send_json({"error": f"not found: {self.path}"}, status=404)

    def do_POST(self):
        if self.path != "/openai/v1/responses":
            self._send_json({"error": f"not found: {self.path}"}, status=404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8") if length else "{}"
        payload = json.loads(raw_body or "{}")
        prompt = payload.get("input", "")
        response = {
            "id": "resp_mock_123",
            "object": "response",
            "created_at": 1760000000,
            "status": "completed",
            "model": payload.get("model", "mock-web-search"),
            "output": [
                {
                    "id": "ws_1",
                    "type": "web_search_call",
                    "status": "completed",
                },
                {
                    "id": "msg_1",
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": f"Mock web search result for: {prompt}",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://example.com/mock-result",
                                    "title": "Mock Result",
                                    "start_index": 0,
                                    "end_index": 4,
                                }
                            ],
                        }
                    ],
                },
            ],
            "usage": {
                "input_tokens": 12,
                "output_tokens": 24,
            },
        }
        self._send_json(response)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
