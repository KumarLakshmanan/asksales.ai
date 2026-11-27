import { describe, expect, it } from "vitest";
import { icpSummaryFields } from "@/lib/icpSummaryFields";

describe("ICP summary shown as fields", () => {
  it("splits the saved one-line summary into labelled fields", () => {
    expect(icpSummaryFields("Target Audience: School owners | Industry: Education | Regions: Chennai, Bengaluru")).toEqual([
      { label: "Target Audience", value: "School owners" },
      { label: "Industry", value: "Education" },
      { label: "Regions", value: "Chennai, Bengaluru" },
    ]);
  });

  it("leaves free-text summaries alone", () => {
    expect(icpSummaryFields("Schools that want AI tutoring | and parents")).toBeNull();
    expect(icpSummaryFields("Target Audience: School owners")).toBeNull();
    expect(icpSummaryFields(null)).toBeNull();
  });
});
