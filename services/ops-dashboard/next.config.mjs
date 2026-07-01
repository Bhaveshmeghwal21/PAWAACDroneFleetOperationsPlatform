import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Next.js configuration for the Ops Dashboard (Service 7).
 *
 * - `output: 'standalone'` emits a self-contained server bundle so the Docker
 *   runtime image stays lean (see ./Dockerfile).
 * - `outputFileTracingRoot` is pinned to the monorepo root so the standalone
 *   trace correctly resolves the `@pawaac/shared-types` workspace package.
 * - `transpilePackages` lets Next compile the shared workspace package directly.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../../'),
  transpilePackages: ['@pawaac/shared-types'],
  reactStrictMode: true,
};

export default nextConfig;
