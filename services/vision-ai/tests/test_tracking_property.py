"""Hypothesis property tests for OBB transforms and track stitching (Task 9.5).

Exhaustive, generator-driven coverage of the design's correctness properties
for *Algorithm 3 — Track Stitching* and the OBB transform contract. Each test
below pins exactly one named property from the design document (P22–P26) and
runs with at least 100 generated examples:

- **P22 — Total assignment** (Req 11.3): after ``stitch_tracks`` every input
  detection has exactly one ``track_id``.
- **P23 — Class consistency** (Req 11.4): every detection assigned to a track
  shares that track's object class.
- **P24 — OBB transform invertibility** (Req 11.7):
  ``inverse_transform_obb(transform_obb(obb, frame), frame)`` recovers ``obb``
  within tolerance.
- **P25 — Confidence preservation** (Req 11.5): ``stitch_tracks`` never alters
  any detection's ``confidence`` or ``cls``.
- **P26 — Stale retirement** (Req 11.6): any track unseen longer than
  ``MAX_AGE`` is absent from the returned active set.

The example-based companion suite lives in ``tests/test_tracking.py``; these
property tests complement it by checking the invariants hold across the whole
generated input space rather than at hand-picked points.
"""

from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.services.tracking import (
    Detection,
    FrameMeta,
    Track,
    inverse_transform_obb,
    stitch_tracks,
    transform_obb,
)

# Object classes the generators draw from. A small, fixed vocabulary keeps the
# chance of cross-class collisions (and thus same-class matches) meaningful.
_CLASSES = ["person", "vehicle", "car", "bicycle"]

# Settings shared by every property test: >=100 examples as mandated by the
# task, and no per-example deadline because exact shapely IoU over many
# generated OBBs can occasionally exceed Hypothesis's default timing budget
# without indicating any logical failure.
_PBT = settings(max_examples=150, deadline=None)


# --------------------------------------------------------------------------- #
# Reusable strategies
# --------------------------------------------------------------------------- #

# Finite, bounded coordinates keep geometry well-conditioned and avoid float
# overflow when boxes are scaled by the frame transform.
_coord = st.floats(min_value=-1_000.0, max_value=1_000.0, allow_nan=False, allow_infinity=False)
# Strictly-positive dimensions (width/height/frame sizes). A small floor avoids
# degenerate zero-area boxes that shapely treats as empty.
_pos = st.floats(min_value=0.1, max_value=1_000.0, allow_nan=False, allow_infinity=False)
_angle = st.floats(min_value=-math.pi, max_value=math.pi, allow_nan=False, allow_infinity=False)
_confidence = st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False)
_ts = st.floats(min_value=0.0, max_value=10_000.0, allow_nan=False, allow_infinity=False)


@st.composite
def obbs(draw: st.DrawFn) -> list[float]:
    """Generate a valid OBB ``[cx, cy, w, h, angle]`` with positive w/h."""

    return [draw(_coord), draw(_coord), draw(_pos), draw(_pos), draw(_angle)]


@st.composite
def frames(draw: st.DrawFn) -> FrameMeta:
    """Generate a :class:`FrameMeta` with strictly-positive pixel/world dims."""

    return FrameMeta(
        width=draw(_pos),
        height=draw(_pos),
        world_width=draw(_pos),
        world_height=draw(_pos),
        origin_x=draw(_coord),
        origin_y=draw(_coord),
    )


@st.composite
def detection_lists(draw: st.DrawFn, *, min_size: int = 0, max_size: int = 6) -> list[Detection]:
    """Generate a list of detections that share one frame timestamp.

    Per Algorithm 3's precondition, all detections in a stitch pass belong to
    the same frame, so they share ``frame_ts``. Ids are unique (``d0``..``dN``).
    """

    n = draw(st.integers(min_value=min_size, max_value=max_size))
    frame_ts = draw(_ts)
    dets: list[Detection] = []
    for i in range(n):
        dets.append(
            Detection(
                id=f"d{i}",
                cls=draw(st.sampled_from(_CLASSES)),
                confidence=draw(_confidence),
                obb=draw(obbs()),
                frame_ts=frame_ts,
            )
        )
    return dets


@st.composite
def track_lists(draw: st.DrawFn, *, max_size: int = 5) -> list[Track]:
    """Generate a list of active tracks with unique ids (``t0``..``tN``)."""

    n = draw(st.integers(min_value=0, max_value=max_size))
    tracks: list[Track] = []
    for i in range(n):
        tracks.append(
            Track(
                track_id=f"t{i}",
                cls=draw(st.sampled_from(_CLASSES)),
                obb=draw(obbs()),
                last_seen_ts=draw(_ts),
                velocity=(
                    draw(st.floats(min_value=-50.0, max_value=50.0, allow_nan=False)),
                    draw(st.floats(min_value=-50.0, max_value=50.0, allow_nan=False)),
                ),
            )
        )
    return tracks


# A track id can never collide between existing ("tN") and freshly-minted
# ("track-dN") tracks, so assignment maps stay unambiguous.


