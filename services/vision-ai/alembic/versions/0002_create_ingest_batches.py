"""create ingest_batches idempotency ledger

Adds the ``ingest_batches`` table backing detection-ingest idempotency
(Task 9.3, Requirement 11.8): each row records a caller-supplied idempotency
key and the serialised IngestResult returned for that batch, so duplicate
submissions can be answered without persisting duplicate detections. Authored
against the Alembic ``op`` API only — no raw SQL DDL (Requirement 28.3).

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-30
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingest_batches",
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("idempotency_key"),
    )


def downgrade() -> None:
    op.drop_table("ingest_batches")
