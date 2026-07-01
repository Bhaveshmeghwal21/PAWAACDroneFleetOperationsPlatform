import type { Waypoint } from '@pawaac/shared-types';
import { InMemoryMissionStore } from '../src/missions/in-memory-mission-store';
import type { MissionConfig } from '../src/missions/mission.config';
import { MissionPlanningService } from '../src/missions/mission-planning.service';

/** Default altitude ceiling used by the test harness (meters). */
export const TEST_MAX_ALTITUDE = 500;

export interface Harness {
  store: InMemoryMissionStore;
  service: MissionPlanningService;
  config: MissionConfig;
}

/** Builds a mission service over the in-memory store for unit tests. */
export function buildHarness(maxAltitude: number = TEST_MAX_ALTITUDE): Harness {
  const store = new InMemoryMissionStore();
  const config: MissionConfig = { maxAltitude };
  const service = new MissionPlanningService(store, config);
  return { store, service, config };
}

/** A single valid waypoint with overridable fields, for terse fixtures. */
export function validWaypoint(overrides: Partial<Waypoint> = {}): Waypoint {
  return {
    seq: 0,
    lat: 12.34,
    lon: 56.78,
    altitude: 100,
    speed: 5,
    gimbalAngle: -30,
    loiterTime: 0,
    ...overrides,
  };
}

/** Builds `count` contiguous valid waypoints with seq 0..count-1. */
export function validRoute(count: number): Waypoint[] {
  return Array.from({ length: count }, (_, seq) => validWaypoint({ seq, lat: seq, lon: seq }));
}


import { InMemoryGeofenceStore } from '../src/geofences/in-memory-geofence-store';
import { GeofenceService } from '../src/geofences/geofence.service';

export interface GeofenceHarness {
  store: InMemoryGeofenceStore;
  service: GeofenceService;
  missions: MissionPlanningService;
}

/**
 * Builds a {@link GeofenceService} over in-memory stores for unit tests, wiring
 * a real {@link MissionPlanningService} so conflict detection can resolve a
 * mission's waypoints without a database.
 */
export function buildGeofenceHarness(maxAltitude: number = TEST_MAX_ALTITUDE): GeofenceHarness {
  const missions = buildHarness(maxAltitude).service;
  const store = new InMemoryGeofenceStore();
  const service = new GeofenceService(store, missions);
  return { store, service, missions };
}

/**
 * A closed unit square no-fly ring `[lon, lat]` centred near the origin, offset
 * and scaled as requested. Returns the ring closed (first point repeated).
 */
export function squareRing(
  originLon = 0,
  originLat = 0,
  size = 10,
): Array<[number, number]> {
  return [
    [originLon, originLat],
    [originLon + size, originLat],
    [originLon + size, originLat + size],
    [originLon, originLat + size],
    [originLon, originLat],
  ];
}



import type { MissionTemplate } from '../src/templates/template';
import { InMemoryTemplateStore } from '../src/templates/in-memory-template-store';
import { TemplatesService } from '../src/templates/templates.service';

export interface TemplateHarness {
  store: InMemoryTemplateStore;
  service: TemplatesService;
  missions: MissionPlanningService;
}

/**
 * Builds a {@link TemplatesService} over an in-memory template registry, wiring
 * a real {@link MissionPlanningService} (in-memory mission store) so an
 * instantiated template is validated and persisted exactly as in production.
 * Pass `templates` to register a bespoke catalogue for a test.
 */
export function buildTemplateHarness(
  templates?: readonly MissionTemplate[],
  maxAltitude: number = TEST_MAX_ALTITUDE,
): TemplateHarness {
  const missions = buildHarness(maxAltitude).service;
  const store = templates ? new InMemoryTemplateStore(templates) : new InMemoryTemplateStore();
  const service = new TemplatesService(store, missions);
  return { store, service, missions };
}

/**
 * A minimal single-waypoint template parameterized by `site`, `lat` and `lon`.
 * Other waypoint fields are literals so tests can focus on substitution.
 */
export function sampleTemplate(overrides: Partial<MissionTemplate> = {}): MissionTemplate {
  return {
    id: 'sample',
    name: 'Sample',
    description: 'A sample one-waypoint template.',
    requiredParams: ['site', 'lat', 'lon'],
    body: {
      name: 'Sweep of ${site}',
      status: 'draft',
      waypoints: [
        {
          seq: 0,
          lat: '${lat}',
          lon: '${lon}',
          altitude: 100,
          speed: 5,
          gimbalAngle: -30,
          loiterTime: 0,
        },
      ],
    },
    ...overrides,
  };
}



import type { Mission } from '@pawaac/shared-types';
import { MavlinkExportService } from '../src/export/mavlink-export.service';

export interface ExportHarness {
  missions: MissionPlanningService;
  geofences: GeofenceService;
  geofenceStore: InMemoryGeofenceStore;
  exportService: MavlinkExportService;
}

/**
 * Builds a {@link MavlinkExportService} over in-memory stores, wiring a real
 * {@link MissionPlanningService} (so the mission being exported is loaded from
 * an actual store) and a real {@link GeofenceService} (so conflict blocking is
 * exercised without a database).
 */
export function buildExportHarness(maxAltitude: number = TEST_MAX_ALTITUDE): ExportHarness {
  const missions = buildHarness(maxAltitude).service;
  const geofenceStore = new InMemoryGeofenceStore();
  const geofences = new GeofenceService(geofenceStore, missions);
  const exportService = new MavlinkExportService(missions, geofences);
  return { missions, geofences, geofenceStore, exportService };
}

/**
 * Creates a `validated` mission with `count` contiguous valid waypoints, used by
 * the export specs (export requires a validated mission, Requirement 7.2).
 */
export async function createValidatedMission(
  missions: MissionPlanningService,
  count = 3,
): Promise<Mission> {
  return missions.createMission({
    name: 'Export Target',
    status: 'validated',
    waypoints: validRoute(count),
  });
}
