import { describe, expect, it } from 'vitest';
import type { Alert } from '@pawaac/shared-types';

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
  type AlertFeedState,
} from './alert-feed-state';

const ALERT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ALERT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RULE = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr';
const USER = 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu';

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: ALERT_A,
    ruleId: RULE,
    severity: 'warning',
    status: 'OPEN',
    escalationLevel: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('seedAlerts', () => {
  it('builds one not-acknowledging item per alert', () => {
    const state = seedAlerts([
      makeAlert({ id: ALERT_A }),
      makeAlert({ id: ALERT_B, status: 'ACKNOWLEDGED' }),
    ]);

    expect(Object.keys(state)).toHaveLength(2);
    expect(state[ALERT_A]).toEqual({ alert: makeAlert({ id: ALERT_A }), acknowledging: false });
    expect(state[ALERT_B]?.alert.status).toBe('ACKNOWLEDGED');
  });

  it('keeps the most-advanced status when an id is duplicated (deterministic)', () => {
    const open = makeAlert({ id: ALERT_A, status: 'OPEN' });
    const acked = makeAlert({ id: ALERT_A, status: 'ACKNOWLEDGED' });

    expect(seedAlerts([open, acked])[ALERT_A]?.alert.status).toBe('ACKNOWLEDGED');
    // Order-independent: the advanced status wins regardless of input order.
    expect(seedAlerts([acked, open])[ALERT_A]?.alert.status).toBe('ACKNOWLEDGED');
  });

  it('returns an empty state for an empty list', () => {
    expect(seedAlerts([])).toEqual({});
  });
});

describe('applyNewAlert (Requirement 24.1)', () => {
  it('inserts a pushed alert into the feed', () => {
    const next = applyNewAlert(emptyAlertFeedState(), makeAlert());

    expect(next[ALERT_A]).toEqual({ alert: makeAlert(), acknowledging: false });
  });

  it('de-duplicates a repeated push for the same id (same reference)', () => {
    const first = applyNewAlert(emptyAlertFeedState(), makeAlert());
    const second = applyNewAlert(first, makeAlert());

    expect(second).toBe(first);
  });

  it('refreshes a known alert when the push carries an escalation', () => {
    const open = applyNewAlert(emptyAlertFeedState(), makeAlert({ status: 'OPEN' }));
    const escalated = applyNewAlert(
      open,
      makeAlert({ status: 'ESCALATED', escalationLevel: 1 }),
    );

    expect(escalated[ALERT_A]?.alert.status).toBe('ESCALATED');
    expect(escalated[ALERT_A]?.alert.escalationLevel).toBe(1);
  });

  it('does not regress an acknowledged alert via a stale new push', () => {
    const acked = applyNewAlert(emptyAlertFeedState(), makeAlert({ status: 'ACKNOWLEDGED' }));
    const stale = applyNewAlert(acked, makeAlert({ status: 'OPEN' }));

    expect(stale).toBe(acked);
    expect(stale[ALERT_A]?.alert.status).toBe('ACKNOWLEDGED');
  });

  it('does not mutate the input state (purity)', () => {
    const seeded = applyNewAlert(emptyAlertFeedState(), makeAlert());
    const snapshot = structuredClone(seeded);

    applyNewAlert(seeded, makeAlert({ id: ALERT_B }));

    expect(seeded).toEqual(snapshot);
  });
});

describe('applyAck (Requirement 24.4)', () => {
  it('updates the stored alert to the acknowledged status', () => {
    const open = applyNewAlert(emptyAlertFeedState(), makeAlert({ status: 'OPEN' }));
    const acked = applyAck(
      open,
      makeAlert({ status: 'ACKNOWLEDGED', acknowledgedBy: USER, acknowledgedAt: '2024-01-01T00:05:00.000Z' }),
    );

    expect(acked[ALERT_A]?.alert.status).toBe('ACKNOWLEDGED');
    expect(acked[ALERT_A]?.alert.acknowledgedBy).toBe(USER);
  });

  it('clears the in-flight acknowledging flag', () => {
    const open = applyNewAlert(emptyAlertFeedState(), makeAlert());
    const pending = beginAcknowledge(open, ALERT_A);
    expect(pending[ALERT_A]?.acknowledging).toBe(true);

    const acked = applyAck(pending, makeAlert({ status: 'ACKNOWLEDGED' }));
    expect(acked[ALERT_A]?.acknowledging).toBe(false);
  });

  it('inserts an acknowledged alert that the feed never saw', () => {
    const acked = applyAck(emptyAlertFeedState(), makeAlert({ status: 'ACKNOWLEDGED' }));

    expect(acked[ALERT_A]).toEqual({
      alert: makeAlert({ status: 'ACKNOWLEDGED' }),
      acknowledging: false,
    });
  });

  it('returns the same reference when nothing changes', () => {
    const acked = applyAck(emptyAlertFeedState(), makeAlert({ status: 'ACKNOWLEDGED' }));
    const again = applyAck(acked, makeAlert({ status: 'ACKNOWLEDGED' }));

    expect(again).toBe(acked);
  });
});

