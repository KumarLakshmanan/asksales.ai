import { describe, expect, it } from "vitest";
import {
  averageActiveDaySpend,
  billingDateRange,
  billingWindowStart,
} from "@/lib/billing-reporting";
describe("billing reporting periods", () => {
  it("averages only spending within the returned reporting window", () => {
    expect(
      averageActiveDaySpend([
        {
          date: "2026-10-01",
          debits: 10,
          credits: 0,
          net: -10,
          transactionCount: 1,
        },
        {
          date: "2026-10-02",
          debits: 30,
          credits: 500,
          net: 470,
          transactionCount: 2,
        },
        {
          date: "2026-10-03",
          debits: 0,
          credits: 800,
          net: 800,
          transactionCount: 1,
        },
      ]),
    ).toBe(20);
    expect(averageActiveDaySpend()).toBe(0);
  });
  it("matches the server daily chart UTC boundary including today", () => {
    expect(billingWindowStart(30, new Date("2026-10-03T05:30:00Z"))).toBe(
      "2026-09-04T00:00:00.000Z",
    );
    expect(billingWindowStart(1, new Date("2026-10-03T23:59:00Z"))).toBe(
      "2026-10-03T00:00:00.000Z",
    );
  });
  it("includes the whole end date and distinguishes lifetime from ranged queries", () => {
    expect(billingDateRange()).toEqual({ start: "", end: "", query: "" });
    expect(billingDateRange("2026-10-01", "2026-10-03")).toMatchObject({
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-10-03T23:59:59.999Z",
    });
  });
});
