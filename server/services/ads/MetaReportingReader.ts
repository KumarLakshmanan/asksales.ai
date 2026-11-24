export type MetaReportingRow = Record<string, unknown>;
export class MetaReportingError extends Error {
  constructor(public code: string, message: string, public retryAfterSeconds = 300) {
    super(message);
    this.name = 'MetaReportingError';
  }
}

/** Reporting is GET-only. Credentials never enter URLs or diagnostic messages. */
export async function readMetaReportingRows<T = MetaReportingRow>(url: string, token: string, fetcher: typeof fetch = fetch): Promise<T[]> {
  const rows: T[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < 20; page++) {
    const parsed = new URL(next);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'graph.facebook.com') throw new Error('Meta returned an invalid insights page URL.');
    // paging.next may repeat a token; keep authentication in the header only.
    parsed.searchParams.delete('access_token');
    const response = await fetcher(parsed.toString(), { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const payload = await response.json() as { data?: T[]; paging?: { next?: string }; error?: { code?: number; error_subcode?: number } };
    if (!response.ok || payload.error) {
      const code = Number(payload.error?.code);
      if (response.status === 429 || [4, 17, 32, 613, 80000, 80004].includes(code)) {
        const retry = Math.max(30, Math.min(86400, Number(response.headers.get('retry-after')) || 300));
        throw new MetaReportingError('META_REPORTING_RATE_LIMITED', 'Meta reporting is temporarily rate limited. Saved data is preserved; wait before refreshing again.', retry);
      }
      if (code === 190 || response.status === 401) throw new MetaReportingError('META_REPORTING_RECONNECT_REQUIRED', 'Meta authorization needs to be renewed before refreshing reporting. Reconnect the Meta Ads account.');
      throw new MetaReportingError('META_REPORTING_UNAVAILABLE', `Meta rejected the reporting request (HTTP ${response.status}${Number.isFinite(code) ? `, Meta code ${code}` : ''}). Saved data is preserved.`);
    }
    rows.push(...(Array.isArray(payload.data) ? payload.data : []));
    next = typeof payload.paging?.next === 'string' ? payload.paging.next : null;
  }
  if (next) throw new Error('Meta pagination exceeded the safe page limit; refresh was incomplete.');
  return rows;
}

export interface MetaReportingIssue {
  entityType: 'campaign' | 'adset' | 'ad';
  entityId: string;
  message: string;
  code?: string;
  retryAfterSeconds?: number;
}

/** Three level reports replace a separate insights request for every unit. */
export async function readMetaReportingSnapshot(input: {
  root: string; apiVersion: string; accessToken: string; reportingQuery: string;
  insightFields: string; adsetFields: string; adFields: string;
}, fetcher: typeof fetch = fetch) {
  const base = `https://graph.facebook.com/${input.apiVersion}/${encodeURIComponent(input.root)}`;
  const result: {
    campaignDaily?: MetaReportingRow[]; adsetDaily?: MetaReportingRow[]; adDaily?: MetaReportingRow[];
    adsets?: MetaReportingRow[]; ads?: MetaReportingRow[]; errors: MetaReportingIssue[];
  } = { errors: [] };
  const read = (path: string) => readMetaReportingRows(`${base}/${path}`, input.accessToken, fetcher);
  for (const level of ['campaign', 'adset', 'ad'] as const) {
    try {
      const entities = level === 'campaign' ? undefined : await read(`${level === 'adset' ? 'adsets' : 'ads'}?fields=${level === 'adset' ? input.adsetFields : input.adFields}&limit=500`);
      const ids = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'campaign_id,adset_id' : 'campaign_id,adset_id,ad_id';
      const daily = await read(`insights?level=${level}&fields=${ids},${input.insightFields}&${input.reportingQuery}&time_increment=1&limit=500`);
      if (level === 'campaign') result.campaignDaily = daily;
      else if (level === 'adset') { result.adsets = entities; result.adsetDaily = daily; }
      else { result.ads = entities; result.adDaily = daily; }
    } catch (error) {
      result.errors.push({ entityType: level, entityId: input.root, message: error instanceof MetaReportingError ? error.message : 'Meta reporting could not be refreshed; previous evidence was preserved.', ...(error instanceof MetaReportingError ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds } : {}) });
      // A throttle or expired grant must stop the sync, not trigger one failed
      // request per campaign and unit. Unread levels keep their saved evidence.
      if (error instanceof MetaReportingError && ['META_REPORTING_RATE_LIMITED', 'META_REPORTING_RECONNECT_REQUIRED'].includes(error.code)) break;
    }
  }
  return result;
}

export function groupMetaReportingRows(rows: MetaReportingRow[] | undefined, field: string) {
  const grouped = new Map<string, MetaReportingRow[]>();
  for (const row of rows || []) {
    const key = String(row[field] || '');
    if (!key) continue;
    const values = grouped.get(key) || [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}
