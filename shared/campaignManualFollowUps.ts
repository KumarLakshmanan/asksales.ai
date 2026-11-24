import type { InboxChannel } from "./outreachInbox.js";
import type { OutreachFollowUp } from "./outreachCompose.js";

/** These IDs are separate namespaces; a campaign workspace is a chat_threads row. */
export interface ManualCampaignIdentity {
  kind: "chat_thread" | "outreach_campaign";
  id: number;
}
export interface ManualSequenceStep {
  delayMinutes: number;
  templateId: number;
}
export interface ManualSequence {
  campaign: ManualCampaignIdentity;
  channel: InboxChannel;
  version: number;
  mode: "manual" | "off";
  steps: Array<
    ManualSequenceStep & { templateVersion: number; templateName: string }
  >;
}
export interface ManualEnrollment {
  version: 1;
  campaign: ManualCampaignIdentity;
  channel: InboxChannel;
  sequenceVersion: number;
  sequenceChecksum: string;
  reviewId: string;
  businessProfileId: number;
  userId: number;
  leadId: number;
  recipient: string;
  steps: Array<
    OutreachFollowUp & {
      sourceTemplateId: number;
      sourceTemplateVersion: number;
    }
  >;
}
export interface ManualReview {
  reviewId: string;
  sequence: ManualSequence;
  recipients: Record<
    string,
    { recipient: string; steps: ManualEnrollment["steps"] }
  >;
}

export const MANUAL_SEQUENCE_MAX_STEPS = 3;
export const MANUAL_SEQUENCE_MAX_DELAY_MINUTES = 129600;
export type ManualSequenceStepsProblem = "steps" | "template" | "delay";
/**
 * Why a campaign sequence cannot be saved, or null when it can. Shared so the
 * editor checks the same rule the server enforces before anyone clicks Save.
 */
export function manualSequenceStepsProblem(mode: unknown, steps: unknown): ManualSequenceStepsProblem | null {
  if (!["manual", "off"].includes(String(mode)) || !Array.isArray(steps) || steps.length > MANUAL_SEQUENCE_MAX_STEPS
    || (mode === "manual" && !steps.length) || (mode === "off" && steps.length))
    return "steps";
  let previous = 0;
  for (const step of steps as Array<Partial<ManualSequenceStep> | null>) {
    if (!step || !Number.isSafeInteger(step.templateId) || Number(step.templateId) < 1) return "template";
    if (!Number.isSafeInteger(step.delayMinutes) || Number(step.delayMinutes) <= previous
      || Number(step.delayMinutes) > MANUAL_SEQUENCE_MAX_DELAY_MINUTES)
      return "delay";
    previous = Number(step.delayMinutes);
  }
  return null;
}
