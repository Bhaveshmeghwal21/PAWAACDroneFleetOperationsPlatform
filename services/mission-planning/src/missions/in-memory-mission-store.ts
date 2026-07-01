import { randomUUID } from 'node:crypto';
import type { Mission, Waypoint } from '@pawaac/shared-types';
import { MissionNotFoundError, MissionStore, NewMission } from './mission-store';

/** Returns a deep copy of the waypoints sorted by ascending `seq`. */
function normalizeWaypoints(waypoints: readonly Waypoint[]): Waypoint[] {
  return waypoints.map((wp) => ({ ...wp })).sort((a, b) => a.seq - b.seq);
}

/**
 * A fully functional in-memory implementation of {@link MissionStore}.
 *
 * It enforces the same invariants as the production adapter — monotonically
 * increasing versions and byte-identical prior versions (P11) — so it is a
 * faithful store for unit and property tests rather than a behaviour-faking
 * mock. Every record is deep-cloned on the way in and out so callers can never
 * mutate persisted state by reference, which is what guarantees earlier
 * versions remain untouched when a new one is appended.
 */
export class InMemoryMissionStore implements MissionStore {
  /** Mission id -> (version -> mission snapshot). */
  private readonly missions = new Map<string, Map<number, Mission>>();

  async create(input: NewMission): Promise<Mission> {
    const id = randomUUID();
    const mission: Mission = {
      id,
      version: 1,
      name: input.name,
      status: input.status,
      waypoints: normalizeWaypoints(input.waypoints),
      createdAt: new Date().toISOString(),
    };
    this.missions.set(id, new Map([[1, mission]]));
    return structuredClone(mission);
  }

  async addVersion(id: string, input: NewMission): Promise<Mission> {
    const versions = this.missions.get(id);
    if (!versions || versions.size === 0) {
      throw new MissionNotFoundError(id);
    }
    const nextVersion = Math.max(...versions.keys()) + 1;
    const mission: Mission = {
      id,
      version: nextVersion,
      name: input.name,
      status: input.status,
      waypoints: normalizeWaypoints(input.waypoints),
      createdAt: new Date().toISOString(),
    };
    // Insert the new version only; prior version objects are never touched.
    versions.set(nextVersion, mission);
    return structuredClone(mission);
  }

  async findVersion(id: string, version: number): Promise<Mission | null> {
    const found = this.missions.get(id)?.get(version);
    return found ? structuredClone(found) : null;
  }

  async findLatest(id: string): Promise<Mission | null> {
    const versions = this.missions.get(id);
    if (!versions || versions.size === 0) {
      return null;
    }
    const latest = versions.get(Math.max(...versions.keys()));
    return latest ? structuredClone(latest) : null;
  }
}
