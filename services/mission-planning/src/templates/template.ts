import type { MissionStatus } from '@pawaac/shared-types';

/**
 * A single field value inside a mission template. It is either a literal value
 * already fixed by the template author, or a string that may embed one or more
 * `${param}` placeholders to be resolved at instantiation time (Requirement 6).
 *
 * Numeric waypoint fields are typically authored either as a literal `number`
 * or as a single-placeholder string such as `"${altitude}"`; after substitution
 * the resolved text is coerced back to a number (an un-coercible value is left
 * for waypoint validation to reject).
 */
export type TemplateValue = string | number;

/**
 * A parameterizable waypoint. Every field mirrors the domain {@link Waypoint}
 * but may be expressed as a placeholder string so a single template can be
 * instantiated at different coordinates, altitudes, speeds, etc.
 */
export interface TemplateWaypoint {
  seq: TemplateValue;
  lat: TemplateValue;
  lon: TemplateValue;
  altitude: TemplateValue;
  speed: TemplateValue;
  gimbalAngle: TemplateValue;
  loiterTime: TemplateValue;
}

/**
 * The parameterizable body of a mission template: the parts that become a
 * concrete {@link Mission} once placeholders are resolved. Identity and version
 * are assigned by the mission store when the instantiated mission is persisted.
 */
export interface MissionTemplateBody {
  /** Display name; may interpolate placeholders (e.g. `"Sweep of ${site}"`). */
  name: string;
  /** Optional starting lifecycle status; defaults to `draft` when omitted. */
  status?: MissionStatus;
  /** Ordered, parameterizable waypoints. */
  waypoints: TemplateWaypoint[];
}

/**
 * A reusable mission template (Requirement 6). A template couples a
 * parameterizable {@link MissionTemplateBody} with the set of parameters its
 * author declares as required. The effective required set used at instantiation
 * is the union of {@link requiredParams} and every placeholder actually
 * referenced in the body, so that a fully-resolved mission can never be
 * produced with a placeholder left dangling.
 */
export interface MissionTemplate {
  /** Stable template identifier used by `POST /templates/:id/instantiate`. */
  id: string;
  /** Human-readable template name (not parameterized). */
  name: string;
  /** Short description of what the template produces. */
  description: string;
  /** Parameters the author declares mandatory for instantiation. */
  requiredParams: string[];
  /** The parameterizable mission body. */
  body: MissionTemplateBody;
}

/**
 * Parameter map supplied when instantiating a template. Values may be strings or
 * numbers; numbers are stringified during interpolation and coerced back where a
 * numeric waypoint field expects them.
 */
export type TemplateParams = Record<string, string | number>;
