/** For identifiers backed by PostgreSQL INTEGER/serial, not bigint columns. */
export function isPostgresIntegerId(value: unknown): boolean {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647;
}
