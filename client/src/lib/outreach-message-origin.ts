import type { OutreachMessage } from "@/components/outreach/types";

const APP_NAMES: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", whatsapp: "WhatsApp" };

/**
 * The line shown above an outbound message saying how it was sent, e.g.
 * "AskSales outreach · Diwali launch · Template diwali_offer · Follow-up 2" or
 * "Sent from the WhatsApp Business app (phone or web)". Older payloads without
 * `origin` fall back to the phone-app provenance in metadata only.
 */
export function messageOriginText(message: OutreachMessage, channel: string): string | null {
  const origin = message.origin;
  if (!origin) {
    const raw = message.metadata?.origin;
    if (raw === "native_app") return `Sent from ${APP_NAMES[channel] || "social app"}`;
    if (raw === "external_app") return "Sent from connected app";
    return null;
  }
  const parts = [origin.label];
  if (origin.outreachName) parts.push(origin.outreachName);
  if (origin.templateName) parts.push(`Template ${origin.templateName}`);
  if (origin.followUpStep) parts.push(`Follow-up ${origin.followUpStep}`);
  return parts.join(" · ");
}
