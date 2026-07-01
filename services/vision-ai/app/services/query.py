"""Detection query service (Task 9.8).

Implements :func:`query_detections`, the read side of the Vision AI Results
service that backs the ``GET /detections`` REST endpoint (Requirement 13.1,
13.2). A query is a conjunction of *optional* filters; a detection is returned
**iff** it satisfies every supplied criterion (design property **P29 — query
filter soundness**):

- **time range** — ``frame_ts`` lies within the closed interval
  ``[time_from, time_to]`` (each bound optional and independent);
- **object class** — ``cls`` equals the requested class;
- **confidence threshold** — ``confidence >= min_confidence``;
- **zone** — the detection's OBB centroid ``(cx, cy)`` falls within the
  supplied zone polygon.

An omitted filter does not constrain the result set.

The scalar filters (time range, class, confidence) are expressed as SQL
predicates and pushed down to the database so the engine does the selection.
``Detection`` carries no zone column, so zone membership is resolved
geometrically in-process: a detection belongs to a zone when its OBB centroid
is covered by the zone polygon. This reuses the shapely
:class:`~app.services.scene.Zone` value object shared with scene
classification, keeping a single definition of "inside a zone".

The matching rule is also exposed as a pure, side-effect-free predicate
(:func:`detection_matches`) so the P29 soundness property can be exercised
directly against in-memory detections, independent of the database.
"""

from __future__ import annotations

from dataclasses import dataclass

from shapely.geometry import Point
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.models import Detection
from app.services.scene import Zone

# Index positions within the five-element OBB array [cx, cy, w, h, angle].
_OBB_CX_INDEX = 0
_OBB_CY_INDEX = 1


@dataclass(frozen=True)
class DetectionQuery:
    """The optional filter criteria for a detection query (Requirement 13.1).

    Every field defaults to ``None`` meaning "do not constrain on this
    dimension". ``zone`` reuses the shapely-backed
    :class:`~app.services.scene.Zone` so membership shares one definition with
    scene classification.
    """

    time_from: float | None = None
    time_to: float | None = None
    cls: str | None = None
    min_confidence: float | None = None
    zone: Zone | None = None


def centroid_in_zone(obb: list[float], zone: Zone) -> bool:
    """Whether a detection's OBB centroid ``(cx, cy)`` lies within ``zone``.

    Uses ``polygon.covers`` so points on the zone boundary count as inside,
    matching the convention used by scene classification.
    """

    cx = obb[_OBB_CX_INDEX]
    cy = obb[_OBB_CY_INDEX]
    return bool(zone.polygon.covers(Point(cx, cy)))


def detection_matches(detection: Detection, q: DetectionQuery) -> bool:
    """Return ``True`` iff ``detection`` satisfies every supplied criterion.

    Pure and side-effect-free. An unset criterion is skipped, so the predicate
    is the logical AND of only the active filters (property **P29**). This is
    the single source of truth for query membership and mirrors exactly the
    selection performed by :func:`query_detections`.
    """

    if q.time_from is not None and detection.frame_ts < q.time_from:
        return False
    if q.time_to is not None and detection.frame_ts > q.time_to:
        return False
    if q.cls is not None and detection.cls != q.cls:
        return False
    if q.min_confidence is not None and detection.confidence < q.min_confidence:
        return False
    if q.zone is not None and not centroid_in_zone(detection.obb, q.zone):
        return False
    return True


def _apply_scalar_filters(
    stmt: Select[tuple[Detection]], q: DetectionQuery
) -> Select[tuple[Detection]]:
    """Push the scalar (non-geometric) criteria down into the SQL statement.

    Only the criteria that are actually supplied add a ``WHERE`` clause, so an
    omitted filter leaves the result unconstrained on that dimension.
    """

    if q.time_from is not None:
        stmt = stmt.where(Detection.frame_ts >= q.time_from)
    if q.time_to is not None:
        stmt = stmt.where(Detection.frame_ts <= q.time_to)
    if q.cls is not None:
        stmt = stmt.where(Detection.cls == q.cls)
    if q.min_confidence is not None:
        stmt = stmt.where(Detection.confidence >= q.min_confidence)
    return stmt


def query_detections(session: Session, q: DetectionQuery) -> list[Detection]:
    """Return all detections matching every supplied criterion (Requirement 13.1).

    The scalar filters (time range, class, confidence threshold) are evaluated
    at the database; the geometric zone filter — which has no SQL column — is
    applied in-process against the OBB centroid. Results are ordered by
    ``frame_ts`` then ``id`` for stable, deterministic output.
    """

    stmt = _apply_scalar_filters(select(Detection), q)
    stmt = stmt.order_by(Detection.frame_ts, Detection.id)
    rows = list(session.execute(stmt).scalars().all())

    if q.zone is not None:
        rows = [d for d in rows if centroid_in_zone(d.obb, q.zone)]

    return rows


__all__ = [
    "DetectionQuery",
    "centroid_in_zone",
    "detection_matches",
    "query_detections",
]
