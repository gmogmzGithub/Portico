from __future__ import annotations

from typing import Any, Iterable


def oauth21_client_id(server_id: str) -> str:
    return f"mcp:{server_id}"


def split_client_id(client_id: str) -> tuple[str | None, str | None]:
    server_type, separator, server_id = client_id.partition(":")
    if not separator or not server_type or not server_id:
        return None, None
    return server_type, server_id


def is_oauth21_tool_server_connection(connection: dict[str, Any] | None) -> bool:
    if not isinstance(connection, dict):
        return False
    info = connection.get("info") or {}
    return bool(info.get("id")) and connection.get("auth_type") == "oauth_2.1"


def find_connection_for_client_id(
    connections: Iterable[dict[str, Any]] | None,
    client_id: str,
) -> tuple[int | None, dict[str, Any] | None, str]:
    server_type, server_id = split_client_id(client_id)
    if not server_type or not server_id:
        return None, None, client_id

    exact_match: tuple[int, dict[str, Any], str] | None = None
    oauth21_match: tuple[int, dict[str, Any], str] | None = None

    for idx, connection in enumerate(connections or []):
        info = connection.get("info") or {}
        if info.get("id") != server_id:
            continue

        if is_oauth21_tool_server_connection(connection):
            oauth21_match = (idx, connection, oauth21_client_id(server_id))
            if server_type == "mcp":
                return oauth21_match
            continue

        if connection.get("type", "openapi") == server_type:
            exact_match = (idx, connection, client_id)
            break

    if oauth21_match is not None:
        return oauth21_match
    if exact_match is not None:
        return exact_match
    return None, None, client_id


def iter_oauth21_tool_server_connections(
    connections: Iterable[dict[str, Any]] | None,
):
    for connection in connections or []:
        if not is_oauth21_tool_server_connection(connection):
            continue
        server_id = (connection.get("info") or {}).get("id")
        if not server_id:
            continue
        yield oauth21_client_id(server_id), connection
