import type { MissionStatus, Waypoint } from '@pawaac/shared-types';
import type {
  MissionTemplate,
  TemplateParams,
  TemplateValue,
  TemplateWaypoint,
} from './template';

/**
 * Matches a single `${name}` placeholder. Names are restricted to word
 * characters so the scan is unambiguous and the same pattern can be reused to
 * both detect and replace placeholders. The `g` flag is required for
 * `String.prototype.replace`/`matchAll`; callers that retain the literal must
 * reset `lastIndex` or build a fresh regex (see {@link placeholderRegex}).
 */
const PLACEHOLDER_SOURCE = '\\$\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}';

/** Returns a fresh, stateful global regex for placeholder scanning. */
const placeholderRegex = (): RegExp => new RegExp(PLACEHOLDER_SOURCE, 'g');

/**
 * The resolved, concrete mission body produced by a successful instantiation:
 * the same shape the {@link MissionPlanningService} accepts for creation.
 */
export interface ResolvedMissionBody {
  name: string;
  status: MissionStatus;
  waypoints: Waypoint[];
}

/**
 * Outcome of a pure template instantiation. Exactly one of two failure modes
 * may be populated, or neither (success):
 *
 * - `missingParameters` — required parameters absent from the supplied params
 *   (Requirement 6.2). When non-empty, `mission` is `undefined`.
 * - `unresolvedPlaceholders` — placeholders still present in the output after
 *   substitution (Requirement 6.3 / property P14). Defensive: with the missing
 *   check enforced first this should always be empty on success.
 */
export interface InstantiationResult {
  mission?: ResolvedMissionBody;
  missingParameters: string[];
  unresolvedPlaceholders: string[];
}

/** Collects the distinct placeholder names referenced in a single string. */
function placeholdersIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(placeholderRegex())) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/** Collects placeholder names from a {@link TemplateValue} (numbers have none). */
function placeholdersInValue(value: TemplateValue): string[] {
  return typeof value === 'string' ? placeholdersIn(value) : [];
}

/**
 * Returns every distinct placeholder name referenced anywhere in a template
 * body (name and all waypoint fields), in first-seen order. Pure.
 */
export function collectPlaceholders(template: MissionTemplate): string[] {
  const seen = new Set<string>();
  const add = (names: string[]): void => {
    for (const name of names) {
      seen.add(name);
    }
  };

  add(placeholdersIn(template.body.name));
  for (const wp of template.body.waypoints) {
    add(placeholdersInValue(wp.seq));
    add(placeholdersInValue(wp.lat));
    add(placeholdersInValue(wp.lon));
    add(placeholdersInValue(wp.altitude));
    add(placeholdersInValue(wp.speed));
    add(placeholdersInValue(wp.gimbalAngle));
    add(placeholdersInValue(wp.loiterTime));
  }
  return [...seen];
}

/**
 * The effective set of required parameters for a template: the union of the
 * author-declared {@link MissionTemplate.requiredParams} and every placeholder
 * actually referenced in the body. Sorted for deterministic error reporting.
 */
export function requiredParameters(template: MissionTemplate): string[] {
  const required = new Set<string>([
    ...template.requiredParams,
    ...collectPlaceholders(template),
  ]);
  return [...required].sort();
}

/** Replaces every `${name}` in `text` with its supplied parameter value. */
function substituteString(text: string, params: TemplateParams): string {
  return text.replace(placeholderRegex(), (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Resolves a single template value to a number for a numeric waypoint field.
 * Literal numbers pass through untouched; placeholder strings are substituted
 * and then coerced with {@link Number}. An un-coercible result yields `NaN`,
 * which the downstream waypoint validation rejects via `Number.isFinite`.
 */
function resolveNumeric(value: TemplateValue, params: TemplateParams): number {
  if (typeof value === 'number') {
    return value;
  }
  const substituted = substituteString(value, params).trim();
  return substituted === '' ? Number.NaN : Number(substituted);
}

/** Resolves a parameterizable waypoint to a concrete numeric {@link Waypoint}. */
function resolveWaypoint(wp: TemplateWaypoint, params: TemplateParams): Waypoint {
  return {
    seq: resolveNumeric(wp.seq, params),
    lat: resolveNumeric(wp.lat, params),
    lon: resolveNumeric(wp.lon, params),
    altitude: resolveNumeric(wp.altitude, params),
    speed: resolveNumeric(wp.speed, params),
    gimbalAngle: resolveNumeric(wp.gimbalAngle, params),
    loiterTime: resolveNumeric(wp.loiterTime, params),
  };
}

/** Counts placeholders remaining in a value after substitution. */
function unresolvedInValue(value: TemplateValue, params: TemplateParams): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return placeholdersIn(substituteString(value, params));
}

/**
 * Purely instantiates a mission template with the supplied parameters
 * (Requirement 6, property P14). The function performs no I/O and never mutates
 * its inputs.
 *
 * Algorithm:
 * 1. Compute the effective required parameters (declared ∪ referenced). Any
 *    that are absent from `params` are reported in `missingParameters` and no
 *    mission is produced (Requirement 6.2).
 * 2. Otherwise substitute every placeholder in the name and waypoint fields and
 *    coerce numeric waypoint fields, producing a concrete mission body.
 * 3. Defensively re-scan the output; any residual placeholder is reported in
 *    `unresolvedPlaceholders` (Requirement 6.3) and the mission is withheld.
 */
export function instantiateTemplate(
  template: MissionTemplate,
  params: TemplateParams,
): InstantiationResult {
  const missingParameters = requiredParameters(template).filter(
    (name) => params[name] === undefined,
  );
  if (missingParameters.length > 0) {
    return { missingParameters, unresolvedPlaceholders: [] };
  }

  const body: ResolvedMissionBody = {
    name: substituteString(template.body.name, params),
    status: template.body.status ?? 'draft',
    waypoints: template.body.waypoints.map((wp) => resolveWaypoint(wp, params)),
  };

  const unresolved = new Set<string>(unresolvedInValue(template.body.name, params));
  for (const wp of template.body.waypoints) {
    for (const field of [
      wp.seq,
      wp.lat,
      wp.lon,
      wp.altitude,
      wp.speed,
      wp.gimbalAngle,
      wp.loiterTime,
    ]) {
      for (const name of unresolvedInValue(field, params)) {
        unresolved.add(name);
      }
    }
  }

  if (unresolved.size > 0) {
    return { missingParameters: [], unresolvedPlaceholders: [...unresolved].sort() };
  }

  return { mission: body, missingParameters: [], unresolvedPlaceholders: [] };
}
