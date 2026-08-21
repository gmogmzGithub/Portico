"""Efficient owner-scoped model identity lookup for lightweight sidebar rows."""

from __future__ import annotations

from collections.abc import Iterable
import logging
from typing import Optional

from sqlalchemy import bindparam, text

from open_webui.internal.db import engine


log = logging.getLogger(__name__)


_SQLITE_MODEL_QUERY = """
SELECT c.id,
       COALESCE(
         CASE
           WHEN json_extract(c.chat, '$.history.messages."' ||
                json_extract(c.chat, '$.history.currentId') || '".role') = 'assistant'
           THEN json_extract(c.chat, '$.history.messages."' ||
                json_extract(c.chat, '$.history.currentId') || '".model')
         END,
         CASE
           WHEN json_extract(c.chat, '$.history.messages."' ||
                json_extract(c.chat, '$.history.currentId') || '".role') = 'user'
           THEN json_extract(c.chat, '$.history.messages."' ||
                json_extract(
                  c.chat,
                  '$.history.messages."' ||
                  json_extract(c.chat, '$.history.currentId') || '".parentId'
                ) || '".model')
         END,
         json_extract(c.chat, '$.models[0]'),
         json_extract(c.chat, '$.model')
       ) AS model_id
FROM chat AS c
WHERE c.user_id = :user_id
  AND c.id IN :chat_ids
  AND json_valid(c.chat)
"""

_POSTGRES_MODEL_QUERY = """
SELECT c.id,
       COALESCE(
         CASE
           WHEN c.chat -> 'history' -> 'messages'
                -> (c.chat -> 'history' ->> 'currentId') ->> 'role' = 'assistant'
           THEN c.chat -> 'history' -> 'messages'
                -> (c.chat -> 'history' ->> 'currentId') ->> 'model'
         END,
         CASE
           WHEN c.chat -> 'history' -> 'messages'
                -> (c.chat -> 'history' ->> 'currentId') ->> 'role' = 'user'
           THEN c.chat -> 'history' -> 'messages'
                -> (
                  c.chat -> 'history' -> 'messages'
                  -> (c.chat -> 'history' ->> 'currentId') ->> 'parentId'
                ) ->> 'model'
         END,
         c.chat -> 'models' ->> 0,
         c.chat ->> 'model'
       ) AS model_id
FROM chat AS c
WHERE c.user_id = :user_id AND c.id IN :chat_ids
"""


def get_sidebar_chat_model_ids(
    user_id: str,
    chat_ids: Iterable[str],
    *,
    db_engine=engine,
) -> dict[str, Optional[str]]:
    """Return one display model per requested chat without loading chat histories."""
    unique_ids = list(dict.fromkeys(chat_id for chat_id in chat_ids if chat_id))
    if not unique_ids:
        return {}

    dialect_name = db_engine.dialect.name
    if dialect_name not in {"sqlite", "postgresql"}:
        log.warning("Sidebar model metadata is unsupported for %s", dialect_name)
        return {}

    query_text = _SQLITE_MODEL_QUERY if dialect_name == "sqlite" else _POSTGRES_MODEL_QUERY
    query = text(query_text).bindparams(bindparam("chat_ids", expanding=True))
    try:
        with db_engine.connect() as connection:
            rows = connection.execute(
                query,
                {"user_id": user_id, "chat_ids": unique_ids},
            ).mappings()
            return {
                row["id"]: str(row["model_id"]) if row["model_id"] else None
                for row in rows
            }
    except Exception:
        # Logos are optional. A database/version edge case must degrade to the
        # favicon fallback instead of taking down the chat-list endpoints.
        log.warning("Sidebar model metadata query failed", exc_info=True)
        return {}
