import { describe, expect, it } from "@jest/globals";
import { outreachQueueSummary } from "../services/outreach/QueueOverview.js";
describe("activity summary and queue use the same delivery records", () => {
  it("includes queued recipients and late provider failures without double-counting delivered or retry subsets", () => {
    const result = outreachQueueSummary([
      {
        channel: "whatsapp",
        accepted: 400,
        delivered: 390,
        queued: 175,
        processing: 1,
        retrying: 25,
        failed: 9,
        review: 2,
      },
      {
        channel: "email",
        accepted: 16,
        delivered: 0,
        queued: 3,
        processing: 0,
        retrying: 1,
        failed: 2,
        review: 0,
      },
    ]);
    expect(result).toMatchObject({
      totalSent: 608,
      delivered: 390,
      range: "all",
      source: "outreach_queue",
      byStatus: { sent: 416, pending: 178, failed: 11 },
    });
    expect(result.byChannel.whatsapp).toEqual({
      sent: 400,
      delivered: 390,
      queued: 175,
      failed: 9,
    });
  });
  it("returns zero only for an established empty queue snapshot", () => {
    expect(outreachQueueSummary([])).toMatchObject({
      totalSent: 0,
      byStatus: { sent: 0, pending: 0, failed: 0 },
    });
  });
});
