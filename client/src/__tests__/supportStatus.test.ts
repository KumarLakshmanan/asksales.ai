import { describe, expect, it } from "vitest";
import { formatSupportTicketStatus } from "@/lib/supportStatus";

describe("support ticket status labels", () => {
  it("formats every separator in multi-word lifecycle states", () => {
    expect(formatSupportTicketStatus("waiting_on_customer")).toBe("waiting on customer");
    expect(formatSupportTicketStatus("in_progress")).toBe("in progress");
    expect(formatSupportTicketStatus("closed")).toBe("closed");
  });
});
