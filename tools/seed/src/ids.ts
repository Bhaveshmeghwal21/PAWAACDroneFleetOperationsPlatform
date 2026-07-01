/**
 * Stable, deterministic identifier derivation for the seed script
 * (Requirement 29.2). Identifiers are derived purely from a fixed namespace and
 * a caller-supplied name, so the same logical entity always maps to the same
 * UUID across runs. This is what lets the DB writers use idempotent
 * `INSERT ... ON CONFLICT (id) DO UPDATE` upserts keyed by stable ids.
 *
 * The derivation is an RFC 4122 version-5 (name-based, SHA-1) UUID, which is
 * itself defined to be a pure function of (namespace, name).
 */
import { createHash } from 'node:crypto';

/**
 * Fixed namespace UUID for every id this seed script mints. Chosen once and
 * frozen; changing it would change every derived id and break idempotency.
 */
const SEED_NAMESPACE = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** Format 16 raw bytes as a canonical lowercase UUID string. */
function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join('-');
}

const NAMESPACE_BYTES = uuidToBytes(SEED_NAMESPACE);

/**
 * Derive a deterministic v5 UUID from `name` within the fixed seed namespace.
 *
 * @example
 *   deterministicUuid('drone:0') // always the same UUID for this namespace
 */
export function deterministicUuid(name: string): string {
  const hash = createHash('sha1');
  hash.update(NAMESPACE_BYTES);
  hash.update(Buffer.from(name, 'utf8'));
  const digest = hash.digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  // Set the version (5) and the RFC 4122 variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}
