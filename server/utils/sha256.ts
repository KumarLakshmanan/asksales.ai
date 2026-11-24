import crypto from 'node:crypto';

/** Hex SHA-256 of a string (token, session or state fingerprints). */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Hex SHA-256 of JSON.stringify(value): a stable fingerprint for request, template and graph payloads. */
export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
