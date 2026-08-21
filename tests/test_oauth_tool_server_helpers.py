from pathlib import Path
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))

from open_webui.utils.oauth_tool_servers import (  # noqa: E402
    find_connection_for_client_id,
    iter_oauth21_tool_server_connections,
    oauth21_client_id,
)


def test_find_connection_for_client_id_canonicalizes_openapi_oauth21_servers():
    connections = [
        {
            "type": "openapi",
            "auth_type": "oauth_2.1",
            "info": {"id": "google_workspace"},
        }
    ]

    index, connection, resolved_client_id = find_connection_for_client_id(
        connections,
        "mcp:google_workspace",
    )

    assert index == 0
    assert connection == connections[0]
    assert resolved_client_id == oauth21_client_id("google_workspace")


def test_find_connection_for_client_id_preserves_non_oauth_exact_type_match():
    connections = [
        {
            "type": "openapi",
            "auth_type": "bearer",
            "info": {"id": "sourcegraph"},
        }
    ]

    index, connection, resolved_client_id = find_connection_for_client_id(
        connections,
        "openapi:sourcegraph",
    )

    assert index == 0
    assert connection == connections[0]
    assert resolved_client_id == "openapi:sourcegraph"


def test_iter_oauth21_tool_server_connections_uses_mcp_namespace():
    connections = [
        {
            "type": "openapi",
            "auth_type": "oauth_2.1",
            "info": {"id": "google_workspace"},
        },
        {
            "type": "openapi",
            "auth_type": "bearer",
            "info": {"id": "sourcegraph"},
        },
    ]

    assert list(iter_oauth21_tool_server_connections(connections)) == [
        ("mcp:google_workspace", connections[0])
    ]
