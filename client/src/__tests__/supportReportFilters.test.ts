import { describe, expect, it } from "vitest";
import {
  readSupportFilters,
  supportRouteMemoryKey,
  restoreSupportNavigationHref,
  parseSupportRouteMemory,
  sameSupportScope,
  supportNavigationHref,
  supportPageNumber,
  updateSupportQuery,
  supportFilterParams,
  supportDateRangeError,
} from "@/lib/support-report";

describe("support report URL state", () => {
  it('defaults to a valid UTC range and omits empty optional API parameters', () => {
    const filters = readSupportFilters(new URLSearchParams());
    expect(filters.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((Date.parse(filters.to) - Date.parse(filters.from)) / 86400000).toBe(29);
    expect(supportFilterParams(filters)).not.toHaveProperty('teamId');
    expect(supportFilterParams(filters)).not.toHaveProperty('assistantId');
    expect(supportDateRangeError(new URLSearchParams('from=2026-02-30'))).toBe('Choose a valid from date.');
    expect(supportDateRangeError(new URLSearchParams('from=2026-10-05&to=2026-09-01'))).toContain('on or before');
  });
  it("accepts real date ranges and rejects overflow dates and unsupported sources", () => {
    expect(
      readSupportFilters(
        new URLSearchParams("from=2026-02-30&to=2026-10-03&source=unknown"),
      ),
    ).toEqual({
      from: "",
      to: "2026-10-03",
      source: "all",
      teamId: "",
      assistantId: "",
    });
    expect(
      readSupportFilters(
        new URLSearchParams(
          "from=2024-02-29&source=widget&teamId=12&assistantId=assistant-1",
        ),
      ),
    ).toMatchObject({
      from: "2024-02-29",
      source: "widget",
      teamId: "12",
      assistantId: "assistant-1",
    });
  });
  it("preserves independent list pages and selected conversation when switching tabs", () => {
    const current = new URLSearchParams(
      "sessionPage=4&leadPage=2&sessionId=145&tab=conversations&source=widget",
    );
    const next = updateSupportQuery(current, {
      tab: "leads",
      leadSearch: "Jane & Company",
      leadPage: null,
    });
    expect(next.get("sessionPage")).toBe("4");
    expect(next.get("sessionId")).toBe("145");
    expect(next.has("leadPage")).toBe(false);
    expect(next.get("leadSearch")).toBe("Jane & Company");
    expect(current.get("tab")).toBe("conversations");
  });
  it("carries common activity filters across pages without leaking conversation identifiers", () => {
    const href = supportNavigationHref(
      "/dashboard/support-ai/quality",
      new URLSearchParams(
        "from=2026-09-01&source=widget&teamId=12&sessionId=145&sessionPage=4&tab=leads",
      ),
    );
    expect(href).toBe(
      "/dashboard/support-ai/quality?from=2026-09-01&source=widget&teamId=12",
    );
  });
  it("restores report selection, pagination, and search when returning from another page", () => {
    const saved =
      "tab=conversations&sessionId=145&sessionPage=4&leadPage=2&sessionSearch=invoice&source=widget";
    const href = restoreSupportNavigationHref(
      "/dashboard/support-ai/reports",
      new URLSearchParams("source=internal"),
      saved,
    );
    expect(href).toContain("sessionId=145");
    expect(href).toContain("sessionPage=4");
    expect(href).toContain("sessionSearch=invoice");
    expect(href).toContain("source=internal");
    expect(supportRouteMemoryKey(7, 10)).not.toBe(supportRouteMemoryKey(7, 11));
    expect(supportRouteMemoryKey(7, 10)).not.toBe(supportRouteMemoryKey(8, 10));
    expect(
      parseSupportRouteMemory(
        JSON.stringify({
          "/dashboard/support-ai/reports": saved,
          "/bad": "sessionId=1",
        }),
      ),
    ).toEqual({ "/dashboard/support-ai/reports": saved });
    expect(parseSupportRouteMemory("invalid-json")).toEqual({});
  });
  it("bounds malformed pagination and only retains previous results in the same private scope", () => {
    for (const value of [null, "0", "-2", "1.5", "NaN", "9007199254740999"])
      expect(supportPageNumber(value)).toBe(1);
    expect(supportPageNumber("42")).toBe(42);
    expect(
      sameSupportScope(
        ["support-ai-report", 7, 10, { page: 1 }],
        ["support-ai-report", 7, 10, { page: 2 }],
      ),
    ).toBe(true);
    expect(
      sameSupportScope(
        ["support-ai-report", 7, 10],
        ["support-ai-report", 7, 11],
      ),
    ).toBe(false);
    expect(
      sameSupportScope(
        ["support-ai-report", 7, 10],
        ["support-ai-report", 8, 10],
      ),
    ).toBe(false);
    expect(
      sameSupportScope(
        ["support-ai-quality", 7, 10],
        ["support-ai-report", 7, 10],
      ),
    ).toBe(false);
  });
});
