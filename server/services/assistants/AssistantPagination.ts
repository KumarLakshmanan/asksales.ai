import { AssistantManagementError } from './AssistantManagementError.js';

export function boundedPageLimit(value: unknown, fallback = 25): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AssistantManagementError('Page size must be between 1 and 100.');
  return limit;
}
export function encodeAssistantCursor(date: string, key: string, source: string): string {
  return Buffer.from(JSON.stringify({ date, key, source })).toString('base64url');
}
export function decodeAssistantCursor(value: unknown, source: string): { date: string; key: string } | null {
  if (value === undefined || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const item = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (item.source !== source || typeof item.date !== 'string' || !Number.isFinite(Date.parse(item.date)) || typeof item.key !== 'string' || item.key.length > 200) throw new Error();
    return { date: new Date(item.date).toISOString(), key: item.key };
  } catch { throw new AssistantManagementError('Invalid page cursor.'); }
}
