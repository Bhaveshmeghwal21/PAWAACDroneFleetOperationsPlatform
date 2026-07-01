import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { AlertEntity } from './entities/alert.entity';
import { AlertRuleEntity } from './entities/alert-rule.entity';
import {
  EscalationService,
  type AlertDispatcher,
  type CreateAlertInput,
} from './escalation.service';
import type { EscalationTimerPort } from './escalation.timer';

/**
 * Orchestration unit tests for the acknowledgement/escalation engine (task
 * 11.7). The TypeORM repositories, the escalation timer (Redis sorted set) and
 * the dispatcher are all replaced with in-memory fakes, so these cover ack
 * idempotency, ack-cancels-escalation, the level cap, the monotonic reschedule
 * and transition legality without any Redis, database or network. The
 * generator-driven property tests (>=100 iterations) are task 11.8.
 */

/** In-memory stand-in for `Repository<AlertEntity>` (only the methods used). */
class FakeAlertRepo {
  readonly store = new Map<string, AlertEntity>();
  private seq = 0;

  create(data: Partial<AlertEntity>): AlertEntity {
    return { ...data } as AlertEntity;
  }

  findOne(opts: { where: { id: string } }): Promise<AlertEntity | null> {
    return Promise.resolve(this.store.get(opts.where.id) ?? null);
  }

  save(entity: AlertEntity): Promise<AlertEntity> {
    if (!entity.id) {
      this.seq += 1;
      entity.id = `alert-${this.seq}`;
    }
    this.store.set(entity.id, entity);
    return Promise.resolve(entity);
  }
}

/** In-memory stand-in for `Repository<AlertRuleEntity>`. */
class FakeRuleRepo {
  readonly store = new Map<string, AlertRuleEntity>();

  findOne(opts: { where: { id: string } }): Promise<AlertRuleEntity | null> {
    return Promise.resolve(this.store.get(opts.where.id) ?? null);
  }
}

/** In-memory escalation timer recording schedule/cancel calls. */
class FakeTimer implements EscalationTimerPort {
  readonly entries = new Map<string, number>();
  readonly scheduled: Array<{ alertId: string; dueAt: number }> = [];
  readonly cancelled: string[] = [];

  schedule(alertId: string, dueAtMs: number): Promise<void> {
    this.entries.set(alertId, dueAtMs);
    this.scheduled.push({ alertId, dueAt: dueAtMs });
    return Promise.resolve();
  }

  cancel(alertId: string): Promise<void> {
    this.entries.delete(alertId);
    this.cancelled.push(alertId);
    return Promise.resolve();
  }

  dueEntries(nowMs: number): Promise<Array<{ alertId: string; dueAt: number }>> {
    const due = [...this.entries.entries()]
      .filter(([, dueAt]) => dueAt <= nowMs)
      .map(([alertId, dueAt]) => ({ alertId, dueAt }));
    return Promise.resolve(due);
  }
}

interface Harness {
  service: EscalationService;
  alerts: FakeAlertRepo;
  rules: FakeRuleRepo;
  timer: FakeTimer;
  dispatch: jest.Mock;
}

const RULE_ID = 'rule-1';
const INTERVAL_MIN = 5;
const INTERVAL_MS = INTERVAL_MIN * 60_000;

function makeHarness(chain: string[] = ['contact-0', 'contact-1', 'contact-2']): Harness {
  const alerts = new FakeAlertRepo();
  const rules = new FakeRuleRepo();
  const timer = new FakeTimer();
  const dispatch = jest.fn().mockResolvedValue({ allDelivered: true });
  const dispatcher: AlertDispatcher = { dispatch };

  rules.store.set(RULE_ID, {
    id: RULE_ID,
    escalationChain: chain,
    escalationIntervalMin: INTERVAL_MIN,
    channels: [{ type: 'email', target: 'ops@pawaac.io' }],
    severity: 'critical',
  } as AlertRuleEntity);

  const service = new EscalationService(
    alerts as unknown as Repository<AlertEntity>,
    rules as unknown as Repository<AlertRuleEntity>,
    timer,
    dispatcher,
  );
  return { service, alerts, rules, timer, dispatch };
}

