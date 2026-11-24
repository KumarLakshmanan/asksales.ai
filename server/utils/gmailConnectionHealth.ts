export function gmailWatchHealth(session: Record<string, unknown> | null | undefined, now = Date.now()) {
  const expiration = Number(session?.watchExpiration);
  const valid = Number.isFinite(expiration) && expiration > 0 && expiration <= 8.64e15;
  const watchStatus = !valid ? 'not_configured' : expiration <= now ? 'expired'
    : expiration - now < 24 * 3600_000 ? 'expiring_soon' : 'active';
  return {
    watchStatus,
    watchExpiresAt: valid ? new Date(expiration).toISOString() : null,
    watchRenewalStatus: ['failed', 'needs_reconnect'].includes(String(session?.watchRenewalStatus)) ? String(session?.watchRenewalStatus) : null,
    watchRetryAt: safeGmailHealthDate(session?.watchRenewalRetryAfter),
  };
}
export function safeGmailHealthDate(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
