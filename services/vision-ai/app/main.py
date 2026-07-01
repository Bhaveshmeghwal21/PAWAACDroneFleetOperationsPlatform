"""Application factory for the Vision AI Results service (Service 4).

Wires together the cross-cutting infrastructure required at bootstrap:
trace-id propagation (Req 34.3), RFC 7807 error handling (Req 34.2), and the
health/readiness endpoints (Req 34.1). Domain features (detection ingest, track
stitching, scene classification) are added by later tasks (9.2+).
"""

from __future__ import annotations

from fastapi import FastAPI

from app.config import get_settings
from app.errors import register_error_handlers
from app.routers import detections, health
from app.tracing import TraceIdMiddleware


def create_app() -> FastAPI:
    """Construct and configure a FastAPI application instance."""

    settings = get_settings()

    app = FastAPI(
        title="PAWAAC Vision AI Results",
        version="0.1.0",
        description=(
            "Service 4 — ingests onboard detections, maintains object tracks, "
            "classifies scene events, and serves detection queries."
        ),
    )

    # Trace propagation first so the id is available to error handlers.
    app.add_middleware(TraceIdMiddleware, header_name=settings.trace_header)

    register_error_handlers(app)

    app.include_router(health.router)
    app.include_router(detections.router)

    return app


app = create_app()
