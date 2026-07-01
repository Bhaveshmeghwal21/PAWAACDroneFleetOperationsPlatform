"""Unit tests for OBB transforms and track stitching (Task 9.4).

Example-based coverage of the design's *Algorithm 3 — Track Stitching* and the
OBB transform contract. Each test pins one of the design correctness
properties by example; the exhaustive Hypothesis property tests are task 9.5:

- **P22 — total assignment** (Req 11.3): every detection gets exactly one track id.
- **P23 — class consistency** (Req 11.4): detections only match same-class tracks.
- **P24 — OBB transform invertibility** (Req 11.7): transform ∘ inverse = identity.
- **P25 — confidence preservation** (Req 11.5): stitching never alters confidence/class.
- **P26 — stale retirement** (Req 11.6): tracks unseen > MAX_AGE leave the active set.
"""

from __future__ import annotations

import math

import pytest

from app.services.tracking import (
    Detection,
    FrameMeta,
    Track,
    inverse_transform_obb,
    obb_iou,
    stitch_tracks,
    transform_obb,
)


def _aabb(cx: float, cy: float, size: float = 10.0) -> list[float]:
    """A square axis-aligned OBB centred at ``(cx, cy)`` with side ``size``."""

    return [cx, cy, size, size, 0.0]


def _det(
    det_id: str,
    cls: str,
    obb: list[float],
    *,
    confidence: float = 0.9,
    frame_ts: float = 100.0,
) -> Detection:
    return Detection(id=det_id, cls=cls, confidence=confidence, obb=obb, frame_ts=frame_ts)


# --------------------------------------------------------------------------- #
# OBB transforms — Requirement 11.7 / property P24
# --------------------------------------------------------------------------- #


def test_transform_normalizes_pixel_coordinates() -> None:
    """A pixel OBB maps into the unit square under default frame metadata."""

    frame = FrameMeta(width=100.0, height=200.0)
    out = transform_obb([50.0, 100.0, 10.0, 20.0, 0.5], frame)
    assert out == pytest.approx([0.5, 0.5, 0.1, 0.1, 0.5])


def test_transform_then_inverse_recovers_original() -> None:
    """transform ∘ inverse returns the original OBB within tolerance (P24)."""

    frame = FrameMeta(width=640.0, height=480.0, world_width=12.0, world_height=9.0,
                      origin_x=3.0, origin_y=-2.0)
    obb = [123.4, 256.7, 40.0, 18.0, 1.23]
    recovered = inverse_transform_obb(transform_obb(obb, frame), frame)
    assert recovered == pytest.approx(obb, abs=1e-9)


def test_inverse_then_transform_recovers_original() -> None:
    """The inverse direction is also exact (world -> pixel -> world)."""

    frame = FrameMeta(width=320.0, height=240.0)
    world_obb = [0.25, 0.75, 0.1, 0.2, -0.4]
    recovered = transform_obb(inverse_transform_obb(world_obb, frame), frame)
    assert recovered == pytest.approx(world_obb, abs=1e-12)


def test_transform_angle_is_preserved() -> None:
    """The rotation component is carried through both directions unchanged."""

    frame = FrameMeta(width=100.0, height=100.0)
    assert transform_obb([1.0, 2.0, 3.0, 4.0, 0.77], frame)[4] == 0.77
    assert inverse_transform_obb([1.0, 2.0, 3.0, 4.0, 0.77], frame)[4] == 0.77


def test_frame_meta_rejects_non_positive_dimensions() -> None:
    """Degenerate frame metadata (which is non-invertible) is rejected."""

    with pytest.raises(ValueError):
        FrameMeta(width=0.0, height=100.0)
    with pytest.raises(ValueError):
        FrameMeta(width=100.0, height=100.0, world_width=-1.0)


def test_transform_rejects_malformed_obb() -> None:
    """An OBB without exactly five elements is rejected."""

    with pytest.raises(ValueError):
        transform_obb([1.0, 2.0, 3.0], FrameMeta(width=10.0, height=10.0))


