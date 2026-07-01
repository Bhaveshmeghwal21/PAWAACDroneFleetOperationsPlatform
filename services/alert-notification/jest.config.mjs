/**
 * Jest configuration for the Alert & Notification service.
 *
 * Uses ts-jest so unit, property-based (fast-check) and Supertest/Testcontainers
 * integration specs all run straight from TypeScript without a separate build.
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '\\.(spec|e2e-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // `dto.ts` value-imports runtime constants (ALERT_SEVERITIES, etc.) from
    // `@pawaac/shared-types`, which emits a real `require(...)` when the app is
    // booted (e.g. AppModule in the integration spec). The shared-types
    // `exports` map only publishes an ESM `import` condition and its `dist`
    // output is ESM, so this service's CommonJS ts-jest resolver cannot load
    // it. Map the package to its TypeScript sources so ts-jest compiles it the
    // same way it compiles this service — kept in lockstep with the `dist`
    // build CI produces from the same sources.
    '^@pawaac/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    // shared-types sources use NodeNext-style explicit `.js` extensions in their
    // relative re-exports; strip the extension so the resolver finds the `.ts`
    // files on disk (mirrors the telemetry-ingestion service's mapper).
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
