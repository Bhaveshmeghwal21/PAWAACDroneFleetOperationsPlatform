"""OBB coordinate transforms and ByteTrack-style track stitching (Task 9.4).

This module implements the two pure, deterministic geometry/association
primitives from the design's *Algorithm 3 — Track Stitching* and the OBB
transform contract, expressed over plain dataclasses rather than ORM rows so
they are trivially unit-testable and ready for the Hypothesis property tests of
task 9.5.

Two capabilities are provided:

- :func:`transform_obb` / :func:`inverse_transform_obb` — convert an oriented
  bounding box between *pixel* frame coordinates and *normalized/world*
  coordinates given a :class:`FrameMeta`. The mapping is an affine
  per-axis scale-and-translate, so transforming an OBB and then applying the
  inverse reproduces the original OBB within floating-point tolerance
  (Requirement 11.7 / property **P24** — OBB transform invertibility).

- :func:`stitch_tracks` — associate a frame's detections with the set of active
  tracks using greedy, high-confidence-first IoU matching gated by object
  class and a minimum-overlap threshold, after predicting each track forward by
  ``dt`` under a constant-velocity model. It guarantees every detection
  receives exactly one ``track_id`` (Requirement 11.3 / **P22**), only matches
  detections to tracks of the same class (Requirement 11.4 / **P23**), never
  mutates a detection's confidence or class (Requirement 11.5 / **P25**), and
  retires tracks unseen for longer than the configured maximum age
  (Requirement 11.6 / **P26**).

The OBB layout is the five-element ``[cx, cy, w, h, angle]`` used throughout the
service, with ``angle`` in radians. None of these functions touch the database
or any shared mutable state; inputs are never mutated and new objects are
returned, keeping behaviour referentially transparent.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from shapely.affinity import rotate, translate
from shapely.geometry import Polygon

from app.config import get_settings

# Index positions within the five-element OBB array [cx, cy, w, h, angle].
_CX, _CY, _W, _H, _ANGLE = 0, 1, 2, 3, 4
_OBB_LENGTH = 5

# A list/tuple of exactly five floats: [cx, cy, w, h, angle] (angle in radians).
OBB = list[float]


# --------------------------------------------------------------------------- #
# OBB coordinate transforms (Requirement 11.7 / property P24)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FrameMeta:
    """Metadata describing how a frame's pixel space maps to world space.

    The mapping is an independent affine transform per axis: a pixel coordinate
    is scaled by ``world_size / pixel_size`` and shifted by the world origin.
    With the defaults (``world_width = world_height = 1`` and a zero origin) the
    transform normalizes pixel coordinates into the unit square, i.e. the
    "pixel -> normalized" mapping referenced by the design.

    All sizes must be strictly positive so the transform is invertible.
    """

    width: float
    height: float
    world_width: float = 1.0
    world_height: float = 1.0
    origin_x: float = 0.0
    origin_y: float = 0.0

    def __post_init__(self) -> None:
        for name in ("width", "height", "world_width", "world_height"):
            value = getattr(self, name)
            if value <= 0:
                raise ValueError(f"FrameMeta.{name} must be strictly positive, got {value!r}")

    @property
    def scale_x(self) -> float:
        """World-units-per-pixel along the x axis."""

        return self.world_width / self.width

    @property
    def scale_y(self) -> float:
        """World-units-per-pixel along the y axis."""

        return self.world_height / self.height


def _validate_obb(obb: OBB) -> None:
    if len(obb) != _OBB_LENGTH:
        raise ValueError("obb must contain exactly five elements [cx, cy, w, h, angle]")


def transform_obb(obb: OBB, frame: FrameMeta) -> OBB:
    """Map a pixel-space OBB into normalized/world coordinates.

    The centre is scaled and shifted into world space; the width and height are
    scaled by the corresponding axis factor; the rotation ``angle`` is
    orientation-preserving and carried through unchanged. The returned OBB is a
    new list (the input is not mutated).
    """

    _validate_obb(obb)
    cx, cy, w, h, angle = obb
    return [
        frame.origin_x + cx * frame.scale_x,
        frame.origin_y + cy * frame.scale_y,
        w * frame.scale_x,
        h * frame.scale_y,
        angle,
    ]


def inverse_transform_obb(obb: OBB, frame: FrameMeta) -> OBB:
    """Map a normalized/world OBB back into pixel-space coordinates.

    Exact inverse of :func:`transform_obb`; composing the two in either order
    recovers the original OBB up to floating-point rounding (property P24).
    """

    _validate_obb(obb)
    cx, cy, w, h, angle = obb
    return [
        (cx - frame.origin_x) / frame.scale_x,
        (cy - frame.origin_y) / frame.scale_y,
        w / frame.scale_x,
        h / frame.scale_y,
        angle,
    ]


# --------------------------------------------------------------------------- #
# OBB geometry helpers (IoU via shapely)
# --------------------------------------------------------------------------- #


def _obb_polygon(obb: OBB) -> Polygon:
    """Build the rotated-rectangle polygon for an OBB ``[cx, cy, w, h, angle]``."""

    cx, cy, w, h, angle = obb
    half_w, half_h = w / 2.0, h / 2.0
    rect = Polygon(
        [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)]
    )
    rect = rotate(rect, angle, origin=(0.0, 0.0), use_radians=True)
    return translate(rect, xoff=cx, yoff=cy)


def obb_iou(a: OBB, b: OBB) -> float:
    """Intersection-over-union of two OBBs in ``[0, 1]`` (0 when degenerate)."""

    _validate_obb(a)
    _validate_obb(b)
    poly_a = _obb_polygon(a)
    poly_b = _obb_polygon(b)
    if not poly_a.is_valid or not poly_b.is_valid:
        return 0.0
    intersection = poly_a.intersection(poly_b).area
    if intersection <= 0.0:
        return 0.0
    union = poly_a.area + poly_b.area - intersection
    if union <= 0.0:
        return 0.0
    return intersection / union


# --------------------------------------------------------------------------- #
# Track stitching (Algorithm 3 / Requirements 11.3-11.6)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Detection:
    """A single detection presented to the stitcher.

    Pure value object decoupled from the ORM ``Detection`` row. ``track_id`` is
    ``None`` on input and populated in the returned copy by :func:`stitch_tracks`.
    """

    id: str
    cls: str
    confidence: float
    obb: OBB
    frame_ts: float
    track_id: str | None = None


@dataclass(frozen=True)
class Track:
    """An active object track with a constant-velocity motion estimate.

    ``obb`` is the track's last observed oriented bounding box; ``velocity`` is
    the per-axis centre velocity (world/pixel units per unit ``dt``) used to
    predict the next position. ``cls`` is fixed for the life of the track,
    underpinning the class-consistency invariant.
    """

    track_id: str
    cls: str
    obb: OBB
    last_seen_ts: float
    velocity: tuple[float, float] = (0.0, 0.0)

    def predict(self, dt: float) -> OBB:
        """Return this track's predicted OBB after advancing ``dt`` in time."""

        vx, vy = self.velocity
        cx, cy, w, h, angle = self.obb
        return [cx + vx * dt, cy + vy * dt, w, h, angle]


