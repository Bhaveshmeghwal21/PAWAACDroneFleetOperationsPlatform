"""Shared pytest fixtures for the Vision AI service test-suite."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session


@pytest.fixture
def client() -> TestClient:
    """A FastAPI TestClient backed by a freshly constructed application."""

    from app.main import create_app

    return TestClient(create_app())


@pytest.fixture
def sqlite_app(tmp_path, monkeypatch) -> Iterator[None]:
    """Point the service at a throwaway SQLite database with schema created.

    Clears the cached settings/engine/sessionmaker so the app and its
    ``get_session`` dependency bind to the temporary database, then creates the
    full ORM schema (including the ``ingest_batches`` idempotency ledger). All
    caches are reset again on teardown so other tests are unaffected.
    """

    import app.models  # noqa: F401 — register tables on Base.metadata
    from app.config import get_settings
    from app.db import Base, get_engine, get_sessionmaker

    db_path = tmp_path / "vision_ai_ingest.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db_path}")
    get_settings.cache_clear()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()

    engine = get_engine()
    Base.metadata.create_all(engine)
    try:
        yield None
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()
        get_settings.cache_clear()
        get_engine.cache_clear()
        get_sessionmaker.cache_clear()


@pytest.fixture
def ingest_client(sqlite_app) -> TestClient:
    """A TestClient whose app is wired to the temporary SQLite database."""

    from app.main import create_app

    return TestClient(create_app())


@pytest.fixture
def db_session(sqlite_app) -> Iterator[Session]:
    """A SQLAlchemy session bound to the temporary SQLite database."""

    from app.db import get_sessionmaker

    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.close()
