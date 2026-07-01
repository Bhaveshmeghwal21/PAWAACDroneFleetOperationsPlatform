"""Pydantic request/response schemas for detection ingest (Task 9.3).

These models define the wire contract for the ``POST /detections`` endpoint and
encode the ingest validation rules from Requirement 11.2 directly as field and
model validators, so a malformed batch is rejected at request-parse time and
surfaced as an RFC 7807 ``422`` problem+json response by the application's
``RequestValidationError`` handler (Requirement 34.2).

Validation rules (Requirement 11.2):
- ``confidence`` must lie within the closed unit interval ``[0, 1]``.
- ``obb`` must contain exactly five elements ``[cx, cy, w, h, angle]`` with a
  strictly positive width (index 2) and height (index 3).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Index positions within the five-element OBB array [cx, cy, w, h, angle].
_OBB_LENGTH = 5
_OBB_WIDTH_INDEX = 2
_OBB_HEIGHT_INDEX = 3


class DetectionIn(BaseModel):
    """A single inbound YOLOv11x oriented-bounding-box detection.

    ``id`` is optional; when omitted the service assigns a UUID. ``track_id``
    is always left unset at ingest and is populated later by track stitching.
    """

    id: str | None = None
    drone_id: str = Field(min_length=1)
    frame_ts: float = Field(ge=0)
    cls: str = Field(min_length=1)
    confidence: float = Field(ge=0, le=1)
    obb: list[float]

    @field_validator("obb")
    @classmethod
    def _validate_obb(cls, value: list[float]) -> list[float]:
        """Enforce the five-element OBB shape with positive width/height."""

        if len(value) != _OBB_LENGTH:
            raise ValueError(
                "obb must contain exactly five elements [cx, cy, w, h, angle]"
            )
        width = value[_OBB_WIDTH_INDEX]
        height = value[_OBB_HEIGHT_INDEX]
        if width <= 0 or height <= 0:
            raise ValueError("obb width and height must be positive")
        return value


class DetectionBatch(BaseModel):
    """A batch of detections submitted together under one idempotency key."""

    idempotency_key: str = Field(min_length=1)
    detections: list[DetectionIn]


class IngestResult(BaseModel):
    """The outcome of ingesting a detection batch.

    Returned both for a freshly persisted batch and, verbatim, for a duplicate
    replay of a previously-seen idempotency key (Requirement 11.8).
    """

    idempotency_key: str
    ingested: int
    detection_ids: list[str]


class DetectionOut(BaseModel):
    """A single detection as returned by the query API (Task 9.8).

    Mirrors the persisted :class:`~app.models.Detection` columns and is built
    directly from ORM instances (``from_attributes``) so the query endpoint can
    return SQLAlchemy rows unchanged (Requirement 13.1, 13.2).
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    drone_id: str
    frame_ts: float
    cls: str
    confidence: float
    obb: list[float]
    track_id: str | None = None
