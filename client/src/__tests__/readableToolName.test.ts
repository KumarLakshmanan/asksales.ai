import { describe, expect, it } from "vitest";
import { readableToolName } from "@/lib/readableToolName";

describe("readableToolName", () => {
  it("hides the provider and actor behind a lead search step", () => {
    expect(readableToolName("apify_linkedin_company_search_scraper")).toBe("LinkedIn company search");
    expect(readableToolName("linkedin_company_search")).toBe("LinkedIn company search");
  });

  it("keeps other tool names readable", () => {
    expect(readableToolName("get_outreach_preparation_options")).toBe("Get outreach preparation options");
    expect(readableToolName("google_maps")).toBe("Google maps");
    expect(readableToolName("___")).toBe("Step");
  });
});
