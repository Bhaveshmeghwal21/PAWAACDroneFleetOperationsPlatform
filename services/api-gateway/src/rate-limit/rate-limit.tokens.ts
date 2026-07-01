/**
 * Dependency-injection tokens for the rate-limit module. Kept in a standalone
 * file to avoid circular imports between the limiter service and the module.
 */

/** DI token for the resolved per-role {@link RateLimitConfig}. */
export const RATE_LIMIT_CONFIG = 'RATE_LIMIT_CONFIG';
