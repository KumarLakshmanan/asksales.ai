import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/app/support/tickets/[id]/page.tsx"),
  "utf8",
);

describe("support ticket takeover refresh contract", () => {
  it("refreshes the authoritative handoff projection after status changes", () => {
    expect(source).toContain(
      "const fetchTicket = useCallback(async (options?: { background?: boolean })",
    );
    expect(source).toContain('if (field === "status")');
    expect(source).toContain("await fetchTicket({ background: true })");
    expect(source).toContain(
      "AI replies are active again for the next customer message.",
    );
  });
});
