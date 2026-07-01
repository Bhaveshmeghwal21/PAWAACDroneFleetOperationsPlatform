import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Initial Mission Planning schema (Requirements 4, 28).
 *
 * Tables and columns are authored with the TypeORM schema-builder (Table) API
 * rather than raw SQL DDL (Requirement 28.3). The single exception is enabling
 * the PostGIS extension: there is no Table-API primitive for extensions, and
 * the geofence geometry column cannot be created without it, so it is enabled
 * with `CREATE EXTENSION IF NOT EXISTS postgis` as a prerequisite rather than a
 * table/column schema change.
 *
 * Missions are immutable and versioned: the `missions` table is keyed by the
 * composite `(id, version)` and `waypoints` reference that pair, so each edit
 * persists a new self-contained snapshot (Requirements 4.5, 4.7).
 */
export class InitMissionPlanning1700000001000 implements MigrationInterface {
  name = 'InitMissionPlanning1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Prerequisite for the geofence geometry column (see note above).
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS postgis');

    await queryRunner.createTable(
      new Table({
        name: 'missions',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true },
          { name: 'version', type: 'int', isPrimary: true },
          { name: 'name', type: 'varchar', length: '255', isNullable: false },
          { name: 'status', type: 'varchar', length: '32', isNullable: false, default: "'draft'" },
          { name: 'createdAt', type: 'timestamptz', isNullable: false, default: 'now()' },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'waypoints',
        columns: [
          { name: 'missionId', type: 'uuid', isPrimary: true },
          { name: 'missionVersion', type: 'int', isPrimary: true },
          { name: 'seq', type: 'int', isPrimary: true },
          { name: 'lat', type: 'double precision', isNullable: false },
          { name: 'lon', type: 'double precision', isNullable: false },
          { name: 'altitude', type: 'double precision', isNullable: false },
          { name: 'speed', type: 'double precision', isNullable: false },
          { name: 'gimbalAngle', type: 'double precision', isNullable: false },
          { name: 'loiterTime', type: 'double precision', isNullable: false },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'waypoints',
      new TableForeignKey({
        name: 'fk_waypoints_mission',
        columnNames: ['missionId', 'missionVersion'],
        referencedTableName: 'missions',
        referencedColumnNames: ['id', 'version'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'geofences',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'name', type: 'varchar', length: '255', isNullable: false },
          { name: 'kind', type: 'varchar', length: '32', isNullable: false, default: "'no_fly'" },
          {
            name: 'polygon',
            type: 'geometry',
            spatialFeatureType: 'Polygon',
            srid: 4326,
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // GiST spatial index backing PostGIS containment/intersection queries.
    await queryRunner.createIndex(
      'geofences',
      new TableIndex({
        name: 'idx_geofences_polygon',
        columnNames: ['polygon'],
        isSpatial: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('geofences', 'idx_geofences_polygon');
    await queryRunner.dropTable('geofences', true);
    await queryRunner.dropForeignKey('waypoints', 'fk_waypoints_mission');
    await queryRunner.dropTable('waypoints', true);
    await queryRunner.dropTable('missions', true);
  }
}
