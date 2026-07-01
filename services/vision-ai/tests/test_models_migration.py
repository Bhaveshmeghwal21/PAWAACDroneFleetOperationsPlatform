"""Tests for the Vision AI persistence schema and migration (Task 9.2).

These cover Requirement 11.1 (detection/track/scene-event persistence) and
Requirement 28.1/28.3 (versioned Alembic migrations, no raw SQL DDL). The
Alembic migration is exercised against a throwaway SQLite database to confirm
it is syntactically valid and produces the expected schema; applying it against
a live Postgres is deferred to the integration suite / deployment.
"""

from __future__ import annotations

import os
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy import inspect

from app.config import get_settings
from app.db import Base
from app.models import Detection, SceneEvent, Track

SERVICE_ROOT = Path(__file__).resolve().parent.parent


def test_models_register_expected_tables() -> None:
    """The ORM metadata declares the three Vision AI tables (Req 11.1)."""

    tables = set(Base.metadata.tables)
    assert {"detections", "tracks", "scene_events"} <= tables


def test_detection_columns_match_design_data_model() -> None:
    """Detection carries every field from the design data model (Req 11.1)."""

    cols = Detection.__table__.columns
    assert set(cols.keys()) == {
        "id",
        "drone_id",
        "frame_ts",
        "cls",
        "confidence",
        "obb",
        "track_id",
    }
    # track_id is the only nullable column (assigned later by stitching).
    assert cols["track_id"].nullable is True
    assert cols["confidence"].nullable is False


def test_track_and_scene_event_columns() -> None:
    """Track and SceneEvent expose their design fields (Req 11.1)."""

    assert set(Track.__table__.columns.keys()) == {"track_id", "cls", "last_seen_ts"}
    assert set(SceneEvent.__table__.columns.keys()) == {
        "id",
        "kind",
        "zone_id",
        "track_ids",
        "ts",
    }


def test_detection_track_foreign_key() -> None:
    """A detection's track_id references the tracks table."""

    fks = list(Detection.__table__.c.track_id.foreign_keys)
    assert len(fks) == 1
    assert fks[0].column.table.name == "tracks"


def test_alembic_migration_creates_schema(tmp_path, monkeypatch) -> None:
    """Running the migration end-to-end builds the expected tables (Req 28.1/28.3).

    Exercised on a disposable SQLite file so the migration's structure is
    verified without requiring a live Postgres instance.
    """

    from alembic.config import Config

    from alembic import command

    db_path = tmp_path / "vision_ai_test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db_path}")
    get_settings.cache_clear()

    cfg = Config(str(SERVICE_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))

    try:
        command.upgrade(cfg, "head")

        engine = sa.create_engine(f"sqlite+pysqlite:///{db_path}")
        inspector = inspect(engine)
        table_names = set(inspector.get_table_names())
        assert {"detections", "tracks", "scene_events"} <= table_names

        det_cols = {c["name"] for c in inspector.get_columns("detections")}
        assert det_cols == {
            "id",
            "drone_id",
            "frame_ts",
            "cls",
            "confidence",
            "obb",
            "track_id",
        }
        engine.dispose()

        # Downgrade must cleanly tear the schema back down.
        command.downgrade(cfg, "base")
        engine = sa.create_engine(f"sqlite+pysqlite:///{db_path}")
        inspector = inspect(engine)
        remaining = set(inspector.get_table_names())
        assert not ({"detections", "tracks", "scene_events"} & remaining)
        engine.dispose()
    finally:
        os.environ.pop("DATABASE_URL", None)
        get_settings.cache_clear()
