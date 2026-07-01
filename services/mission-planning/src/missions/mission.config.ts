/**
 * Runtime configuration for mission authoring. The maximum altitude ceiling is
 * deployment-configurable (Requirement 4.4) and feeds waypoint validation
 * (property P10).
 */
export interface MissionConfig {
  /** The configured maximum allowed waypoint altitude in meters. */
  maxAltitude: number;
}

/** DI token for the {@link MissionConfig} value. */
export const MISSION_CONFIG = Symbol('MISSION_CONFIG');

/** Fallback ceiling used when `MAX_ALTITUDE` is unset or invalid (meters). */
export const DEFAULT_MAX_ALTITUDE = 500;

/**
 * Builds the {@link MissionConfig} from the environment. `MAX_ALTITUDE` must be
 * a finite, positive number; otherwise the {@link DEFAULT_MAX_ALTITUDE} is
 * used.
 */
export function loadMissionConfig(): MissionConfig {
  const raw = Number(process.env['MAX_ALTITUDE']);
  const maxAltitude = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ALTITUDE;
  return { maxAltitude };
}
