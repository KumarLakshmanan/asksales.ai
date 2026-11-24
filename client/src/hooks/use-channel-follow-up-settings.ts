"use client";

import type { ChannelFollowUpSettingsDTO } from "../../../shared/followUpSettings";

export type ChannelFollowUpSettings = ChannelFollowUpSettingsDTO;

/** Compare effective delays without mistaking equivalent hour/day representations. */
export function followUpSettingsFingerprint(settings: ChannelFollowUpSettings | null, includeNames = true): string | null {
  return settings ? JSON.stringify({ enabled: settings.enableAutoFollowUp, steps: settings.followUpSteps.map(step => ({
    id: step.id, enabled: step.enabled !== false, minutes: step.delayValue * (step.delayUnit === 'days' ? 1440 : step.delayUnit === 'hours' ? 60 : 1),
    templateId: step.templateId ?? null, ...(includeNames ? { templateName: (step.templateName || '').trim().slice(0, 200) } : {}),
  })) }) : null;
}

