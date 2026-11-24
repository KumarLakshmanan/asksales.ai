import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../models/db.js";
import { listListeningEvents } from "../controllers/socialAnalyticsController.js";
import {
  collectOfficialCommentPages,
  contentFromRow,
  normalizeContent,
  synchronizeSocialContent,
  discoverSocialContentHistory,
} from "../services/social/SocialContentInsightsService.js";
const compile = (query: unknown) => new PgDialect().sqlToQuery(query as never);
const response = () => {
  const json = jest.fn();
  const status = jest.fn((_code: number) => ({ json }));
  return { json, status, value: { json, status } as unknown as Response };
};
const request = (query: Record<string, unknown>) =>
  ({ user: { id: 17 }, query }) as unknown as Request;
afterEach(() => {
  jest.restoreAllMocks();
});
describe("Listening source context and continuation", () => {
  it("defaults to comments and counts tagged content separately", async () => {
    const execute = jest
      .spyOn(db, "execute")
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ kind: "tags", count: 14 }] } as never);
    const res = response();
    await listListeningEvents(request({ paginated: "1" }), res.value);
    expect(compile(execute.mock.calls[0][0]).params).toContain("comments");
    expect(compile(execute.mock.calls[2][0]).params).not.toContain("comments");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 0,
        sourceSummary: { comments: 0, tags: 14, manual: 0 },
      }),
    );
  });
  it("scopes post conversations to an owned account without a publication date restriction", async () => {
    jest.spyOn(db, "select").mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 22, platform: "instagram_api" }],
        }),
      }),
    } as never);
    const execute = jest
      .spyOn(db, "execute")
      .mockResolvedValue({ rows: [] } as never);
    await listListeningEvents(
      request({
        platform: "instagram",
        credentialId: "22",
        postId: "123",
        kind: "all",
      }),
      response().value,
    );
    const query = compile(execute.mock.calls[0][0]);
    expect(query.params).toEqual(expect.arrayContaining([17, "22", "123"]));
    expect(query.sql).toContain("metadata->>'contentId'");
    expect(query.sql).not.toContain("occurred_at >=");
    expect(query.sql).toContain("content.user_id=");
  });
  it("rejects post-only queries without account scope", async () => {
    const execute = jest.spyOn(db, "execute");
    const res = response();
    await listListeningEvents(request({ postId: "123" }), res.value);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(execute).not.toHaveBeenCalled();
  });
  it("persists provider cursors at the batch limit and resumes on the next collection", async () => {
    const first = jest.fn(async () => ({
      data: [{ id: "1" }],
      paging: {
        next: "https://provider.invalid/token",
        cursors: { after: "cursor-two" },
      },
    }));
    const saved: string[] = [];
    const onCursor = async (cursor: string | null) => {
      saved.push(String(cursor));
    };
    const consume = jest.fn(async () => {});
    expect(
      await collectOfficialCommentPages(
        { platform: "instagram", request: first },
        "123",
        consume,
        1,
        { onCursor },
      ),
    ).toEqual({ count: 1, truncated: true });
    expect(saved).toEqual(["cursor-two"]);
    const next = jest.fn(async (_path: string, _params?: Record<string, unknown>) => ({ data: [{ id: "2" }] }));
    expect(
      await collectOfficialCommentPages(
        { platform: "instagram", request: next },
        "123",
        consume,
        1,
        { after: saved[0], onCursor },
      ),
    ).toEqual({ count: 1, truncated: false });
    expect(next).toHaveBeenCalledWith(
      "123/comments",
      expect.objectContaining({ after: "cursor-two" }),
    );
    expect(saved.at(-1)).toBe("null");
  });
  it("collects comments on older captured posts and resumes their stored cursor without overwriting sentiment", async () => {
    jest.spyOn(db, "select").mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 22,
              platform: "instagram_api",
              accountIdentifier: "1234",
              accessToken: "test-token",
            },
          ],
        }),
      }),
    } as never);
    jest.spyOn(db, "update").mockImplementation(() => {
      throw new Error("No admin settings in test");
    });
    const execute = jest
      .spyOn(db, "execute")
      .mockImplementation(async (query) => {
        const statement = compile(query).sql;
        if (statement.includes("COUNT(*)"))
          return { rows: [{ total: 101 }] } as never;
        if (statement.includes("SELECT * FROM social_content_items"))
          return {
            rows: [
              {
                provider_id: "99",
                platform: "instagram",
                content_type: "photo",
                published_at: "2026-01-01",
                listening_after: "older-page",
                permalink: "https://instagram.com/p/old",
              },
            ],
          } as never;
        return { rows: [] } as never;
      });
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        return new globalThis.Response(
          JSON.stringify(
            url.pathname.endsWith("99/comments")
              ? {
                  data: [
                    {
                      id: "77",
                      text: "Still love this",
                      timestamp: "2026-09-18T12:00:00Z",
                      username: "visitor",
                    },
                  ],
                }
              : { data: [] },
          ),
          { status: 200 },
        );
      });
    await synchronizeSocialContent(17, 22, "2026-09-01", "2026-09-19");
    const commentsRequest = fetcher.mock.calls
      .map((call) => new URL(String(call[0])))
      .find((url) => url.pathname.endsWith("99/comments"));
    expect(commentsRequest?.searchParams.get("after")).toBe("older-page");
    const compiled = execute.mock.calls.map((call) => compile(call[0]));
    const batch = compiled.find((query) =>
      query.sql.includes("SELECT * FROM social_content_items"),
    )!;
    expect(batch.sql).toContain("listening_attempted_at ASC NULLS FIRST");
    expect(batch.sql).not.toContain("published_at >=");
    expect(batch.sql).toContain("LIMIT 100");
    const upsert = compiled.find((query) =>
      query.sql.includes("INSERT INTO social_listening_events"),
    )!;
    expect(upsert.params).toContain("Still love this");
    expect(upsert.sql.split("DO UPDATE SET")[1]).not.toContain("sentiment=");
  });
  it("discovers older history in bounded pages without date filters or per-post insights", async () => {
    const execute = jest
      .spyOn(db, "execute")
      .mockImplementation(async (query) =>
        compile(query).sql.includes("SELECT discovery_state")
          ? ({
              rows: [
                {
                  discovery_state: {
                    media: { after: "older-history", scanned: 100 },
                  },
                },
              ],
            } as never)
          : ({ rows: [] } as never),
      );
    const request = jest.fn(
      async (_path: string, query: Record<string, string>) => ({
        data: [
          {
            id: query.after === "older-history" ? "111" : "112",
            timestamp: "2020-01-01",
            media_type: "IMAGE",
          },
        ],
        paging: {
          next: "https://ignored.example",
          cursors: {
            after:
              query.after === "older-history" ? "next-older" : "oldest-page",
          },
        },
      }),
    );
    const result = await discoverSocialContentHistory(17, 22, {
      platform: "instagram",
      credential: { accountIdentifier: "1234" },
      request,
    } as never);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ captured: 2, complete: false });
    expect(request.mock.calls[0][1]).not.toHaveProperty("after");
    expect(request.mock.calls[1][1]).toMatchObject({
      after: "older-history",
      limit: "50",
    });
    for (const [path, query] of request.mock.calls) {
      expect(path).toBe("1234/media");
      expect(query).not.toHaveProperty("since");
      expect(query).not.toHaveProperty("until");
    }
    const checkpoints = execute.mock.calls
      .map((call) => compile(call[0]))
      .filter((query) => query.sql.includes("SET discovery_state"));
    expect(JSON.parse(String(checkpoints.at(-1)!.params[0])).media.after).toBe(
      "next-older",
    );
  });
  it("keeps Facebook video thumbnails separate from playable media", () => {
    const item = normalizeContent("facebook", {
      id: "123_456",
      created_time: "2026-09-19",
      attachments: {
        data: [
          {
            media_type: "video",
            target: { id: "456" },
            media: { image: { src: "https://cdn.example/thumbnail.jpg" } },
            subattachments: {
              data: [
                {
                  media_type: "video",
                  media: { image: { src: "https://cdn.example/child.jpg" } },
                },
              ],
            },
          },
        ],
      },
    })!;
    expect(item.mediaUrl).toBeNull();
    expect(item.thumbnailUrl).toBe("https://cdn.example/thumbnail.jpg");
    expect(item.children?.[0].mediaUrl).toBeNull();
    expect(item.children?.[0].thumbnailUrl).toBe(
      "https://cdn.example/child.jpg",
    );
    expect(item.providerMediaId).toBe("456");
  });
  it("keeps carousel video media and validates stored URLs for the detail page", () => {
    const item = normalizeContent("instagram", {
      id: "123",
      timestamp: "2026-09-18",
      media_type: "CAROUSEL_ALBUM",
      media_url: "https://cdn.example/cover.jpg",
      children: {
        data: [
          {
            id: "456",
            media_type: "VIDEO",
            media_url: "https://cdn.example/video.mp4",
            thumbnail_url: "https://cdn.example/thumb.jpg",
          },
        ],
      },
    })!;
    expect(item.children?.[0]).toEqual({
      id: "456",
      type: "video",
      mediaUrl: "https://cdn.example/video.mp4",
      thumbnailUrl: "https://cdn.example/thumb.jpg",
    });
    const restored = contentFromRow({
      provider_id: "123",
      platform: "instagram",
      content_type: "carousel",
      published_at: "2026-09-18",
      media_url: "javascript:alert(1)",
      media_children: [
        { id: "456", type: "video", mediaUrl: "https://cdn.example/video.mp4" },
      ],
    });
    expect(restored.mediaUrl).toBeNull();
    expect(restored.children?.[0].mediaUrl).toBe(
      "https://cdn.example/video.mp4",
    );
  });
});
