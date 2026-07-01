import type { DroneStatus } from '@pawaac/shared-types';

/**
 * Low-level transport used to deliver real-time events to subscribers. The
 * production implementation is a WebSocket gateway; tests can substitute any
 * implementation of this single-method port.
 */
export interface EventTransport {
  emit(eventName: string, payload: unknown): Promise<void>;
}

/** DI token for the {@link EventTransport} port. */
export const EVENT_TRANSPORT = Symbol('EVENT_TRANSPORT');

/** WebSocket event name for drone status changes. */
export const STATUS_CHANGED_EVENT = 'drone.status-changed';

/** WebSocket / domain event name for maintenance-due transitions. */
export const MAINTENANCE_DUE_EVENT = 'drone.maintenance-due';

/** Payload broadcast when a drone's persisted status transitions. */
export interface DroneStatusChangedEvent {
  droneId: string;
  previousStatus: DroneStatus;
  status: DroneStatus;
  version: number;
  ts: string;
}
