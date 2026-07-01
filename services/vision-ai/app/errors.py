"""RFC 7807 problem+json error handling (Requirement 34.2).

Registers exception handlers that translate framework and application errors
into ``application/problem+json`` responses with a consistent shape:

    {
      "type": "about:blank",
      "title": "Not Found",
      "status": 404,
      "detail": "...",
      "instance": "/path",
      "traceId": "..."
    }
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

from app.tracing import get_trace_id

PROBLEM_JSON_MEDIA_TYPE = "application/problem+json"


def _reason_phrase(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return "Error"


def build_problem(
    status_code: int,
    detail: str,
    instance: str,
    *,
    title: str | None = None,
    type_: str = "about:blank",
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    """Construct an RFC 7807 problem+json ``JSONResponse``."""

    body: dict[str, Any] = {
        "type": type_,
        "title": title or _reason_phrase(status_code),
        "status": status_code,
        "detail": detail,
        "instance": instance,
    }
    trace_id = get_trace_id()
    if trace_id is not None:
        body["traceId"] = trace_id
    if extra:
        body.update(extra)

    return JSONResponse(
        status_code=status_code,
        content=body,
        media_type=PROBLEM_JSON_MEDIA_TYPE,
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else _reason_phrase(exc.status_code)
    return build_problem(exc.status_code, detail, str(request.url.path))


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return build_problem(
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "Request validation failed.",
        str(request.url.path),
        extra={"errors": jsonable_encoder(exc.errors())},
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return build_problem(
        HTTPStatus.INTERNAL_SERVER_ERROR,
        "An unexpected error occurred.",
        str(request.url.path),
    )


def register_error_handlers(app: FastAPI) -> None:
    """Wire the RFC 7807 handlers onto a FastAPI application."""

    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
