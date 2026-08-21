#!/usr/bin/env python3

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


STATE = {
    "toggles": {},
    "marketplaces": {},
    "marketplace_order": [],
    "marketplace_skills": {},
    "installed_skills": [],
}


def mock_project_root():
    configured = os.getenv("MOCK_PROJECT_ROOT", "").strip()
    return Path(configured) if configured else None


def canonical_user_skill_markdown(skill_name, content, existing_content=None):
    text = content if isinstance(content, str) else ""
    existing_creator = ""
    if isinstance(existing_content, str):
        for line in existing_content.splitlines():
            if line.startswith("created_by_email:"):
                existing_creator = line.split(":", 1)[1].strip()
                break
    creator = existing_creator or "test-user@example.invalid"
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        try:
            closing_index = next(
                index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"
            )
        except StopIteration as error:
            raise ValueError("malformed skill frontmatter") from error
        metadata_lines = [
            line
            for line in lines[1:closing_index]
            if not line.startswith("name:") and not line.startswith("created_by_email:")
        ]
        body_lines = lines[closing_index + 1 :]
        canonical_lines = [
            "---",
            f"name: {skill_name}",
            f"created_by_email: {creator}",
            *metadata_lines,
            "---",
            *body_lines,
        ]
        return "\n".join(canonical_lines) + ("\n" if text.endswith("\n") else "")

    description = next(
        (
            line.strip()
            for line in lines
            if line.strip() and not line.lstrip().startswith("#")
        ),
        "User-created agent skill.",
    )
    return (
        "---\n"
        f"name: {skill_name}\n"
        f"description: {json.dumps(description)}\n"
        f"created_by_email: {creator}\n"
        "---\n"
        f"{text}"
    )


def parse_body(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length).decode("utf-8") if length else "{}"
    return json.loads(raw or "{}")


def readiness_payload(server_id):
    enabled = STATE["toggles"].get(server_id, True)
    if not enabled:
        return {
            "success": True,
            "server_id": server_id,
            "healthy": False,
            "status": "disabled",
            "readiness_phase": "disabled",
            "discovered": False,
            "openapi_available": False,
            "proxy_probe_ok": False,
            "proxy_probe_status": None,
            "tools_count": 0,
            "total_paths": 0,
        }
    return {
        "success": True,
        "server_id": server_id,
        "healthy": True,
        "status": "healthy",
        "readiness_phase": "tool_ready",
        "discovered": True,
        "openapi_available": True,
        "proxy_probe_ok": True,
        "proxy_probe_status": 422,
        "tools_count": 1,
        "total_paths": 1,
    }


def marketplace_id_from_source(source_input):
    source = (source_input or "marketplace").strip().rstrip("/")
    if not source:
        source = "marketplace"
    parsed = urlparse(source)
    segments = [segment for segment in parsed.path.split("/") if segment]
    candidate = segments[-1] if segments else source
    if candidate.endswith(".git"):
        candidate = candidate[:-4]
    if candidate in {"marketplace.json", "plugin.json"} and len(segments) >= 2:
        candidate = segments[-2]
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in candidate).strip("-")
    return slug or "marketplace"


def default_marketplace(marketplace_id, source_input):
    return {
        "id": marketplace_id,
        "name": marketplace_id.replace("-", " ").title(),
        "source": {
            "type": "mock",
            "input": source_input,
        },
        "isOfficial": False,
        "hasUpdate": False,
    }


def default_marketplace_skills(marketplace_id):
    skill_id = f"{marketplace_id}-skill"
    return [
        {
            "id": skill_id,
            "name": skill_id.replace("-", " ").title(),
            "description": "Mock marketplace skill",
            "version": "1.0.0",
            "path": f"skills-marketplace/{marketplace_id}/{skill_id}",
            "source": {
                "type": "mock",
                "marketplaceId": marketplace_id,
            },
        }
    ]


def ensure_marketplace_skills(marketplace_id):
    if marketplace_id not in STATE["marketplace_skills"]:
        STATE["marketplace_skills"][marketplace_id] = default_marketplace_skills(marketplace_id)
    return STATE["marketplace_skills"][marketplace_id]


