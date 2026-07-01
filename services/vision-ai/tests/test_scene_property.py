"""Hypothesis property tests for scene event classification (Task 9.7).

Exhaustive, generator-driven coverage of the design's correctness properties
for *Algorithm 4 — Scene Event Classification* (Requirement 12). Each test
below pins exactly one named property from the design document and runs with at
least 100 generated examples:

- **P27 — Group-gathering threshold** (Req 12.3): a ``group_gathering`` event
  for a zone fires **iff** strictly more than ``group_threshold`` (default 5)
  *distinct* ``person`` tracks have their **latest** position inside that zone,
  measured as global zone occupancy independent of which track is processed.
- **P28 — Zone-entry edge** (Req 12.1): a ``person_entered_zone`` event fires
  **iff** the track's *previous* position was outside the zone and its *latest*
  position is inside it (an outside -> inside transition).

The example-based companion suite lives in ``tests/test_scene.py``; these
property tests complement it by checking the invariants hold across the whole
generated input space rather than at hand-picked points. Points are generated
relative to a single fixed axis-aligned square zone so "inside" / "outside" is
unambiguous (strictly-interior / strictly-exterior, never on the boundary).
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from app.services.scene import (
    GROUP_GATHERING,
    PERSON_ENTERED_ZONE,
    SceneTrack,
    TrackPoint,
    Zone,
    classify_scene_events,
    zone_from_coords,
)

# Settings shared by every property test: >=100 examples as mandated by the
# task. The pure classifier does only light shapely point-in-polygon work, but
# we drop the per-example deadline so an occasional slow draw never flakes.
_PBT = settings(max_examples=200, deadline=None)

# A single fixed 10x10 axis-aligned square zone anchored at the origin. All
# generated points are positioned relative to it.
_ZONE_ID = "zone-A"
_ZONE: Zone = zone_from_coords(
    _ZONE_ID, [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
)


# --------------------------------------------------------------------------- #
# Strategies: points strictly inside / strictly outside the fixed zone
# --------------------------------------------------------------------------- #

# Strictly-interior coordinates (margin away from the [0, 10] boundary so the
# boundary-inclusive ``covers`` test is unambiguous).
_inside_coord = st.floats(min_value=1.0, max_value=9.0, allow_nan=False, allow_infinity=False)
# A coordinate strictly outside the [0, 10] span, on either side.
_outside_coord = st.one_of(
    st.floats(min_value=-1_000.0, max_value=-1.0, allow_nan=False, allow_infinity=False),
    st.floats(min_value=11.0, max_value=1_000.0, allow_nan=False, allow_infinity=False),
)
# Any finite coordinate (used for the free axis of an outside point).
_any_coord = st.floats(min_value=-1_000.0, max_value=1_000.0, allow_nan=False, allow_infinity=False)


@st.composite
def inside_points(draw: st.DrawFn) -> tuple[float, float]:
    """An ``(x, y)`` guaranteed strictly inside the fixed zone."""

    return (draw(_inside_coord), draw(_inside_coord))


@st.composite
def outside_points(draw: st.DrawFn) -> tuple[float, float]:
    """An ``(x, y)`` guaranteed strictly outside the fixed zone.

    At least one axis is pushed beyond ``[0, 10]`` (chosen at random) which is
    sufficient for the point to lie outside the square regardless of the other.
    """

    if draw(st.booleans()):
        return (draw(_outside_coord), draw(_any_coord))
    return (draw(_any_coord), draw(_outside_coord))


@st.composite
def positioned_point(draw: st.DrawFn, *, inside: bool) -> tuple[float, float]:
    """An ``(x, y)`` inside the zone when ``inside`` else outside it."""

    return draw(inside_points()) if inside else draw(outside_points())


# --------------------------------------------------------------------------- #
# P27 — Group-gathering threshold (Requirement 12.3)
# --------------------------------------------------------------------------- #


@_PBT
@given(
    placements=st.lists(st.booleans(), min_size=0, max_size=12),
    group_threshold=st.integers(min_value=0, max_value=10),
    data=st.data(),
)
def test_p27_group_gathering_fires_iff_distinct_inside_exceeds_threshold(
    placements: list[bool], group_threshold: int, data: st.DataObject
) -> None:
    """P27: group_gathering fires iff > threshold distinct persons are inside.

    Each boolean in ``placements`` is one distinct single-point person track,
    placed inside (``True``) or outside (``False``) the fixed zone by its latest
    (only) position. The number of ``True`` entries is the global zone occupancy
    used by the classifier (Req 12.3 / P27).
    """

    tracks: list[SceneTrack] = []
    for i, inside in enumerate(placements):
        x, y = data.draw(positioned_point(inside=inside), label=f"p{i}")
        tracks.append(
            SceneTrack(track_id=f"p{i}", cls="person", points=(TrackPoint(ts=0.0, x=x, y=y),))
        )

    inside_count = sum(placements)
    events = classify_scene_events(tracks, [_ZONE], group_threshold=group_threshold)
    gatherings = [e for e in events if e.kind == GROUP_GATHERING]

    if inside_count > group_threshold:
        assert len(gatherings) == 1, (
            f"expected group_gathering with {inside_count} inside > {group_threshold}"
        )
        gathering = gatherings[0]
        assert gathering.zone_id == _ZONE_ID
        # Participants are exactly the distinct tracks whose latest pos is inside.
        expected_ids = {f"p{i}" for i, inside in enumerate(placements) if inside}
        assert set(gathering.track_ids) == expected_ids
    else:
        assert gatherings == [], (
            f"expected no group_gathering with {inside_count} inside <= {group_threshold}"
        )


# --------------------------------------------------------------------------- #
# P28 — Zone-entry edge (Requirement 12.1)
# --------------------------------------------------------------------------- #


@_PBT
@given(prev_inside=st.booleans(), latest_inside=st.booleans(), data=st.data())
def test_p28_person_entered_zone_fires_iff_outside_to_inside_transition(
    prev_inside: bool, latest_inside: bool, data: st.DataObject
) -> None:
    """P28: person_entered_zone fires iff previous outside and latest inside.

    A two-point ``person`` track is generated whose earlier position is inside
    or outside the zone and whose later position is inside or outside it. The
    event must fire exactly for the outside -> inside transition (Req 12.1 / P28).
    """

    px, py = data.draw(positioned_point(inside=prev_inside), label="prev")
    lx, ly = data.draw(positioned_point(inside=latest_inside), label="latest")
    track = SceneTrack(
        track_id="p1",
        cls="person",
        points=(TrackPoint(ts=0.0, x=px, y=py), TrackPoint(ts=1.0, x=lx, y=ly)),
    )

    events = classify_scene_events([track], [_ZONE])
    entries = [e for e in events if e.kind == PERSON_ENTERED_ZONE]

    transitioned = (not prev_inside) and latest_inside
    if transitioned:
        assert len(entries) == 1, "outside -> inside transition must fire person_entered_zone"
        assert entries[0].zone_id == _ZONE_ID
        assert entries[0].track_ids == ("p1",)
        assert entries[0].ts == 1.0
    else:
        assert entries == [], "non-transition must not fire person_entered_zone"
