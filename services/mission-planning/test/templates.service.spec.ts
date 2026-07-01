import { BadRequestException, NotFoundException } from '@nestjs/common';
import { buildTemplateHarness, sampleTemplate, TemplateHarness } from './helpers';

describe('TemplatesService — mission template library (Requirement 6)', () => {
  let h: TemplateHarness;

  beforeEach(() => {
    h = buildTemplateHarness([sampleTemplate()]);
  });

  describe('instantiate (6.1, 6.3)', () => {
    it('produces a persisted, validated mission with all placeholders resolved', async () => {
      const mission = await h.service.instantiate('sample', {
        site: 'North Gate',
        lat: 10,
        lon: 20,
      });

      expect(mission.id).toBeDefined();
      expect(mission.version).toBe(1);
      expect(mission.name).toBe('Sweep of North Gate');
      expect(mission.waypoints[0]).toMatchObject({ lat: 10, lon: 20, altitude: 100 });
      // No unresolved placeholder survives anywhere in the produced mission.
      expect(JSON.stringify(mission)).not.toMatch(/\$\{[^}]*\}/);

      // The mission was actually persisted and is retrievable.
      const reread = await h.missions.getLatestMission(mission.id);
      expect(reread.name).toBe('Sweep of North Gate');
    });

    it('rejects a missing required parameter with a 400 naming it (6.2)', async () => {
      expect.assertions(3);
      try {
        await h.service.instantiate('sample', { lat: 1, lon: 2 });
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const body = (error as BadRequestException).getResponse() as { message: string[] };
        expect(Array.isArray(body.message)).toBe(true);
        expect(body.message).toContain('missing required parameter: site');
      }
    });

    it('does not persist any mission when a required parameter is missing', async () => {
      await expect(h.service.instantiate('sample', {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // The mission store received nothing to retrieve.
      await expect(
        h.missions.getLatestMission('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s for an unknown template id', async () => {
      await expect(
        h.service.instantiate('does-not-exist', { site: 'S', lat: 1, lon: 2 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when substituted parameters yield an out-of-range waypoint (reuses validation)', async () => {
      // lat resolves to 999 which violates the canonical waypoint range rules.
      await expect(
        h.service.instantiate('sample', { site: 'S', lat: 999, lon: 2 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('catalogue access', () => {
    it('lists the built-in templates', async () => {
      const all = await buildTemplateHarness().service.listTemplates();
      expect(all.map((t) => t.id)).toEqual(
        expect.arrayContaining(['perimeter-sweep', 'point-inspection']),
      );
    });

    it('gets a template by id and 404s for unknown ids', async () => {
      const t = await h.service.getTemplate('sample');
      expect(t.id).toBe('sample');
      await expect(h.service.getTemplate('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
