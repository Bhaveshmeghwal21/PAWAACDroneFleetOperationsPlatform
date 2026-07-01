"""Tests for the bootstrap health/error/trace infrastructure (Req 34.1–34.3)."""

from __future__ import annotations

from fastapi.testclient import TestClient

import app.routers.health as health_module


def test_health_endpoint_returns_ok(client: TestClient) -> None:
    """GET /health is a pure liveness probe and always returns 200."""

    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_ready_endpoint_ok_when_database_reachable(
    client: TestClient, monkeypatch
) -> None:
    """GET /ready returns 200 when datastore connectivity succeeds (Req 34.1)."""

    monkeypatch.setattr(health_module, "check_connectivity", lambda: True)
    resp = client.get("/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["checks"] == "database:ok"


def test_ready_endpoint_503_problem_json_when_database_unreachable(
    client: TestClient, monkeypatch
) -> None:
    """GET /ready returns a 503 problem+json body when the datastore is down."""

    monkeypatch.setattr(health_module, "check_connectivity", lambda: False)
    resp = client.get("/ready")
    assert resp.status_code == 503
    assert resp.headers["content-type"].startswith("application/problem+json")
    body = resp.json()
    assert body["status"] == 503
    assert body["title"] == "Service Unavailable"


def test_unknown_route_returns_rfc7807_problem_json(client: TestClient) -> None:
    """Errors are emitted as RFC 7807 problem+json bodies (Req 34.2)."""

    resp = client.get("/does-not-exist")
    assert resp.status_code == 404
    assert resp.headers["content-type"].startswith("application/problem+json")
    body = resp.json()
    assert body["status"] == 404
    assert body["instance"] == "/does-not-exist"
    assert "title" in body and "type" in body


def test_trace_id_generated_when_absent(client: TestClient) -> None:
    """A trace id is generated and echoed back when the caller omits it (Req 34.3)."""

    resp = client.get("/health")
    assert resp.headers.get("X-Trace-Id")


def test_trace_id_propagated_when_supplied(client: TestClient) -> None:
    """A caller-supplied trace id is propagated unchanged onto the response."""

    supplied = "trace-abc-123"
    resp = client.get("/health", headers={"X-Trace-Id": supplied})
    assert resp.headers.get("X-Trace-Id") == supplied


def test_problem_response_includes_trace_id(client: TestClient) -> None:
    """The trace id is surfaced inside the problem+json body for correlation."""

    supplied = "trace-err-9"
    resp = client.get("/nope", headers={"X-Trace-Id": supplied})
    assert resp.json()["traceId"] == supplied
