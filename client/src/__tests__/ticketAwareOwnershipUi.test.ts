import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ticket-aware ownership UI", () => {
  it("distinguishes a bounded factual answer from AI ownership resumption", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/dashboard/(main)/support/[id]/page.tsx"),
      "utf8",
    );

    expect(source).toContain("Bounded informational AI answer");
    expect(source).toContain("Human ownership did not resume.");
    expect(source).toContain("Message retained for the human queue");
    expect(source).toContain("Human ownership retained");
    expect(source).toContain("AI explicitly resumed");
    expect(source).toContain("An operator resolved the ticket without resuming AI.");
    expect(source).toContain("ownershipResolution.resolvedAt");
  });
});
