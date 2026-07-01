import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Mission } from '@pawaac/shared-types';
import { MissionPlanningService } from '../missions/mission-planning.service';
import type { MissionTemplate, TemplateParams } from './template';
import { instantiateTemplate } from './template-substitution';
import { TEMPLATE_STORE, TemplateStore } from './template-store';

/**
 * Mission Planning template library service (Requirement 6).
 *
 * - {@link listTemplates} / {@link getTemplate} expose the catalogue.
 * - {@link instantiate} resolves a template's `${param}` placeholders with the
 *   supplied parameters via the pure {@link instantiateTemplate} function,
 *   rejecting a request that omits a required parameter with a `400` that names
 *   the missing parameter(s) (6.2) and guaranteeing no unresolved placeholder
 *   survives into the produced mission (6.1, 6.3 / property P14). The resolved
 *   mission is persisted through {@link MissionPlanningService.createMission},
 *   which runs the canonical waypoint validation so an instantiated mission is
 *   subject to exactly the same range/sequence rules as an authored one.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(TEMPLATE_STORE) private readonly store: TemplateStore,
    private readonly missions: MissionPlanningService,
  ) {}

  /** Returns the full template catalogue. */
  async listTemplates(): Promise<MissionTemplate[]> {
    return this.store.findAll();
  }

  /** Returns a single template by id, or 404 when unknown. */
  async getTemplate(id: string): Promise<MissionTemplate> {
    const template = await this.requireTemplate(id);
    return template;
  }

  /**
   * Instantiates a template into a new, validated, persisted mission
   * (Requirement 6). Throws `404` for an unknown template, and `400` either
   * when a required parameter is missing (naming it) or — defensively — when a
   * placeholder remains unresolved.
   */
  async instantiate(id: string, params: TemplateParams): Promise<Mission> {
    const template = await this.requireTemplate(id);
    const result = instantiateTemplate(template, params);

    if (result.missingParameters.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: result.missingParameters.map(
          (name) => `missing required parameter: ${name}`,
        ),
      });
    }

    if (result.unresolvedPlaceholders.length > 0 || !result.mission) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: result.unresolvedPlaceholders.map(
          (name) => `unresolved placeholder: ${name}`,
        ),
      });
    }

    // Reuse mission authoring so the instantiated mission is validated with the
    // canonical waypoint rules and persisted as an immutable version 1.
    return this.missions.createMission({
      name: result.mission.name,
      status: result.mission.status,
      waypoints: result.mission.waypoints,
    });
  }

  /** Loads a template or raises a 404. */
  private async requireTemplate(id: string): Promise<MissionTemplate> {
    const template = await this.store.findById(id);
    if (!template) {
      throw new NotFoundException(`Template "${id}" was not found`);
    }
    return template;
  }
}
