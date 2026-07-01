import { BadRequestException, NotFoundException } from '@nestjs/common';
import { buildGeofenceHarness, GeofenceHarness, squareRing, validWaypoint } from './helpers';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('GeofenceService — definition and conflict detection (Requirement 5)', () => {
  let h: GeofenceHarness;

  beforeEach(() => {
    h = buildGeofenceHarness();
  });

  describe('defineGeofence (5.1, 5.2)', () => {
    it('persists a closed, simple polygon and assigns an id', async () => {
      const geofence = await h.service.defineGeofence({
        name: 'No-Fly A',
        polygon: squareRing(0, 0, 10),
      });
      expect(geofence.id).toBeDefined();
      expect(geofence.kind).toBe('no_fly');
      expect(geofence.polygon).toHaveLength(5);
    });

    it('rejects a non-closed polygon with a 400 (5.2)', async () => {
      await expect(
        h.service.defineGeofence({
          name: 'Open',
          polygon: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a self-intersecting polygon with a 400 (5.2)', async () => {
      await expect(
        h.service.defineGeofence({
          name: 'Bowtie',
          polygon: [
            [0, 0],
            [10, 10],
            [10, 0],
            [0, 10],
            [0, 0],
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not persist a rejected polygon', async () => {
      await expect(
        h.service.defineGeofence({ name: 'Bad', polygon: [[0, 0]] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await h.service.listGeofences()).toHaveLength(0);
    });
  });

  describe('getGeofence', () => {
    it('returns a persisted geofence by id', async () => {
      const created = await h.service.defineGeofence({
        name: 'Z',
        polygon: squareRing(0, 0, 5),
      });
      expect(await h.service.getGeofence(created.id)).toEqual(created);
    });

    it('404s for an unknown id', async () => {
      await expect(h.service.getGeofence(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('detectConflicts (5.3, 5.4, 5.5)', () => {
    beforeEach(async () => {
      await h.service.defineGeofence({ name: 'Zone', polygon: squareRing(0, 0, 10) });
    });

    it('returns an empty list when a route avoids all zones (5.3)', async () => {
      const conflicts = await h.service.detectConflicts({
        waypoints: [
          validWaypoint({ seq: 0, lon: -5, lat: -5 }),
          validWaypoint({ seq: 1, lon: -5, lat: 20 }),
        ],
      });
      expect(conflicts).toEqual([]);
    });

    it('returns a conflict for a route segment that crosses a zone (5.4)', async () => {
      const conflicts = await h.service.detectConflicts({
        waypoints: [
          validWaypoint({ seq: 0, lon: -1, lat: 5 }),
          validWaypoint({ seq: 1, lon: 11, lat: 5 }),
        ],
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.segmentIndex).toBe(0);
    });

    it('resolves the route from a mission id when waypoints are omitted', async () => {
      const mission = await h.missions.createMission({
        name: 'Crossing',
        waypoints: [
          validWaypoint({ seq: 0, lon: -1, lat: 5 }),
          validWaypoint({ seq: 1, lon: 11, lat: 5 }),
        ],
      });
      const conflicts = await h.service.detectConflicts({ missionId: mission.id });
      expect(conflicts).toHaveLength(1);
    });

    it('is deterministic across repeated identical runs (5.5)', async () => {
      const dto = {
        waypoints: [
          validWaypoint({ seq: 0, lon: -1, lat: 5 }),
          validWaypoint({ seq: 1, lon: 11, lat: 5 }),
        ],
      };
      const first = await h.service.detectConflicts(dto);
      const second = await h.service.detectConflicts(dto);
      expect(second).toEqual(first);
    });

    it('rejects a request providing neither missionId nor waypoints', async () => {
      await expect(h.service.detectConflicts({})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s when the referenced mission does not exist', async () => {
      await expect(
        h.service.detectConflicts({ missionId: UNKNOWN_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
