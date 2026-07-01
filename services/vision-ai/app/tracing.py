"""Trace-id propagation middleware (Requirement 34.3).

Every inbound request is associated with a trace id: either the one supplied by
the caller via the configured trace header (default ``X-Trace-Id``) or a freshly
generated UUID4 when absent. The id is stored on ``request.state`` and in a
context variable (so error handlers and downstream code can read it) and echoed
back on the response.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from app.config import get_settings

# Context variable readable from anywhere in the request lifecycle (e.g. the
# RFC 7807 error handlers) without threading the request object through.
_trace_id_ctx: ContextVar[str | None] = ContextVar("trace_id", default=None)


def get_trace_id() -> str | None:
    """Return the trace id bound to the current request context, if any."""

    return _trace_id_ctx.get()


class TraceIdMiddleware(BaseHTTPMiddleware):
    """Propagate a trace id across the request/response boundary."""

    def __init__(self, app: ASGIApp, header_name: str | None = None) -> None:
        super().__init__(app)
        self._header_name = header_name or get_settings().trace_header

    async def dispatch(self, request: Request, call_next) -> Response:
        incoming = request.headers.get(self._header_name)
        trace_id = incoming.strip() if incoming and incoming.strip() else str(uuid.uuid4())

        request.state.trace_id = trace_id
        token = _trace_id_ctx.set(trace_id)
        try:
            response = await call_next(request)
        finally:
            _trace_id_ctx.reset(token)

        response.headers[self._header_name] = trace_id
        return response
