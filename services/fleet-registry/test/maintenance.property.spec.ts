import fc from 'fast-check';
import type { ComponentLifecycle } from '@pawaac/shared-types';
import { evaluateMaintenance } from '../src/drones/maintenance';
import { buildHarness } from './helpers';

const RUNS = { numRuns: 100 } as const;

/** Generates an arbitrary, internally-consistent lifecycle record. */
const lifecycleArb = (): fc.Arbitrary<ComponentLifecycle> =>
  fc.record({
    droneId: fc.uuid(),
    batteryCycles: fc.nat(2000),
    motorHours: fc.double({ min: 0, max: 2000, noNaN: true }),
    propellerReplacements: fc.nat(2000),
    thresholds: fc.record({
      maxBatteryCycles: fc.nat(2000),
      maxMotorHours: fc.double({ min: 0, max: 2000, noNaN: true }),
      maxPropellerLifeHours: fc.nat(2000),
    }),
  });

describe('Lifecycle and maintenance invariants (property-based)', () => {
  it('P3 — Counters non-negative: counters stay >= 0 across arbitrary usage deltas (Validates: Requirements 2.2)', async () => {
    const step = fc.record({
      batteryCyclesDelta: fc.integer({ min: -200, max: 200 }),
      motorHoursDelta: fc.double({ min: -200, max: 200, noNaN: true }),
      propellerReplacementsDelta: fc.integer({ min: -200, max: 200 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 25 }), async (steps) => {
        const { service } = buildHarness();
        const drone = await service.createDrone({
          serialNumber: 'SN-P3',
          model: 'm',
          firmwareVersion: '1',
        });
        for (const usage of steps) {
          const lifecycle = await service.recordComponentUsage(drone.id, usage);
          expect(lifecycle.batteryCycles).toBeGreaterThanOrEqual(0);
          expect(lifecycle.motorHours).toBeGreaterThanOrEqual(0);
          expect(lifecycle.propellerReplacements).toBeGreaterThanOrEqual(0);
        }
      }),
      RUNS,
    );
  });

  it('P4 — Maintenance soundness: a due/overdue alert appears iff the counter >= its threshold (Validates: Requirements 2.3)', () => {
    fc.assert(
      fc.property(
        fc.nat(2000),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.nat(2000),
        fc.nat(2000),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.nat(2000),
        (batteryCycles, motorHours, propellerReplacements, maxBattery, maxMotor, maxProp) => {
          const lifecycle: ComponentLifecycle = {
            droneId: 'drone-p4',
            batteryCycles,
            motorHours,
            propellerReplacements,
            thresholds: {
              maxBatteryCycles: maxBattery,
              maxMotorHours: maxMotor,
              maxPropellerLifeHours: maxProp,
            },
          };
          const alerts = evaluateMaintenance(lifecycle);
          const alertFor = (component: string) =>
            alerts.find((alert) => alert.component === component);

          // IFF: an alert exists exactly when the counter meets or exceeds its threshold.
          const cases: ReadonlyArray<readonly [string, number, number]> = [
            ['battery', batteryCycles, maxBattery],
            ['motor', motorHours, maxMotor],
            ['propeller', propellerReplacements, maxProp],
          ];
          for (const [component, value, threshold] of cases) {
            const alert = alertFor(component);
            expect(alert !== undefined).toBe(value >= threshold);
            if (alert) {
              // Equal => due; strictly above => overdue.
              expect(alert.status).toBe(value > threshold ? 'overdue' : 'due');
              expect(alert.currentValue).toBe(value);
              expect(alert.threshold).toBe(threshold);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it('P4 — Maintenance purity: evaluateMaintenance is deterministic and never mutates its input (Validates: Requirements 2.4)', () => {
    fc.assert(
      fc.property(lifecycleArb(), (lifecycle) => {
        const snapshot = JSON.parse(JSON.stringify(lifecycle));

        const first = evaluateMaintenance(lifecycle);
        const second = evaluateMaintenance(lifecycle);

        // Determinism: identical inputs yield identical outputs.
        expect(second).toEqual(first);

        // No side effects: the input object is left byte-for-byte unchanged.
        expect(lifecycle).toEqual(snapshot);
      }),
      RUNS,
    );
  });
});
