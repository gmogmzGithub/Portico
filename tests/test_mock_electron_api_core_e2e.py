import importlib.util
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "scripts"
    / "mock_electron_api_core_e2e.py"
)


def load_mock_module():
    spec = importlib.util.spec_from_file_location(
        "mock_electron_api_core_e2e",
        SCRIPT_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def post_json(base_url, path, payload):
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(base_url, path):
    with urllib.request.urlopen(f"{base_url}{path}", timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def test_delete_mcp_server_route_returns_structured_success_and_clears_toggle():
    module = load_mock_module()
    module.STATE["toggles"].clear()
    module.STATE["toggles"]["demo-user-http"] = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"

    try:
        response = post_json(base_url, "/api/delete-mcp-server/demo-user-http", {})
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert response["success"] is True
    assert response["server_id"] == "demo-user-http"
    assert response["toggle_removed"] is True
    assert response["files_deleted_count"] == 1
    assert "demo-user-http" not in module.STATE["toggles"]


def test_user_skill_routes_canonicalize_creator_and_preserve_it_on_update(tmp_path, monkeypatch):
    module = load_mock_module()
    monkeypatch.setenv("MOCK_PROJECT_ROOT", str(tmp_path))
    server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"

    try:
        created = post_json(
            base_url,
            "/api/user-skills/create",
            {
                "skill_name": "plain-skill",
                "skill_content": "# Plain Skill\n\nPlain description.\n",
                "author": "Spoofed Caller",
            },
        )
        updated = post_json(
            base_url,
            "/api/user-skills/update",
            {
                "skill_name": "plain-skill",
                "skill_content": "# Plain Skill\n\nUpdated description.\n",
            },
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    skill_file = tmp_path / "skills-user" / "plain-skill" / "SKILL.md"
    content = skill_file.read_text(encoding="utf-8")
    assert created["success"] is True
    assert updated["success"] is True
    assert "name: plain-skill" in content
    assert "created_by_email: test-user@example.invalid" in content
    assert "Updated description." in content
    assert "Spoofed Caller" not in content


def test_marketplace_routes_support_add_list_install_and_remove_flow():
    module = load_mock_module()
    module.STATE["marketplaces"].clear()
    module.STATE["marketplace_order"].clear()
    module.STATE["marketplace_skills"].clear()
    module.STATE["installed_skills"].clear()

    server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"

    try:
        added = post_json(base_url, "/api/marketplaces", {"source_input": "squall-mod/trust-kit"})
        marketplace_id = added["marketplace"]["id"]

        listed = get_json(base_url, "/api/marketplaces")
        skills = get_json(base_url, f"/api/marketplaces/{marketplace_id}/skills")
        skill_id = skills["skills"][0]["id"]

        installed = post_json(
            base_url,
            "/api/marketplaces/skills/install",
            {
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
                "skill_path": f"skills-marketplace/{marketplace_id}/{skill_id}",
            },
        )
        updated = post_json(
            base_url,
            "/api/marketplaces/skills/update",
            {
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
            },
        )
        detached = post_json(
            base_url,
            "/api/marketplaces/skills/detach",
            {
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
            },
        )
        reinstalled = post_json(
            base_url,
            "/api/marketplaces/skills/install",
            {
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
                "skill_path": f"skills-marketplace/{marketplace_id}/{skill_id}",
            },
        )
        uninstalled = post_json(
            base_url,
            "/api/marketplaces/skills/uninstall",
            {
                "marketplace_id": marketplace_id,
                "skill_id": skill_id,
            },
        )
        removed = post_json(
            base_url,
            "/api/marketplaces/remove",
            {
                "marketplace_id": marketplace_id,
                "remove_installed_skills": True,
            },
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert added["success"] is True
    assert marketplace_id == "trust-kit"
    assert listed["data"]["marketplaces"][0]["id"] == marketplace_id
    assert skills["marketplace"]["id"] == marketplace_id
    assert installed["success"] is True
    assert updated["version"] == "1.0.0"
    assert detached["success"] is True
    assert detached["skillName"] == f"{skill_id}-detached"
    assert reinstalled["success"] is True
    assert uninstalled["success"] is True
    assert removed["removedInstalledSkills"] is True
    assert marketplace_id not in module.STATE["marketplaces"]
