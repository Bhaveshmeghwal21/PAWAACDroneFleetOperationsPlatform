"""Integration tests for the ingest + query endpoints (Task 9.9).

End-to-end coverage that exercises the full ``POST /detections`` ->
``GET /detections`` round-trip against the SQLite-backed application
(``ingest_client`` / ``db_session`` fixtures — the integration substrate used
throughout this service, standing in for Postgres). The single-filter and
combined-filter query cases plus the request-validation rejections are covered
in ``tests/test_query.py``; the ingest-validation and bare idempotency-ledger
behaviour in ``tests/test_ingest.py``. This module fills the remaining gap:
how idempotent duplicate-batch ingestion (Requirement 11.8) and multi-batch
ingestion interact with what the query endpoint subsequently returns
(Requirement 13.1, 13.2).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models import Detection


def _detection(**overrides) -> dict:
    """A valid detection payload with optional field overrides."""

    payload = {
        "drone_id": "drone-1",
        "frame_ts": 1000.0,
        "cls": "person",
        "confidence": 0.9,
        "obb": [5.0, 5.0, 4.0, 6.0, 0.0],
    }
    payload.update(overrides)
    return payload


def _ingest(client: TestClient, key: str, detections: list[dict]) -> dict:
    resp = client.post("/detections", json={"idempotency_key": key, "detections": detections})
    assert resp.status_code in (200, 201)
    return resp.json()


def test_ingested_batch_is_returned_by_query(ingest_client: TestClient) -> None:
    """A freshly ingested batch is fully retrievable via GET /detections."""

    _ingest(
        ingest_client,
        "round-trip",
        [
            _detection(id="a", frame_ts=10.0, cls="person", confidence=0.7),
            _detection(id="b", frame_ts=20.0, cls="vehicle", confidence=0.95),
        ],
    )
    resp = ingest_client.get("/detections")
    assert resp.status_code == 200
    assert {d["id"] for d in resp.json()} == {"a", "b"}


def test_duplicate_batch_does_not_duplicate_query_results(
    ingest_client: TestClient, db_session
) -> None:
    """Replaying a batch (Req 11.8) leaves the query result set unchanged.

    The second POST carries the same idempotency key (even with *different*
    detections); it must replay the prior result and persist nothing new, so a
    subsequent query returns exactly the originally-ingested detections with no
    duplicates.
    """

    first = _ingest(
        ingest_client,
        "dup-key",
        [_detection(id="x", cls="person"), _detection(id="y", cls="vehicle")],
    )

    before = ingest_client.get("/detections").json()
    assert {d["id"] for d in before} == {"x", "y"}

    # Re-submit the same key with a different payload: idempotent replay.
    replay = ingest_client.post(
        "/detections",
        json={"idempotency_key": "dup-key", "detections": [_detection(id="z", cls="animal")]},
    )
    assert replay.status_code == 200
    assert replay.json() == first

    after = ingest_client.get("/detections").json()
    assert {d["id"] for d in after} == {"x", "y"}
    # No phantom rows persisted by the replay.
    assert db_session.query(Detection).count() == 2


def test_distinct_batches_accumulate_in_query(ingest_client: TestClient) -> None:
    """Detections from distinct idempotency keys are all queryable (union)."""

    _ingest(ingest_client, "k1", [_detection(id="p", cls="person", frame_ts=1.0)])
    _ingest(ingest_client, "k2", [_detection(id="v", cls="vehicle", frame_ts=2.0)])

    resp = ingest_client.get("/detections")
    assert resp.status_code == 200
    assert {d["id"] for d in resp.json()} == {"p", "v"}


def test_query_filters_apply_across_multiple_ingested_batches(ingest_client: TestClient) -> None:
    """A filtered query selects across detections ingested in separate batches.

    Combines the multi-batch ingest path with a combined (class + confidence +
    time) query, confirming the filter holds over the merged population
    (Req 13.1).
    """

    _ingest(
        ingest_client,
        "batch-A",
        [
            _detection(id="hit", frame_ts=150.0, cls="person", confidence=0.9),
            _detection(id="low", frame_ts=150.0, cls="person", confidence=0.2),
        ],
    )
    _ingest(
        ingest_client,
        "batch-B",
        [
            _detection(id="late", frame_ts=999.0, cls="person", confidence=0.9),
            _detection(id="other", frame_ts=150.0, cls="vehicle", confidence=0.9),
        ],
    )

    resp = ingest_client.get(
        "/detections",
        params={"from": 100.0, "to": 200.0, "cls": "person", "min_confidence": 0.5},
    )
    assert resp.status_code == 200
    assert [d["id"] for d in resp.json()] == ["hit"]
