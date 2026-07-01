"""Unit tests for scene event classification and fan-out (Task 9.6).

Example-based coverage of the design's *Algorithm 4 — Scene Event
Classification* (Requirement 12). The exhaustive Hypothesis property tests for
the group-gathering threshold (**P27**) and the zone-entry edge (**P28**) are
task 9.7; here we pin each event kind, its boundary, and the Alert-Service
fan-out by example:

- ``person_entered_zone`` — fires iff a person's previous centroid was outside
  and its latest centroid is inside the zone (Req 12.1 / P28).
- ``vehicle_stopped`` — fires when a vehicle's centroid stays below ``MOVE_EPS``
  for a continuous span strictly greater than 60s while inside a zone (Req 12.2).
- ``group_gathering`` — fires iff more than 5 distinct person tracks occupy the
  same zone by global occupancy (Req 12.3 / P27).
- emitted events reference only existing track ids and a defined zone (Req 12.4)
  and are forwarded to the Alert service through an injectable sink (Req 12.5).
"""

from __future__ import annotations

from dataclasses import replace

from app.services.scene import (
    GROUP_GATHERING,
    PERSON_ENTERED_ZONE,
    VEHICLE_STOPPED,
    AlertServiceClient,
    SceneEventOut,
    SceneTrack,
    TrackPoint,
    Zone,
    classify_and_forward,
    classify_scene_events,
    to_scene_domain_event,
    zone_from_coords,
)


def _zone(zone_id: str = "zone-A") -> Zone:
    """A 10x10 axis-aligned square zone anchored at the origin."""

    return zone_from_coords(zone_id, [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)])


def _person(track_id: str, points: list[tuple[float, float, float]]) -> SceneTrack:
    return SceneTrack(
        track_id=track_id,
        cls="person",
        points=tuple(TrackPoint(ts=t, x=x, y=y) for t, x, y in points),
    )


def _vehicle(track_id: str, points: list[tuple[float, float, float]]) -> SceneTrack:
    return SceneTrack(
        track_id=track_id,
        cls="vehicle",
        points=tuple(TrackPoint(ts=t, x=x, y=y) for t, x, y in points),
    )


def _kinds(events: list[SceneEventOut]) -> list[str]:
    return [e.kind for e in events]


# --------------------------------------------------------------------------- #
# person_entered_zone — Requirement 12.1 / property P28
# --------------------------------------------------------------------------- #


def test_person_entered_zone_fires_on_outside_to_inside_transition() -> None:
    """Previous centroid outside, latest inside -> one person_entered_zone (P28)."""

    track = _person("p1", [(0.0, -5.0, 5.0), (1.0, 5.0, 5.0)])  # outside -> inside
    events = classify_scene_events([track], [_zone()])

    assert _kinds(events) == [PERSON_ENTERED_ZONE]
    assert events[0].zone_id == "zone-A"
    assert events[0].track_ids == ("p1",)
    assert events[0].ts == 1.0


def test_no_entry_event_when_already_inside() -> None:
    """An inside -> inside step is not a transition, so nothing fires (P28)."""

    track = _person("p1", [(0.0, 4.0, 4.0), (1.0, 6.0, 6.0)])  # inside -> inside
    assert classify_scene_events([track], [_zone()]) == []


def test_no_entry_event_when_staying_outside() -> None:
    """An outside -> outside step never fires a person_entered_zone."""

    track = _person("p1", [(0.0, -5.0, 5.0), (1.0, -3.0, 5.0)])
    assert classify_scene_events([track], [_zone()]) == []


def test_no_entry_event_for_single_observation() -> None:
    """With no previous position there is no transition to detect."""

    track = _person("p1", [(0.0, 5.0, 5.0)])  # inside, but only one point
    assert classify_scene_events([track], [_zone()]) == []


def test_entry_detected_from_unordered_points() -> None:
    """Classification orders points by ts, so input order is irrelevant."""

    track = _person("p1", [(1.0, 5.0, 5.0), (0.0, -5.0, 5.0)])  # supplied latest-first
    assert _kinds(classify_scene_events([track], [_zone()])) == [PERSON_ENTERED_ZONE]


# --------------------------------------------------------------------------- #
# vehicle_stopped — Requirement 12.2
# --------------------------------------------------------------------------- #


