/**
 * WebSocket clients for live dashboard data, layered over socket.io-client.
 *
 * The Gateway proxies real-time streams from the backend services; the
 * dashboard subscribes to namespaced channels for telemetry and alerts. Event
 * payloads are typed against `@pawaac/shared-types`.
 *
 * During bootstrap (task 15.1) these factories establish typed, lazily-
 * connected sockets. The components that consume them — fleet map, telemetry
 * panels, alert feed — are wired up in tasks 15.2, 15.4, and 15.5.
 */
import { io, type Socket } from 'socket.io-client';
import type { Alert, DroneStatus, TelemetrySample, Uuid } from '@pawaac/shared-types';

import { clientConfig } from './config';

/** A drone status-change event pushed over the telemetry namespace. */
export interface DroneStatusEvent {
  droneId: Uuid;
  status: DroneStatus;
}

/** Events the telemetry namespace pushes to the dashboard (Requirements 21, 23). */
export type TelemetryServerToClientEvents = {
  'telemetry:sample': (sample: TelemetrySample) => void;
  'drone:status': (event: DroneStatusEvent) => void;
};

/** Events the alert namespace pushes to the dashboard (Requirement 24). */
export type AlertServerToClientEvents = {
  'alert:new': (alert: Alert) => void;
  'alert:ack': (alert: Alert) => void;
};

/** Messages the client emits to the alert namespace. */
export type AlertClientToServerEvents = {
  'alert:acknowledge': (payload: { id: Uuid; acknowledgedBy?: Uuid }) => void;
};

export type TelemetrySocket = Socket<TelemetryServerToClientEvents>;
export type AlertSocket = Socket<AlertServerToClientEvents, AlertClientToServerEvents>;

/** Authentication options for opening an authenticated socket. */
export interface SocketAuthOptions {
  /** JWT issued by the Gateway, forwarded in the socket handshake auth. */
  token?: string;
}

function createSocket<
  ServerEvents extends Record<string, (...args: never[]) => void>,
  ClientEvents extends Record<string, (...args: never[]) => void> = Record<string, never>,
>(namespace: string, options: SocketAuthOptions = {}): Socket<ServerEvents, ClientEvents> {
  const url = `${clientConfig.wsUrl.replace(/\/$/, '')}${namespace}`;
  const socket = io(url, {
    autoConnect: false,
    transports: ['websocket'],
    auth: options.token ? { token: options.token } : {},
  });
  // `io` returns a default-typed Socket; narrow it to the namespace's typed
  // event contract for type-safe `.on(...)`/`.emit(...)` at call sites.
  return socket as unknown as Socket<ServerEvents, ClientEvents>;
}

/** Open a (not-yet-connected) socket on the live telemetry namespace. */
export function createTelemetrySocket(options: SocketAuthOptions = {}): TelemetrySocket {
  return createSocket<TelemetryServerToClientEvents>('/telemetry', options);
}

/** Open a (not-yet-connected) socket on the alert namespace. */
export function createAlertSocket(options: SocketAuthOptions = {}): AlertSocket {
  return createSocket<AlertServerToClientEvents, AlertClientToServerEvents>('/alerts', options);
}