@dataclass(frozen=True)
class StitchResult:
    """Outcome of a stitch pass over one frame's detections.

    ``detections`` mirrors the input order with every entry assigned a
    ``track_id`` (property P22). ``active_tracks`` is the post-update active set
    with stale tracks already retired (property P26).
    """

    detections: list[Detection]
    active_tracks: list[Track]


def _new_track_id(detection: Detection) -> str:
    """Deterministically derive a fresh track id from a detection id."""

    return f"track-{detection.id}"


def stitch_tracks(
    detections: list[Detection],
    active_tracks: list[Track],
    dt: float,
    *,
    now: float | None = None,
    max_age: float | None = None,
    iou_gate: float | None = None,
) -> StitchResult:
    """Associate one frame's detections with active tracks (Algorithm 3).

    Implements the design's ByteTrack-style association:

    1. **Predict** every active track forward by ``dt`` under a constant-velocity
       model.
    2. **Associate** greedily, highest-confidence detection first: a detection
       matches the unmatched active track of the *same class* with the greatest
       OBB IoU, provided that IoU meets ``iou_gate``. Each track receives at most
       one detection from this frame (the loop invariant). An unmatched
       detection spawns a brand-new track.
    3. **Retire** any track unseen for longer than ``max_age`` so it is excluded
       from the returned active set.

    ``max_age`` and ``iou_gate`` default to the service configuration
    (``TRACK_MAX_AGE`` / ``IOU_GATE``). ``now`` defaults to the frame's
    timestamp (all detections share one ``frame_ts``); when there are no
    detections it falls back to the newest ``last_seen_ts`` among the tracks.

    Inputs are never mutated: the returned detections and tracks are fresh
    objects, leaving the function pure and deterministic. Each detection's
    ``confidence`` and ``cls`` are carried through unchanged (property P25).
    """

    settings = get_settings()
    if max_age is None:
        max_age = settings.track_max_age
    if iou_gate is None:
        iou_gate = settings.iou_gate

    if now is None:
        if detections:
            now = max(d.frame_ts for d in detections)
        elif active_tracks:
            now = max(t.last_seen_ts for t in active_tracks)
        else:
            now = 0.0

    # Working copies so inputs remain untouched. ``predicted`` is computed once
    # per track up front (step 1).
    tracks: list[Track] = list(active_tracks)
    predicted: dict[str, OBB] = {t.track_id: t.predict(dt) for t in tracks}
    matched_ids: set[str] = set()
    assigned: dict[str, Track] = {t.track_id: t for t in tracks}

    # Greedy, high-confidence-first ordering. Ties broken by detection id for
    # deterministic behaviour.
    order = sorted(detections, key=lambda d: (-d.confidence, d.id))

    assignment: dict[str, str] = {}  # detection id -> track id
    for det in order:
        _validate_obb(det.obb)
        best_track_id: str | None = None
        best_iou = iou_gate
        for track in tracks:
            if track.track_id in matched_ids:
                continue
            if track.cls != det.cls:  # same-class gate (P23)
                continue
            iou = obb_iou(det.obb, predicted[track.track_id])
            if iou >= best_iou and iou > 0.0:
                # Strict-greater keeps the first (highest-confidence) winner on
                # ties via the >= seed only triggering on a genuine improvement.
                if best_track_id is None or iou > best_iou:
                    best_iou = iou
                    best_track_id = track.track_id

        if best_track_id is not None:
            matched_ids.add(best_track_id)
            assignment[det.id] = best_track_id
            existing = assigned[best_track_id]
            # Update last observed OBB, last-seen time, and velocity estimate.
            old_cx, old_cy = existing.obb[_CX], existing.obb[_CY]
            new_cx, new_cy = det.obb[_CX], det.obb[_CY]
            if dt > 0.0:
                velocity = ((new_cx - old_cx) / dt, (new_cy - old_cy) / dt)
            else:
                velocity = existing.velocity
            assigned[best_track_id] = replace(
                existing,
                obb=list(det.obb),
                last_seen_ts=det.frame_ts,
                velocity=velocity,
            )
        else:
            new_id = _new_track_id(det)
            assignment[det.id] = new_id
            assigned[new_id] = Track(
                track_id=new_id,
                cls=det.cls,
                obb=list(det.obb),
                last_seen_ts=det.frame_ts,
                velocity=(0.0, 0.0),
            )

    # Step 3: retire stale tracks (unseen strictly longer than max_age) - P26.
    active_out = [
        track for track in assigned.values() if (now - track.last_seen_ts) <= max_age
    ]

    # Detections returned in original order, each with its assigned track id - P22/P25.
    detections_out = [replace(det, track_id=assignment[det.id]) for det in detections]

    return StitchResult(detections=detections_out, active_tracks=active_out)


# Re-exported for convenience / discoverability.
__all__ = [
    "FrameMeta",
    "Detection",
    "Track",
    "StitchResult",
    "transform_obb",
    "inverse_transform_obb",
    "obb_iou",
    "stitch_tracks",
]