/** Seed an OPEN alert directly in the repo + arm its timer at `dueAt`. */
function seedOpenAlert(h: Harness, dueAt: number, level = 0): AlertEntity {
  const alert: AlertEntity = {
    id: 'alert-seed',
    ruleId: RULE_ID,
    severity: 'critical',
    status: 'OPEN',
    escalationLevel: level,
    createdAt: new Date(0),
    acknowledgedAt: null,
    acknowledgedBy: null,
  } as AlertEntity;
  h.alerts.store.set(alert.id, alert);
  h.timer.entries.set(alert.id, dueAt);
  return alert;
}

const CREATE_INPUT: CreateAlertInput = {
  ruleId: RULE_ID,
  severity: 'critical',
  escalationIntervalMin: INTERVAL_MIN,
};

describe('EscalationService.createAlert (Req 16.1)', () => {
  it('persists a new alert OPEN at level 0 and arms the escalation timer', async () => {
    const h = makeHarness();
    const now = new Date('2024-01-01T00:00:00.000Z');

    const alert = await h.service.createAlert(CREATE_INPUT, now);

    expect(alert.status).toBe('OPEN');
    expect(alert.escalationLevel).toBe(0);
    expect(h.alerts.store.get(alert.id)?.status).toBe('OPEN');
    // First escalation is armed exactly one interval into the future.
    expect(h.timer.entries.get(alert.id)).toBe(now.getTime() + INTERVAL_MS);
  });
});

