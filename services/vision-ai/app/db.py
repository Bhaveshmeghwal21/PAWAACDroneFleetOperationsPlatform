"""Database engine and session management.

Provides a lazily-constructed SQLAlchemy engine/sessionmaker plus a
``check_connectivity`` helper used by the ``/ready`` readiness probe
(Requirement 34.1).
"""

from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app.config import get_settings

# Declarative base for ORM models authored in later tasks (9.2+).
Base = declarative_base()


@lru_cache
def get_engine() -> Engine:
    """Return a cached SQLAlchemy engine built from the configured URL.

    ``pool_pre_ping`` ensures stale connections are transparently recycled so
    that the readiness probe reflects genuine current connectivity.
    """

    settings = get_settings()
    return create_engine(settings.database_url, pool_pre_ping=True, future=True)


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    """Return a cached session factory bound to the engine."""

    return sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a scoped database session."""

    factory = get_sessionmaker()
    session = factory()
    try:
        yield session
    finally:
        session.close()


def check_connectivity() -> bool:
    """Return ``True`` if a trivial ``SELECT 1`` succeeds against the datastore.

    Any connectivity/driver error is swallowed and reported as ``False`` so the
    readiness endpoint can translate it into a 503 problem+json response.
    """

    try:
        engine = get_engine()
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
