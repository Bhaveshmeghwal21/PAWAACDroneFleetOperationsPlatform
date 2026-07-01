import type { MissionTemplate } from './template';
import { TemplateStore } from './template-store';

/**
 * The built-in mission template catalogue (Requirement 6). Each template is a
 * parameterizable mission body plus its declared required parameters. Templates
 * are authored with `${param}` placeholders in the fields that vary per
 * instantiation (site name, survey coordinates, altitude, etc.).
 */
export const BUILT_IN_TEMPLATES: readonly MissionTemplate[] = [
  {
    id: 'perimeter-sweep',
    name: 'Perimeter Sweep',
    description:
      'A four-corner perimeter patrol around a site at a configurable altitude and speed.',
    requiredParams: ['site', 'lat', 'lon', 'altitude', 'speed'],
    body: {
      name: 'Perimeter Sweep of ${site}',
      status: 'draft',
      waypoints: [
        {
          seq: 0,
          lat: '${lat}',
          lon: '${lon}',
          altitude: '${altitude}',
          speed: '${speed}',
          gimbalAngle: -45,
          loiterTime: 0,
        },
        {
          seq: 1,
          lat: '${lat}',
          lon: '${lon}',
          altitude: '${altitude}',
          speed: '${speed}',
          gimbalAngle: -45,
          loiterTime: 0,
        },
      ],
    },
  },
  {
    id: 'point-inspection',
    name: 'Point Inspection',
    description:
      'A single-waypoint loiter inspection over a point of interest at a configurable altitude.',
    requiredParams: ['poi', 'lat', 'lon', 'altitude', 'loiterTime'],
    body: {
      name: 'Inspection of ${poi}',
      status: 'draft',
      waypoints: [
        {
          seq: 0,
          lat: '${lat}',
          lon: '${lon}',
          altitude: '${altitude}',
          speed: 3,
          gimbalAngle: -90,
          loiterTime: '${loiterTime}',
        },
      ],
    },
  },
];

/**
 * In-memory {@link TemplateStore} backed by the {@link BUILT_IN_TEMPLATES}
 * catalogue (or an explicit list for testing). It returns deep clones so callers
 * can never mutate the shared template definitions by reference.
 */
export class InMemoryTemplateStore implements TemplateStore {
  private readonly templates: Map<string, MissionTemplate>;

  constructor(templates: readonly MissionTemplate[] = BUILT_IN_TEMPLATES) {
    this.templates = new Map(templates.map((t) => [t.id, t]));
  }

  async findAll(): Promise<MissionTemplate[]> {
    return [...this.templates.values()].map((t) => structuredClone(t));
  }

  async findById(id: string): Promise<MissionTemplate | null> {
    const found = this.templates.get(id);
    return found ? structuredClone(found) : null;
  }
}
