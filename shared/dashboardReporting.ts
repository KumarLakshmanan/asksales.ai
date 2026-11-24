/** Dashboard receipt reporting is distinct from immutable CRM win attribution. */
export interface DashboardReporting {
  reportingVersion: 2;
  reporting: { timezone: 'UTC'; activityDays: 7; campaignLimit: 10; basis: 'recorded_outbound_receipts'; customerUpdates: 'mutable_customer_record_updates' };
  recordedWins: { total: number | null; crmContacts: number | null; thisWeek: number | null; lastWeek: number | null; rate: string | null; coverage: 'recorded_events_only' | 'restricted'; policy: 'first_lifetime_win_per_canonical_contact' };
  dailyActivity: Array<{ date: string; leads: number; messages: number; customerUpdates: number; recordedWins: number | null }>;
  campaignPerformance: Array<{ id: number; name: string; sent: number; opened: number; replied: number }>;
}

export function isDashboardReportingCacheCurrent(value: unknown): value is DashboardReporting {
  if (!value || typeof value !== 'object') return false;
  const cached = value as Partial<DashboardReporting>;
  return cached.reportingVersion === 2 && !!cached.recordedWins
    && ['restricted', 'recorded_events_only'].includes(cached.recordedWins.coverage)
    && (typeof cached.recordedWins.rate === 'string' || cached.recordedWins.rate === null)
    && Array.isArray(cached.dailyActivity) && Array.isArray(cached.campaignPerformance);
}

export function dashboardCacheMatchesCrmAccess(value: unknown, crmEnabled: boolean): boolean {
  return isDashboardReportingCacheCurrent(value) && value.recordedWins.coverage === (crmEnabled ? 'recorded_events_only' : 'restricted');
}

export function dashboardUtcWeekStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay()));
}