describe('beginAcknowledge / failAcknowledge (Requirement 24.3 optimistic UI)', () => {
  it('marks an alert as acknowledging', () => {
    const open = applyNewAlert(emptyAlertFeedState(), makeAlert());
    const pending = beginAcknowledge(open, ALERT_A);

    expect(pending[ALERT_A]?.acknowledging).toBe(true);
  });

  it('is a no-op for an unknown id', () => {
    const state = applyNewAlert(emptyAlertFeedState(), makeAlert());
    expect(beginAcknowledge(state, ALERT_B)).toBe(state);
  });

  it('rolls back the acknowledging flag on failure', () => {
    const open = applyNewAlert(emptyAlertFeedState(), makeAlert());
    const pending = beginAcknowledge(open, ALERT_A);
    const rolledBack = failAcknowledge(pending, ALERT_A);

    expect(rolledBack[ALERT_A]?.acknowledging).toBe(false);
    expect(rolledBack[ALERT_A]?.alert.status).toBe('OPEN');
  });

  it('failAcknowledge is a no-op when nothing is in flight', () => {
    const open = applyNewAlert(emptyAlertFeedState(), makeAlert());
    expect(failAcknowledge(open, ALERT_A)).toBe(open);
  });
});

describe('isActionable', () => {
  it('is true for OPEN and ESCALATED alerts', () => {
    expect(isActionable({ alert: makeAlert({ status: 'OPEN' }), acknowledging: false })).toBe(true);
    expect(isActionable({ alert: makeAlert({ status: 'ESCALATED' }), acknowledging: false })).toBe(
      true,
    );
  });

  it('is false for ACKNOWLEDGED and CLOSED alerts', () => {
    expect(
      isActionable({ alert: makeAlert({ status: 'ACKNOWLEDGED' }), acknowledging: false }),
    ).toBe(false);
    expect(isActionable({ alert: makeAlert({ status: 'CLOSED' }), acknowledging: false })).toBe(
      false,
    );
  });
});

describe('toAlertList', () => {
  it('orders items newest-first by createdAt, tie-broken by id', () => {
    const state: AlertFeedState = seedAlerts([
      makeAlert({ id: ALERT_A, createdAt: '2024-01-01T00:00:00.000Z' }),
      makeAlert({ id: ALERT_B, createdAt: '2024-01-01T00:10:00.000Z' }),
    ]);

    expect(toAlertList(state).map((i) => i.alert.id)).toEqual([ALERT_B, ALERT_A]);
  });

  it('breaks createdAt ties deterministically by id', () => {
    const sameTs = '2024-01-01T00:00:00.000Z';
    const state = seedAlerts([
      makeAlert({ id: ALERT_B, createdAt: sameTs }),
      makeAlert({ id: ALERT_A, createdAt: sameTs }),
    ]);

    expect(toAlertList(state).map((i) => i.alert.id)).toEqual([ALERT_A, ALERT_B]);
  });
});

describe('nextDisplayAction (Requirement 24.2)', () => {
  it('retries while attempts remain under the cap', () => {
    expect(nextDisplayAction(0, 2)).toBe('retry');
    expect(nextDisplayAction(1, 2)).toBe('retry');
  });

  it('logs once the retry cap is reached', () => {
    expect(nextDisplayAction(2, 2)).toBe('log');
    expect(nextDisplayAction(3, 2)).toBe('log');
  });

  it('uses the default retry cap when none is provided', () => {
    expect(nextDisplayAction(0)).toBe('retry');
    expect(nextDisplayAction(2)).toBe('log');
  });
});
