import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateMissionDto, UpdateMissionDto } from '../src/missions/dto';
import { validWaypoint } from './helpers';

describe('CreateMissionDto validation (Requirement 4.1/4.4)', () => {
  it('accepts a well-formed create payload', () => {
    const dto = plainToInstance(CreateMissionDto, {
      name: 'OK',
      waypoints: [validWaypoint()],
    });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an empty name', () => {
    const dto = plainToInstance(CreateMissionDto, {
      name: '',
      waypoints: [validWaypoint()],
    });
    expect(validateSync(dto).some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects an empty waypoint list', () => {
    const dto = plainToInstance(CreateMissionDto, { name: 'OK', waypoints: [] });
    expect(validateSync(dto).some((e) => e.property === 'waypoints')).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const dto = plainToInstance(CreateMissionDto, {
      name: 'OK',
      status: 'flying',
      waypoints: [validWaypoint()],
    });
    expect(validateSync(dto).some((e) => e.property === 'status')).toBe(true);
  });

  it('rejects an out-of-range waypoint latitude via nested validation', () => {
    const dto = plainToInstance(CreateMissionDto, {
      name: 'OK',
      waypoints: [validWaypoint({ lat: 200 })],
    });
    expect(validateSync(dto).some((e) => e.property === 'waypoints')).toBe(true);
  });

  it('rejects a non-positive altitude via nested validation', () => {
    const dto = plainToInstance(CreateMissionDto, {
      name: 'OK',
      waypoints: [validWaypoint({ altitude: 0 })],
    });
    expect(validateSync(dto).some((e) => e.property === 'waypoints')).toBe(true);
  });
});

describe('UpdateMissionDto validation (Requirement 4.5)', () => {
  it('accepts an empty patch (all fields optional)', () => {
    const dto = plainToInstance(UpdateMissionDto, {});
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('accepts a name-only patch', () => {
    const dto = plainToInstance(UpdateMissionDto, { name: 'Renamed' });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an out-of-range gimbal angle in a waypoint patch', () => {
    const dto = plainToInstance(UpdateMissionDto, {
      waypoints: [validWaypoint({ gimbalAngle: 120 })],
    });
    expect(validateSync(dto).some((e) => e.property === 'waypoints')).toBe(true);
  });
});
