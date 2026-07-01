import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Initial Fleet Registry schema (Requirement 28). Authored with the TypeORM
 * schema-builder API rather than raw SQL DDL (Requirement 28.3).
 */
export class InitFleetRegistry1700000000000 implements MigrationInterface {
  name = 'InitFleetRegistry1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'drones',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'serialNumber', type: 'varchar', length: '255', isNullable: false },
          { name: 'model', type: 'varchar', length: '255', isNullable: false },
          { name: 'firmwareVersion', type: 'varchar', length: '255', isNullable: false },
          { name: 'hardwareConfig', type: 'jsonb', isNullable: false, default: "'{}'" },
          { name: 'status', type: 'varchar', length: '32', isNullable: false, default: "'active'" },
          { name: 'version', type: 'int', isNullable: false, default: 1 },
          { name: 'createdAt', type: 'timestamptz', isNullable: false, default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', isNullable: false, default: 'now()' },
        ],
        indices: [
          {
            name: 'uq_drones_serial_number',
            columnNames: ['serialNumber'],
            isUnique: true,
          },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'component_lifecycle',
        columns: [
          { name: 'droneId', type: 'uuid', isPrimary: true },
          { name: 'batteryCycles', type: 'int', isNullable: false, default: 0 },
          { name: 'motorHours', type: 'double precision', isNullable: false, default: 0 },
          { name: 'propellerReplacements', type: 'int', isNullable: false, default: 0 },
          { name: 'thresholds', type: 'jsonb', isNullable: false },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('component_lifecycle', true);
    await queryRunner.dropTable('drones', true);
  }
}
