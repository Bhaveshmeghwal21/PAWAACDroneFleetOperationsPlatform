/**
 * Common scalar aliases reused across cross-service DTOs and events.
 *
 * These are intentionally lightweight `string`/`number` aliases that document
 * intent at call sites without imposing a runtime representation, keeping the
 * shared package free of runtime coupling.
 */

/** A UUID string (RFC 4122). */
export type Uuid = string;

/** An ISO-8601 timestamp string, e.g. `2024-01-01T12:00:00.000Z`. */
export type IsoTimestamp = string;

/** Epoch seconds (may be fractional), used for high-rate vision frame stamps. */
export type EpochSeconds = number;

/**
 * A geographic coordinate expressed as `[longitude, latitude]` in decimal
 * degrees, matching GeoJSON axis ordering.
 */
export type GeoPoint = readonly [lon: number, lat: number];

/**
 * A closed polygon ring of `GeoPoint`s. By convention the first and last point
 * are identical (closed ring) and the ring has at least four points.
 */
export type GeoPolygon = GeoPoint[];
