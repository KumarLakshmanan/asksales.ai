import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const select = jest.fn();
const totalWhere =
  jest.fn<(condition: SQL) => Promise<Array<{ count: number }>>>();
const fileWhere = jest.fn();
const orderBy = jest.fn();
const offset =
  jest.fn<
    (
      offset: number,
    ) => Promise<Array<{ id: number; category: string; url: string }>>
  >();
jest.unstable_mockModule("../models/db", () => ({ db: { select } }));
jest.unstable_mockModule("../services/ObjectStorageService.js", () => ({
  objectStorage: {},
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../utils/safeRemoteFetch.js", () => ({
  fetchPublicHttpUrl: jest.fn(),
  readResponseBuffer: jest.fn(),
}));
jest.unstable_mockModule("../services/billing/entitlements.js", () => ({
  releaseOrganizationStorage: jest.fn(),
  reserveOrganizationStorage: jest.fn(),
  storageOrganizationEntitlements: jest.fn(),
}));
const { storageService } = await import("../services/StorageService.js");
const dialect = new PgDialect();

beforeEach(() => {
  jest.clearAllMocks();
  const totalQuery = { from: jest.fn(), where: totalWhere };
  totalQuery.from.mockReturnValue(totalQuery);
  totalWhere.mockResolvedValue([{ count: 2 }]);
  const fileQuery = {
    from: jest.fn(),
    where: fileWhere,
    orderBy,
    limit: jest.fn(),
    offset,
  };
  fileQuery.from.mockReturnValue(fileQuery);
  fileWhere.mockReturnValue(fileQuery);
  orderBy.mockReturnValue(fileQuery);
  fileQuery.limit.mockReturnValue(fileQuery);
  offset.mockResolvedValue([
    { id: 3, category: "document", url: "/private/document.txt" },
  ]);
  select.mockReturnValueOnce(totalQuery).mockReturnValueOnce(fileQuery);
});

describe("storage library database queries", () => {
  it("searches literal file names within the owner scope and uses the same predicate for totals and results", async () => {
    const result = await storageService.listFiles(7, {
      search: "50%_launch\\",
      category: "image",
    });
    const predicate = dialect.sqlToQuery(totalWhere.mock.calls[0][0] as SQL);
    expect(predicate.sql).toContain('"storage_files"."user_id" =');
    expect(predicate.sql).toContain('"storage_files"."is_deleted" =');
    expect(predicate.sql).toContain('"storage_files"."original_name" ilike');
    expect(predicate.params).toEqual([
      7,
      false,
      "image",
      "%50\\%\\_launch\\\\%",
      "%50\\%\\_launch\\\\%",
    ]);
    expect(dialect.sqlToQuery(fileWhere.mock.calls[0][0] as SQL)).toEqual(
      predicate,
    );
    expect(result.total).toBe(2);
    expect(result.files[0].url).toBe(
      "/api/settings/storage/files/3/download?inline=true",
    );
  });

  it("scopes a run to the exact owner namespace without including other or nested runs", async () => {
    await storageService.listFiles(7, {
      category: "actor_output",
      folder: "export/run-1",
      offset: 50,
    });
    const predicate = dialect.sqlToQuery(fileWhere.mock.calls[0][0] as SQL);
    expect(predicate.sql).toContain("regexp_replace");
    expect(predicate.params).toContain("7/actor_output/export/run-1");
    expect(predicate.params[0]).toBe(7);
    expect(offset).toHaveBeenCalledWith(50);
  });

  it.each([
    [
      "newest",
      '"storage_files"."created_at" desc',
      '"storage_files"."id" desc',
    ],
    ["oldest", '"storage_files"."created_at" asc', '"storage_files"."id" asc'],
    ["name", "lower(coalesce(", '"storage_files"."id" asc'],
    [
      "size",
      '"storage_files"."file_size_bytes" desc',
      '"storage_files"."id" desc',
    ],
  ] as const)(
    "sorts %s with a stable pagination tie-breaker",
    async (sort, primary, tieBreaker) => {
      await storageService.listFiles(7, { sort });
      expect(dialect.sqlToQuery(orderBy.mock.calls[0][0] as SQL).sql).toContain(
        primary,
      );
      expect(dialect.sqlToQuery(orderBy.mock.calls[0][1] as SQL).sql).toBe(
        tieBreaker,
      );
    },
  );
});
