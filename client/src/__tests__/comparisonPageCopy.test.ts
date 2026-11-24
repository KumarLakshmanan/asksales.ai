import { describe, expect, it } from "vitest";
import { comparisons } from "@/lib/comparison-content";
import { comparisonLinks } from "@/lib/comparisons";

describe("competitor comparison pages", () => {
  it("gives every competitor its own hero headline and at least one specific difference", () => {
    const headlines = comparisons.map((comparison) => comparison.headline);
    expect(new Set(headlines).size).toBe(comparisons.length);
    for (const comparison of comparisons) {
      expect(comparison.headline.trim()).not.toBe("");
      expect(comparison.differences.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("covers every linked competitor exactly once", () => {
    expect(comparisons.map((comparison) => comparison.slug).sort()).toEqual(comparisonLinks.map((link) => link.slug).sort());
  });
});
