import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../models/db.js";
import type { Request, Response as ExpressResponse } from "express";
import { createHash } from "node:crypto";
// Transport/controller tests assume readiness; real rejection paths are tested separately.
jest.unstable_mockModule('../services/assistants/CustomerDeliveryGate.js', () => ({
  assertCustomerDeliveryReady: async () => ({}), assertCustomerDeliveryRuntime: () => {},
  deliverySetupFailure: () => undefined, CustomerDeliverySetupError: class extends Error {},
}));
const { listSocialContent } = await import('../controllers/socialContentController.js');
const { commentCapabilities, socialCommentAction } = await import('../controllers/socialEngagementController.js');
const { mutateMetaComment } = await import('../services/social/MetaInsightsClient.js');
const { collectOfficialCommentPages } = await import('../services/social/SocialContentInsightsService.js');
const response = () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return {
    json,
    status,
    value: { json, status } as unknown as ExpressResponse,
  };
};
afterEach(() => { jest.restoreAllMocks(); });

describe("social content queries and engagement", () => {
  it("paginates and filters in SQL while computing totals over the entire account period", async () => {
    jest
      .spyOn(db, "select")
      .mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 22, platform: "instagram_api" }],
          }),
        }),
      } as never);
    const execute = jest
      .spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ count: 115 }] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            type: "reel",
            posts: 200,
            metric_totals: { views: 10000, reach: 5000 },
            metric_coverage: { views: 200, reach: 180 },
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ date: "2026-09-02", posts: 0, reels: 200, stories: 0 }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const res = response();
    await listSocialContent(
      {
        user: { id: 9 },
        query: {
          credentialId: "22",
          platform: "instagram",
          startDate: "2026-09-01",
          endDate: "2026-09-09",
          offset: "50",
          q: "resort",
          kind: "reel",
          sort: "reach",
        },
      } as unknown as Request,
      res.value,
    );
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as never);
    expect(query.sql).toContain("LIMIT 51 OFFSET");
    expect(query.sql).toContain("POSITION(LOWER(");
    expect(query.sql).not.toContain("10001");
    expect(query.params).toEqual(
      expect.arrayContaining([9, 22, "resort", "reach", 50]),
    );
    const aggregate = new PgDialect().sqlToQuery(
      execute.mock.calls[2][0] as never,
    );
    expect(aggregate.params).not.toContain("resort");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        totalPosts: 200,
        matchedPosts: 115,
        metricTotals: { views: 10000, reach: 5000 },
        metricCoverage: { views: 200, reach: 180 },
      }),
    );
  });
  it("advances safe comment cursors and reports a bounded/repeated cursor", async () => {
    const request = jest
      .fn<
        (
          path: string,
          query: Record<string, string>,
        ) => Promise<Record<string, unknown>>
      >()
      .mockResolvedValueOnce({
        data: [{ id: "1" }],
        paging: {
          next: "https://untrusted.example",
          cursors: { after: "next" },
        },
      })
      .mockResolvedValueOnce({
        data: [{ id: "2" }],
        paging: {
          next: "https://untrusted.example",
          cursors: { after: "next" },
        },
      });
    const consume = jest
      .fn<(comment: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValue();
    expect(
      await collectOfficialCommentPages(
        { platform: "instagram", request },
        "123",
        consume,
      ),
    ).toEqual({ count: 2, truncated: true });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "123/comments",
      expect.objectContaining({ after: "next", limit: "50" }),
    );
    expect(consume).toHaveBeenCalledTimes(2);
  });
  it("never retries a provider write after transport errors or a server rejection", async () => {
    for (const fetcher of [
      jest.fn<typeof fetch>().mockRejectedValue(new Error("secret")),
      jest
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: 2 } }), { status: 503 }),
        ),
    ]) {
      await expect(
        mutateMetaComment(
          "https://graph.facebook.com/v25.0",
          "secret",
          "123/replies",
          { message: "hello" },
          fetcher,
          { userId: 17, channel: 'instagram', accountId: '123', surface: 'public_comment' },
        ),
      ).rejects.toMatchObject({ code: "SOCIAL_ACTION_UNCERTAIN" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0][0])).not.toContain("secret");
    }
  });
  it("uses form encoded POST fields and fails closed without comment management scope", async () => {
    const fetcher = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "reply-1" }), { status: 200 }),
      );
    await expect(
      mutateMetaComment(
        "https://graph.facebook.com/v25.0",
        "token",
        "123/replies",
        { message: "Hello" },
        fetcher,
        { userId: 17, channel: 'instagram', accountId: '123', surface: 'public_comment' },
      ),
    ).resolves.toEqual({ id: "reply-1" });
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(String(fetcher.mock.calls[0][1]?.body)).toBe("message=Hello");
    expect(commentCapabilities("instagram", []).reply).toBe(false);
    expect(
      commentCapabilities("instagram", ["instagram_manage_comments"]).reply,
    ).toBe(true);
    expect(
      commentCapabilities("facebook", ["instagram_manage_comments"]).moderate,
    ).toBe(false);
  });
  it("rejects malformed actions before loading any account", async () => {
    const select = jest.spyOn(db, "select");
    const res = response();
    await socialCommentAction(
      {
        user: { id: 9 },
        params: { id: "123", commentId: "45" },
        body: {
          credentialId: 22,
          platform: "instagram",
          action: "reply",
          message: "hi",
        },
      } as unknown as Request,
      res.value,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(select).not.toHaveBeenCalled();
  });
  it("rejects another post's comment even when the selected post belongs to the tenant", async () => {
    jest
      .spyOn(db, "select")
      .mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 22,
                platform: "instagram_api",
                accountIdentifier: "1234",
                accessToken: "test-token",
                grantedScopes: ["instagram_manage_comments"],
              },
            ],
          }),
        }),
      } as never);
    jest.spyOn(db, "update").mockImplementation(() => {
      throw new Error("No admin config in unit test");
    });
    jest
      .spyOn(db, "execute")
      .mockResolvedValue({ rows: [{ provider_id: "123" }] } as never);
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: "99", media: { id: "another-post" } }),
        ),
      );
    const res = response();
    await socialCommentAction(
      {
        user: { id: 9 },
        params: { id: "123", commentId: "99" },
        body: {
          credentialId: 22,
          platform: "instagram",
          action: "reply",
          message: "hello",
          idempotencyKey: "receipt_0123456789",
        },
      } as unknown as Request,
      res.value,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
  });
  it("blocks an uncertain identical reply with a new key and replays a successful receipt", async () => {
    jest
      .spyOn(db, "select")
      .mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 22,
                platform: "instagram_api",
                accountIdentifier: "1234",
                accessToken: "test-token",
                grantedScopes: ["instagram_manage_comments"],
              },
            ],
          }),
        }),
      } as never);
    jest.spyOn(db, "update").mockImplementation(() => {
      throw new Error("No admin config in unit test");
    });
    jest
      .spyOn(db, "execute")
      .mockResolvedValue({ rows: [{ provider_id: "123" }] } as never);
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ id: "99", media: { id: "123" } })),
      );
    const hash = createHash("sha256")
      .update(JSON.stringify([22, "123", "99", "reply", "hello"]))
      .digest("hex");
    for (const status of ["uncertain", "succeeded"]) {
      const txExecute = jest
        .fn()
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({
          rows: [
            {
              request_hash: hash,
              status,
              result: { success: true, providerId: "done" },
            },
          ],
        } as never);
      jest
        .spyOn(db, "transaction")
        .mockImplementation((async (callback: (tx: unknown) => unknown) =>
          callback({ execute: txExecute })) as never);
      const res = response();
      await socialCommentAction(
        {
          user: { id: 9 },
          params: { id: "123", commentId: "99" },
          body: {
            credentialId: 22,
            platform: "instagram",
            action: "reply",
            message: "hello",
            idempotencyKey: "new_receipt_0123456789",
          },
        } as unknown as Request,
        res.value,
      );
      if (status === "uncertain") expect(res.status).toHaveBeenCalledWith(409);
      else
        expect(res.json).toHaveBeenCalledWith({
          success: true,
          providerId: "done",
        });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(([, options]) => options?.method !== "POST"),
    ).toBe(true);
  });
});
