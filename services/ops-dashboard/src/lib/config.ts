/**
 * Runtime configuration for browser-facing endpoints.
 *
 * `NEXT_PUBLIC_*` variables are inlined into the client bundle at build time
 * (see docker-compose.yml and .env.example). Defaults target a locally
 * published API Gateway so `next dev` works with zero configuration.
 */

const DEFAULT_API_GATEWAY_URL = 'http://localhost:3000';
const DEFAULT_WS_URL = 'ws://localhost:3000';

export interface ClientConfig {
  /** Base URL of the API Gateway REST surface (browser-reachable). */
  readonly apiGatewayUrl: string;
  /** Base URL of the API Gateway WebSocket surface (browser-reachable). */
  readonly wsUrl: string;
}

export const clientConfig: ClientConfig = {
  apiGatewayUrl: process.env.NEXT_PUBLIC_API_GATEWAY_URL ?? DEFAULT_API_GATEWAY_URL,
  wsUrl: process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL,
};
