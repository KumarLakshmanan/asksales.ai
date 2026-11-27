import { describe, expect, it } from "vitest";
import { displayTabLabel } from "@/lib/tabDisplayLabel";
import { normalizeTabType } from "@/lib/tabConfig";

describe("one name per workspace tab", () => {
  it("uses the registry name for fixed tabs, whatever older code saved", () => {
    expect(displayTabLabel("agentchoose", "Choose Agent")).toBe("Agents");
    expect(displayTabLabel("lead-inputs", "Lead Inputs")).toBe("Search Settings");
    expect(displayTabLabel("ads")).toBe("Ad Copy");
    expect(displayTabLabel("performancemarketing", "Performance & Analytics")).toBe("Performance Marketing");
    expect(displayTabLabel("search", "Search 2")).toBe("Search");
  });

  it("opens old Lead Config tabs as Search Settings", () => {
    expect(normalizeTabType("leadconfig")).toBe("lead-inputs");
    expect(normalizeTabType("lead-config")).toBe("lead-inputs");
    expect(displayTabLabel("leadconfig", "Lead Config")).toBe("Search Settings");
  });

  it("keeps content titles and fixes the platform name in post plans", () => {
    expect(displayTabLabel("socialpostpreview", "linkedin plan (5 posts)")).toBe("LinkedIn plan (5 posts)");
    expect(displayTabLabel("content-email", "Welcome sequence")).toBe("Welcome sequence");
    expect(displayTabLabel("content-email", "")).toBe("Email");
  });
});
