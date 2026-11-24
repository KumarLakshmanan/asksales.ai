import { describe, expect, it } from "@jest/globals";
import { applyWhatsAppReceipts } from "../models/outreachConversations/whatsappReceipts.js";
const timestamp = "2026-10-28T13:00:00Z";
const receipt = (status: string) => ({
  event_type: `whatsapp_${status}`,
  timestamp,
  raw_data: { status: { errors: [{ message: "Media upload error" }] } },
});
describe("WhatsApp receipt before send acknowledgement", () => {
  it("keeps an early provider failure when the HTTP send later succeeds", () => {
    expect(
      applyWhatsAppReceipts({ status: "sent" }, [
        receipt("failed"),
        receipt("sent"),
      ]),
    ).toMatchObject({
      status: "failed",
      errorMessage: "Media upload error",
      failedAt: new Date(timestamp),
    });
  });
  it("prefers delivery evidence regardless of callback order", () => {
    expect(
      applyWhatsAppReceipts({ status: "sent" }, [
        receipt("read"),
        receipt("failed"),
        receipt("delivered"),
      ]),
    ).toMatchObject({ status: "read", errorMessage: null });
  });
  it("does not regress an already read message", () => {
    expect(
      applyWhatsAppReceipts({ status: "read" }, [
        receipt("sent"),
        receipt("failed"),
      ]),
    ).toBeNull();
  });
  it("ignores invalid timestamps and unrelated events", () => {
    expect(
      applyWhatsAppReceipts({ status: "sent" }, [
        { ...receipt("failed"), timestamp: "invalid" },
      ]),
    ).toBeNull();
    expect(
      applyWhatsAppReceipts({ status: "sent" }, [receipt("other")]),
    ).toBeNull();
  });
});