def test_vehicle_stopped_fires_after_continuous_stationary_span() -> None:
    """A vehicle below MOVE_EPS for >60s inside a zone fires vehicle_stopped."""

    track = _vehicle("v1", [(0.0, 5.0, 5.0), (30.0, 5.4, 5.0), (70.0, 5.8, 5.0)])
    events = classify_scene_events([track], [_zone()])

    assert _kinds(events) == [VEHICLE_STOPPED]
    assert events[0].track_ids == ("v1",)
    assert events[0].ts == 70.0


def test_vehicle_not_stopped_when_moving() -> None:
    """Per-step displacement above MOVE_EPS breaks the stationary run."""

    track = _vehicle("v1", [(0.0, 1.0, 5.0), (30.0, 5.0, 5.0), (70.0, 9.0, 5.0)])
    assert classify_scene_events([track], [_zone()]) == []


def test_vehicle_stopped_requires_span_strictly_greater_than_threshold() -> None:
    """A stationary span of exactly 60s does not exceed the threshold."""

    track = _vehicle("v1", [(10.0, 5.0, 5.0), (70.0, 5.5, 5.0)])  # span == 60
    assert classify_scene_events([track], [_zone()]) == []


def test_vehicle_stopped_only_when_inside_a_defined_zone() -> None:
    """A stationary vehicle outside every zone emits nothing (needs a zone id)."""

    track = _vehicle("v1", [(0.0, -5.0, 5.0), (70.0, -5.2, 5.0)])  # stopped but outside
    assert classify_scene_events([track], [_zone()]) == []


# --------------------------------------------------------------------------- #
# group_gathering — Requirement 12.3 / property P27
# --------------------------------------------------------------------------- #


def test_group_gathering_fires_above_five_distinct_persons() -> None:
    """Six distinct person tracks in one zone fire one group_gathering (P27)."""

    tracks = [_person(f"p{i}", [(float(i), 5.0, 5.0)]) for i in range(6)]
    events = classify_scene_events(tracks, [_zone()])

    gatherings = [e for e in events if e.kind == GROUP_GATHERING]
    assert len(gatherings) == 1
    assert gatherings[0].zone_id == "zone-A"
    assert set(gatherings[0].track_ids) == {f"p{i}" for i in range(6)}
    # ts is the latest participating observation.
    assert gatherings[0].ts == 5.0


def test_group_gathering_does_not_fire_at_exactly_five() -> None:
    """Exactly five persons in a zone is the boundary and does not fire (P27)."""

    tracks = [_person(f"p{i}", [(float(i), 5.0, 5.0)]) for i in range(5)]
    assert [e for e in classify_scene_events(tracks, [_zone()]) if e.kind == GROUP_GATHERING] == []


def test_group_gathering_counts_global_occupancy_across_zones() -> None:
    """Occupancy is per-zone; six in zone A and one in zone B fire only for A."""

    zone_a = _zone("zone-A")
    zone_b = zone_from_coords("zone-B", [(20.0, 20.0), (30.0, 20.0), (30.0, 30.0), (20.0, 30.0)])
    in_a = [_person(f"a{i}", [(float(i), 5.0, 5.0)]) for i in range(6)]
    in_b = [_person("b1", [(0.0, 25.0, 25.0)])]

    gatherings = [
        e for e in classify_scene_events(in_a + in_b, [zone_a, zone_b]) if e.kind == GROUP_GATHERING
    ]
    assert len(gatherings) == 1
    assert gatherings[0].zone_id == "zone-A"


def test_group_gathering_only_counts_persons_not_vehicles() -> None:
    """Vehicles inside the zone do not contribute to the person-occupancy count."""

    persons = [_person(f"p{i}", [(float(i), 5.0, 5.0)]) for i in range(5)]
    vehicles = [_vehicle(f"v{i}", [(float(i), 6.0, 6.0)]) for i in range(3)]
    gatherings = [
        e for e in classify_scene_events(persons + vehicles, [_zone()]) if e.kind == GROUP_GATHERING
    ]
    assert gatherings == []


# --------------------------------------------------------------------------- #
# Invariants: existing ids / defined zones, purity, determinism (Req 12.4)
# --------------------------------------------------------------------------- #