describe('EscalationService.acknowledge (Req 16.2/16.3 / P36)', () => {
  it('moves OPEN -> ACKNOWLEDGED and cancels the escalation timer (P33)', async () => {
    const h = makeHarness();
    seedOpenAlert(h, 10_000);

    const result = await h.service.acknowledge('alert-seed', 'user-1', new Date(1_000));

    expect(result.status).toBe('ACKNOWLEDGED');
    expect(result.acknowledgedBy).toBe('user-1');
    expect(h.timer.entries.has('alert-seed')).toBe(false);
    expect(h.timer.cancelled).toContain('alert-seed');
  });

  it('acknowledges an ESCALATED (terminal) alert', async () => {
    const h = makeHarness();
    const alert = seedOpenAlert(h, 10_000);
    alert.status = 'ESCALATED';

    const result = await h.service.acknowledge('alert-seed', 'user-1');

    expect(result.status).toBe('ACKNOWLEDGED');
  });

  it('is an idempotent no-op when already acknowledged, preserving the first ack (P36)', async () => {
    const h = makeHarness();
    seedOpenAlert(h, 10_000);
    const first = await h.service.acknowledge('alert-seed', 'user-1', new Date(1_000));
    h.timer.cancelled.length = 0; // reset to observe the second call

    const second = await h.service.acknowledge('alert-seed', 'user-2', new Date(2_000));

    // Same state returned; the original actor/time are untouched.
    expect(second).toEqual(first);
    expect(second.acknowledgedBy).toBe('user-1');
    // A no-op does not re-touch the timer.
    expect(h.timer.cancelled).toHaveLength(0);
  });

  it('rejects acknowledging a CLOSED alert as an illegal transition (P38)', async () => {
    const h = makeHarness();
    const alert = seedOpenAlert(h, 10_000);
    alert.status = 'CLOSED';

    await expect(h.service.acknowledge('alert-seed', 'user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws NotFound for an unknown alert', async () => {
    const h = makeHarness();
    await expect(h.service.acknowledge('nope', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EscalationService.tickEscalations — escalation step (Req 16.5 / P35)', () => {
  it('increments the level, dispatches the next contact and reschedules further out', async () => {
    const h = makeHarness(['contact-0', 'contact-1', 'contact-2']);
    const dueAt = 100_000;
    seedOpenAlert(h, dueAt, 0);

    const actions = await h.service.tickEscalations(dueAt);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      alertId: 'alert-seed',
      fromLevel: 0,
      toLevel: 1,
      contactId: 'contact-0',
      status: 'OPEN',
      terminal: false,
      dispatched: true,
    });
    expect(h.alerts.store.get('alert-seed')?.escalationLevel).toBe(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    // Dispatched over the rule's configured channels.
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'alert-seed' }),
      [{ type: 'email', target: 'ops@pawaac.io' }],
    );
    // Rescheduled strictly later than the previous due time (monotonicity).
    const next = h.timer.entries.get('alert-seed');
    expect(next).toBe(dueAt + INTERVAL_MS);
    expect(next!).toBeGreaterThan(dueAt);
  });

  it('does not escalate an alert whose timer is not yet due', async () => {
    const h = makeHarness();
    seedOpenAlert(h, 100_000, 0);

    const actions = await h.service.tickEscalations(50_000);

    expect(actions).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.alerts.store.get('alert-seed')?.escalationLevel).toBe(0);
  });
});

describe('EscalationService.tickEscalations — level cap & terminal (Req 16.6 / P34)', () => {
  it('walks the chain one contact per tick and caps the level at chain length', async () => {
    const chain = ['c0', 'c1'];
    const h = makeHarness(chain);
    let due = 100_000;
    seedOpenAlert(h, due, 0);

    // Tick 1: level 0 -> 1, contact c0, still OPEN, rescheduled.
    let actions = await h.service.tickEscalations(due);
    expect(actions[0]).toMatchObject({ toLevel: 1, contactId: 'c0', terminal: false });

    // Tick 2: level 1 -> 2, contact c1, chain now exhausted -> terminal ESCALATED.
    due = h.timer.entries.get('alert-seed') ?? due + INTERVAL_MS;
    actions = await h.service.tickEscalations(due);
    expect(actions[0]).toMatchObject({
      toLevel: 2,
      contactId: 'c1',
      status: 'ESCALATED',
      terminal: true,
      nextDueAt: null,
    });

    const alert = h.alerts.store.get('alert-seed');
    expect(alert?.escalationLevel).toBe(chain.length);
    expect(alert?.status).toBe('ESCALATED');
    // Terminal: timer removed, never rescheduled beyond the chain.
    expect(h.timer.entries.has('alert-seed')).toBe(false);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('marks an alert with an empty escalation chain terminally ESCALATED without dispatch', async () => {
    const h = makeHarness([]);
    seedOpenAlert(h, 100_000, 0);

    const actions = await h.service.tickEscalations(100_000);

    expect(actions[0]).toMatchObject({ terminal: true, status: 'ESCALATED', dispatched: false });
    expect(h.alerts.store.get('alert-seed')?.status).toBe('ESCALATED');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.timer.entries.has('alert-seed')).toBe(false);
  });
});

describe('EscalationService.tickEscalations — never escalate ack/closed (Req 16.4 / P33)', () => {
  it('does not escalate an acknowledged alert and cancels any stale timer', async () => {
    const h = makeHarness();
    const alert = seedOpenAlert(h, 100_000, 0);
    alert.status = 'ACKNOWLEDGED';

    const actions = await h.service.tickEscalations(100_000);

    expect(actions).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.timer.entries.has('alert-seed')).toBe(false);
    expect(alert.escalationLevel).toBe(0);
  });

  it('end-to-end: an acknowledged alert is never subsequently escalated (P33)', async () => {
    const h = makeHarness();
    const now = new Date('2024-01-01T00:00:00.000Z');
    const alert = await h.service.createAlert(CREATE_INPUT, now);
    await h.service.acknowledge(alert.id, 'user-1', now);

    // Sweep far in the future, well past any escalation interval.
    const actions = await h.service.tickEscalations(now.getTime() + 100 * INTERVAL_MS);

    expect(actions).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.alerts.store.get(alert.id)?.status).toBe('ACKNOWLEDGED');
    expect(h.alerts.store.get(alert.id)?.escalationLevel).toBe(0);
  });

  it('cancels the timer for an orphaned alert id (alert no longer present)', async () => {
    const h = makeHarness();
    h.timer.entries.set('ghost', 100_000);

    const actions = await h.service.tickEscalations(100_000);

    expect(actions).toHaveLength(0);
    expect(h.timer.entries.has('ghost')).toBe(false);
  });
});
