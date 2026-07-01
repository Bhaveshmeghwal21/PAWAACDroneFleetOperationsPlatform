/**
 * Deterministic seed CLI (Requirement 29).
 *
 * Usage:
 *   pnpm --filter @pawaac/seed seed             # generate + apply to all DBs
 *   pnpm --filter @pawaac/seed seed:dry-run     # generate + print summary only
 *
 * Flags:
 *   --dry-run        Generate the dataset and print a summary; perform NO writes.
 *   --only=<svc,...> Restrict writes to specific services
 *                    (fleet, mission, telemetry, vision, alert).
 *
 * The dataset is produced purely from a fixed RNG seed, then applied to each
 * service datastore via idempotent upserts, so repeated runs converge to an
 * identical dataset.
 */
import { telemetryIntervalSecondsFromEnv, type ServiceKey } from './config.js';
import { DEFAULT_TELEMETRY_INTERVAL_SECONDS, generateSeedData } from './generate.js';
import { writeAlert, writeFleet, writeMission, writeTelemetry, writeVision, type WriteCounts } from './writers.js';

interface CliOptions {
  dryRun: boolean;
  only: ServiceKey[] | null;
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let only: ServiceKey[] | null = null;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--only=')) {
      only = arg
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as ServiceKey[];
    }
  }

  return { dryRun, only };
}

const WRITERS: Array<{ service: ServiceKey; run: (d: ReturnType<typeof generateSeedData>) => Promise<WriteCounts> }> = [
  { service: 'fleet', run: writeFleet },
  { service: 'mission', run: writeMission },
  { service: 'telemetry', run: writeTelemetry },
  { service: 'vision', run: writeVision },
  { service: 'alert', run: writeAlert },
];

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const intervalSeconds = telemetryIntervalSecondsFromEnv() ?? DEFAULT_TELEMETRY_INTERVAL_SECONDS;

  const data = generateSeedData({ telemetryIntervalSeconds: intervalSeconds });

  // Summary of the generated dataset (Requirement 29.1 acceptance counts).
  console.log('Generated deterministic seed dataset:');
  console.log(`  drones:             ${data.drones.length}`);
  console.log(`  component lifecycle:${data.componentLifecycle.length}`);
  console.log(`  missions:           ${data.missions.length}`);
  console.log(`  waypoints:          ${data.waypoints.length}`);
  console.log(`  geofences:          ${data.geofences.length}`);
  console.log(`  telemetry samples:  ${data.telemetry.length} (cadence: 1 / ${intervalSeconds}s over 72h)`);
  console.log(`  tracks:             ${data.tracks.length}`);
  console.log(`  detections:         ${data.detections.length}`);
  console.log(`  scene events:       ${data.sceneEvents.length}`);
  console.log(`  alert rules:        ${data.alertRules.length}`);
  console.log(`  alert conditions:   ${data.alertConditions.length}`);
  console.log(`  alerts:             ${data.alerts.length}`);

  if (opts.dryRun) {
    console.log('\n--dry-run: no database writes performed.');
    return;
  }

  const selected = WRITERS.filter((w) => opts.only === null || opts.only.includes(w.service));

  console.log('\nApplying dataset (idempotent upserts)...');
  for (const { service, run } of selected) {
    const counts = await run(data);
    const summary = Object.entries(counts)
      .map(([table, n]) => `${table}=${n}`)
      .join(', ');
    console.log(`  [${service}] ${summary}`);
  }

  console.log('\nSeed complete.');
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
