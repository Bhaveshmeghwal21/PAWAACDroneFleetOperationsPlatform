"""Scene event classification and Alert-Service fan-out (Task 9.6).

This module implements the design's *Algorithm 4 — Scene Event Classification*:
turning stitched object tracks, evaluated against mission-defined zones, into
the three higher-level :class:`~app.models.SceneEvent` kinds (Requirement 12):

- ``person_entered_zone`` — a ``person`` track whose **latest** centroid is
  inside a zone while its **previous** centroid was outside it. The event fires
  if and only if that outside -> inside transition occurs (Requirement 12.1 /
  property **P28**).
- ``vehicle_stopped`` — a ``vehicle`` track whose centroid displacement stays
  below ``MOVE_EPS`` for a continuous span strictly greater than 60 seconds
  (Requirement 12.2). The event references the zone the stationary vehicle
  currently occupies so every emitted event names a defined zone (Req 12.4).
- ``group_gathering`` — more than 5 *distinct* ``person`` tracks simultaneously
  inside the same zone, measured as **global zone occupancy** independent of
  which track is being processed. It fires if and only if the count exceeds 5
  (Requirement 12.3 / property **P27**).

:func:`classify_scene_events` is a **pure, deterministic** function of
``(tracks, zones)``: it performs no I/O, reads no clock, never mutates its
inputs, and returns events in a stable sorted order, so it is trivially
unit-testable and ready for the Hypothesis property tests of task 9.7.

Forwarding classified events to the Alert & Notification service
(Requirement 12.5) is kept separate from classification: an injectable
:class:`SceneEventSink` (defaulting to an HTTP :class:`AlertServiceClient`)
sits behind the pure core, mirroring the Telemetry service's anomaly-emitter
pattern so the hot path never touches the network directly and tests can use an
in-memory fake.
"""

from __future__ import annotations

import json
import math
import urllib.request
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

from shapely.geometry import Point, Polygon

from app.config import get_settings

# Scene-event kind discriminants (mirror ``SCENE_EVENT_KINDS`` in shared-types).
PERSON_ENTERED_ZONE = "person_entered_zone"
VEHICLE_STOPPED = "vehicle_stopped"
GROUP_GATHERING = "group_gathering"

# Object-class labels the classifier keys off.
PERSON_CLASS = "person"
VEHICLE_CLASS = "vehicle"


# --------------------------------------------------------------------------- #
# Pure value objects (decoupled from the ORM / wire schemas)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class TrackPoint:
    """One sampled centroid position of a track at a point in time.

    ``ts`` is the frame timestamp in epoch seconds; ``x``/``y`` are the object
    centroid in the same coordinate space as the zone polygons.
    """

    ts: float
    x: float
    y: float


@dataclass(frozen=True)
class SceneTrack:
    """A track's identity, class, and time-ordered centroid history.

    Only the centroid trajectory is needed for scene classification, so this is
    intentionally lighter than the stitching :class:`~app.services.tracking.Track`.
    ``points`` need not be pre-sorted; the classifier orders a copy by ``ts``.
    """

    track_id: str
    cls: str
    points: tuple[TrackPoint, ...] = ()


@dataclass(frozen=True)
class Zone:
    """A mission-defined zone: an id plus a shapely polygon region.

    The polygon is reused directly from the shapely representation shared with
    geofence handling; construct one from raw coordinates via
    :func:`zone_from_coords`.
    """

    zone_id: str
    polygon: Polygon


@dataclass(frozen=True)
class SceneEventOut:
    """A classified scene event (pure result; persistence is a separate concern).

    ``track_ids`` lists every participating track and ``zone_id`` the zone the
    event was classified against — both always reference existing inputs
    (Requirement 12.4). ``ts`` is the epoch-second timestamp the event is
    attributed to (the latest participating observation).
    """

    kind: str
    zone_id: str
    track_ids: tuple[str, ...]
    ts: float


def zone_from_coords(zone_id: str, coords: Sequence[tuple[float, float]]) -> Zone:
    """Build a :class:`Zone` from an ordered ring of ``(x, y)`` vertices."""

    return Zone(zone_id=zone_id, polygon=Polygon(coords))


# --------------------------------------------------------------------------- #
# Geometry / history helpers
# --------------------------------------------------------------------------- #


def _ordered_points(track: SceneTrack) -> list[TrackPoint]:
    """Return the track's points ascending by ``ts`` (ties broken by position).

    Sorting a copy keeps the function pure regardless of input ordering and
    makes "previous"/"latest" well-defined and deterministic.
    """

    return sorted(track.points, key=lambda p: (p.ts, p.x, p.y))


