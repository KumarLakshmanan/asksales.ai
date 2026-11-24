import type { FollowUpChannel } from "./followUpChannels.js";
import type { TemplateRenderContext } from "./templateRenderContext.js";

/** The single reviewed producer/consumer record for a configured follow-up.
 * Capture versions used for rendering; later reads may validate, never replace them. */
export interface FollowUpProvenance {
  version: 1;
  userId: number;
  businessProfileId: number;
  channel: FollowUpChannel;
  originTable: "outreach_messages" | "sent_messages";
  originMessageId: number;
  step: number;
  settingsRevision: string;
  templateId?: number;
  templateVersion?: number;
  templateRenderContext?: TemplateRenderContext;
}
