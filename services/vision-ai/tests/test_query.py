"""Tests for the detection query API (Task 9.8).

Example-based coverage of Requirement 13.1 (return only detections matching all
specified criteria — time range, zone, class, confidence >= threshold) and
Requirement 13.2 (exposed as a REST endpoint). The exhaustive Hypothesis
property test for **P29 — query filter soundness** plus the Postgres
integration tests are task 9.9; here we pin each filter and their conjunction
by example, exercising both the ``GET /detections`` endpoint and the pure
:func:`detection_matches` predicate / :func:`query_detections` service.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.models import Detection
from app.services.query import (
    DetectionQuery,
    centroid_in_zone,
    detection_matches,
    query_detections,
)
from app.services.scene import zone_from_coords

# A 10x10 axis-aligned square zone anchored at the origin.
_SQUARE = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]


def _zone():
    return zone_from_coords("zone-A", [tuple(p) for p in _SQUARE])


def _seed(session, rows: list[dict]) -> None:
    """Insert detection rows (each dict overriding a sensible default)."""

    for i, overrides in enumerate(rows):
        payload = {
            "id": f"det-{i}",
            "drone_id": "drone-1",
            "frame_ts": 1000.0,
            "cls": "person",
            "confidence": 0.9,
            # Centroid inside the square zone by default.
            "obb": [5.0, 5.0, 4.0, 6.0, 0.0],
            "track_id": None,
        }
        payload.update(overrides)
        session.add(Detection(**payload))
    session.commit()


# --- detection_matches pure predicate ---------------------------------------


def _det(**overrides) -> Detection:
    payload = {
        "id": "d",
        "drone_id": "drone-1",
        "frame_ts": 1000.0,
        "cls": "person",
        "confidence": 0.9,
        "obb": [5.0, 5.0, 4.0, 6.0, 0.0],
        "track_id": None,
    }
    payload.update(overrides)
    return Detection(**payload)


def test_empty_query_matches_everything() -> None:
    """An empty query constrains nothing (Req 13.1 — omitted filters)."""

    assert detection_matches(_det(), DetectionQuery()) is True


def test_time_range_constrains_both_bounds() -> None:
    """frame_ts must lie within the closed [from, to] interval."""

    q = DetectionQuery(time_from=100.0, time_to=200.0)
    assert detection_matches(_det(frame_ts=150.0), q) is True
    assert detection_matches(_det(frame_ts=100.0), q) is True  # inclusive lower
    assert detection_matches(_det(frame_ts=200.0), q) is True  # inclusive upper
    assert detection_matches(_det(frame_ts=99.0), q) is False
    assert detection_matches(_det(frame_ts=201.0), q) is False


def test_class_filter_is_exact() -> None:
    q = DetectionQuery(cls="vehicle")
    assert detection_matches(_det(cls="vehicle"), q) is True
    assert detection_matches(_det(cls="person"), q) is False


def test_confidence_is_threshold_inclusive() -> None:
    q = DetectionQuery(min_confidence=0.5)
    assert detection_matches(_det(confidence=0.5), q) is True
    assert detection_matches(_det(confidence=0.9), q) is True
    assert detection_matches(_det(confidence=0.49), q) is False


def test_zone_filter_uses_centroid_membership() -> None:
    q = DetectionQuery(zone=_zone())
    assert detection_matches(_det(obb=[5.0, 5.0, 1.0, 1.0, 0.0]), q) is True
    assert detection_matches(_det(obb=[50.0, 50.0, 1.0, 1.0, 0.0]), q) is False
    # Boundary counts as inside.
    assert detection_matches(_det(obb=[0.0, 5.0, 1.0, 1.0, 0.0]), q) is True


def test_centroid_in_zone_helper() -> None:
    zone = _zone()
    assert centroid_in_zone([5.0, 5.0, 1.0, 1.0, 0.0], zone) is True
    assert centroid_in_zone([-1.0, 5.0, 1.0, 1.0, 0.0], zone) is False


def test_combined_filters_are_anded() -> None:
    """A detection must satisfy ALL active criteria simultaneously (P29)."""

    q = DetectionQuery(
        time_from=100.0,
        time_to=200.0,
        cls="person",
        min_confidence=0.5,
        zone=_zone(),
    )
    match = _det(frame_ts=150.0, cls="person", confidence=0.8, obb=[5.0, 5.0, 1.0, 1.0, 0.0])
    assert detection_matches(match, q) is True

    # Each single violation flips the result to False.
    assert detection_matches(_det(frame_ts=50.0, cls="person", confidence=0.8), q) is False
    assert detection_matches(_det(frame_ts=150.0, cls="vehicle", confidence=0.8), q) is False
    assert detection_matches(_det(frame_ts=150.0, cls="person", confidence=0.1), q) is False
    outside = _det(frame_ts=150.0, cls="person", confidence=0.8, obb=[99.0, 99.0, 1.0, 1.0, 0.0])
    assert detection_matches(outside, q) is False


# --- query_detections service against the database --------------------------


def test_query_service_no_filters_returns_all(db_session) -> None:
    _seed(db_session, [{}, {}, {}])
    assert len(query_detections(db_session, DetectionQuery())) == 3


def test_query_service_time_range(db_session) -> None:
    _seed(
        db_session,
        [
            {"id": "a", "frame_ts": 50.0},
            {"id": "b", "frame_ts": 150.0},
            {"id": "c", "frame_ts": 250.0},
        ],
    )
    rows = query_detections(db_session, DetectionQuery(time_from=100.0, time_to=200.0))
    assert [r.id for r in rows] == ["b"]


def test_query_service_zone_filter_in_process(db_session) -> None:
    _seed(
        db_session,
        [
            {"id": "in", "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            {"id": "out", "obb": [99.0, 99.0, 1.0, 1.0, 0.0]},
        ],
    )
    rows = query_detections(db_session, DetectionQuery(zone=_zone()))
    assert [r.id for r in rows] == ["in"]


def test_query_service_combined_filters(db_session) -> None:
    _seed(
        db_session,
        [
            # Matches everything.
            {"id": "hit", "frame_ts": 150.0, "cls": "person", "confidence": 0.9,
             "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            # Wrong class.
            {"id": "cls", "frame_ts": 150.0, "cls": "vehicle", "confidence": 0.9,
             "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            # Below confidence threshold.
            {"id": "conf", "frame_ts": 150.0, "cls": "person", "confidence": 0.2,
             "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            # Outside zone.
            {"id": "zone", "frame_ts": 150.0, "cls": "person", "confidence": 0.9,
             "obb": [99.0, 99.0, 1.0, 1.0, 0.0]},
            # Outside time range.
            {"id": "time", "frame_ts": 999.0, "cls": "person", "confidence": 0.9,
             "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
        ],
    )
    q = DetectionQuery(
        time_from=100.0, time_to=200.0, cls="person", min_confidence=0.5, zone=_zone()
    )
    rows = query_detections(db_session, q)
    assert [r.id for r in rows] == ["hit"]


# --- GET /detections endpoint ----------------------------------------------


def _ingest(client: TestClient, key: str, detections: list[dict]) -> None:
    resp = client.post("/detections", json={"idempotency_key": key, "detections": detections})
    assert resp.status_code == 201


def test_endpoint_no_filters_returns_all(ingest_client: TestClient) -> None:
    _ingest(
        ingest_client,
        "k",
        [
            {"drone_id": "d", "frame_ts": 100.0, "cls": "person", "confidence": 0.9,
             "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            {"drone_id": "d", "frame_ts": 200.0, "cls": "vehicle", "confidence": 0.4,
             "obb": [50.0, 50.0, 1.0, 1.0, 0.0]},
        ],
    )
    resp = ingest_client.get("/detections")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_endpoint_combined_filters(ingest_client: TestClient) -> None:
    """Each criterion constrains, and together they AND (Req 13.1, P29)."""

    _ingest(
        ingest_client,
        "k",
        [
            {"id": "hit", "drone_id": "d", "frame_ts": 150.0, "cls": "person",
             "confidence": 0.9, "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            {"id": "wrong-class", "drone_id": "d", "frame_ts": 150.0, "cls": "vehicle",
             "confidence": 0.9, "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            {"id": "low-conf", "drone_id": "d", "frame_ts": 150.0, "cls": "person",
             "confidence": 0.2, "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            {"id": "outside-zone", "drone_id": "d", "frame_ts": 150.0, "cls": "person",
             "confidence": 0.9, "obb": [99.0, 99.0, 1.0, 1.0, 0.0]},
            {"id": "out-of-time", "drone_id": "d", "frame_ts": 5.0, "cls": "person",
             "confidence": 0.9, "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
        ],
    )
    resp = ingest_client.get(
        "/detections",
        params={
            "from": 100.0,
            "to": 200.0,
            "cls": "person",
            "min_confidence": 0.5,
            "zone": json.dumps(_SQUARE),
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [d["id"] for d in body] == ["hit"]


def test_endpoint_single_class_filter(ingest_client: TestClient) -> None:
    _ingest(
        ingest_client,
        "k",
        [
            {"id": "p", "drone_id": "d", "frame_ts": 1.0, "cls": "person",
             "confidence": 0.9, "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
            {"id": "v", "drone_id": "d", "frame_ts": 1.0, "cls": "vehicle",
             "confidence": 0.9, "obb": [5.0, 5.0, 1.0, 1.0, 0.0]},
        ],
    )
    resp = ingest_client.get("/detections", params={"cls": "vehicle"})
    assert resp.status_code == 200
    assert [d["id"] for d in resp.json()] == ["v"]


def test_endpoint_rejects_malformed_zone(ingest_client: TestClient) -> None:
    """A non-JSON / degenerate zone parameter is a 422 problem+json (Req 34.2)."""

    resp = ingest_client.get("/detections", params={"zone": "not-json"})
    assert resp.status_code == 422
    assert resp.headers["content-type"].startswith("application/problem+json")

    degenerate = ingest_client.get("/detections", params={"zone": json.dumps([[0, 0], [1, 1]])})
    assert degenerate.status_code == 422


def test_endpoint_rejects_out_of_range_confidence(ingest_client: TestClient) -> None:
    """min_confidence outside [0, 1] is rejected by request validation."""

    resp = ingest_client.get("/detections", params={"min_confidence": 1.5})
    assert resp.status_code == 422
