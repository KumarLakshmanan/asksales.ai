import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
const summaryWhere = jest.fn();
const rowsWhere = jest.fn();
let leads: Array<Record<string, unknown>> = [];
const transaction = jest.fn<any>();
const select = jest.fn<any>((fields: Record<string, unknown>) => {
  if ("totalLeads" in fields)
    return {
      from: () => ({
        where: (predicate: unknown) => {
          summaryWhere(predicate);
          return Promise.resolve([
            {
              totalLeads: leads.length,
              active: 1,
              converted: 1,
              qualified: 1,
              contacted: 0,
            },
          ]);
        },
      }),
    };
  let limit = 20;
  const builder = {
    from: () => builder,
    leftJoin: () => builder,
    where: (predicate: unknown) => {
      rowsWhere(predicate);
      return builder;
    },
    orderBy: () => builder,
    limit: (value: number) => {
      limit = value;
      return builder;
    },
    offset: (value: number) =>
      Promise.resolve(leads.slice(value, value + limit)),
  };
  return builder;
});
const selectDistinct = jest.fn<any>(() => ({
  from: () => ({
    where: () => ({ orderBy: () => Promise.resolve([{ value: "new" }]) }),
  }),
}));
jest.unstable_mockModule("../models/db.js", () => ({ db: { transaction } }));
const service = await import("../services/AdminLeadDirectoryService.js");
const dialect = new PgDialect();
beforeEach(() => {
  jest.clearAllMocks();
  leads = [];
  transaction.mockImplementation(async (callback: any) =>
    callback({ select, selectDistinct }),
  );
});
describe("canonical admin lead directory", () => {
  it("rejects invalid pagination, arrays, IDs and ranges before querying", () => {
    for (const query of [
      { page: "-1" },
      { pageSize: "201" },
      { pageSize: "2x" },
      { userId: "NaN" },
      { search: ["one", "two"] },
      { minScore: "80", maxScore: "20" },
      { sortBy: "raw sql" },
    ])
      expect(() => service.parseAdminLeadFilters(query)).toThrow();
    expect(
      service.parseAdminLeadFilters({
        page: "2",
        pageSize: "50",
        search: " ACME ",
        source: "instagram",
      }),
    ).toMatchObject({
      page: 2,
      pageSize: 50,
      search: "ACME",
      source: "instagram",
    });
    expect(
      service.parseAdminLeadFilters({ search: "all", status: "all" }),
    ).toMatchObject({ search: "all", status: undefined });
  });
  it("applies deletion, owner, source, status, literal search and score predicates together", () => {
    const compiled = dialect.sqlToQuery(
      and(
        ...service.adminLeadPredicates({
          userId: 42,
          status: "contacted",
          source: "instagram",
          search: "20%_sale",
          minScore: 10,
          maxScore: 80,
        }),
      )!,
    );
    expect(compiled.sql).toContain('"deleted_at" is null');
    expect(compiled.sql).toContain('"source" =');
    expect(compiled.sql).toContain('"status" =');
    expect(compiled.params).toContain(42);
    expect(compiled.params).toContain("%20\\%\\_sale%");
    expect(compiled.params).toContain(80);
  });
  it("returns real items with accurate filtered totals, snapshot stats and bounded page", async () => {
    leads = Array.from({ length: 23 }, (_, index) => ({ id: index + 1 }));
    const result = await service.listAdminLeads({
      page: 99,
      pageSize: 20,
      status: "new",
    });
    expect(result.items).toHaveLength(3);
    expect(result.pagination).toEqual({
      total: 23,
      page: 2,
      pageSize: 20,
      totalPages: 2,
    });
    expect(result.stats.conversionRate).toBe(4);
    expect(dialect.sqlToQuery(summaryWhere.mock.calls[0][0] as any)).toEqual(
      dialect.sqlToQuery(rowsWhere.mock.calls[0][0] as any),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      readOnly: true,
    });
  });
  it("exports every matching row beyond the first batch with identical predicates", async () => {
    leads = Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1,
      name: index ? `Lead ${index}` : '=HYPERLINK("unsafe")',
      source: "instagram",
    }));
    const chunks: string[] = [];
    await service.exportAdminLeads({ source: "instagram" }, async (chunk) => {
      chunks.push(chunk);
    });
    const csv = chunks.join("");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1002);
    expect(csv).toContain('"1001"');
    expect(csv).toContain('"\'=HYPERLINK(""unsafe"")"');
    expect(rowsWhere).toHaveBeenCalledTimes(2);
  });
  it("escapes CSV delimiters, quotes, multiline fields and spreadsheet formulas", () => {
    expect(service.adminLeadCsvCell('ACME, "West"\nBranch')).toBe(
      '"ACME, ""West""\nBranch"',
    );
    expect(service.adminLeadCsvCell("  +cmd")).toBe('"\'  +cmd"');
    expect(service.adminLeadCsvCell(null)).toBe('""');
  });
});
