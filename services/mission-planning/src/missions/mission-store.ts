import type { Mission, MissionStatus, Waypoint } from '@pawaac/shared-types';

/**
 * The content of a single mission version (everything except identity and
 * version, which the store assigns). Used both to create the first version and
 * to append a new immutable version on edit.
 */
export interface NewMission {
  name: string;
  status: MissionStatus;
  waypoints: Waypoint[];
}

/**
 * Persistence port for versioned, immutable missions (Requirement 4). The
 * service depends only on this interface; production wires a TypeORM/Postgres
 * adapter while tests use a fully functional in-memory adapter. Both honour the
 * same contract:
 *
 * - {@link create} persists version 1 of a brand-new mission.
 * - {@link addVersion} persists a new version numbered one greater than the
 *   current highest version, leaving every prior version byte-identical (P11).
 * - prior versions are never mutated by any operation.
 */
export interface MissionStore {
  /** Persists version 1 of a new mission and returns it. */
  create(input: NewMission): Promise<Mission>;
  /**
   * Persists a new version of an existing mission, numbered `maxVersion + 1`,
   * leaving all prior versions byte-identical. Throws {@link MissionNotFoundError}
   * when no version of `id` exists.
   */
  addVersion(id: string, input: NewMission): Promise<Mission>;
  /** Returns a specific mission version, or `null` when it does not exist. */
  findVersion(id: string, version: number): Promise<Mission | null>;
  /** Returns the highest-numbered version of a mission, or `null` if unknown. */
  findLatest(id: string): Promise<Mission | null>;
}

/** DI token for the {@link MissionStore} port. */
export const MISSION_STORE = Symbol('MISSION_STORE');

/** Thrown when an operation targets a mission id that has no versions. */
export class MissionNotFoundError extends Error {
  constructor(id: string) {
    super(`Mission "${id}" was not found`);
    this.name = 'MissionNotFoundError';
  }
}

/** Thrown when a specific `(id, version)` pair does not exist. */
export class MissionVersionNotFoundError extends Error {
  constructor(id: string, version: number) {
    super(`Mission "${id}" version ${version} was not found`);
    this.name = 'MissionVersionNotFoundError';
  }
}