def test_events_reference_only_existing_tracks_and_defined_zones() -> None:
    """Every emitted event names an input track id and an input zone (Req 12.4)."""

    zone = _zone()
    persons = [_person(f"p{i}", [(0.0, -5.0, 5.0), (1.0, 5.0, 5.0)]) for i in range(6)]
    events = classify_scene_events(persons, [zone])

    track_ids = {t.track_id for t in persons}
    for event in events:
        assert event.zone_id == zone.zone_id
        assert set(event.track_ids).issubset(track_ids)


def test_classification_does_not_mutate_inputs_and_is_deterministic() -> None:
    """Pure: inputs untouched and repeated calls yield identical results."""

    tracks = [_person("p1", [(0.0, -5.0, 5.0), (1.0, 5.0, 5.0)])]
    zones = [_zone()]
    snapshot = list(tracks)

    first = classify_scene_events(tracks, zones)
    second = classify_scene_events(tracks, zones)

    assert first == second
    assert tracks == snapshot  # input list/objects unchanged


def test_threshold_overrides_are_honoured() -> None:
    """Explicit thresholds override the configured defaults."""

    tracks = [_person(f"p{i}", [(float(i), 5.0, 5.0)]) for i in range(3)]
    gatherings = [
        e
        for e in classify_scene_events(tracks, [_zone()], group_threshold=2)
        if e.kind == GROUP_GATHERING
    ]
    assert len(gatherings) == 1


# --------------------------------------------------------------------------- #
# Alert-Service fan-out — Requirement 12.5
# --------------------------------------------------------------------------- #


def test_to_scene_domain_event_builds_shared_types_envelope() -> None:
    """The forwarded payload matches the SceneDomainEvent shape."""

    event = SceneEventOut(kind=PERSON_ENTERED_ZONE, zone_id="zone-A", track_ids=("p1",), ts=1.0)
    envelope = to_scene_domain_event(event)

    assert envelope["kind"] == "scene"
    assert envelope["zoneId"] == "zone-A"
    assert envelope["payload"] == {
        "kind": PERSON_ENTERED_ZONE,
        "zoneId": "zone-A",
        "trackIds": ["p1"],
        "ts": 1.0,
    }
    assert envelope["ts"].startswith("1970-01-01T00:00:01")


class _RecordingSink:
    """In-memory :class:`SceneEventSink` used to assert fan-out behaviour."""

    def __init__(self) -> None:
        self.emitted: list[SceneEventOut] = []

    def emit(self, event: SceneEventOut) -> None:
        self.emitted.append(event)


def test_classify_and_forward_emits_each_event_to_the_sink() -> None:
    """classify_and_forward forwards every classified event (Req 12.5)."""

    sink = _RecordingSink()
    track = _person("p1", [(0.0, -5.0, 5.0), (1.0, 5.0, 5.0)])

    events = classify_and_forward([track], [_zone()], sink)

    assert _kinds(events) == [PERSON_ENTERED_ZONE]
    assert sink.emitted == events


def test_alert_service_client_posts_envelope_via_injected_poster() -> None:
    """AlertServiceClient POSTs the JSON envelope through the injected HttpPost."""

    calls: list[tuple[str, str, dict[str, str]]] = []
    client = AlertServiceClient(
        url="http://alerts/events",
        post=lambda url, body, headers: calls.append((url, body, headers)),
    )
    event = SceneEventOut(kind=VEHICLE_STOPPED, zone_id="zone-A", track_ids=("v1",), ts=70.0)

    client.emit(event)

    assert len(calls) == 1
    url, body, headers = calls[0]
    assert url == "http://alerts/events"
    assert headers["Content-Type"] == "application/json"
    assert '"kind": "scene"' in body


def test_alert_service_client_isolates_delivery_failures() -> None:
    """A failing POST is routed to on_error and never propagates to the caller."""

    seen: list[Exception] = []

    def _boom(url: str, body: str, headers: dict[str, str]) -> None:
        raise RuntimeError("alert service down")

    client = AlertServiceClient(
        url="http://alerts/events",
        post=_boom,
        on_error=lambda err, event: seen.append(err),
    )
    event = replace(
        SceneEventOut(kind=GROUP_GATHERING, zone_id="zone-A", track_ids=("p1", "p2"), ts=3.0)
    )

    client.emit(event)  # must not raise

    assert len(seen) == 1
    assert isinstance(seen[0], RuntimeError)
