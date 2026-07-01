"""Vision AI Results service (Service 4).

FastAPI application package. This module exposes the application factory so that
both the ASGI server (``uvicorn app.main:app``) and the test-suite can construct
a fully wired application instance.
"""

from app.main import app, create_app

__all__ = ["app", "create_app"]
