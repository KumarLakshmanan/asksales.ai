import { asRecordOrNull as record } from '../../../shared/records';
export type LeadExecutionStatus = 'succeeded' | 'succeeded_empty' | 'partial_success' | 'failed' | 'cancelled' | 'unknown';
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Adapt legacy arrays/maps without trusting their shape or inventing success. */
export function normalizeLeadExecutionSummary(value: unknown) {
  const envelope = record(value) || {};
  const data = { ...record(envelope.metadata), ...envelope };
  const raw = data.results ?? data.platformResults;
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((item, index) => [String(index), item])
    : Object.entries(record(raw) || {});
  const results = entries.flatMap(([key, item]) => {
    const result = record(item);
    if (!result) return [];
    const status = String(result.status || '');
    const success = typeof result.success === 'boolean' ? result.success
      : ['succeeded', 'succeeded_empty', 'completed'].includes(status) ? true
        : ['failed', 'error'].includes(status) ? false : undefined;
    return [{
      platform: String(result.platform || result.workflow || key), success,
      leads_count: count(result.leads_count ?? result.leadsCount),
      error: typeof result.error === 'string' ? result.error : undefined,
    }];
  });
  const successCount = count(data.successful_platforms) ?? results.filter(result => result.success === true).length;
  const failedCount = count(data.failed_platforms) ?? results.filter(result => result.success === false).length;
  const totalLeads = count(data.total_leads ?? data.totalLeads)
    ?? (results.length > 0 && results.every(result => result.leads_count !== undefined)
      ? results.reduce((sum, result) => sum + result.leads_count!, 0) : undefined);
  let status: LeadExecutionStatus = ['succeeded', 'succeeded_empty', 'partial_success', 'failed', 'cancelled'].includes(String(data.status))
    ? data.status as LeadExecutionStatus : 'unknown';
  if (status !== 'cancelled') {
    if (failedCount > 0) status = successCount > 0 ? 'partial_success' : 'failed';
    else if (status === 'unknown' && results.length > 0 && results.every(result => result.success === true)) status = 'succeeded';
    if (status === 'succeeded' && totalLeads === 0) status = 'succeeded_empty';
  }
  return { status, totalLeads, successCount, failedCount, results };
}

export function leadEmptyState(status?: string) {
  if (status === 'completed' || status === 'succeeded_empty' || status === 'succeeded') return {
    badge: 'No matches', title: 'Search finished with no matching leads',
    description: 'No leads were saved. Adjust the targeting or choose another strategy in chat, then review the new inputs before running again.',
  };
  if (status === 'error' || status === 'failed' || status === 'partial_success') return {
    badge: 'Needs attention', title: 'The search could not finish successfully',
    description: 'Review the provider errors below. No outreach can start without saved leads.',
  };
  if (status === 'cancelled' || status === 'stopped') return {
    badge: 'Cancelled', title: 'The search was stopped',
    description: 'No leads were saved. Review the search settings in chat before starting a new run.',
  };
  return {
    badge: 'Ready to Generate', title: 'Start a lead generation workflow via Campaign Chat',
    description: 'Select or configure workflows to find and organize leads. You can also add profiles manually or import a CSV/Excel file.',
  };
}
