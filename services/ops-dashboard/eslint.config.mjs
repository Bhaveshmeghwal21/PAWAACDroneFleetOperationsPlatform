// Ops Dashboard ESLint config: reuse the shared monorepo flat config and add
// frontend-specific ignore paths (Next build output, Playwright artifacts).
import baseConfig from '../../eslint.config.mjs';

export default [
  {
    ignores: ['.next/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'],
  },
  ...baseConfig,
];
