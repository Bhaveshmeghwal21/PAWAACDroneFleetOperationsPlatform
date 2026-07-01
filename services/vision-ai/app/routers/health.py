"""Liveness and readiness endpoints (Requirement 34.1).

- ``GET /health``  — liveness: the process is up and serving requests.
- ``GET /ready``   — readiness: the process can reach its datastore. Returns a
  503 problem+json body when datastore connectivity fails.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from app.db import check_connectivity
from app.errors import build_problem

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe — always returns 200 while the process is running."""

    return {"status": "ok", "service": "vision-ai"}


@router.get("/ready", response_model=None)
async def ready(request: Request) -> JSONResponse | dict[str, str]:
    """Readiness probe including datastore connectivity."""

    if check_connectivity():
        return {"status": "ready", "service": "vision-ai", "checks": "database:ok"}

    return build_problem(
        503,
        "Datastore connectivity check failed.",
        str(request.url.path),
        title="Service Unavailable",
    )