def find_skill(marketplace_id, skill_id):
    skills = ensure_marketplace_skills(marketplace_id)
    for skill in skills:
        if skill.get("id") == skill_id:
            return skill
    return None


def find_installed_skill(marketplace_id, skill_id):
    for installed in STATE["installed_skills"]:
        if (
            installed.get("marketplaceId") == marketplace_id
            and installed.get("skillId") == skill_id
        ):
            return installed
    return None


def marketplace_list_payload():
    return {
        "success": True,
        "data": {
            "marketplaces": [
                STATE["marketplaces"][marketplace_id]
                for marketplace_id in STATE["marketplace_order"]
                if marketplace_id in STATE["marketplaces"]
            ],
            "installedSkills": list(STATE["installed_skills"]),
        },
    }


def marketplace_error(handler, message, code, status=400):
    handler._send_json(
        {
            "success": False,
            "error": message,
            "errorCode": code,
        },
        status=status,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "mock-electron-api/1.0"

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
        if self.path.startswith("/api/server-readiness/"):
            server_id = self.path.rsplit("/", 1)[-1]
            self._send_json(readiness_payload(server_id))
            return
        if self.path == "/api/marketplaces":
            self._send_json(marketplace_list_payload())
            return
        # App-owned identity endpoints (mirror api.js response shapes). The
        # Subagents server fails closed on these: create_agent resolves
        # created_by_email via /api/agent-attribution/current-user, and the
        # lifecycle/reconcile handlers require a links object from
        # /api/agent-attribution/context.
        if self.path == "/api/creator-identity/current-user":
            self._send_json({"email": "test-user@example.invalid", "ldap": "test-user"})
            return
        if self.path == "/api/agent-attribution/current-user":
            self._send_json({"email": "test-user@example.invalid"})
            return
        if self.path == "/api/agent-attribution/context":
            self._send_json({"email": "test-user@example.invalid", "links": {}})
            return
        parsed_path = urlparse(self.path)
        if parsed_path.path.startswith("/api/marketplaces/") and parsed_path.path.endswith(
            "/skills"
        ):
            marketplace_id = parsed_path.path.split("/", 4)[3]
            marketplace = STATE["marketplaces"].get(marketplace_id)
            if marketplace is None:
                marketplace_error(
                    self,
                    f"Marketplace '{marketplace_id}' not found",
                    "marketplace_not_found",
                    status=404,
                )
                return
            skills = [
                {
                    **skill,
                    "installed": find_installed_skill(
                        marketplace_id, skill.get("id")
                    )
                    is not None,
                    "installedVersion": (
                        find_installed_skill(marketplace_id, skill.get("id")) or {}
                    ).get("installedVersion"),
                    "hasUpdate": bool(
                        (find_installed_skill(marketplace_id, skill.get("id")) or {}).get(
                            "hasUpdate"
                        )
                    ),
                    "isDirty": bool(
                        (find_installed_skill(marketplace_id, skill.get("id")) or {}).get(
                            "isDirty"
                        )
                    ),
                    "hasConflict": bool(
                        (find_installed_skill(marketplace_id, skill.get("id")) or {}).get(
                            "hasConflict"
                        )
                    ),
                    "localPath": (
                        find_installed_skill(marketplace_id, skill.get("id")) or {}
                    ).get("localPath"),
                }
                for skill in ensure_marketplace_skills(marketplace_id)
            ]
            # Mirror the real route's optional agentic filters.
            params = parse_qs(parsed_path.query)
            plugin_name = (params.get("plugin_name") or [""])[0]
            search = (params.get("search") or [""])[0].strip().lower()
            limit_raw = (params.get("limit") or [""])[0]
            if plugin_name:
                skills = [
                    skill
                    for skill in skills
                    if (skill.get("pluginName") or "") == plugin_name
                ]
            if search:
                skills = [
                    skill
                    for skill in skills
                    if search
                    in " ".join(
                        [
                            str(skill.get("id") or ""),
                            str(skill.get("display_name") or ""),
                            str(skill.get("description") or ""),
                        ]
                    ).lower()
                ]
            total_matching = len(skills)
            if limit_raw.isdigit() and int(limit_raw) > 0:
                skills = skills[: int(limit_raw)]
            self._send_json(
                {
                    "success": True,
                    "marketplace": marketplace,
                    "skills": skills,
                    "total_matching": total_matching,
                }
            )
            return
        self._send_json({"error": f"not found: {self.path}"}, status=404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = parse_body(self)

        if path in {"/api/user-skills/create", "/api/user-skills/update"}:
            project_root = mock_project_root()
            skill_name = str(body.get("skill_name") or "").strip()
            skill_content = body.get("skill_content")
            if project_root is None or not skill_name or not isinstance(skill_content, str):
                self._send_json(
                    {
                        "success": False,
                        "error": "invalid mock user-skill request",
                        "code": "invalid_skill_content",
                    },
                    status=400,
                )
                return
            skill_dir = project_root / "skills-user" / skill_name
            skill_file = skill_dir / "SKILL.md"
            is_create = path.endswith("/create")
            if is_create and skill_dir.exists():
                self._send_json(
                    {
                        "success": False,
                        "error": f"Skill '{skill_name}' already exists.",
                        "code": "skill_already_exists",
                    },
                    status=409,
                )
                return
            if not is_create and not skill_file.is_file():
                self._send_json(
                    {
                        "success": False,
                        "error": f"Skill '{skill_name}' was not found.",
                        "code": "skill_not_found",
                    },
                    status=404,
                )
                return
            existing = skill_file.read_text(encoding="utf-8") if skill_file.is_file() else None
            try:
                canonical = canonical_user_skill_markdown(
                    skill_name,
                    skill_content,
                    existing_content=existing,
                )
            except ValueError as error:
                self._send_json(
                    {
                        "success": False,
                        "error": str(error),
                        "code": "malformed_skill_frontmatter",
                    },
                    status=400,
                )
                return
            skill_dir.mkdir(parents=True, exist_ok=True)
            if is_create:
                (skill_dir / "references").mkdir(exist_ok=True)
                (skill_dir / "scripts").mkdir(exist_ok=True)
            temp_file = skill_dir / ".SKILL.md.tmp"
            temp_file.write_text(canonical, encoding="utf-8")
            temp_file.replace(skill_file)
            self._send_json(
                {
                    "success": True,
                    "skill_name": skill_name,
                    "path": str(skill_file),
                    "created_by_email": "test-user@example.invalid",
                }
            )
            return

        if path == "/api/persist-mcp-toggle":
            server_id = body.get("server_id")
            if isinstance(server_id, str):
                STATE["toggles"][server_id] = bool(body.get("enabled"))
            self._send_json({"success": True, "persisted": body})
            return

        if path.startswith("/api/restart-mcp-server/"):
            server_id = path.rsplit("/", 1)[-1]
            self._send_json(
                {
                    "success": True,
                    "server_id": server_id,
                    "mode": "docker",
                    "healthy": True,
                    "readiness_phase": "tool_ready",
                    "message": f"Server {server_id} restarted successfully",
                }
            )
            return

        if path.startswith("/api/delete-mcp-server/"):
            server_id = path.rsplit("/", 1)[-1]
            toggle_removed = server_id in STATE["toggles"]
            STATE["toggles"].pop(server_id, None)
            self._send_json(
                {
                    "success": True,
                    "server_id": server_id,
                    "files_deleted_count": 1,
                    "toggle_removed": toggle_removed,
                    "message": f"User-installed MCP server '{server_id}' deleted",
                    "warnings": [],
                }
            )
            return

        if path == "/api/restart-mcp":
            self._send_json(
                {
                    "success": True,
                    "healthCheckPassed": True,
                    "logs": ["mock restart completed"],
                }
            )
            return

        if path == "/api/toggle-mcp-server":
            enabled = bool(body.get("enabled"))
            server_id = body.get("server_id")
            if isinstance(server_id, str):
                STATE["toggles"][server_id] = enabled
            self._send_json(
                {
                    "success": True,
                    "server_id": server_id,
                    "healthy": enabled,
                    "readiness_phase": "tool_ready" if enabled else "disabled",
                    "message": "toggle complete",
                }
            )
            return

        if path == "/api/trigger-oauth-flow":
            self._send_json(
                {
                    "success": True,
                    "completed": True,
                    "healthy": True,
                    "already_authorized": False,
                    "message": "OAuth authorization completed",
                }
            )
            return

        if path == "/api/trigger-guided-setup":
            self._send_json(
                {
                    "success": True,
                    "completed": True,
                    "healthy": True,
                    "dismissed": False,
                    "message": "Guided setup finished",
                }
            )
            return

        if path in {
            "/api/open-artifact",
            "/api/close-artifact",
        }:
            self._send_json({"success": True, "path": path, "payload": body})
            return

        if path == "/api/oauth-log":
            self._send_json({"success": True})
            return

        if path == "/api/marketplaces":
            source_input = body.get("source_input") or body.get("sourceInput") or ""
            marketplace_id = marketplace_id_from_source(source_input)
            marketplace = default_marketplace(marketplace_id, source_input)
            STATE["marketplaces"][marketplace_id] = marketplace
            if marketplace_id not in STATE["marketplace_order"]:
                STATE["marketplace_order"].append(marketplace_id)
            ensure_marketplace_skills(marketplace_id)
            self._send_json({"success": True, "marketplace": marketplace})
            return

        if path == "/api/marketplaces/remove":
            marketplace_id = body.get("marketplace_id") or body.get("marketplaceId")
            if marketplace_id not in STATE["marketplaces"]:
                marketplace_error(
                    self,
                    f"Marketplace '{marketplace_id}' not found",
                    "marketplace_not_found",
                    status=404,
                )
                return
            remove_installed_skills = bool(
                body.get("remove_installed_skills") or body.get("removeInstalledSkills")
            )
            removed_skills_count = 0
            if remove_installed_skills:
                remaining = []
                for installed in STATE["installed_skills"]:
                    if installed.get("marketplaceId") == marketplace_id:
                        removed_skills_count += 1
                    else:
                        remaining.append(installed)
                STATE["installed_skills"] = remaining
            STATE["marketplaces"].pop(marketplace_id, None)
            STATE["marketplace_skills"].pop(marketplace_id, None)
            STATE["marketplace_order"] = [
                item for item in STATE["marketplace_order"] if item != marketplace_id
            ]
            self._send_json(
                {
                    "success": True,
                    "marketplaceId": marketplace_id,
                    "removedInstalledSkills": remove_installed_skills,
                    "removedSkillsCount": removed_skills_count,
                }
            )
            return

        if path == "/api/marketplaces/sync":
            marketplace_id = body.get("marketplace_id") or body.get("marketplaceId")
            marketplace = STATE["marketplaces"].get(marketplace_id)
            if marketplace is None:
                marketplace_error(
                    self,
                    f"Marketplace '{marketplace_id}' not found",
                    "marketplace_not_found",
                    status=404,
                )
                return
            self._send_json(
                {
                    "success": True,
                    # Mirrors the real route's dieted marketplace header (no
                    # cachedManifest) plus per-skill sync verdict arrays.
                    "marketplace": {
                        "id": marketplace.get("id"),
                        "name": marketplace.get("name"),
                        "marketplaceVersion": marketplace.get("marketplaceVersion"),
                        "lastSynced": marketplace.get("lastSynced"),
                        "skill_count": len(
                            STATE["marketplace_skills"].get(marketplace_id, [])
                        ),
                    },
                    "hasUpdate": bool(marketplace.get("hasUpdate")),
                    "skillsUpdated": [],
                    "skillsConflicted": [],
                    "skillsUpToDate": [],
                    "skillSyncErrors": [],
                }
            )
            return

        if path == "/api/marketplaces/sync-all":
            self._send_json(
                {
                    "success": True,
                    "results": [
                        {
                            "id": marketplace_id,
                            "success": True,
                            "hasUpdate": bool(STATE["marketplaces"][marketplace_id].get("hasUpdate")),
                        }
                        for marketplace_id in STATE["marketplace_order"]
                        if marketplace_id in STATE["marketplaces"]
                    ],
                }
            )
            return

        if path == "/api/marketplaces/skills/install":
            marketplace_id = body.get("marketplace_id") or body.get("marketplaceId")
            skill_id = body.get("skill_id") or body.get("skillId")
            skill_path = body.get("skill_path") or body.get("skillPath")
            marketplace = STATE["marketplaces"].get(marketplace_id)
            if marketplace is None:
                marketplace_error(
                    self,
                    f"Marketplace '{marketplace_id}' not found",
                    "marketplace_not_found",
                    status=404,
                )
                return
            skill = find_skill(marketplace_id, skill_id)
            version = skill.get("version", "1.0.0") if skill else "1.0.0"
            installed = {
                "marketplaceId": marketplace_id,
                "skillId": skill_id,
                "localPath": skill_path or f"skills-marketplace/{marketplace_id}/{skill_id}",
                "installedVersion": version,
                "hasUpdate": False,
                "isDirty": False,
                "hasConflict": False,
            }
            STATE["installed_skills"] = [
                item
                for item in STATE["installed_skills"]
                if not (
                    item.get("marketplaceId") == marketplace_id
                    and item.get("skillId") == skill_id
                )
            ]
            STATE["installed_skills"].append(installed)
            self._send_json(
                {
                    "success": True,
                    "localPath": installed["localPath"],
                    "version": version,
                    "pluginName": body.get("plugin_name") or body.get("pluginName"),
                    "display_name": skill_id,
                    # Mirrors the real route: set only after the registry
                    # record is written (registered install vs files on disk).
                    "registered": True,
                    "marketplace_id": marketplace_id,
                    "skill_id": skill_id,
                }
            )
            return

        if path == "/api/marketplaces/skills/uninstall":
            marketplace_id = body.get("marketplace_id") or body.get("marketplaceId")
            skill_id = body.get("skill_id") or body.get("skillId")
            before_count = len(STATE["installed_skills"])
            STATE["installed_skills"] = [
                item
                for item in STATE["installed_skills"]
                if not (
                    item.get("marketplaceId") == marketplace_id
                    and item.get("skillId") == skill_id
                )
            ]
            if len(STATE["installed_skills"]) == before_count:
                marketplace_error(
                    self,
                    f"Skill '{skill_id}' is not installed",
                    "skill_not_installed",
                    status=404,
                )
                return
            self._send_json(
                {
                    "success": True,
                    "marketplaceId": marketplace_id,
                    "skillId": skill_id,
                }
            )
            return

        if path == "/api/marketplaces/skills/detach":
            marketplace_id = body.get("marketplace_id") or body.get("marketplaceId")
            skill_id = body.get("skill_id") or body.get("skillId")
            target_skill_name = (
                body.get("target_skill_name")
                or body.get("targetSkillName")
                or f"{skill_id}-detached"
            )
            before_count = len(STATE["installed_skills"])
            STATE["installed_skills"] = [
                item
                for item in STATE["installed_skills"]
                if not (
                    item.get("marketplaceId") == marketplace_id
                    and item.get("skillId") == skill_id
                )
            ]
            if len(STATE["installed_skills"]) == before_count:
                marketplace_error(
                    self,
                    f"Skill '{skill_id}' is not installed",
                    "skill_not_installed",
                    status=404,
                )
                return
            self._send_json(
                {
                    "success": True,
                    "marketplaceId": marketplace_id,
                    "skillId": skill_id,
                    "skillName": target_skill_name,
                    "localPath": f"skills-user/{target_skill_name}",
                }
            )
            return

        if path == "/api/marketplaces/skills/check-updates":
            self._send_json({"success": True, "updates": [], "hasUpdates": False})
            return

        if path == "/api/marketplaces/skills/update":
            marketplace_id = body.get("marketplace_id") or body.get("marketplaceId")
            skill_id = body.get("skill_id") or body.get("skillId")
            skill = find_skill(marketplace_id, skill_id)
            version = skill.get("version", "1.0.0") if skill else "1.0.0"
            self._send_json({"success": True, "version": version})
            return

        self._send_json({"error": f"not found: {self.path}"}, status=404)


if __name__ == "__main__":
    port = int(os.environ.get("MOCK_ELECTRON_PORT", "9987"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
