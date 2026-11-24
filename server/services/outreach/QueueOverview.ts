import { getCampaignReport } from './CampaignReportingService.js';
/** The unfiltered activity header must use the same durable records as its queue table. */
export function outreachQueueSummary(channels: Array<Record<string, unknown>>) {
  const count = (row: Record<string, unknown>, key: string) =>
    Math.max(0, Number(row[key]) || 0);
  const total = (key: string) =>
    channels.reduce((sum, row) => sum + count(row, key), 0);
  return {
    totalSent: ["accepted", "queued", "processing", "failed", "review"].reduce(
      (sum, key) => sum + total(key),
      0,
    ),
    delivered: total("delivered"),
    byStatus: {
      sent: total("accepted"),
      pending: total("queued"),
      failed: total("failed"),
    },
    byChannel: Object.fromEntries(
      channels.map((row) => [
        String(row.channel),
        {
          sent: count(row, "accepted"),
          delivered: count(row, "delivered"),
          queued: count(row, "queued"),
          failed: count(row, "failed"),
        },
      ]),
    ),
    range: "all",
    source: "outreach_queue",
  };
}

/** Compatibility adapter for existing queue cards; all counts come from reporting. */
export async function getOutreachQueueOverview(userId: number) {
  const report = await getCampaignReport(userId, {messageKind:'all'});
  return {channels:report.channels, checkedAt:report.checkedAt};
}
