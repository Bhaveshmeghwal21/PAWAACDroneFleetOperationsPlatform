import { Table, TableForeignKey, type QueryRunner } from 'typeorm';
import { InitAlertNotification1700000000200 } from './1700000000200-InitAlertNotification';

/**
 * Verifies the initial Alert & Notification migration is expressed through the
 * TypeORM schema-builder API and never via raw SQL DDL (Requirement 28.3).
 */
describe('InitAlertNotification1700000000200', () => {
  function createMockRunner(): {
    runner: QueryRunner;
    createdTables: Table[];
    foreignKeys: TableForeignKey[];
    droppedTables: string[];
    rawQueries: string[];
  } {
    const createdTables: Table[] = [];
    const foreignKeys: TableForeignKey[] = [];
    const droppedTables: string[] = [];
    const rawQueries: string[] = [];

    const runner = {
      createTable: jest.fn(async (table: Table) => {
        createdTables.push(table);
      }),
      createForeignKey: jest.fn(async (_table: string, fk: TableForeignKey) => {
        foreignKeys.push(fk);
      }),
      dropTable: jest.fn(async (name: string | Table) => {
        droppedTables.push(typeof name === 'string' ? name : name.name);
      }),
      query: jest.fn(async (sql: string) => {
        rawQueries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { runner, createdTables, foreignKeys, droppedTables, rawQueries };
  }

  it('creates the three tables via the Table API with no raw SQL DDL', async () => {
    const { runner, createdTables, rawQueries } = createMockRunner();

    await new InitAlertNotification1700000000200().up(runner);

    expect(createdTables.map((t) => t.name)).toEqual([
      'alert_rules',
      'alert_conditions',
      'alerts',
    ]);
    expect(createdTables.every((t) => t instanceof Table)).toBe(true);
    // No raw SQL data-definition statements were emitted (Requirement 28.3).
    expect(rawQueries).toHaveLength(0);
  });

  it('wires foreign keys from conditions and alerts back to the rule table', async () => {
    const { runner, foreignKeys } = createMockRunner();

    await new InitAlertNotification1700000000200().up(runner);

    const referenced = foreignKeys.map((fk) => ({
      cols: fk.columnNames,
      table: fk.referencedTableName,
      onDelete: fk.onDelete,
    }));
    expect(referenced).toEqual(
      expect.arrayContaining([
        { cols: ['ruleId'], table: 'alert_rules', onDelete: 'CASCADE' },
        { cols: ['ruleId'], table: 'alert_rules', onDelete: 'RESTRICT' },
      ]),
    );
  });

  it('drops tables in dependency-safe order on down()', async () => {
    const { runner, droppedTables } = createMockRunner();

    await new InitAlertNotification1700000000200().down(runner);

    expect(droppedTables).toEqual(['alerts', 'alert_conditions', 'alert_rules']);
  });
});
