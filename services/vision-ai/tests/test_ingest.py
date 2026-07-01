"""Tests for detection ingest: validation and idempotency (Task 9.3).

Covers Requirement 11.1 (persist each detection's fields), Requirement 11.2
(reject out-of-range confidence and malformed OBBs with a validation error),
and Requirement 11.8 (duplicate idempotency key replays the prior result
without creating duplicates).

Hypothesis property tests for these behaviours are deferred to task 9.5; these
are example-based unit/integration tests exercising the FastAPI endpoint and
the service function directly against a SQLite-backed session.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models import Detection, IngestBatch
from app.schemas import DetectionBatch
from app.services.ingest import ingest_detections


def _detection(**overrides) -> dict:
    """A valid detection payload with optional field overrides."""

    payload = {
        "drone_id": "drone-1",
        "frame_ts": 1000.0,
        "cls": "person",
        "confidence": 0.9,
        "obb": [10.0, 20.0, 4.0, 6.0, 0.5],
    }
    payload.update(overrides)
    return payload


def _batch(idempotency_key: str = "batch-1", detections: list[dict] | None = None) -> dict:
    return {
        "idempotency_key": idempotency_key,
        "detections": detections if detections is not None else [_detection()],
    }


# --- Requirement 11.1: persistence ------------------------------------------


def test_ingest_persists_detection_fields(ingest_client: TestClient) -> None:
    """A valid batch is persisted with all design-model fields (Req 11.1)."""

    resp = ingest_client.post("/detections", json=_batch())
    assert resp.status_code == 201
    body = resp.json()
    assert body["idempotency_key"] == "batch-1"
    assert body["ingested"] == 1
    assert len(body["detection_ids"]) == 1


def test_ingest_persists_multiple_detections(ingest_client: TestClient, db_session) -> None:
    """Every detection in the batch is persisted with its field values."""

    dets = [
        _detection(drone_id="drone-A", cls="person", confidence=0.5),
        _detection(drone_id="drone-B", cls="vehicle", confidence=0.75),
    ]
    resp = ingest_client.post("/detections", json=_batch(detections=dets))
    assert resp.status_code == 201
    assert resp.json()["ingested"] == 2

    rows = db_session.query(Detection).order_by(Detection.drone_id).all()
    assert [r.drone_id for r in rows] == ["drone-A", "drone-B"]
    assert [r.cls for r in rows] == ["person", "vehicle"]
    assert [r.confidence for r in rows] == [0.5, 0.75]
    # OBB coordinates and frame timestamp are round-tripped intact.
    assert rows[0].obb == [10.0, 20.0, 4.0, 6.0, 0.5]
    assert rows[0].frame_ts == 1000.0
    # track_id is unset at ingest (assigned later by stitching).
    assert all(r.track_id is None for r in rows)


def test_ingest_honours_client_supplied_id(ingest_client: TestClient, db_session) -> None:
    """A caller-provided detection id is used as the persisted primary key."""

    dets = [_detection(id="det-xyz")]
    resp = ingest_client.post("/detections", json=_batch(detections=dets))
    assert resp.status_code == 201
    assert resp.json()["detection_ids"] == ["det-xyz"]
    assert db_session.get(Detection, "det-xyz") is not None


def test_ingest_empty_batch_persists_nothing(ingest_client: TestClient) -> None:
    """An empty batch is accepted and reports zero ingested detections."""

    resp = ingest_client.post("/detections", json=_batch(detections=[]))
    assert resp.status_code == 201
    assert resp.json()["ingested"] == 0


# --- Requirement 11.2: validation -------------------------------------------


def test_reject_confidence_above_one(ingest_client: TestClient) -> None:
    """Confidence greater than 1 is rejected as a 422 problem+json (Req 11.2)."""

    resp = ingest_client.post("/detections", json=_batch(detections=[_detection(confidence=1.5)]))
    assert resp.status_code == 422
    assert resp.headers["content-type"].startswith("application/problem+json")


def test_reject_confidence_below_zero(ingest_client: TestClient) -> None:
    """Negative confidence is rejected with a validation error (Req 11.2)."""

    resp = ingest_client.post(
        "/detections", json=_batch(detections=[_detection(confidence=-0.1)])
    )
    assert resp.status_code == 422


def test_reject_obb_wrong_element_count(ingest_client: TestClient) -> None:
    """An OBB without exactly five elements is rejected (Req 11.2)."""

    resp = ingest_client.post(
        "/detections", json=_batch(detections=[_detection(obb=[1.0, 2.0, 3.0, 4.0])])
    )
    assert resp.status_code == 422


def test_reject_obb_non_positive_width(ingest_client: TestClient) -> None:
    """A non-positive OBB width is rejected (Req 11.2)."""

    resp = ingest_client.post(
        "/detections", json=_batch(detections=[_detection(obb=[10.0, 20.0, 0.0, 6.0, 0.5])])
    )
    assert resp.status_code == 422


def test_reject_obb_non_positive_height(ingest_client: TestClient) -> None:
    """A non-positive OBB height is rejected (Req 11.2)."""

    resp = ingest_client.post(
        "/detections", json=_batch(detections=[_detection(obb=[10.0, 20.0, 4.0, -2.0, 0.5])])
    )
    assert resp.status_code == 422


def test_invalid_detection_persists_nothing(ingest_client: TestClient, db_session) -> None:
    """A batch containing an invalid detection persists no rows."""

    dets = [_detection(), _detection(confidence=2.0)]
    resp = ingest_client.post("/detections", json=_batch(detections=dets))
    assert resp.status_code == 422
    assert db_session.query(Detection).count() == 0


# --- Requirement 11.8: idempotency ------------------------------------------


def test_duplicate_key_returns_prior_result(ingest_client: TestClient, db_session) -> None:
    """A duplicate key replays the prior result without duplicating rows."""

    first = ingest_client.post("/detections", json=_batch())
    assert first.status_code == 201
    first_body = first.json()

    # Re-submit the same key (even with different detections): the original
    # result is returned verbatim and no new detections are persisted.
    second = ingest_client.post(
        "/detections",
        json=_batch(detections=[_detection(cls="vehicle"), _detection(cls="person")]),
    )
    assert second.status_code == 200
    assert second.json() == first_body

    assert db_session.query(Detection).count() == 1
    assert db_session.query(IngestBatch).count() == 1


def test_distinct_keys_persist_independently(ingest_client: TestClient, db_session) -> None:
    """Different idempotency keys each persist their own detections."""

    ingest_client.post("/detections", json=_batch(idempotency_key="k1"))
    ingest_client.post("/detections", json=_batch(idempotency_key="k2"))
    assert db_session.query(Detection).count() == 2
    assert db_session.query(IngestBatch).count() == 2


# --- Service-level behaviour ------------------------------------------------


def test_service_returns_created_flag(db_session) -> None:
    """ingest_detections reports created=True then created=False on replay."""

    batch = DetectionBatch.model_validate(_batch(idempotency_key="svc-1"))

    result, created = ingest_detections(db_session, batch)
    assert created is True
    assert result.ingested == 1

    replay, created_again = ingest_detections(db_session, batch)
    assert created_again is False
    assert replay == result
