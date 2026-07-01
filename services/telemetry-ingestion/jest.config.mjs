/**
 * Jest configuration for the Telemetry Ingestion service.
 *
 * The service is authored as native ESM (`"type": "module"`) with NodeNext
 * module resolution, so tests run through ts-jest's ESM preset. The
 * `moduleNameMapper` rewrites the `.js` extensions used in our relative imports
 * (required by NodeNext) back to the on-disk `.ts` sources during testing.
 */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          // Tests are excluded from the build tsconfig; relax the unused-symbol
          // checks that are appropriate for production code but noisy in tests.
          noUnusedLocals: false,
          noUnusedParameters: false,
        },
      },
    ],
  },
};