# --------------------------------------------------------------------------- #
# OBB IoU helper
# --------------------------------------------------------------------------- #


def test_iou_identical_boxes_is_one() -> None:
    assert obb_iou(_aabb(0.0, 0.0), _aabb(0.0, 0.0)) == pytest.approx(1.0)


def test_iou_disjoint_boxes_is_zero() -> None:
    assert obb_iou(_aabb(0.0, 0.0), _aabb(1000.0, 0.0)) == 0.0


def test_iou_partial_overlap() -> None:
    """Two unit-size-10 squares offset by 1 along x overlap with IoU 90/110."""

    assert obb_iou(_aabb(0.0, 0.0), _aabb(1.0, 0.0)) == pytest.approx(90.0 / 110.0)


# --------------------------------------------------------------------------- #
# Track stitching — Algorithm 3
# --------------------------------------------------------------------------- #


def test_total_assignment_every_detection_gets_one_track_id() -> None:
    """Every detection is assigned exactly one track id (P22 / Req 11.3)."""

    dets = [
        _det("d1", "person", _aabb(0.0, 0.0), confidence=0.9),
        _det("d2", "vehicle", _aabb(500.0, 500.0), confidence=0.8),
    ]
    result = stitch_tracks(dets, active_tracks=[], dt=1.0, now=100.0)

    assert len(result.detections) == 2
    assert all(d.track_id is not None for d in result.detections)
    # Distinct, non-overlapping detections of different classes -> distinct tracks.
    assert len({d.track_id for d in result.detections}) == 2


def test_overlapping_same_class_detection_matches_existing_track() -> None:
    """A same-class detection overlapping a track reuses that track id."""

    track = Track(track_id="t-exist", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=99.0)
    det = _det("d1", "person", _aabb(1.0, 0.0), frame_ts=100.0)

    result = stitch_tracks([det], [track], dt=1.0, now=100.0)

    assert result.detections[0].track_id == "t-exist"
    # The matched track's last-seen advances to the detection's frame timestamp.
    matched = next(t for t in result.active_tracks if t.track_id == "t-exist")
    assert matched.last_seen_ts == 100.0


def test_class_consistency_blocks_cross_class_match() -> None:
    """A detection never matches a track of a different class (P23 / Req 11.4)."""

    track = Track(track_id="t-person", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=99.0)
    det = _det("d1", "vehicle", _aabb(0.0, 0.0), frame_ts=100.0)  # perfect overlap

    result = stitch_tracks([det], [track], dt=1.0, now=100.0)

    # Despite full geometric overlap, the differing class forces a new track.
    assert result.detections[0].track_id != "t-person"
    new_track = next(t for t in result.active_tracks if t.track_id == result.detections[0].track_id)
    assert new_track.cls == "vehicle"


def test_confidence_and_class_preserved() -> None:
    """Stitching leaves each detection's confidence and class unchanged (P25)."""

    track = Track(track_id="t1", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=99.0)
    dets = [
        _det("d1", "person", _aabb(1.0, 0.0), confidence=0.42),
        _det("d2", "car", _aabb(800.0, 800.0), confidence=0.13),
    ]
    result = stitch_tracks(dets, [track], dt=1.0, now=100.0)

    by_id = {d.id: d for d in result.detections}
    assert by_id["d1"].confidence == 0.42
    assert by_id["d1"].cls == "person"
    assert by_id["d2"].confidence == 0.13
    assert by_id["d2"].cls == "car"


def test_stale_track_retired_beyond_max_age() -> None:
    """A track unseen longer than MAX_AGE is dropped from the active set (P26)."""

    fresh = Track(track_id="fresh", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=98.0)
    stale = Track(track_id="stale", cls="vehicle", obb=_aabb(900.0, 900.0), last_seen_ts=10.0)

    # now=100, max_age=30 -> stale (last_seen 10, age 90) retired; fresh (age 2) kept.
    result = stitch_tracks([], [fresh, stale], dt=1.0, now=100.0, max_age=30.0)

    ids = {t.track_id for t in result.active_tracks}
    assert "fresh" in ids
    assert "stale" not in ids


