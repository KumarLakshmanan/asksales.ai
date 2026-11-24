/** Strict decimal validation for PostgreSQL serial IDs and bounded inbox queries. */
export function notificationInteger(value: unknown, fallback?: number, maximum = 2_147_483_647): number | null {
  if (value === undefined) return fallback ?? null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

export interface NotificationCursor {
  createdAt: string;
  id: number;
  userId: number;
  businessProfileId: number | null;
  type: string | null;
  read: boolean | null;
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeNotificationCursor(value: unknown): NotificationCursor | null {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!cursor || typeof cursor !== 'object' || !Number.isInteger(cursor.id) || cursor.id < 1 || cursor.id > 2_147_483_647
      || typeof cursor.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(cursor.createdAt)
      || !Number.isFinite(Date.parse(`${cursor.createdAt}Z`))
      || new Date(`${cursor.createdAt}Z`).toISOString().slice(0, 19) !== cursor.createdAt.slice(0, 19)) return null;
    return cursor;
  } catch { return null; }
}
