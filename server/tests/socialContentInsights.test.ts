import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  contentMetricValues,
  normalizeContent,
  normalizeOfficialListeningComment,
  summarizeContent,
} from "../services/social/SocialContentInsightsService.js";
import { requestMetaInsights } from "../services/social/MetaInsightsClient.js";
import {
  listSocialContent,
  listSocialContentComments,
  listSocialContentReplies,
  getSocialContent,
  normalizeSocialComment,
  mergeSentReplies,
  mergeAgentReplies,
} from "../controllers/socialContentController.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../models/db.js";
import type { Request, Response as ExpressResponse } from "express";
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const post = (
  id: string,
  kind = "FEED",
  metrics: Record<string, number> = {},
) => ({
  ...normalizeContent("instagram", {
    id,
    timestamp: "2026-09-05T12:00:00Z",
    media_product_type: kind,
    media_type: "VIDEO",
  })!,
  metrics,
});
function mockCommentCredential() {
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
              accountName: "orocircle",
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
}
describe("social content insights", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it("classifies publication types without guessing a Facebook video is a reel", () => {
    expect(post("1", "REELS").type).toBe("reel");
    expect(post("2", "STORY").type).toBe("story");
    expect(
      normalizeContent("instagram", {
        id: "3",
        timestamp: "2026-09-01",
        media_type: "CAROUSEL_ALBUM",
      })?.type,
    ).toBe("carousel");
    expect(
      normalizeContent("facebook", {
        id: "10_12",
        created_time: "2026-09-01",
        attachments: { data: [{ media_type: "video" }] },
      })?.type,
    ).toBe("video");
  });
  it("keeps measured zeros but rejects missing values and unsafe links", () => {
    const item = normalizeContent("facebook", {
      id: "10_12",
      created_time: "2026-09-01",
      permalink_url: "javascript:alert(1)",
      comments: { summary: { total_count: 0 } },
    });
    expect(item?.metrics).toEqual({ comments: 0 });
    expect(item?.permalink).toBeNull();
    expect(
      contentMetricValues({
        data: [
          { name: "views", values: [{ value: 850 }] },
          { name: "reach", total_value: { value: 371 } },
          { name: "profile_visits", values: [] },
          { name: "follows", values: [{ value: 0 }] },
        ],
      }),
    ).toEqual({ views: 850, reach: 371, follows: 0 });
  });
  it("normalizes official owned-post comments without trusting unsafe links", () => {
    expect(
      normalizeOfficialListeningComment(
        "instagram",
        { id: "44", permalink: "https://instagram.com/p/44" },
        {
          id: "44_99",
          text: " Useful feedback ",
          username: "guest",
          timestamp: "2026-09-05T12:00:00Z",
          permalink_url: "javascript:alert(1)",
        },
      ),
    ).toEqual({
      providerEventId: "44_99",
      publicUrl: "https://instagram.com/p/44",
      author: "guest",
      body: "Useful feedback",
      occurredAt: "2026-09-05T12:00:00.000Z",
    });
    expect(
      normalizeOfficialListeningComment(
        "facebook",
        { id: "44", permalink: null },
        { id: "invalid", message: "hello", created_time: "2026-09-05" },
      ),
    ).toBeNull();
  });
  it("keeps lifetime results out of daily publication activity", () => {
    const result = summarizeContent([
      post("1", "REELS", { views: 1000 }),
      post("2", "STORY", { views: 200 }),
    ]);
    expect(result.timeline[0]).toMatchObject({
      posts: 0,
      reels: 1,
      stories: 1,
    });
    expect(result.timeline[0]).not.toHaveProperty("views");
    expect(result.topContent[0].contributionPercent).toBe(83.3);
  });
  it("uses actual profile visits for attribution instead of assuming views are visitors", () => {
    const result = summarizeContent([
      post("1", "REELS", { profile_visits: 30, views: 100 }),
      post("2", "FEED", { profile_visits: 10, views: 1000 }),
      post("3", "FEED", { views: 10000 }),
    ]);
    expect(result.rankingMetric).toBe("profile_visits");
    expect(result.topContent.map((p) => p.id)).toEqual(["1", "2"]);
    expect(result.topContent[0].contributionPercent).toBe(75);
  });
  it("retries transient failures and keeps tokens out of URLs", async () => {
    const fetcher = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ error: { code: 2 } }, 503))
      .mockResolvedValueOnce(reply({ data: [] }));
    await expect(
      requestMetaInsights(
        "https://graph.facebook.com/v25.0",
        "secret",
        "123/insights",
        { metric: "views" },
        fetcher,
      ),
    ).resolves.toEqual({ data: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).not.toContain("secret");
  });
  it("reports transport failures safely and does not retry authorization or rate limits", async () => {
    const fetcher = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("https://provider?access_token=secret"));
    await expect(
      requestMetaInsights(
        "https://graph.facebook.com/v25.0",
        "secret",
        "123/insights",
        {},
        fetcher,
      ),
    ).rejects.toMatchObject({ status: 503, code: "SOCIAL_PROVIDER_TIMEOUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [code, expected] of [
      [190, "SOCIAL_ANALYTICS_RECONNECT_REQUIRED"],
      [10, "SOCIAL_ANALYTICS_PERMISSION_REQUIRED"],
      [4, "SOCIAL_PROVIDER_RATE_LIMITED"],
    ] as const) {
      const denied = jest
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ error: { code, message: "secret" } }, 400));
      await expect(
        requestMetaInsights(
          "https://graph.facebook.com/v25.0",
          "secret",
          "123/insights",
          {},
          denied,
        ),
      ).rejects.toMatchObject({ code: expected });
      expect(denied).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects arbitrary pagination URLs as request paths", async () => {
    const fetcher = jest.fn<typeof fetch>();
    await expect(
      requestMetaInsights(
        "https://graph.facebook.com/v25.0",
        "secret",
        "https://example.com",
        {},
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "SOCIAL_INVALID_RESOURCE" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never queries content for a credential outside the workspace", async () => {
    jest.spyOn(db, "select").mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    } as never);
    const execute = jest.spyOn(db, "execute");
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const req = {
      user: { id: 9 },
      params: { id: "10_12" },
      query: {
        credentialId: "26",
        platform: "instagram",
        startDate: "2026-09-01",
        endDate: "2026-09-09",
      },
    } as unknown as Request;
    await listSocialContent(req, {
      status,
      json,
    } as unknown as ExpressResponse);
    await listSocialContentComments(req, {
      status,
      json,
    } as unknown as ExpressResponse);
    expect(status).toHaveBeenCalledWith(404);
    expect(execute).not.toHaveBeenCalled();
  });
  it("loads an owned post directly without applying dashboard date filters or exposing credentials", async () => {
    jest
      .spyOn(db, "select")
      .mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 22,
                platform: "instagram_api",
                accountName: "orocircle",
                accountIdentifier: "1234",
                accessToken: "secret",
                grantedScopes: [],
              },
            ],
          }),
        }),
      } as never);
    const execute = jest
      .spyOn(db, "execute")
      .mockResolvedValue({
        rows: [
          {
            provider_id: "123",
            platform: "instagram",
            content_type: "reel",
            published_at: "2025-01-01T12:00:00Z",
            caption: "An older post",
            metrics: { reach: 200 },
            limitations: [],
          },
        ],
      } as never);
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await getSocialContent(
      {
        user: { id: 9 },
        params: { id: "123" },
        query: { credentialId: "22", platform: "instagram" },
      } as unknown as Request,
      { json, status } as unknown as ExpressResponse,
    );
    const result = json.mock.calls[0][0] as {
      item: { id: string };
      account: Record<string, unknown>;
    };
    expect(result.item.id).toBe("123");
    expect(result.account).toEqual({
      id: 22,
      platform: "instagram",
      name: "orocircle",
      identifier: "1234",
      pictureUrl: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as never);
    expect(query.params).toEqual([9, 22, "instagram", "123"]);
    expect(query.sql).not.toContain("published_at>");
  });
  it("distinguishes account replies and merges durable sent replies without duplication", () => {
    const identity = {
      platform: "instagram",
      accountIdentifier: "1234",
      accountName: "orocircle",
    };
    const own = normalizeSocialComment(
      { id: "88", text: "Thanks!", username: "orocircle" },
      identity,
      null,
    );
    expect(own.isOwn).toBe(true);
    expect(
      normalizeSocialComment(
        { id: "89", from: { id: "555", name: "orocircle" } },
        { ...identity, platform: "facebook" },
        null,
      ).isOwn,
    ).toBe(false);
    expect(
      normalizeSocialComment(
        { id: "90", from: { id: "1234", name: "ORO" } },
        { ...identity, platform: "facebook" },
        null,
      ).isOwn,
    ).toBe(true);
    const replies = mergeSentReplies(
      [own],
      [
        { comment_id: "10", result: { providerId: "88", body: "Thanks!" } },
        {
          comment_id: "10",
          result: {
            providerId: "91",
            body: "See you soon!",
            publishedAt: "2026-09-19T01:00:00Z",
          },
        },
        {
          comment_id: "11",
          result: { providerId: "92", body: "Another thread" },
        },
      ],
      "10",
      identity,
      null,
    );
    expect(replies.map((row) => row.id)).toEqual(["88", "91"]);
    expect(replies[1]).toMatchObject({
      body: "See you soon!",
      isOwn: true,
      source: "sent",
    });
  });
  it("shows confirmed AI agent replies under their parent comment without duplicating provider replies", () => {
    const identity = { platform: "instagram", accountIdentifier: "1234", accountName: "orocircle" };
    const provider = normalizeSocialComment({ id: "88", text: "Thanks!", username: "orocircle" }, identity, null);
    const replies = mergeAgentReplies([provider], [
      { comment_id: "10", provider_message_id: "88", body: "Thanks!", sent_at: "2026-09-28T10:00:00Z" },
      { comment_id: "10", provider_message_id: "89", body: "Happy to help", sent_at: "2026-09-28T10:01:00Z" },
      { comment_id: "11", provider_message_id: "90", body: "Other post" },
      { comment_id: "10", provider_message_id: null, body: "Unconfirmed draft" },
    ], "10", identity, null);
    expect(replies.map((reply) => reply.id)).toEqual(["88", "89"]);
    expect(replies[0]).toMatchObject({ source: "agent", isOwn: true });
    expect(replies[1]).toMatchObject({ body: "Happy to help", source: "agent", isOwn: true });
  });
  it("rejects cross-platform content and malformed reply cursors before provider access", async () => {
    jest
      .spyOn(db, "select")
      .mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 22, platform: "instagram_api" }],
          }),
        }),
      } as never);
    const execute = jest.spyOn(db, "execute");
    const fetcher = jest.spyOn(globalThis, "fetch");
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const request = {
      user: { id: 9 },
      params: { id: "123", commentId: "99" },
      query: { credentialId: "22", platform: "facebook" },
    };
    await getSocialContent(
      request as unknown as Request,
      { status, json } as unknown as ExpressResponse,
    );
    expect(status).toHaveBeenLastCalledWith(404);
    await listSocialContentReplies(
      {
        ...request,
        query: {
          ...request.query,
          platform: "instagram",
          after: "https://evil.example",
        },
      } as unknown as Request,
      { status, json } as unknown as ExpressResponse,
    );
    expect(status).toHaveBeenLastCalledWith(400);
    expect(execute).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks comment ownership before fetching a paginated reply thread", async () => {
    mockCommentCredential();
    jest
      .spyOn(db, "execute")
      .mockResolvedValue({
        rows: [
          { permalink: "https://instagram.com/p/test", content_type: "reel" },
        ],
      } as never);
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reply({ id: "99", media: { id: "different-post" } }));
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await listSocialContentReplies(
      {
        user: { id: 9 },
        params: { id: "123", commentId: "99" },
        query: { credentialId: "22", platform: "instagram", after: "page2" },
      } as unknown as Request,
      { status, json } as unknown as ExpressResponse,
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("includes a confirmed agent reply in its own post comment thread", async () => {
    mockCommentCredential();
    const execute = jest.spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [{ permalink: null, content_type: "photo" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ comment_id: "99", provider_message_id: "101", body: "Thanks for asking!", sent_at: "2026-09-28T10:00:00Z" }] } as never);
    jest.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      data: [{ id: "99", text: "What time?", username: "guest", replies: { data: [] } }],
    }));
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await listSocialContentComments({
      user: { id: 9 }, params: { id: "123" },
      query: { credentialId: "22", platform: "instagram" },
    } as unknown as Request, { json, status } as unknown as ExpressResponse);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      comments: [expect.objectContaining({
        id: "99",
        replies: [expect.objectContaining({ id: "101", body: "Thanks for asking!", source: "agent" })],
      })],
    }));
    const query = new PgDialect().sqlToQuery(execute.mock.calls[3][0] as never);
    expect(query.sql).toContain("m.is_ai_generated=TRUE");
    expect(query.params).toEqual(expect.arrayContaining([9, "instagram_comment", "99"]));
  });
  it("loads replies beyond the initial ten via safe cursors and stops repeated provider cursors", async () => {
    mockCommentCredential();
    jest
      .spyOn(db, "execute")
      .mockResolvedValueOnce({
        rows: [
          { permalink: "https://instagram.com/p/test", content_type: "reel" },
        ],
      } as never)
      .mockResolvedValue({ rows: [] } as never);
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply({ id: "99", media: { id: "123" } }))
      .mockResolvedValueOnce(
        reply({
          data: Array.from({ length: 11 }, (_, index) => ({
            id: String(100 + index),
            text: "Reply",
            username: index === 0 ? "orocircle" : "guest",
          })),
          paging: {
            next: "https://untrusted.example",
            cursors: { after: "page2" },
          },
        }),
      );
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await listSocialContentReplies(
      {
        user: { id: 9 },
        params: { id: "123", commentId: "99" },
        query: { credentialId: "22", platform: "instagram", after: "page2" },
      } as unknown as Request,
      { status, json } as unknown as ExpressResponse,
    );
    const value = json.mock.calls[0][0] as {
      replies: { isOwn: boolean }[];
      nextCursor: string | null;
    };
    expect(value.replies).toHaveLength(11);
    expect(value.replies[0].isOwn).toBe(true);
    expect(value.nextCursor).toBeNull();
    const url = new URL(String(fetcher.mock.calls[1][0]));
    expect(url.pathname).toMatch(/99\/replies$/);
    expect(url.searchParams.get("after")).toBe("page2");
    expect(url.searchParams.get("limit")).toBe("50");
  });
  it("recovers comments when optional fields are rejected without dropping pagination", async () => {
    mockCommentCredential();
    jest.spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [{ content_type: "photo", permalink: null }] } as never)
      .mockResolvedValue({ rows: [] } as never);
    const fetcher = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply({ error: { code: 100 } }, 400))
      .mockResolvedValueOnce(reply({
        data: [{ id: "99", text: "Hello", username: "guest" }],
        paging: { next: "unused", cursors: { after: "next-page" } },
      }));
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await listSocialContentComments({
      user: { id: 9 }, params: { id: "123" },
      query: { credentialId: "22", platform: "instagram" },
    } as unknown as Request, { json, status } as unknown as ExpressResponse);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      comments: [expect.objectContaining({ id: "99", body: "Hello", moreReplies: true })],
      nextCursor: "next-page",
    }));
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("fields")).toBe("id,text,timestamp,username");
  });

  it("does not retry denied comment access or present it as an empty thread", async () => {
    mockCommentCredential();
    jest.spyOn(db, "execute").mockResolvedValue({ rows: [{ content_type: "photo" }] } as never);
    const fetcher = jest.spyOn(globalThis, "fetch")
      .mockResolvedValue(reply({ error: { code: 200 } }, 403));
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await listSocialContentComments({
      user: { id: 9 }, params: { id: "123" },
      query: { credentialId: "22", platform: "instagram" },
    } as unknown as Request, { json, status } as unknown as ExpressResponse);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "SOCIAL_ANALYTICS_PERMISSION_REQUIRED" }));
  });

  it("refreshes owned Instagram media without replacing saved metrics", async () => {
    mockCommentCredential();
    const execute = jest.spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [{
        provider_id: "123", platform: "instagram", content_type: "photo",
        published_at: "2026-09-01", thumbnail_url: "https://example.com/old.jpg",
        metrics: { reach: 300 }, limitations: [],
      }] } as never)
      .mockResolvedValue({ rows: [] } as never);
    jest.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      id: "123", media_type: "IMAGE", media_url: "https://example.com/fresh.jpg",
    }));
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await getSocialContent({
      user: { id: 9 }, params: { id: "123" },
      query: { credentialId: "22", platform: "instagram", refreshMedia: "1" },
    } as unknown as Request, { json, status } as unknown as ExpressResponse);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ thumbnailUrl: "https://example.com/fresh.jpg", metrics: { reach: 300 } }),
    }));
    const update = new PgDialect().sqlToQuery(execute.mock.calls[1][0] as never);
    expect(update.params).toEqual(expect.arrayContaining([9, 22, "123", "instagram"]));
    expect(update.sql).not.toContain("metrics=");
  });
  it("refreshes older post insights on demand while preserving captured counts", async () => {
    mockCommentCredential();
    const execute = jest.spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [{
        provider_id: "123", platform: "instagram", content_type: "photo",
        published_at: "2023-09-01", metrics: { likes: 8 }, limitations: [],
      }] } as never)
      .mockResolvedValue({ rows: [] } as never);
    jest.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      data: [{ name: "reach", total_value: { value: 120 } }],
    }));
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await getSocialContent({
      user: { id: 9 }, params: { id: "123" },
      query: { credentialId: "22", platform: "instagram", refreshMetrics: "1" },
    } as unknown as Request, { json, status } as unknown as ExpressResponse);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ metrics: { likes: 8, reach: 120 } }),
    }));
    const update = new PgDialect().sqlToQuery(execute.mock.calls[1][0] as never);
    expect(update.sql).toContain("metrics=metrics ||");
    expect(update.params).toEqual(expect.arrayContaining([9, 22, "instagram", "123"]));
  });

  it("does not represent private story replies as public comments", async () => {
    mockCommentCredential();
    jest
      .spyOn(db, "execute")
      .mockResolvedValue({ rows: [{ content_type: "story" }] } as never);
    const fetcher = jest.spyOn(globalThis, "fetch");
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    await listSocialContentComments(
      {
        user: { id: 9 },
        params: { id: "123" },
        query: { credentialId: "22", platform: "instagram" },
      } as unknown as Request,
      { status, json } as unknown as ExpressResponse,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        comments: [],
        capabilities: expect.objectContaining({ reply: false }),
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
