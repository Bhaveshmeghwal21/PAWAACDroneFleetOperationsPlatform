import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateDroneDto } from '../src/drones/dto';

describe('CreateDroneDto validation (Requirement 1.2)', () => {
  it('rejects an empty serial number', () => {
    const dto = plainToInstance(CreateDroneDto, {
      serialNumber: '',
      model: 'm',
      firmwareVersion: '1',
    });
    const errors = validateSync(dto);
    const serialError = errors.find((e) => e.property === 'serialNumber');
    expect(serialError).toBeDefined();
  });

  it('accepts a well-formed create payload', () => {
    const dto = plainToInstance(CreateDroneDto, {
      serialNumber: 'SN-OK',
      model: 'PX4',
      firmwareVersion: '1.0.0',
      status: 'active',
    });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an unknown status value', () => {
    const dto = plainToInstance(CreateDroneDto, {
      serialNumber: 'SN-OK',
      model: 'PX4',
      firmwareVersion: '1.0.0',
      status: 'flying',
    });
    expect(validateSync(dto).some((e) => e.property === 'status')).toBe(true);
  });
});
