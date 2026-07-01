import fc from 'fast-check';
import type { DroneStatus } from '@pawaac/shared-types';
import {
  DroneStatusChangedEvent,
  STATUS_CHANGED_EVENT,
} from '../src/events/event-transport';
import { ResilientEventPublisher } from '../src/events/resilient-event-publisher';
import { buildHarness, FlakyTransport, RecordingTransport } from './helpers';

const STATUSES: readonly DroneStatus[] = ['active', 'maintenance', 'decommissioned'];
const RUNS = { numRuns: 200 } as const;

/** One step in a randomised edit sequence applied to a single drone. */
type Step =
  | { kind: 'status'; status: DroneStatus }
  | { kind: 'noop'; model: string };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('status' as const), status: fc.constantFrom(...STATUSES) }),
  fc.record({ kind: fc.constant('noop' as const), model: fc.string({ minLength: 1, maxLength: 8 }) }),
);

interface ExpectedEvent {
  previousStatus: DroneStatus;
  status: DroneStatus;
}


describe('Status-change event fidelity over update sequences (property-based)', () => {
  it('P5 — emitted status-change events correspond exactly to updates where the persisted status changed (Validates: Requirements 3.2, 3.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...STATUSES),
        fc.array(stepArb, { minLength: 0, maxLength: 12 }),
        async (initialStatus, steps) => {
          const { service, transport } = buildHarness();
          const created = await service.createDrone({
            serialNumber: 'SN-P5-SEQ',
            model: 'base',
            firmwareVersion: '1.0.0',
            status: initialStatus,
          });

          // Predict the sequence of status-change events the service should emit.
          const expected: ExpectedEvent[] = [];
          let persisted: DroneStatus = initialStatus;
          for (const step of steps) {
            if (step.kind === 'status') {
              if (step.status !== persisted) {
                expected.push({ previousStatus: persisted, status: step.status });
                persisted = step.status;
              }
              await service.updateDrone(created.id, { status: step.status });
            } else {
              // A non-status update must never produce a status-change event.
              await service.updateDrone(created.id, { model: step.model });
            }
          }

          const emitted = transport.events
            .filter((e) => e.eventName === STATUS_CHANGED_EVENT)
            .map((e) => e.payload as DroneStatusChangedEvent);

          // Count fidelity: exactly one event per real transition.
          expect(emitted).toHaveLength(expected.length);
          // Sequence fidelity: each event reflects the correct prev -> new pair.
          emitted.forEach((event, i) => {
            const want = expected[i]!;
            expect(event.previousStatus).toBe(want.previousStatus);
            expect(event.status).toBe(want.status);
            expect(event.status).not.toBe(event.previousStatus);
            expect(event.droneId).toBe(created.id);
          });
          // Final persisted status must match the last emitted target (if any).
          const fresh = await service.getDrone(created.id);
          expect(fresh.status).toBe(persisted);
        },
      ),
      RUNS,
    );
  });
});


const sampleEvent: DroneStatusChangedEvent = {
  droneId: 'drone-retry',
  previousStatus: 'active',
  status: 'maintenance',
  version: 2,
  ts: new Date('2024-01-01T00:00:00.000Z').toISOString(),
};

describe('ResilientEventPublisher retry-on-failure queueing (Requirement 3.4)', () => {
  it('re-delivers a failed event on subsequent flushes until the transport succeeds', async () => {
    const transport = new FlakyTransport(2); // first two attempts fail
    const publisher = new ResilientEventPublisher(transport, { autoFlush: false });

    const delivered = await publisher.publishStatusChange(sampleEvent);
    expect(delivered).toBe(false);
    expect(publisher.pendingCount).toBe(1);

    await publisher.flush(); // attempt 2 fails, event stays queued
    expect(publisher.pendingCount).toBe(1);

    await publisher.flush(); // attempt 3 succeeds, queue drains
    expect(publisher.pendingCount).toBe(0);

    // Delivered exactly once, with the original payload intact.
    expect(transport.events).toHaveLength(1);
    const only = transport.events[0]!;
    expect(only.eventName).toBe(STATUS_CHANGED_EVENT);
    expect(only.payload).toEqual(sampleEvent);
  });

  it('preserves enqueue order when multiple failed events are re-delivered together', async () => {
    const transport = new FlakyTransport(2); // both initial deliveries fail
    const publisher = new ResilientEventPublisher(transport, { autoFlush: false });

    const first = { ...sampleEvent, droneId: 'd-1', version: 1 };
    const second = { ...sampleEvent, droneId: 'd-2', version: 1 };
    await publisher.publishStatusChange(first);
    await publisher.publishStatusChange(second);
    expect(publisher.pendingCount).toBe(2);

    await publisher.flush(); // transport healthy now; both delivered in order

    expect(publisher.pendingCount).toBe(0);
    expect(transport.events.map((e) => (e.payload as DroneStatusChangedEvent).droneId)).toEqual([
      'd-1',
      'd-2',
    ]);
  });

  it('never queues an event when the transport is healthy', async () => {
    const transport = new RecordingTransport();
    const publisher = new ResilientEventPublisher(transport, { autoFlush: false });

    const delivered = await publisher.publishStatusChange(sampleEvent);

    expect(delivered).toBe(true);
    expect(publisher.pendingCount).toBe(0);
    expect(transport.count(STATUS_CHANGED_EVENT)).toBe(1);
  });
});
