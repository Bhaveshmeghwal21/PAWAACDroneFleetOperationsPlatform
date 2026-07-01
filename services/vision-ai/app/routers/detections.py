"""Detection ingest and query endpoints (Tasks 9.3, 9.8).

Exposes:

- ``POST /detections`` which accepts a :class:`DetectionBatch`, validates it
  (Requirement 11.2 — surfaced as RFC 7807 ``422`` by the global validation
  handler), persists each detection (Requirement 11.1), and replays the prior
  result for a duplicate idempotency key (Requirement 11.8). A freshly
  persisted batch responds ``201 Created``; an idempotent replay of a
  previously-seen key responds ``200 OK`` with the original result.
- ``GET /detections`` which returns only the detections matching every supplied
  filter — time range, zone, object class, and ``confidence >= threshold``
  (Requirement 13.1, 13.2 — design property **P29**). Every filter is optional;
  an omitted filter does not constrain the result set.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Detection
from app.schemas import DetectionBatch, DetectionOut, IngestResult
from app.services.ingest import ingest_detections
from app.services.query import DetectionQuery, query_detections
from app.services.scene import Zone, zone_from_coords

router = APIRouter(tags=["detections"])

# A polygon ring needs at least three distinct vertices to bound an area.
_MIN_ZONE_VERTICES = 3


@router.post("/detections", response_model=IngestResult)
def post_detections(
    batch: DetectionBatch,
    response: Response,
    session: Session = Depends(get_session),  # noqa: B008 — FastAPI dependency injection
) -> IngestResult:
    """Ingest a batch of detections, idempotent on ``idempotency_key``."""

    result, created = ingest_detections(session, batch)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return result


def _parse_zone(raw: str | None) -> Zone | None:
    """Parse the ``zone`` query parameter into a shapely-backed :class:`Zone`.

    The zone is supplied as a JSON array of ``[x, y]`` vertex pairs forming the
    polygon ring, e.g. ``[[0,0],[10,0],[10,10],[0,10]]``. A malformed or
    degenerate ring is rejected as a ``422`` problem+json response, consistent
    with the service's request-validation contract (Requirement 34.2).
    """

    if raw is None:
        return None
    try:
        decoded = json.loads(raw)
        ring = [(float(x), float(y)) for x, y in decoded]
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail="zone must be a JSON array of [x, y] coordinate pairs.",
        ) from exc
    if len(ring) < _MIN_ZONE_VERTICES:
        raise HTTPException(
            status_code=422,
            detail="zone polygon requires at least three vertices.",
        )
    return zone_from_coords("query-zone", ring)


@router.get("/detections", response_model=list[DetectionOut])
def get_detections(
    from_ts: float | None = Query(
        None, alias="from", description="Inclusive lower bound on frame_ts."
    ),
    to_ts: float | None = Query(
        None, alias="to", description="Inclusive upper bound on frame_ts."
    ),
    cls: str | None = Query(None, description="Exact object class to match."),
    min_confidence: float | None = Query(
        None,
        ge=0,
        le=1,
        description="Minimum confidence; matches detections with confidence >= this value.",
    ),
    zone: str | None = Query(
        None,
        description="JSON polygon ring [[x, y], ...]; matches detections whose centroid is inside.",
    ),
    session: Session = Depends(get_session),  # noqa: B008 — FastAPI dependency injection
) -> list[Detection]:
    """Return detections matching every supplied filter (Requirement 13.1, 13.2).

    Filters are optional and combined with logical AND; omitting a filter leaves
    that dimension unconstrained.
    """

    q = DetectionQuery(
        time_from=from_ts,
        time_to=to_ts,
        cls=cls,
        min_confidence=min_confidence,
        zone=_parse_zone(zone),
    )
    return query_detections(session, q)
