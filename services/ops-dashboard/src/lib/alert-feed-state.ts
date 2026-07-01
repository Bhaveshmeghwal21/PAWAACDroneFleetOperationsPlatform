/**
 * Pure state reduction for the live alert feed (Requirement 24).
 *
 * The alert feed is driven by three inputs:
 *   - an initial list of alerts fetched from the Gateway (`seedAlerts`),
 *   - WebSocket pushes of newly-raised alerts (`alert:new` → `applyNewAlert`,
 *     Requirement 24.1), and
 *   - WebSocket acknowledgement updates (`alert:ack` → `applyAck`,
 *     Requirement 24.4).
 *
 * The acknowledge *action* (sending an acknowledgement through the Gateway to
 * the Alert Service, Requirement 24.3) lives in the React component; the
 * optimistic UI bookkeeping around it — marking an item as "acknowledging"
 * while the request is in flight and rolling back on failure — is modelled here
 * as pure transitions so it can be unit-tested without a DOM or network.
 *
 * Display-failure handling (Requirement 24.2) is expressed as the pure
 * {@link nextDisplayAction} decision, which the component's per-item render
 * guard consults to decide whether to retry rendering or log the failure for
 * manual intervention.
 *
 * Every function is pure: inputs are never mutated and a new state object is
 * returned for the entries it touches, so the reducers compose cleanly with
 * React's `setState(prev => reduce(prev, event))`. When a transition is a
 * no-op, the *same* state reference is returned so React can skip a re-render.
 */
import type { Alert, AlertStatus, Uuid } from '@pawaac/shared-types';

/**
 * A single row in the alert feed: the alert itself plus transient UI state that
 * is not part of the persisted alert (whether an acknowledge request is
 * currently in flight for optimistic feedback).
 */
export interface AlertFeedItem {
  alert: Alert;
  /** True while an acknowledge request for this alert is in flight. */
  acknowledging: boolean;
}

/** The full alert-feed state: one item per alert, keyed by alert id. */
export type AlertFeedState = Record<Uuid, AlertFeedItem>;

/** Default cap on display retries before a failure is logged (Requirement 24.2). */
export const DEFAULT_MAX_DISPLAY_RETRIES = 2;

/**
 * Relative precedence of alert statuses, used to decide whether an incoming
 * alert for an already-tracked id carries *newer* information. Acknowledgement
 * and closure are terminal outcomes that must never be regressed by a
 * late/duplicate `alert:new` push; escalation supersedes the initial open
 * state.
 */
const STATUS_RANK: Record<AlertStatus, number> = {
  OPEN: 0,
  ESCALATED: 1,
  ACKNOWLEDGED: 2,
  CLOSED: 3,
};

/** An empty alert-feed state. */
export function emptyAlertFeedState(): AlertFeedState {
  return {};
}

/**
 * Build the initial feed state from the alert list returned by the Gateway.
 * If the same alert id appears more than once, the highest-ranked (most
 * advanced) status wins so the seed is deterministic regardless of input order.
 */
export function seedAlerts(alerts: readonly Alert[]): AlertFeedState {
  let state: AlertFeedState = {};
  for (const alert of alerts) {
    state = applyNewAlert(state, alert);
  }
  return state;
}

/**
 * Whether `incoming` should replace the alert currently tracked for its id.
 * An alert with a strictly more-advanced status supersedes the existing one; a
 * later escalation at the same status but higher level also supersedes it.
 * Otherwise the existing (equal or more-advanced) entry is kept.
 */
function isNewerAlert(existing: Alert, incoming: Alert): boolean {
  const existingRank = STATUS_RANK[existing.status];
  const incomingRank = STATUS_RANK[incoming.status];
  if (incomingRank !== existingRank) {
    return incomingRank > existingRank;
  }
  return incoming.escalationLevel > existing.escalationLevel;
}

/**
 * Insert a WebSocket-pushed alert into the feed, de-duplicating by id
 * (Requirement 24.1).
 *
 * - A brand-new alert id is added as a fresh, not-acknowledging item.
 * - A duplicate/stale push for a known id is ignored (the same state reference
 *   is returned) unless it carries newer information (e.g. an escalation),
 *   in which case the stored alert is refreshed while any in-flight
 *   acknowledging flag is preserved.
 */
export function applyNewAlert(state: AlertFeedState, alert: Alert): AlertFeedState {
  const existing = state[alert.id];

  if (!existing) {
    return { ...state, [alert.id]: { alert, acknowledging: false } };
  }

  if (!isNewerAlert(existing.alert, alert)) {
    return state;
  }

  return {
    ...state,
    [alert.id]: { alert, acknowledging: existing.acknowledging },
  };
}

/**
 * Apply an acknowledgement update to the feed (Requirement 24.4).
 *
 * Sets the stored alert to the acknowledged record and clears the in-flight
 * acknowledging flag. If the acknowledgement arrives for an alert the feed has
 * not seen, it is inserted so the acknowledged state is still reflected.
 */
export function applyAck(state: AlertFeedState, alert: Alert): AlertFeedState {
  const existing = state[alert.id];
  if (existing && existing.alert.status === alert.status && !existing.acknowledging) {
    return state;
  }
  return { ...state, [alert.id]: { alert, acknowledging: false } };
}

/**
 * Mark an alert as having an acknowledge request in flight (optimistic UI for
 * Requirement 24.3). Returns the same reference when the alert is unknown or is
 * already being acknowledged.
 */
export function beginAcknowledge(state: AlertFeedState, id: Uuid): AlertFeedState {
  const existing = state[id];
  if (!existing || existing.acknowledging) {
    return state;
  }
  return { ...state, [id]: { ...existing, acknowledging: true } };
}

/**
 * Roll back the acknowledging flag after an acknowledge request fails, so the
 * responder can retry. Returns the same reference when there is nothing to roll
 * back.
 */
export function failAcknowledge(state: AlertFeedState, id: Uuid): AlertFeedState {
  const existing = state[id];
  if (!existing || !existing.acknowledging) {
    return state;
  }
  return { ...state, [id]: { ...existing, acknowledging: false } };
}

/** Whether an alert is still actionable (can be acknowledged from the feed). */
export function isActionable(item: AlertFeedItem): boolean {
  return item.alert.status === 'OPEN' || item.alert.status === 'ESCALATED';
}

/**
 * Render-ready list of feed items, sorted newest-first by `createdAt` (ISO 8601
 * strings compare chronologically), tie-broken by id for a stable, deterministic
 * order across updates.
 */
export function toAlertList(state: AlertFeedState): AlertFeedItem[] {
  return Object.values(state).sort((a, b) => {
    if (a.alert.createdAt !== b.alert.createdAt) {
      return a.alert.createdAt < b.alert.createdAt ? 1 : -1;
    }
    return a.alert.id.localeCompare(b.alert.id);
  });
}

/**
 * Pure decision for the per-item display-failure guard (Requirement 24.2).
 *
 * Given how many display attempts have already failed and the retry cap,
 * returns `'retry'` while retries remain, or `'log'` once the cap is reached so
 * the failure can be recorded for manual intervention.
 */
export function nextDisplayAction(
  failedAttempts: number,
  maxRetries: number = DEFAULT_MAX_DISPLAY_RETRIES,
): 'retry' | 'log' {
  return failedAttempts < maxRetries ? 'retry' : 'log';
}
