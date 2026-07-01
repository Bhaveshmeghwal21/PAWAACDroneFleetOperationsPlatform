'use client';

/**
 * Live alert feed with acknowledge workflow (Requirement 24).
 *
 * Behaviour:
 *   - Seeds the feed with current alerts from the Gateway, then stays live over
 *     the alert WebSocket: `alert:new` inserts a pushed alert (Requirement 24.1)
 *     and `alert:ack` reflects an acknowledgement (Requirement 24.4).
 *   - A responder can acknowledge an actionable alert; the acknowledgement is
 *     sent through the Gateway to the Alert Service (Requirement 24.3). The row
 *     shows optimistic "acknowledging…" feedback and rolls back on failure.
 *   - Each row renders inside a display guard that, if rendering throws, retries
 *     a bounded number of times and then logs the failure for manual
 *     intervention (Requirement 24.2).
 *
 * All feed-state transitions are delegated to the pure reducers in
 * `lib/alert-feed-state` (unit-tested in isolation); this component is the thin
 * React adapter that wires socket/HTTP data into those reducers.
 */
import { Component, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { AlertSeverity, AlertStatus, Uuid } from '@pawaac/shared-types';

import { apiClient, type GatewayApiClient } from '@/lib/api-client';
import { createAlertSocket, type AlertSocket, type SocketAuthOptions } from '@/lib/ws-client';
import {
  applyAck,
  applyNewAlert,
  beginAcknowledge,
  emptyAlertFeedState,
  failAcknowledge,
  isActionable,
  nextDisplayAction,
  seedAlerts,
  toAlertList,
  type AlertFeedItem,
  type AlertFeedState,
} from '@/lib/alert-feed-state';

/** Minimal slice of the Gateway client the feed depends on (eases testing). */
type AlertFeedClient = Pick<GatewayApiClient, 'listAlerts' | 'acknowledgeAlert'>;

export interface AlertFeedProps {
  /** Gateway client; defaults to the shared configured instance. */
  client?: AlertFeedClient;
  /** Alert socket factory; defaults to `createAlertSocket`. */
  createSocket?: (options?: SocketAuthOptions) => AlertSocket;
  /** JWT forwarded to the Gateway/socket for authenticated streams. */
  token?: string;
  /** Identity of the acknowledging responder, attached to the acknowledgement. */
  acknowledgedBy?: Uuid;
}

/** Tailwind colour classes per severity, for the row accent. */
const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  info: 'border-l-sky-500',
  warning: 'border-l-amber-500',
  critical: 'border-l-red-500',
};

/** Human-friendly status badge styling. */
const STATUS_STYLES: Record<AlertStatus, string> = {
  OPEN: 'bg-red-500/15 text-red-300',
  ESCALATED: 'bg-amber-500/15 text-amber-300',
  ACKNOWLEDGED: 'bg-emerald-500/15 text-emerald-300',
  CLOSED: 'bg-slate-500/15 text-slate-300',
};

/**
 * Subscribe to the live alert-feed state: seed from the Gateway, then apply
 * `alert:new` / `alert:ack` pushes through the pure reducers. Also exposes the
 * acknowledge action and the optimistic begin/fail transitions.
 */
