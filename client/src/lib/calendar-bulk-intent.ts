import { creatorSessionScope } from './creator-session';
import { isPositiveSafeInteger as positive } from '../../../shared/numbers';

export type CalendarBulkPayload = {
  action: 'cancel' | 'reschedule';
  assetIds: number[];
  scope: 'single' | 'group';
  expectedVersions: Record<number, number>;
  expectedScheduledFor: Record<number, string>;
  scheduledDate?: string;
  scheduledTime?: string;
  timezone?: string;
};
export type CalendarBulkIntent = { version: 1; scope: string; key: string; createdAt: number; payload: CalendarBulkPayload };
const storageKey = (scope: string) => `calendar-bulk:v1:${scope}`;

function validIntent(value: CalendarBulkIntent | null, scope: string): value is CalendarBulkIntent {
  const body = value?.payload;
  if (value?.version !== 1 || value.scope !== scope || typeof value.key !== 'string' || value.key.length < 8
    || value.key.length > 200 || !Number.isFinite(value.createdAt) || !body
    || !['cancel', 'reschedule'].includes(body.action) || !['single', 'group'].includes(body.scope)
    || Object.keys(body).some(key => !['action', 'assetIds', 'scope', 'expectedVersions', 'expectedScheduledFor', 'scheduledDate', 'scheduledTime', 'timezone'].includes(key))
    || !Array.isArray(body.assetIds) || !body.assetIds.length || body.assetIds.length > 100
    || !body.assetIds.every(positive) || new Set(body.assetIds).size !== body.assetIds.length) return false;
  for (const [field, values] of Object.entries({ expectedVersions: body.expectedVersions, expectedScheduledFor: body.expectedScheduledFor })) {
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.entries(values).some(([id, expected]) => !body.assetIds.includes(Number(id))
        || (field === 'expectedVersions' ? !positive(expected) : typeof expected !== 'string' || !Number.isFinite(Date.parse(expected))))) return false;
  }
  return body.action === 'cancel' || (typeof body.scheduledDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.scheduledDate)
    && typeof body.scheduledTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.scheduledTime)
    && typeof body.timezone === 'string' && body.timezone.length > 0 && body.timezone.length < 200);
}

/** Only recovery metadata is stored: no captions, private wording or credentials. */
export function loadCalendarBulkIntent(scope: string): CalendarBulkIntent | null {
  const raw = sessionStorage.getItem(storageKey(scope));
  if (!raw) return null;
  const value = JSON.parse(raw) as CalendarBulkIntent | null;
  if (!validIntent(value, scope)) throw new Error('Calendar recovery details are invalid. Review the current calendar before requesting another change.');
  return value;
}

export function saveCalendarBulkIntent(scope: string, payload: CalendarBulkPayload): CalendarBulkIntent {
  if (scope !== creatorSessionScope()) throw new Error('The business changed. Return to the original business before retrying.');
  const previous = loadCalendarBulkIntent(scope);
  if (previous) {
    if (JSON.stringify(previous.payload) !== JSON.stringify(payload)) throw new Error('A different calendar action awaits confirmation. Reload to recover that reviewed action first.');
    return previous;
  }
  const intent: CalendarBulkIntent = { version: 1, scope, key: crypto.randomUUID(), createdAt: Date.now(), payload };
  if (!validIntent(intent, scope)) throw new Error('Review this calendar action: select 1–100 destinations and a valid schedule before submitting.');
  // Persist before sending. If storage is unavailable, no mutation is started.
  sessionStorage.setItem(storageKey(scope), JSON.stringify(intent));
  return intent;
}

export function clearCalendarBulkIntent(intent: CalendarBulkIntent): void {
  if (intent.scope !== creatorSessionScope()) return;
  const saved = loadCalendarBulkIntent(intent.scope);
  if (saved?.key === intent.key) sessionStorage.removeItem(storageKey(intent.scope));
}

/** The existing server receipt lasts 24 hours; never replay after it expires. */
export function canReplayCalendarBulkIntent(intent: CalendarBulkIntent): boolean {
  const age = Date.now() - intent.createdAt;
  return age >= 0 && age < 24 * 60 * 60 * 1000;
}
