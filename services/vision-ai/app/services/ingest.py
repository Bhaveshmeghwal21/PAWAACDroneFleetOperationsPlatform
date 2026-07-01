"""Detection ingest service (Task 9.3).

Implements :func:`ingest_detections`, which persists a validated batch of
detections and enforces idempotent re-delivery:

- **Persistence (Requirement 11.1):** each detection is stored with its class,
  confidence, OBB coordinates, frame timestamp, and drone id. A missing
  detection ``id`` is assigned a UUID4 so callers may submit either
  client-generated or server-generated identifiers.
- **Idempotency (Requirement 11.8):** the batch's idempotency key is recorded
  in the ``ingest_batches`` ledger alongside the produced :class:`IngestResult`.
  A repeat ingest carrying a previously-seen key returns the stored result
  verbatim and persists no further detections.

Structural validation of confidence and OBB shape (Requirement 11.2) is applied
upstream by the :mod:`app.schemas` Pydantic models, so by the time a
:class:`DetectionBatch` reaches this module every detection is already valid.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.models import Detection, IngestBatch
from app.schemas import DetectionBatch, IngestResult


def ingest_detections(session: Session, batch: DetectionBatch) -> tuple[IngestResult, bool]:
    """Persist a detection batch idempotently.

    Returns a ``(result, created)`` pair where ``created`` is ``True`` when the
    batch was newly persisted and ``False`` when it was a duplicate replay
    served from the idempotency ledger.
    """

    existing = session.get(IngestBatch, batch.idempotency_key)
    if existing is not None:
        # Duplicate batch: return the prior result without creating duplicates.
        return IngestResult.model_validate(existing.result), False

    detection_ids: list[str] = []
    for det in batch.detections:
        detection_id = det.id or str(uuid.uuid4())
        session.add(
            Detection(
                id=detection_id,
                drone_id=det.drone_id,
                frame_ts=det.frame_ts,
                cls=det.cls,
                confidence=det.confidence,
                obb=det.obb,
                track_id=None,
            )
        )
        detection_ids.append(detection_id)

    result = IngestResult(
        idempotency_key=batch.idempotency_key,
        ingested=len(detection_ids),
        detection_ids=detection_ids,
    )

    session.add(
        IngestBatch(idempotency_key=batch.idempotency_key, result=result.model_dump())
    )
    session.commit()

    return result, True
