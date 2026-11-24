import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";

const listFiles =
  jest.fn<
    (
      userId: number,
      options: unknown,
    ) => Promise<{ files: Array<{ id: number }>; total: number }>
  >();
const owner = jest.fn<() => number | null>();
jest.unstable_mockModule("../services/StorageService.js", () => ({
  storageService: { listFiles },
  StorageLimitError: class extends Error {},
}));
jest.unstable_mockModule("../tenancy/businessContext.js", () => ({
  businessOwnerUserId: owner,
}));
jest.unstable_mockModule("../services/billing/entitlements.js", () => ({
  normalizeCapacityError: jest.fn(),
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { error: jest.fn() },
}));
const { getMyFiles } = await import("../controllers/storageController.js");

function response() {
  const json = jest.fn();
  const status = jest.fn();
  const result = { json, status };
  status.mockReturnValue(result);
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  owner.mockReturnValue(7);
  listFiles.mockResolvedValue({ files: [{ id: 1 }], total: 60 });
});

describe("storage browsing request boundary", () => {
  it("passes normalized search, validated sort, folder and bounded pagination to the owner-scoped query", async () => {
    const res = response();
    await getMyFiles(
      {
        query: {
          category: "actor_output",
          search: "  leads  ",
          sort: "size",
          folder: "export/run-1",
          limit: "999",
          offset: "50",
        },
      } as unknown as Request,
      res as unknown as Response,
    );
    expect(listFiles).toHaveBeenCalledWith(7, {
      category: "actor_output",
      search: "leads",
      sort: "size",
      folder: "export/run-1",
      limit: 200,
      offset: 50,
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          total: 60,
          pagination: { limit: 200, offset: 50, hasMore: true },
        }),
      }),
    );
  });

  it.each([
    { search: ["a", "b"] },
    { search: "a".repeat(256) },
    { sort: "unsafe" },
    { category: "../image" },
    { category: "image", folder: "export/run-1" },
    { category: "actor_output", folder: "" },
  ])(
    "rejects malformed filter input before querying storage: %j",
    async (query) => {
      const res = response();
      await getMyFiles(
        { query } as unknown as Request,
        res as unknown as Response,
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(listFiles).not.toHaveBeenCalled();
    },
  );

  it("does not query storage without an authenticated owner", async () => {
    owner.mockReturnValue(null);
    const res = response();
    await getMyFiles({ query: {} } as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(listFiles).not.toHaveBeenCalled();
  });
});
