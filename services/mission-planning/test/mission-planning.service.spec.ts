import { BadRequestException, NotFoundException } from '@nestjs/common';
import { buildHarness, Harness, validRoute, validWaypoint } from './helpers';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('MissionPlanningService — versioned authoring (Requirement 4)', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  describe('createMission (4.1)', () => {
    it('persists a valid mission as version 1 with the default draft status', async () => {
      const mission = await h.service.createMission({
        name: 'Perimeter Sweep',
        waypoints: validRoute(2),
      });
      expect(mission.id).toBeDefined();
      expect(mission.version).toBe(1);
      expect(mission.status).toBe('draft');
      expect(mission.waypoints).toHaveLength(2);
    });

    it('rejects an invalid waypoint with a 400 and persists nothing (4.3)', async () => {
      await expect(
        h.service.createMission({
          name: 'Bad',
          waypoints: [validWaypoint({ altitude: 0 })],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-contiguous sequence (4.2)', async () => {
      await expect(
        h.service.createMission({
          name: 'Gappy',
          waypoints: [validWaypoint({ seq: 0 }), validWaypoint({ seq: 2 })],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateMission (4.5, 4.6, 4.7)', () => {
    it('creates a new version numbered one greater on a valid edit (4.5)', async () => {
      const v1 = await h.service.createMission({ name: 'M', waypoints: validRoute(1) });
      const v2 = await h.service.updateMission(v1.id, { name: 'M (edited)' });
      expect(v2.version).toBe(v1.version + 1);
      expect(v2.name).toBe('M (edited)');
    });

    it('carries over omitted fields from the prior version', async () => {
      const v1 = await h.service.createMission({
        name: 'Keep',
        status: 'validated',
        waypoints: validRoute(2),
      });
      const v2 = await h.service.updateMission(v1.id, { name: 'Renamed' });
      expect(v2.status).toBe('validated');
      expect(v2.waypoints).toHaveLength(2);
    });

    it('leaves the prior version byte-identical after an edit (4.7 / P11)', async () => {
      const v1 = await h.service.createMission({ name: 'Immutable', waypoints: validRoute(2) });
      const snapshot = structuredClone(v1);
      await h.service.updateMission(v1.id, {
        name: 'Changed',
        waypoints: validRoute(3),
      });
      const reread = await h.service.getMissionVersion(v1.id, 1);
      expect(reread).toEqual(snapshot);
    });

    it('rejects an invalid edit and does NOT create a new version (4.6)', async () => {
      const v1 = await h.service.createMission({ name: 'Safe', waypoints: validRoute(2) });
      await expect(
        h.service.updateMission(v1.id, { waypoints: [validWaypoint({ lat: 999 })] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // No version 2 was created; the latest remains version 1.
      const latest = await h.service.getLatestMission(v1.id);
      expect(latest.version).toBe(1);
      await expect(h.service.getMissionVersion(v1.id, 2)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when editing a mission that does not exist', async () => {
      await expect(
        h.service.updateMission(UNKNOWN_ID, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMissionVersion (4.8)', () => {
    it('returns the content for a specific version', async () => {
      const v1 = await h.service.createMission({ name: 'V', waypoints: validRoute(1) });
      await h.service.updateMission(v1.id, { name: 'V2' });
      const got = await h.service.getMissionVersion(v1.id, 1);
      expect(got.version).toBe(1);
      expect(got.name).toBe('V');
    });

    it('404s for an unknown version', async () => {
      const v1 = await h.service.createMission({ name: 'V', waypoints: validRoute(1) });
      await expect(h.service.getMissionVersion(v1.id, 99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
