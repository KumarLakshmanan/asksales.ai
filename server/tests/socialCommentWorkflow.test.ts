import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../models/db.js";
import {
  listListeningEvents,
  updateListeningEvent,
} from "../controllers/socialAnalyticsController.js";
const compile = (query: unknown) => new PgDialect().sqlToQuery(query as never);
const response = () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { json, status, value: { json, status } as unknown as Response };
};
const event = {
  id: "event",
  user_id: 17,
  platform: "instagram",
  provider_event_id: "99",
  source: "official_api",
  body: "Hello",
  sentiment: "unknown",
  metadata: {
    collection: "owned_post_comments",
    credentialId: 22,
    contentId: "123",
  },
};
afterEach(() => { jest.restoreAllMocks(); });
describe("Shared comment and listening workflow", () => {
  it.each([
    ["new", "open"],
    ["reviewed", "reviewed"],
    ["follow_up", "follow_up"],
    ["escalated", "escalated"],
    ["resolved", "resolved"],
  ])(
    "maps listening %s to canonical %s atomically",
    async (reviewStatus, workflowStatus) => {
      jest
        .spyOn(db, "execute")
        .mockResolvedValueOnce({ rows: [event] } as never)
        .mockResolvedValueOnce({ rows: [{ provider_id: "123" }] } as never);
      const execute = jest
        .fn()
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({
          rows: [{ ...event, metadata: { ...event.metadata, reviewStatus } }],
        } as never);
      jest
        .spyOn(db, "transaction")
        .mockImplementation((async (callback: (tx: unknown) => unknown) =>
          callback({ execute })) as never);
      const res = response();
      await updateListeningEvent(
        {
          user: { id: 17 },
          params: { id: "event" },
          body: { status: reviewStatus },
        } as unknown as Request,
        res.value,
      );
      const canonical = compile(execute.mock.calls[0][0]);
      expect(canonical.sql).toContain("INSERT INTO social_comment_workflows");
      expect(canonical.params).toEqual([17, 22, "123", "99", workflowStatus]);
      expect(compile(execute.mock.calls[1][0]).sql).toContain(
        "UPDATE social_listening_events",
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reviewStatus }),
        }),
      );
    },
  );
  it("does not create comment workflow rows for tags or manual notes", async () => {
    const execute = jest
      .spyOn(db, "execute")
      .mockResolvedValueOnce({
        rows: [
          {
            ...event,
            source: "public_export",
            metadata: {
              collection: "manual",
              credentialId: 22,
              contentId: "123",
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: "event" }] } as never);
    const transaction = jest.spyOn(db, "transaction");
    await updateListeningEvent(
      {
        user: { id: 17 },
        params: { id: "event" },
        body: { status: "follow_up" },
      } as unknown as Request,
      response().value,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("refuses to update a canonical workflow when its post is not owned by that account", async () => {
    jest
      .spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [event] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const transaction = jest.spyOn(db, "transaction");
    const res = response();
    await updateListeningEvent(
      {
        user: { id: 17 },
        params: { id: "event" },
        body: { status: "resolved" },
      } as unknown as Request,
      res.value,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(transaction).not.toHaveBeenCalled();
  });
  it("uses canonical workflow status for inbox rows, filters and source counts", async () => {
    const execute = jest
      .spyOn(db, "execute")
      .mockResolvedValue({ rows: [] } as never);
    await listListeningEvents(
      {
        user: { id: 17 },
        query: { status: "escalated", paginated: "1" },
      } as unknown as Request,
      response().value,
    );
    for (const call of execute.mock.calls) {
      const query = compile(call[0]);
      expect(query.sql).toContain("FROM social_comment_workflows workflow");
      expect(query.sql).toContain(
        "workflow.user_id=social_listening_events.user_id",
      );
      expect(query.sql).toContain(
        "workflow.credential_id::text=social_listening_events.metadata->>'credentialId'",
      );
      expect(query.sql).toContain(
        "workflow.comment_id=social_listening_events.provider_event_id",
      );
      expect(query.params).toContain("escalated");
    }
    expect(compile(execute.mock.calls[0][0]).sql).toContain(
      "jsonb_build_object('reviewStatus',events.review_status)",
    );
  });
});
