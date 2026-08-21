"""Add a denormalized model ID to chat rows.

Revision ID: portico_chat_model_id_v1
Revises: portico_title_emoji_v1
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "portico_chat_model_id_v1"
down_revision: Union[str, None] = "portico_title_emoji_v1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Deliberately do not backfill legacy rows: parsing every historical chat
    # during startup would recreate the multi-gigabyte lock incident this
    # column is intended to prevent. Normal create/update paths populate it.
    op.add_column("chat", sa.Column("model_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("chat", "model_id")
