import fc from 'fast-check';
import type { DroneStatus } from '@pawaac/shared-types';
import { buildHarness } from './helpers';

const STATUSES: readonly DroneStatus[] = ['active', 'maintenance', 'decommissioned'];
const RUNS = { numRuns: 100 } as const;

describe('Fleet Registry CRUD invariants (property-based)', () => {
  it('P1 — Status round-trip: get after update returns the requested status (Validates: Requirements 1.7)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...STATUSES), async (status) => {
        const { service } = buildHarness();
        const created = await service.createDrone({
          serialNumber: 'SN-P1',
          model: 'm',
          firmwareVersion: '1',
        });
        await service.updateDrone(created.id, { status });
        const fetched = await service.getDrone(created.id);
        expect(fetched.status).toBe(status);
      }),
      RUNS,
    );
  });

  it('P2 — Version monotonicity: each successful update strictly increases the version (Validates: Requirements 1.8)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 12 }),
        async (firmwares) => {
          const { service } = buildHarness();
          const created = await service.createDrone({
            serialNumber: 'SN-P2',
            model: 'm',
            firmwareVersion: '1',
          });
          let previousVersion = created.version;
          for (const firmwareVersion of firmwares) {
            const updated = await service.updateDrone(created.id, { firmwareVersion });
            expect(updated.version).toBeGreaterThan(previousVersion);
            previousVersion = updated.version;
          }
          expect(previousVersion).toBe(created.version + firmwares.length);
        },
      ),
      RUNS,
    );
  });

  it('P6 — Serial uniqueness: no two persisted drones share a serial number (Validates: Requirements 1.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 25 }),
        async (serials) => {
          const { service, store } = buildHarness();
          for (const serialNumber of serials) {
            try {
              await service.createDrone({ serialNumber, model: 'm', firmwareVersion: '1' });
            } catch {
              // Duplicate serials are rejected; that is the behaviour under test.
            }
          }
          const all = await store.findAll();
          const persistedSerials = new Set(all.map((drone) => drone.serialNumber));
          expect(persistedSerials.size).toBe(all.length);
          expect(all.length).toBe(new Set(serials).size);
        },
      ),
      RUNS,
    );
  });
});
