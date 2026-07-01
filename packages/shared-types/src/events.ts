/**
 * Cross-service domain events. The Alert & Notification service evaluates rules
 * against these events; producers (Telemetry, Vision AI, Fleet Registry) emit
 * the matching variant.
 */
import type { IsoTimestamp, Uuid } from './common.js';
import type { MaintenanceAlert } from './fleet.js';
import type { Anomaly } from './telemetry.js';
import type { SceneEvent } from './vision.js';

/** Discriminator for the kind of domain event. */
export type DomainEventKind = 'anomaly' | 'scene' | 'maintenance';

/** An anomaly emitted by the Telemetry Ingestion service. */
export interface AnomalyDomainEvent {
  kind: 'anomaly';
  ts: IsoTimestamp;
  droneId: Uuid;
  zoneId?: Uuid;
  payload: Anomaly;
}

/** A scene event emitted by the Vision AI Results service. */
export interface SceneDomainEvent {
  kind: 'scene';
  ts: IsoTimestamp;
  zoneId: Uuid;
  payload: SceneEvent;
}

/** A maintenance-due event emitted by the Fleet Registry service. */
export interface MaintenanceDomainEvent {
  kind: 'maintenance';
  ts: IsoTimestamp;
  droneId: Uuid;
  zoneId?: Uuid;
  payload: MaintenanceAlert;
}

/**
 * A discriminated union of all cross-service domain events. The `kind`
 * discriminant aligns with `AlertRule.eventKind`.
 */
export type DomainEvent = AnomalyDomainEvent | SceneDomainEvent | MaintenanceDomainEvent;
