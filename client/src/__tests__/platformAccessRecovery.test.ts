import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfiguration from '../../next.config';

const readClientFile = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("platform access recovery", () => {
  it("keeps access fail-closed while automatically retrying transient outages", () => {
    const hook = readClientFile("src/hooks/use-platform-access.ts");
    const layout = readClientFile("src/app/dashboard/(main)/layout.tsx");

    expect(hook).toContain('query.state.status === "error" ? 5_000 : false');
    expect(hook).toContain("failureCount < 4");
    expect(layout).toContain('title={`Reconnecting to ${BRAND_NAME}`}');
    expect(layout).toContain("no module will be opened until server verification succeeds");
  });

  it("does not persist the large production webpack cache", () => {
    const nextConfig = readClientFile("next.config.ts");
    expect(nextConfig).toContain("if (!dev) config.cache = false");
    expect(nextConfiguration.turbopack?.resolveAlias).toEqual({
      "./blogContent.js": "../shared/blogContent.ts",
      "./emailTemplateSections.js": "../shared/emailTemplateSections.ts",
    });
  });
});