def test_track_exactly_at_max_age_is_retained() -> None:
    """A track unseen for exactly MAX_AGE is on the boundary and retained."""

    track = Track(track_id="edge", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=70.0)
    result = stitch_tracks([], [track], dt=1.0, now=100.0, max_age=30.0)
    assert {t.track_id for t in result.active_tracks} == {"edge"}


def test_constant_velocity_prediction_enables_match() -> None:
    """Forward prediction lets a moved object match its track (Algorithm 3 step 1)."""

    # Track centred at origin, moving +10/sec in x. After dt=1 it is predicted
    # at x=10, which overlaps a detection observed at x=11.
    track = Track(
        track_id="moving",
        cls="person",
        obb=_aabb(0.0, 0.0),
        last_seen_ts=99.0,
        velocity=(10.0, 0.0),
    )
    det = _det("d1", "person", _aabb(11.0, 0.0), frame_ts=100.0)

    # Without prediction the boxes (x=0 vs x=11, side 10) would be disjoint.
    assert obb_iou(track.obb, det.obb) == 0.0
    result = stitch_tracks([det], [track], dt=1.0, now=100.0)
    assert result.detections[0].track_id == "moving"


def test_greedy_high_confidence_first_wins_contested_track() -> None:
    """When two detections contest one track, the higher-confidence one wins."""

    track = Track(track_id="t1", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=99.0)
    high = _det("d_high", "person", _aabb(1.0, 0.0), confidence=0.95, frame_ts=100.0)
    low = _det("d_low", "person", _aabb(1.0, 0.0), confidence=0.40, frame_ts=100.0)

    result = stitch_tracks([low, high], [track], dt=1.0, now=100.0)

    by_id = {d.id: d for d in result.detections}
    assert by_id["d_high"].track_id == "t1"  # higher confidence claims the track
    assert by_id["d_low"].track_id != "t1"  # forced onto a new track
    # Total assignment still holds for both.
    assert by_id["d_low"].track_id is not None


def test_non_overlapping_detection_spawns_new_track() -> None:
    """A detection outside the IoU gate creates a fresh track, not a match."""

    track = Track(track_id="t1", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=99.0)
    det = _det("d1", "person", _aabb(500.0, 500.0), frame_ts=100.0)

    result = stitch_tracks([det], [track], dt=1.0, now=100.0)
    assert result.detections[0].track_id != "t1"


def test_inputs_are_not_mutated() -> None:
    """The function is pure: input detections and tracks are left untouched."""

    track = Track(track_id="t1", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=99.0)
    det = _det("d1", "person", _aabb(1.0, 0.0), frame_ts=100.0)

    stitch_tracks([det], [track], dt=1.0, now=100.0)

    assert det.track_id is None
    assert track.last_seen_ts == 99.0


def test_empty_frame_only_retires_tracks() -> None:
    """With no detections, stitching just applies retirement to the active set."""

    keep = Track(track_id="keep", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=95.0)
    drop = Track(track_id="drop", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=1.0)
    result = stitch_tracks([], [keep, drop], dt=1.0, now=100.0, max_age=30.0)
    assert result.detections == []
    assert {t.track_id for t in result.active_tracks} == {"keep"}


def test_iou_gate_threshold_respected() -> None:
    """A custom IoU gate higher than the actual overlap forces a new track."""

    track = Track(track_id="t1", cls="person", obb=_aabb(0.0, 0.0), last_seen_ts=99.0)
    # IoU of these boxes is 90/110 ~= 0.818; a gate of 0.9 excludes the match.
    det = _det("d1", "person", _aabb(1.0, 0.0), frame_ts=100.0)
    result = stitch_tracks([det], [track], dt=1.0, now=100.0, iou_gate=0.9)
    assert result.detections[0].track_id != "t1"
    # Sanity: the same detection matches under the default lower gate.
    assert math.isclose(obb_iou(track.obb, det.obb), 90.0 / 110.0)
