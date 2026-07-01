"""SQLAlchemy ORM models for the Vision AI Results service (Task 9.2).

Defines the relational schema for detections, object tracks, and classified
scene events as described in the design data model (Requirement 11.1). All
schema changes are delivered through Alembic versioned migrations; this module
is the single source of truth that ``alembic/env.py`` registers as
``target_metadata`` (Requirement 28.1, 28.3 — no raw SQL DDL).

Only the persistence schema is defined here. Ingest validation, track
stitching, scene classification, and query logic are implemented by later
tasks (9.3+); the schema is shaped to support them:

- ``Detection`` stores one YOLOv11x OBB detection (class, confidence, the
  five-element OBB ``[cx, cy, w, h, angle]``, frame timestamp, drone id) with
  an optional ``track_id`` assigned by stitching.
- ``Track`` records the single object class shared by all its detections plus
  the last-seen timestamp, supporting the "one track_id maps to a single
  class" invariant.
- ``SceneEvent`` records a higher-level classified event referencing a zone
  and the participating track ids.

Schema-level guards that are intrinsic to the data model are expressed as
``CheckConstraint``s (confidence within [0, 1]; non-negative frame/seen/event
timestamps); richer request-level validation (e.g. OBB element count and
positive width/height) is layered on at ingest time in a later task.
"""

from __future__ import annotations

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Track(Base):
    """An object track: a time-ordered set of detections of one class.

    ``cls`` captures the single object class shared by every member detection,
    underpinning the class-consistency invariant enforced during stitching.
    """

    __tablename__ = "tracks"

    track_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    cls: Mapped[str] = mapped_column(String(64), nullable=False)
    last_seen_ts: Mapped[float] = mapped_column(Float, nullable=False)

    detections: Mapped[list[Detection]] = relationship(
        back_populates="track",
        order_by="Detection.frame_ts",
    )

    __table_args__ = (
        CheckConstraint("last_seen_ts >= 0", name="ck_tracks_last_seen_ts_non_negative"),
    )


class Detection(Base):
    """A single YOLOv11x oriented-bounding-box detection.

    ``obb`` holds the five-element OBB ``[cx, cy, w, h, angle]`` as a JSON
    array; ``track_id`` is nullable until assigned by track stitching.
    """

    __tablename__ = "detections"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    drone_id: Mapped[str] = mapped_column(String(64), nullable=False)
    frame_ts: Mapped[float] = mapped_column(Float, nullable=False)
    cls: Mapped[str] = mapped_column(String(64), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    # Five-element OBB [cx, cy, w, h, angle]; element-count / positivity
    # validation is applied at ingest (task 9.3).
    obb: Mapped[list[float]] = mapped_column(JSON, nullable=False)
    track_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("tracks.track_id", ondelete="SET NULL"),
        nullable=True,
    )

    track: Mapped[Track | None] = relationship(back_populates="detections")

    __table_args__ = (
        CheckConstraint(
            "confidence >= 0 AND confidence <= 1",
            name="ck_detections_confidence_unit_interval",
        ),
        CheckConstraint("frame_ts >= 0", name="ck_detections_frame_ts_non_negative"),
        Index("ix_detections_drone_id", "drone_id"),
        Index("ix_detections_frame_ts", "frame_ts"),
        Index("ix_detections_cls", "cls"),
        Index("ix_detections_track_id", "track_id"),
    )


class IngestBatch(Base):
    """Idempotency ledger for detection-ingest batches (Requirement 11.8).

    Each successfully ingested batch records its caller-supplied idempotency
    key together with the :class:`~app.schemas.IngestResult` it produced
    (serialised as JSON). A repeat ingest carrying a previously-seen key is
    answered from this row, so the same batch can be retried safely without
    persisting duplicate detections.
    """

    __tablename__ = "ingest_batches"

    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    # Serialised IngestResult payload returned verbatim on duplicate replay.
    result: Mapped[dict] = mapped_column(JSON, nullable=False)


class SceneEvent(Base):
    """A classified scene event referencing a zone and participating tracks.

    ``kind`` is one of ``person_entered_zone``, ``vehicle_stopped``, or
    ``group_gathering``; ``track_ids`` is a JSON array of the participating
    track ids.
    """

    __tablename__ = "scene_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    zone_id: Mapped[str] = mapped_column(String(64), nullable=False)
    track_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    ts: Mapped[float] = mapped_column(Float, nullable=False)

    __table_args__ = (
        CheckConstraint("ts >= 0", name="ck_scene_events_ts_non_negative"),
        Index("ix_scene_events_zone_id", "zone_id"),
        Index("ix_scene_events_kind", "kind"),
        Index("ix_scene_events_ts", "ts"),
    )
