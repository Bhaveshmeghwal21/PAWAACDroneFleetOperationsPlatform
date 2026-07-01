"""Runtime configuration for the Vision AI service.

All configuration is supplied exclusively through environment variables
(Requirement 31.3); this module centralises parsing and provides sane,
non-secret defaults for local development. Values mirror the ``vision-ai``
service stanza in ``docker-compose.yml``.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Strongly-typed view over the service environment variables."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # General
    env: str = "development"
    log_level: str = "info"
    port: int = 8000

    # Trace propagation header name (Requirement 34.3).
    trace_header: str = "X-Trace-Id"

    # Datastore. SQLAlchemy 2.x + psycopg 3 driver URL, e.g.
    # postgresql+psycopg://user:pass@host:5432/dbname
    database_url: str = (
        "postgresql+psycopg://vision_ai:vision_ai@localhost:5434/vision_ai"
    )

    # Tracking parameters (consumed by track stitching, task 9.4). ``track_max_age``
    # is the maximum span (in frame-time units, seconds) a track may go unseen
    # before it is retired from the active set; ``iou_gate`` is the minimum OBB
    # IoU required to associate a detection with an existing track.
    track_max_age: float = 30.0
    iou_gate: float = 0.3
    # Scene classification (task 9.6). ``move_eps`` is the per-step centroid
    # displacement (world/pixel units) below which a vehicle counts as not
    # moving; ``vehicle_stopped_seconds`` is the continuous stationary span that
    # must be exceeded before a ``vehicle_stopped`` event fires; and
    # ``group_gathering_threshold`` is the distinct-person-track count a single
    # zone must exceed to fire a ``group_gathering`` event.
    move_eps: float = 2.0
    vehicle_stopped_seconds: float = 60.0
    group_gathering_threshold: int = 5

    # Alert & Notification ingest endpoint scene events are forwarded to
    # (Requirement 12.5); mirrors telemetry's ``ALERT_NOTIFICATION_URL``.
    alert_notification_url: str = "http://localhost:3005/events"


@lru_cache
def get_settings() -> Settings:
    """Return a cached :class:`Settings` instance.

    The cache makes the settings effectively a process-wide singleton while
    remaining trivially overridable in tests via ``get_settings.cache_clear()``.
    """

    return Settings()
