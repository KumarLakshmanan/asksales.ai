import { describe, expect, it } from "vitest";
import { contentAssetSmsMessage } from "@/lib/contentAssetMapping";

describe("content asset mapping", () => {
  it("extracts the message from manual SMS persistence envelopes", () => {
    expect(contentAssetSmsMessage(JSON.stringify({
      title: "QA",
      content: "Actual SMS copy",
      imageUrl: "/uploads/qa.png",
    }))).toBe("Actual SMS copy");
  });

  it("preserves legacy plain-text SMS assets", () => {
    expect(contentAssetSmsMessage("Legacy SMS copy")).toBe("Legacy SMS copy");
  });
});