function useAlertFeed(
  client: AlertFeedClient,
  makeSocket: () => AlertSocket,
  token: string | undefined,
  acknowledgedBy: Uuid | undefined,
): {
  state: AlertFeedState;
  acknowledge: (id: Uuid) => void;
} {
  const [state, setState] = useState<AlertFeedState>(emptyAlertFeedState);

  // Seed the initial feed from the Alert Service (via the Gateway).
  useEffect(() => {
    let cancelled = false;
    client
      .listAlerts(token)
      .then((alerts) => {
        if (!cancelled) {
          // Merge the seed under any alerts the socket already delivered.
          setState((prev) => ({ ...seedAlerts(alerts), ...prev }));
        }
      })
      .catch(() => {
        // A failed seed is non-fatal: pushed alerts still populate the feed.
      });
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  // Keep the feed live over the alert socket.
  useEffect(() => {
    const socket = makeSocket();

    socket.on('alert:new', (alert) => {
      setState((prev) => applyNewAlert(prev, alert));
    });
    socket.on('alert:ack', (alert) => {
      setState((prev) => applyAck(prev, alert));
    });

    socket.connect();
    return () => {
      socket.off('alert:new');
      socket.off('alert:ack');
      socket.disconnect();
    };
  }, [makeSocket]);

  const acknowledge = useCallback(
    (id: Uuid) => {
      // Optimistically mark the row as acknowledging.
      setState((prev) => beginAcknowledge(prev, id));
      client
        .acknowledgeAlert(id, acknowledgedBy, token)
        .then((alert) => {
          // Reflect the authoritative acknowledged alert (Requirement 24.4).
          setState((prev) => applyAck(prev, alert));
        })
        .catch((error: unknown) => {
          // Roll back optimistic state so the responder can retry.
          setState((prev) => failAcknowledge(prev, id));
          console.error(`Failed to acknowledge alert ${id}`, error);
        });
    },
    [client, token, acknowledgedBy],
  );

  return { state, acknowledge };
}

/**
 * Per-row display guard (Requirement 24.2): if rendering a row throws, retry a
 * bounded number of times, then log the failure and show fallback content for
 * manual intervention. React error boundaries must be class components.
 */
class AlertDisplayGuard extends Component<
  { alertId: Uuid; maxRetries?: number; children: ReactNode },
  { failedAttempts: number }
> {
  override state = { failedAttempts: 0 };

  override componentDidCatch(error: Error): void {
    const action = nextDisplayAction(this.state.failedAttempts, this.props.maxRetries);
    if (action === 'retry') {
      // Retry the display by re-rendering the children once more.
      this.setState((prev) => ({ failedAttempts: prev.failedAttempts + 1 }));
    } else {
      // Log the failure for manual intervention.
      console.error(`Failed to display alert ${this.props.alertId}`, error);
      this.setState((prev) => ({ failedAttempts: prev.failedAttempts + 1 }));
    }
  }

  override render(): ReactNode {
    const action = nextDisplayAction(this.state.failedAttempts, this.props.maxRetries);
    if (this.state.failedAttempts > 0 && action === 'log') {
      return (
        <li
          className="rounded-md border border-dashed border-red-700 bg-slate-900 p-3 text-xs text-red-300"
          data-testid="alert-display-error"
        >
          Unable to display alert {this.props.alertId}. Logged for manual intervention.
        </li>
      );
    }
    return this.props.children;
  }
}

function formatTimestamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function AlertRow({
  item,
  onAcknowledge,
}: {
  item: AlertFeedItem;
  onAcknowledge: (id: Uuid) => void;
}) {
  const { alert, acknowledging } = item;
  const actionable = isActionable(item);

  return (
    <li
      className={`flex items-center justify-between gap-4 rounded-md border border-slate-800 border-l-4 bg-slate-900 p-3 ${SEVERITY_STYLES[alert.severity]}`}
      data-testid="alert-row"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLES[alert.status]}`}
          >
            {alert.status}
          </span>
          <span className="text-xs uppercase text-slate-500">{alert.severity}</span>
          {alert.escalationLevel > 0 ? (
            <span className="text-[10px] text-amber-400">esc L{alert.escalationLevel}</span>
          ) : null}
        </div>
        <div className="truncate text-sm text-slate-200">Alert {alert.id}</div>
        <div className="text-xs text-slate-500">{formatTimestamp(alert.createdAt)}</div>
      </div>
      <div className="shrink-0">
        {actionable ? (
          <button
            type="button"
            onClick={() => onAcknowledge(alert.id)}
            disabled={acknowledging}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="alert-ack-button"
          >
            {acknowledging ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        ) : (
          <span className="text-xs text-slate-500">
            {alert.status === 'ACKNOWLEDGED' ? 'Acknowledged' : '—'}
          </span>
        )}
      </div>
    </li>
  );
}

/** The live alert feed surface. */
export function AlertFeed({
  client = apiClient,
  createSocket = createAlertSocket,
  token,
  acknowledgedBy,
}: AlertFeedProps = {}) {
  const makeSocket = useMemo(
    () => () => createSocket(token ? { token } : {}),
    [createSocket, token],
  );

  const { state, acknowledge } = useAlertFeed(client, makeSocket, token, acknowledgedBy);
  const items = useMemo(() => toAlertList(state), [state]);
  const openCount = items.filter((i) => isActionable(i)).length;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Alert Feed</h2>
        <span className="text-xs text-slate-400" data-testid="alert-open-count">
          {openCount} open / {items.length} total
        </span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-md border border-slate-800 bg-slate-900 p-4 text-sm text-slate-500">
          No alerts. Live alerts will appear here as they are raised.
        </p>
      ) : (
        <ul className="space-y-2 overflow-y-auto pr-1" data-testid="alert-feed-list">
          {items.map((item) => (
            <AlertDisplayGuard key={item.alert.id} alertId={item.alert.id}>
              <AlertRow item={item} onAcknowledge={acknowledge} />
            </AlertDisplayGuard>
          ))}
        </ul>
      )}
    </div>
  );
}

export default AlertFeed;
