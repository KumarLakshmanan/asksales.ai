import { describe, expect, it } from "vitest";
import { markdownToPreviewText } from "@/lib/markdownPreview";
import { supportQueuePresentation, withReadablePrivacyTokens } from "@/lib/supportQueuePresentation";

describe("dashboard audit fixes", () => {
  it("drops markdown markers from one-line prompt previews", () => {
    expect(markdownToPreviewText('**Concept: The ₹500 Mystery** – **Main headline:** "WHERE DID YOUR ₹500 GO?"'))
      .toBe('Concept: The ₹500 Mystery – Main headline: "WHERE DID YOUR ₹500 GO?"');
    expect(markdownToPreviewText("## Scene 1\n- Show a desk with `laptop`")).toBe("Scene 1\nShow a desk with laptop");
    expect(markdownToPreviewText(null)).toBe("");
  });

  it("shows privacy-vault tokens as readable stand-ins in the support queue", () => {
    expect(withReadablePrivacyTokens("I'm [NAME_252244243010479] a stay, mail [EMAIL_2]")).toBe("I'm (name) a stay, mail (email)");
    const { headline } = supportQueuePresentation({ ticketNumber: "TKT-1", subject: "I'm [NAME_25] a stay for 2 people", description: null, handoffReason: null, lastMessagePreview: null, lastMessageDirection: null });
    expect(headline).toBe("I'm (name) a stay for 2 people");
  });
});