# --------------------------------------------------------------------------- #
# P24 — OBB transform invertibility (Requirement 11.7)
# --------------------------------------------------------------------------- #


@_PBT
@given(obb=obbs(), frame=frames())
def test_p24_inverse_recovers_original_obb(obb: list[float], frame: FrameMeta) -> None:
    """P24: inverse_transform_obb(transform_obb(obb)) ~= obb within tolerance."""

    recovered = inverse_transform_obb(transform_obb(obb, frame), frame)
    assert recovered == pytest.approx(obb, rel=1e-9, abs=1e-9)


@_PBT
@given(obb=obbs(), frame=frames())
def test_p24_transform_recovers_original_obb(obb: list[float], frame: FrameMeta) -> None:
    """P24 (other direction): transform_obb(inverse_transform_obb(obb)) ~= obb."""

    recovered = transform_obb(inverse_transform_obb(obb, frame), frame)
    assert recovered == pytest.approx(obb, rel=1e-9, abs=1e-9)


# --------------------------------------------------------------------------- #
# P22 — Total assignment (Requirement 11.3)
# --------------------------------------------------------------------------- #


@_PBT
@given(dets=detection_lists(), tracks=track_lists(), dt=st.floats(0.0, 5.0, allow_nan=False))
def test_p22_every_detection_gets_exactly_one_track_id(
    dets: list[Detection], tracks: list[Track], dt: float
) -> None:
    """P22: after stitching, every input detection has exactly one track id."""

    result = stitch_tracks(dets, tracks, dt=dt)

    # Same multiset of detection ids in, out — none dropped or duplicated.
    assert [d.id for d in result.detections] == [d.id for d in dets]
    # Every detection carries a (single, non-null) track id.
    assert all(d.track_id is not None for d in result.detections)


# --------------------------------------------------------------------------- #
# P23 — Class consistency (Requirement 11.4)
# --------------------------------------------------------------------------- #


@_PBT
@given(
    dets=detection_lists(min_size=1),
    tracks=track_lists(),
    dt=st.floats(0.0, 5.0, allow_nan=False),
)
def test_p23_detection_shares_its_assigned_tracks_class(
    dets: list[Detection], tracks: list[Track], dt: float
) -> None:
    """P23: each detection's assigned track has the detection's own class."""

    # Generous max_age + now anchored to the frame keeps every assigned track
    # in the active set so its class is observable for the check.
    now = dets[0].frame_ts
    result = stitch_tracks(dets, tracks, dt=dt, now=now, max_age=float("inf"))

    track_cls = {t.track_id: t.cls for t in result.active_tracks}
    for det in result.detections:
        assert det.track_id in track_cls, "assigned track must be present in active set"
        assert track_cls[det.track_id] == det.cls


# --------------------------------------------------------------------------- #
# P25 — Confidence preservation (Requirement 11.5)
# --------------------------------------------------------------------------- #


@_PBT
@given(dets=detection_lists(), tracks=track_lists(), dt=st.floats(0.0, 5.0, allow_nan=False))
def test_p25_confidence_and_class_unchanged(
    dets: list[Detection], tracks: list[Track], dt: float
) -> None:
    """P25: stitching never alters any detection's confidence or class."""

    original = {d.id: (d.confidence, d.cls) for d in dets}
    result = stitch_tracks(dets, tracks, dt=dt)

    for det in result.detections:
        conf, cls = original[det.id]
        assert det.confidence == conf
        assert det.cls == cls
    # Inputs themselves remain untouched (referential transparency).
    assert all(d.track_id is None for d in dets)


# --------------------------------------------------------------------------- #
# P26 — Stale retirement (Requirement 11.6)
# --------------------------------------------------------------------------- #


@_PBT
@given(
    dets=detection_lists(),
    tracks=track_lists(),
    dt=st.floats(0.0, 5.0, allow_nan=False),
    now=_ts,
    max_age=st.floats(min_value=0.0, max_value=5_000.0, allow_nan=False),
)
def test_p26_no_active_track_exceeds_max_age(
    dets: list[Detection],
    tracks: list[Track],
    dt: float,
    now: float,
    max_age: float,
) -> None:
    """P26: every returned active track was seen within MAX_AGE of ``now``."""

    result = stitch_tracks(dets, tracks, dt=dt, now=now, max_age=max_age)

    for track in result.active_tracks:
        assert (now - track.last_seen_ts) <= max_age


@_PBT
@given(
    tracks=track_lists(max_size=6),
    now=_ts,
    max_age=st.floats(min_value=0.0, max_value=5_000.0, allow_nan=False),
)
def test_p26_stale_tracks_absent_on_empty_frame(
    tracks: list[Track], now: float, max_age: float
) -> None:
    """P26: with no detections, exactly the non-stale tracks survive."""

    result = stitch_tracks([], tracks, dt=1.0, now=now, max_age=max_age)

    surviving = {t.track_id for t in result.active_tracks}
    for track in tracks:
        is_stale = (now - track.last_seen_ts) > max_age
        assert (track.track_id not in surviving) == is_stale
