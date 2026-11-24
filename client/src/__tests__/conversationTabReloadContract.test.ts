import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("conversation tab reload contract", () => {
  it("exits the saved-workspace spinner with a visible timeout failure", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("tabLoadTimedOut = true");
    expect(page).toContain("setTabsLoaded(true)");
    expect(page).toContain("did not respond within 10 seconds");
  });
});
