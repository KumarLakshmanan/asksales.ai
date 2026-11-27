import { describe, expect, it } from "vitest";
import { replyCreditsLabel } from "@/components/MessageBubble";

describe("credits shown under a reply", () => {
  it("shows what the reply cost", () => {
    expect(replyCreditsLabel(11)).toBe(" · 11 credits");
    expect(replyCreditsLabel(1)).toBe(" · 1 credit");
    expect(replyCreditsLabel(2.5)).toBe(" · 2.5 credits");
    expect(replyCreditsLabel(0.25)).toBe(" · 0.25 credits");
  });

  it("shows nothing when no cost was recorded", () => {
    expect(replyCreditsLabel(undefined)).toBe("");
    expect(replyCreditsLabel(0)).toBe("");
    expect(replyCreditsLabel("abc")).toBe("");
  });
});
