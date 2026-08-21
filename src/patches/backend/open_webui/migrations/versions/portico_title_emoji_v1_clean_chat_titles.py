"""Remove emoji from existing chat titles.

Revision ID: portico_title_emoji_v1
Revises: c440947495f3
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from open_webui.utils.chat_titles import normalize_chat_title


revision: str = "portico_title_emoji_v1"
down_revision: Union[str, None] = "c440947495f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    connection = op.get_bind()
    chat_table = sa.table(
        "chat",
        sa.column("id", sa.String()),
        sa.column("title", sa.Text()),
        sa.column("chat", sa.JSON()),
    )

    rows = list(
        connection.execute(
            sa.select(chat_table.c.id, chat_table.c.title, chat_table.c.chat)
        ).mappings()
    )
    for row in rows:
        normalized_title = normalize_chat_title(row["title"])
        values = {"title": normalized_title}

        chat_payload = row["chat"]
        if isinstance(chat_payload, dict):
            normalized_payload = dict(chat_payload)
            normalized_payload["title"] = normalize_chat_title(
                normalized_payload.get("title"),
                fallback=normalized_title,
            )
            values["chat"] = normalized_payload

        connection.execute(
            chat_table.update()
            .where(chat_table.c.id == row["id"])
            .values(**values)
        )


def downgrade() -> None:
    # Removed emoji cannot be reconstructed. This data cleanup is irreversible.
    pass
