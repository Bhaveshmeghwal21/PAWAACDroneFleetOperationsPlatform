import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { canonicalize, parseMavlink } from '../src/export/mavlink';
import {
  buildExportHarness,
  createValidatedMission,
  ExportHarness,
  squareRing,
  validRoute,
} from './helpers';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('MavlinkExportService — guarded MAVLink export (Requirement 7)', () => {
  let h: ExportHarness;

  beforeEach(() => {
    h = buildExportHarness();
  });

  describe('successful export of a validated, conflict-free mission (7.1, 7.3)', () => {
    it('exports JSON with a home item plus one item per waypoint', async () => {
      const m = await createValidatedMission(h.missions, 3);
      const result = await h.exportService.exportMission(m.id, 'json');
      expect(result.format).toBe('json');
      // 1 home/takeoff item + 3 waypoint items.
      expect(result.items).toHaveLength(4);
      expect(result.bytes).toBeUndefined();
    });

    it('exports deterministic binary bytes that parse back to the canonical mission (7.5, 7.6)', async () => {
      const m = await createValidatedMission(h.missions, 3);
      const first = await h.exportService.exportMission(m.id, 'binary');
      const second = await h.exportService.exportMission(m.id, 'binary');

      expect(first.bytes!.equals(second.bytes!)).toBe(true);
      expect(parseMavlink(first.bytes!)).toEqual(canonicalize(m));
    });
  });

  describe('rejecting exports that violate a precondition', () => {
    it('rejects export of a non-validated (draft) mission with 422 (7.2)', async () => {
      const draft = await h.missions.createMission({
        name: 'Draft',
        status: 'draft',
        waypoints: validRoute(2),
      });
      await expect(h.exportService.exportMission(draft.id, 'binary')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('404s when the mission does not exist', async () => {
      await expect(h.exportService.exportMission(UNKNOWN_ID, 'json')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('blocks export with 409 when geofence conflict detection is non-empty (7.7)', async () => {
      // validRoute(n) lays waypoints at (lat, lon) = (i, i), inside this zone.
      await h.geofences.defineGeofence({ name: 'No-Fly', polygon: squareRing(0, 0, 10) });
      const m = await createValidatedMission(h.missions, 3);

      await expect(h.exportService.exportMission(m.id, 'binary')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('allows export once the route avoids every geofence', async () => {
      // Zone far from the route at (i, i), but within valid lon/lat range.
      await h.geofences.defineGeofence({ name: 'Far', polygon: squareRing(50, 50, 5) });
      const m = await createValidatedMission(h.missions, 3);

      const result = await h.exportService.exportMission(m.id, 'binary');
      expect(result.format).toBe('binary');
    });
  });
});
