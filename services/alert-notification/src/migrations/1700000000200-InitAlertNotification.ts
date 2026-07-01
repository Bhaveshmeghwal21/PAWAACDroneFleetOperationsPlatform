import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

/**
 * Initial Alert & Notification schema (Requirements 14.1, 28.1, 28.3).
 *
 * Authored entirely with the TypeORM schema-builder API (`Table`,
 * `TableForeignKey`) rather than raw SQL DDL, satisfying the "no raw SQL DDL"
 * constraint (Requirement 28.3). Creates the rule, condition and alert tables
 * plus their indices and foreign keys. The rule engine, dispatch and escalation
 * behaviours are implemented by later tasks (11.3+).
 */
export class InitAlertNotification1700000000200 implements MigrationInterface {
  name = 'InitAlertNotification1700000000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'alert_rules',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'name', type: 'varchar', length: '255', isNullable: false },
          { name: 'enabled', type: 'boolean', isNullable: false, default: true },
          { name: 'eventKind', type: 'varchar', length: '32', isNullable: false },
          { name: 'timeWindow', type: 'jsonb', isNullable: true },
          { name: 'zoneId', type: 'uuid', isNullable: true },
          { name: 'severity', type: 'varchar', length: '16', isNullable: false },
          { name: 'channels', type: 'jsonb', isNullable: false, default: "'[]'" },
          { name: 'escalationChain', type: 'jsonb', isNullable: false, default: "'[]'" },
          { name: 'escalationIntervalMin', type: 'int', isNullable: false },
          { name: 'createdAt', type: 'timestamptz', isNullable: false, default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', isNullable: false, default: 'now()' },
        ],
        indices: [
          { name: 'idx_alert_rules_enabled', columnNames: ['enabled'] },
          { name: 'idx_alert_rules_event_kind', columnNames: ['eventKind'] },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'alert_conditions',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'ruleId', type: 'uuid', isNullable: false },
          { name: 'position', type: 'int', isNullable: false, default: 0 },
          { name: 'field', type: 'varchar', length: '255', isNullable: false },
          { name: 'operator', type: 'varchar', length: '16', isNullable: false },
          { name: 'value', type: 'jsonb', isNullable: true },
        ],
        indices: [{ name: 'idx_alert_conditions_rule_id', columnNames: ['ruleId'] }],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'alert_conditions',
      new TableForeignKey({
        name: 'fk_alert_conditions_rule',
        columnNames: ['ruleId'],
        referencedTableName: 'alert_rules',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'alerts',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'ruleId', type: 'uuid', isNullable: false },
          { name: 'severity', type: 'varchar', length: '16', isNullable: false },
          { name: 'status', type: 'varchar', length: '16', isNullable: false, default: "'OPEN'" },
          { name: 'escalationLevel', type: 'int', isNullable: false, default: 0 },
          { name: 'createdAt', type: 'timestamptz', isNullable: false, default: 'now()' },
          { name: 'acknowledgedAt', type: 'timestamptz', isNullable: true },
          { name: 'acknowledgedBy', type: 'uuid', isNullable: true },
        ],
        indices: [
          { name: 'idx_alerts_rule_id', columnNames: ['ruleId'] },
          { name: 'idx_alerts_status', columnNames: ['status'] },
          { name: 'idx_alerts_created_at', columnNames: ['createdAt'] },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'alerts',
      new TableForeignKey({
        name: 'fk_alerts_rule',
        columnNames: ['ruleId'],
        referencedTableName: 'alert_rules',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('alerts', true);
    await queryRunner.dropTable('alert_conditions', true);
    await queryRunner.dropTable('alert_rules', true);
  }
}
