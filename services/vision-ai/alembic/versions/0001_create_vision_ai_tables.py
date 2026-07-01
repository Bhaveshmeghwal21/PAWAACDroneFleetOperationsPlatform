"""create vision ai detection, track, and scene_event tables

Initial schema for the Vision AI Results service (Task 9.2): object tracks,
YOLOv11x OBB detections, and classified scene events. Authored against the
Alembic ``op`` API only — no raw SQL DDL (Requirement 28.3).

Revision ID: 0001
Revises:
Create Date: 2026-06-30
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tracks",
        sa.Column("track_id", sa.String(length=64), nullable=False),
        sa.Column("cls", sa.String(length=64), nullable=False),
        sa.Column("last_seen_ts", sa.Float(), nullable=False),
        sa.CheckConstraint("last_seen_ts >= 0", name="ck_tracks_last_seen_ts_non_negative"),
        sa.PrimaryKeyConstraint("track_id"),
    )

    op.create_table(
        "detections",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("drone_id", sa.String(length=64), nullable=False),
        sa.Column("frame_ts", sa.Float(), nullable=False),
        sa.Column("cls", sa.String(length=64), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("obb", sa.JSON(), nullable=False),
        sa.Column("track_id", sa.String(length=64), nullable=True),
        sa.CheckConstraint(
            "confidence >= 0 AND confidence <= 1",
            name="ck_detections_confidence_unit_interval",
        ),
        sa.CheckConstraint("frame_ts >= 0", name="ck_detections_frame_ts_non_negative"),
        sa.ForeignKeyConstraint(
            ["track_id"],
            ["tracks.track_id"],
            name="fk_detections_track_id_tracks",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_detections_drone_id", "detections", ["drone_id"])
    op.create_index("ix_detections_frame_ts", "detections", ["frame_ts"])
    op.create_index("ix_detections_cls", "detections", ["cls"])
    op.create_index("ix_detections_track_id", "detections", ["track_id"])

    op.create_table(
        "scene_events",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("zone_id", sa.String(length=64), nullable=False),
        sa.Column("track_ids", sa.JSON(), nullable=False),
        sa.Column("ts", sa.Float(), nullable=False),
        sa.CheckConstraint("ts >= 0", name="ck_scene_events_ts_non_negative"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_scene_events_zone_id", "scene_events", ["zone_id"])
    op.create_index("ix_scene_events_kind", "scene_events", ["kind"])
    op.create_index("ix_scene_events_ts", "scene_events", ["ts"])


def downgrade() -> None:
    op.drop_index("ix_scene_events_ts", table_name="scene_events")
    op.drop_index("ix_scene_events_kind", table_name="scene_events")
    op.drop_index("ix_scene_events_zone_id", table_name="scene_events")
    op.drop_table("scene_events")

    op.drop_index("ix_detections_track_id", table_name="detections")
    op.drop_index("ix_detections_cls", table_name="detections")
    op.drop_index("ix_detections_frame_ts", table_name="detections")
    op.drop_index("ix_detections_drone_id", table_name="detections")
    op.drop_table("detections")

    op.drop_table("tracks")
