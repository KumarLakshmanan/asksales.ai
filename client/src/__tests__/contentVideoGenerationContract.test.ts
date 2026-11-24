import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  resolve(process.cwd(), "src/components/content-studio/creators/VideoCreator.tsx"),
  "utf8",
);

describe("content studio video generation contract", () => {
  it("defaults to a Seedance 2.5-supported resolution", () => {
    expect(page).toContain('useState("720p")');
    expect(page).toContain('{ value: "480p", label: "480p"');
    expect(page).toContain('{ value: "720p", label: "720p"');
    expect(page).not.toContain('{ value: "1080p", label: "1080p"');
  });
});
