"""Hypothesis property tests for the detection query API (Task 9.9).

Exhaustive, generator-driven coverage of the design's correctness property
**P29 — Query filter soundness** (Requirement 13.1): a detection query returns
**only** detections matching **all** specified criteria — time range, zone,
object class, and ``confidence >= threshold`` — and **all** of the matching
ones. Every filter is optional; an omitted filter does not constrain the
result set.

Two complementary properties are exercised, both with at least 100 generated
examples (the example-based companion suite lives in ``tests/test_query.py``):

- :func:`test_p29_query_detections_returns_exactly_matching_set` drives the
  **SQLite-backed** :func:`~app.services.query.query_detections` through the
  ``db_session`` fixture so the SQL pushdown of the scalar filters *and* the
  in-process geometric zone filter are both exercised. For each random
  population of persisted detections and each random query, the set of ids
  returned by the service must equal the set independently selected by the
  pure :func:`~app.services.query.detection_matches` predicate — proving both
  soundness (returns only matches) and completeness (returns all matches).

- :func:`test_p29_detection_matches_is_conjunction_of_active_filters` pins the
  pure predicate directly: a query's verdict on a detection must equal the
  logical AND of that detection's verdict against each active single-criterion
  query (and an empty query matches everything). This establishes that the
  combined query is exactly the conjunction of its individual filters.
"""

from __future__ import annotations

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.models import Detection
from app.services.query import DetectionQuery, detection_matches, query_detections
from app.services.scene import zone_from_coords

# >=100 examples as mandated by the task. The DB-backed test reuses a single
# function-scoped SQLite fixture across examples (cleaned per example below), so
# that health check is suppressed; the per-example deadline is dropped so an
# occasional slow shapely / SQLite round-trip never flakes.
_PBT = settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)

# A small fixed object-class vocabulary so the ``cls`` filter actually selects.
_CLASSES = ["person", "vehicle", "animal", "bike"]
_DRONES = ["drone-1", "drone-2", "drone-3"]

# Finite, well-behaved coordinate / scalar ranges. Centroids span a window that
# overlaps the candidate zones below so the zone filter is meaningfully tested.
_coord = st.floats(min_value=-50.0, max_value=50.0, allow_nan=False, allow_infinity=False)
_confidence = st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False)
_frame_ts = st.floats(min_value=0.0, max_value=10_000.0, allow_nan=False, allow_infinity=False)

# Candidate zone polygons a query may filter on (or ``None`` for no zone filter).
# Membership is resolved identically by query_detections and detection_matches
# (both via ``centroid_in_zone``), so the two paths agree on the boundary too.
_ZONE_RINGS: dict[str, list[tuple[float, float]]] = {
    "square-origin": [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)],
    "square-wide": [(-25.0, -25.0), (25.0, -25.0), (25.0, 25.0), (-25.0, 25.0)],
    "square-corner": [(-50.0, -50.0), (-40.0, -50.0), (-40.0, -40.0), (-50.0, -40.0)],
}


@st.composite
def detection_rows(draw: st.DrawFn) -> list[dict]:
    """A population of 0..8 detections as kwargs for the ORM model.

    Ids are unique within the population so result/expected id-sets compare
    cleanly. OBB width/height are fixed positive; only the centroid varies,
    since zone membership keys solely off ``(cx, cy)``.
    """

    count = draw(st.integers(min_value=0, max_value=8))
    rows: list[dict] = []
    for i in range(count):
        rows.append(
            {
                "id": f"det-{i}",
                "drone_id": draw(st.sampled_from(_DRONES)),
                "frame_ts": draw(_frame_ts),
                "cls": draw(st.sampled_from(_CLASSES)),
                "confidence": draw(_confidence),
                "obb": [draw(_coord), draw(_coord), 1.0, 1.0, 0.0],
            }
        )
    return rows


@st.composite
def detection_queries(draw: st.DrawFn) -> DetectionQuery:
    """A random query with each of the five filters independently optional."""

    zone_key = draw(st.none() | st.sampled_from(list(_ZONE_RINGS)))
    zone = zone_from_coords(zone_key, _ZONE_RINGS[zone_key]) if zone_key is not None else None
    return DetectionQuery(
        time_from=draw(st.none() | _frame_ts),
        time_to=draw(st.none() | _frame_ts),
        cls=draw(st.none() | st.sampled_from(_CLASSES)),
        min_confidence=draw(st.none() | _confidence),
        zone=zone,
    )


# --------------------------------------------------------------------------- #
# P29 — soundness + completeness against the SQLite-backed query service
# --------------------------------------------------------------------------- #


@_PBT
@given(rows=detection_rows(), q=detection_queries())
def test_p29_query_detections_returns_exactly_matching_set(
    db_session, rows: list[dict], q: DetectionQuery
) -> None:
    """P29: query_detections returns exactly the detections matching all filters.

    Persist a random population, run the SQLite-backed service, and assert the
    returned id-set equals the set independently chosen by the pure
    ``detection_matches`` predicate — i.e. only matches are returned
    (soundness) and every match is returned (completeness).

    **Validates: Requirements 13.1**
    """

    # The function-scoped SQLite db is shared across examples; reset it so each
    # example runs against an empty table.
    db_session.query(Detection).delete()
    db_session.commit()

    objs = [Detection(**row) for row in rows]
    db_session.add_all(objs)
    db_session.commit()

    result = query_detections(db_session, q)
    result_ids = {d.id for d in result}
    expected_ids = {d.id for d in objs if detection_matches(d, q)}

    assert result_ids == expected_ids

    # Soundness, stated directly: every returned detection satisfies the query.
    for d in result:
        assert detection_matches(d, q)
    # Completeness, stated directly: no persisted match was dropped.
    for d in objs:
        if detection_matches(d, q):
            assert d.id in result_ids


# --------------------------------------------------------------------------- #
# P29 — the predicate is exactly the conjunction of its active filters
# --------------------------------------------------------------------------- #


def _single_criterion_queries(q: DetectionQuery) -> list[DetectionQuery]:
    """Decompose ``q`` into one query per *active* filter (empty if none)."""

    singles: list[DetectionQuery] = []
    if q.time_from is not None:
        singles.append(DetectionQuery(time_from=q.time_from))
    if q.time_to is not None:
        singles.append(DetectionQuery(time_to=q.time_to))
    if q.cls is not None:
        singles.append(DetectionQuery(cls=q.cls))
    if q.min_confidence is not None:
        singles.append(DetectionQuery(min_confidence=q.min_confidence))
    if q.zone is not None:
        singles.append(DetectionQuery(zone=q.zone))
    return singles


@_PBT
@given(row=detection_rows().map(lambda rows: rows[0] if rows else None), q=detection_queries())
def test_p29_detection_matches_is_conjunction_of_active_filters(
    row: dict | None, q: DetectionQuery
) -> None:
    """P29: the combined query equals the AND of its single-filter verdicts.

    ``detection_matches(d, q)`` must be true iff ``d`` matches *every* active
    single-criterion sub-query (an empty query matches everything). This is an
    independent statement of "matching all specified criteria".

    **Validates: Requirements 13.1**
    """

    if row is None:
        return
    det = Detection(**row)

    expected = all(detection_matches(det, single) for single in _single_criterion_queries(q))
    assert detection_matches(det, q) is expected