def _inside(polygon: Polygon, point: TrackPoint) -> bool:
    """Whether ``point`` lies within ``polygon`` (interior or boundary)."""

    return bool(polygon.covers(Point(point.x, point.y)))


def _trailing_stationary_span(points: Sequence[TrackPoint], move_eps: float) -> float:
    """Duration of the maximal trailing run of sub-``move_eps`` steps.

    Walking backward from the most recent point, accumulate consecutive samples
    whose step displacement is strictly below ``move_eps``; the returned span is
    ``latest.ts - earliest_in_run.ts``. A run of a single point has span ``0``.
    """

    if len(points) < 2:
        return 0.0
    latest = points[-1]
    earliest_ts = latest.ts
    for cur, prev in zip(points[-1:0:-1], points[-2::-1], strict=True):
        if math.dist((prev.x, prev.y), (cur.x, cur.y)) < move_eps:
            earliest_ts = prev.ts
        else:
            break
    return latest.ts - earliest_ts


# --------------------------------------------------------------------------- #
# Classification (Algorithm 4) — pure & deterministic
# --------------------------------------------------------------------------- #


def classify_scene_events(
    tracks: Iterable[SceneTrack],
    zones: Iterable[Zone],
    *,
    move_eps: float | None = None,
    stopped_seconds: float | None = None,
    group_threshold: int | None = None,
) -> list[SceneEventOut]:
    """Classify scene events from ``tracks`` against ``zones`` (Algorithm 4).

    Pure and deterministic: inputs are never mutated and the result is returned
    in a stable order (by kind, zone, timestamp, then track ids). ``move_eps``,
    ``stopped_seconds`` and ``group_threshold`` default to the service
    configuration (``MOVE_EPS`` / ``VEHICLE_STOPPED_SECONDS`` /
    ``GROUP_GATHERING_THRESHOLD``).

    Every emitted event references only ids drawn from ``tracks`` and a
    ``zone_id`` drawn from ``zones`` (Requirement 12.4).
    """

    settings = get_settings()
    if move_eps is None:
        move_eps = settings.move_eps
    if stopped_seconds is None:
        stopped_seconds = settings.vehicle_stopped_seconds
    if group_threshold is None:
        group_threshold = settings.group_gathering_threshold

    zone_list = list(zones)
    track_list = list(tracks)
    events: list[SceneEventOut] = []

    # Pre-compute ordered point histories once per track.
    ordered: dict[str, list[TrackPoint]] = {
        t.track_id: _ordered_points(t) for t in track_list
    }

    # Global per-zone person occupancy (by latest position) for group_gathering.
    # Tracked as {zone_id: [(track_id, latest_ts), ...]} regardless of which
    # track is "currently" being processed (Requirement 12.3).
    occupancy: dict[str, list[tuple[str, float]]] = {z.zone_id: [] for z in zone_list}

    for track in track_list:
        pts = ordered[track.track_id]
        if not pts:
            continue
        latest = pts[-1]
        prev = pts[-2] if len(pts) >= 2 else None

        for zone in zone_list:
            latest_inside = _inside(zone.polygon, latest)

            if track.cls == PERSON_CLASS:
                # person_entered_zone: previous outside, latest inside (P28).
                if prev is not None and latest_inside and not _inside(zone.polygon, prev):
                    events.append(
                        SceneEventOut(
                            kind=PERSON_ENTERED_ZONE,
                            zone_id=zone.zone_id,
                            track_ids=(track.track_id,),
                            ts=latest.ts,
                        )
                    )
                # Contribute to this zone's global person occupancy snapshot.
                if latest_inside:
                    occupancy[zone.zone_id].append((track.track_id, latest.ts))

            elif track.cls == VEHICLE_CLASS:
                # vehicle_stopped: stationary span > threshold while inside a
                # defined zone (so the event names a zone — Requirement 12.4).
                if latest_inside:
                    span = _trailing_stationary_span(pts, move_eps)
                    if span > stopped_seconds:
                        events.append(
                            SceneEventOut(
                                kind=VEHICLE_STOPPED,
                                zone_id=zone.zone_id,
                                track_ids=(track.track_id,),
                                ts=latest.ts,
                            )
                        )

    # group_gathering: > group_threshold distinct person tracks in one zone
    # by global occupancy; fires iff the count strictly exceeds the threshold.
    for zone in zone_list:
        members = occupancy[zone.zone_id]
        distinct = sorted({tid for tid, _ in members})
        if len(distinct) > group_threshold:
            latest_ts = max(ts for _, ts in members)
            events.append(
                SceneEventOut(
                    kind=GROUP_GATHERING,
                    zone_id=zone.zone_id,
                    track_ids=tuple(distinct),
                    ts=latest_ts,
                )
            )

    events.sort(key=lambda e: (e.kind, e.zone_id, e.ts, e.track_ids))
    return events


