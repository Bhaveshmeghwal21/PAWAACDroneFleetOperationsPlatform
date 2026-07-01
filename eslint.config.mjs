// Root ESLint flat configuration shared by every workspace in the monorepo.
// Services may extend this file via `import baseConfig from '../../eslint.config.mjs'`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Globally ignored paths (build output, deps, coverage, etc.).
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.next/**',
      // Next.js auto-generates next-env.d.ts with triple-slash references that
      // intentionally violate @typescript-eslint/triple-slash-reference and is
      // marked "should not be edited". Ignore it globally so monorepo-wide
      // `pnpm lint` stays green.
      '**/next-env.d.ts',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Disable stylistic rules that conflict with Prettier (must be last).
  eslintConfigPrettier,
);
