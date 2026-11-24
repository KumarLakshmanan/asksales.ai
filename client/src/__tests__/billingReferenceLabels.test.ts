import { describe, expect, it } from "vitest";
import { getBillingReferenceMeta, humanizeReferenceType } from "@/app/dashboard/(main)/billing/_components/billingMetadata";

describe("billing reference labels", () => {
  it("labels the charge types the server writes today", () => {
    for (const type of ["media_generation", "crm_contact", "outreach_message", "ai_visibility_audit", "ai_visibility_audit_usage", "whatsapp_message_charge"]) {
      expect(getBillingReferenceMeta(type).label).not.toContain("_");
    }
    expect(getBillingReferenceMeta("media_generation").label).toBe("Image & video generation");
  });

  it("shows an unlabelled type as words instead of a code", () => {
    expect(humanizeReferenceType("lead_score_update")).toBe("Lead score update");
    expect(getBillingReferenceMeta("new-thing").label).toBe("New thing");
    expect(humanizeReferenceType("")).toBe("Other");
  });
});
