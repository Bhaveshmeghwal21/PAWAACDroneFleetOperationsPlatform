import fc from 'fast-check';
import type { DroneStatus } from '@pawaac/shared-types';
import { STATUS_CHANGED_EVENT } from '../src/events/event-transport';
import { buildHarness } from './helpers';

const STATUSES: readonly DroneStatus[] = ['active', 'maintenance', 'decommissioned'];
const RUNS = { numRuns: 100 } as const;

describe('Status-change event fidelity (property-based)', () => {
  it('P5 — a status-change event is emitted iff the persisted status actually changed (Validates: Requirements 3.2, 3.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...STATUSES),
        fc.constantFrom(...STATUSES),
        async (previous, next) => {
          const { service, transport } = buildHarness();
          const created = await service.createDrone({
            serialNumber: 'SN-P5',
            model: 'm',
            firmwareVersion: '1',
            status: previous,
          });

          await service.updateDrone(created.id, { status: next });

          const emitted = transport.count(STATUS_CHANGED_EVENT);
          expect(emitted === 1).toBe(next !== previous);
        },
      ),
      RUNS,
    );
  });
});