# --------------------------------------------------------------------------- #
# Alert-Service fan-out (Requirement 12.5) — injectable, like the anomaly emitter
# --------------------------------------------------------------------------- #


def _iso(ts: float) -> str:
    """Render an epoch-second timestamp as a UTC ISO-8601 string."""

    return datetime.fromtimestamp(ts, tz=UTC).isoformat()


def to_scene_domain_event(event: SceneEventOut) -> dict:
    """Wrap a scene event in the cross-service ``SceneDomainEvent`` envelope.

    Matches the shared-types contract: ``{kind: 'scene', ts, zoneId, payload}``
    where ``payload`` is the camel-cased :class:`SceneEvent`.
    """

    return {
        "kind": "scene",
        "ts": _iso(event.ts),
        "zoneId": event.zone_id,
        "payload": {
            "kind": event.kind,
            "zoneId": event.zone_id,
            "trackIds": list(event.track_ids),
            "ts": event.ts,
        },
    }


class SceneEventSink(Protocol):
    """A destination for classified scene events. Implementations must not throw."""

    def emit(self, event: SceneEventOut) -> None:  # pragma: no cover - protocol
        ...


# Minimal HTTP POST abstraction: succeed silently, raise on transport/HTTP error.
HttpPost = Callable[[str, str, dict[str, str]], None]


def urllib_http_post(url: str, body: str, headers: dict[str, str]) -> None:
    """Default :data:`HttpPost` backed by the standard-library ``urllib``.

    Raises on a non-2xx response so the caller's ``on_error`` hook can record
    the failure. Production composition roots may inject an ``httpx``-based
    poster instead; tests inject an in-memory fake.
    """

    request = urllib.request.Request(  # noqa: S310 - fixed internal Alert URL
        url, data=body.encode("utf-8"), headers=headers, method="POST"
    )
    with urllib.request.urlopen(request) as response:  # noqa: S310
        status = getattr(response, "status", 200)
        if status >= 300:
            raise RuntimeError(f"Alert service responded {status}")


@dataclass
class AlertServiceClient:
    """:class:`SceneEventSink` that POSTs scene events to the Alert service.

    Delivery is best-effort: a failed POST is routed to ``on_error`` and never
    propagates, so a flaky Alert service can never break classification.
    """

    url: str
    post: HttpPost = urllib_http_post
    on_error: Callable[[Exception, SceneEventOut], None] = lambda err, event: None
    headers: dict[str, str] = field(default_factory=lambda: {"Content-Type": "application/json"})

    def emit(self, event: SceneEventOut) -> None:
        body = json.dumps(to_scene_domain_event(event))
        try:
            self.post(self.url, body, dict(self.headers))
        except Exception as err:  # noqa: BLE001 - sink owns its errors
            self.on_error(err, event)


def forward_scene_events(events: Iterable[SceneEventOut], sink: SceneEventSink) -> None:
    """Forward each classified event through ``sink``, isolating per-event errors."""

    for event in events:
        sink.emit(event)


def classify_and_forward(
    tracks: Iterable[SceneTrack],
    zones: Iterable[Zone],
    sink: SceneEventSink,
    **kwargs: object,
) -> list[SceneEventOut]:
    """Classify scene events (pure) then forward them to the Alert service.

    Returns the classified events so callers may also persist them. The pure
    :func:`classify_scene_events` core is unchanged; this is the thin wiring
    that satisfies Requirement 12.5.
    """

    events = classify_scene_events(tracks, zones, **kwargs)  # type: ignore[arg-type]
    forward_scene_events(events, sink)
    return events


__all__ = [
    "PERSON_ENTERED_ZONE",
    "VEHICLE_STOPPED",
    "GROUP_GATHERING",
    "TrackPoint",
    "SceneTrack",
    "Zone",
    "SceneEventOut",
    "zone_from_coords",
    "classify_scene_events",
    "to_scene_domain_event",
    "SceneEventSink",
    "HttpPost",
    "urllib_http_post",
    "AlertServiceClient",
    "forward_scene_events",
    "classify_and_forward",
]
