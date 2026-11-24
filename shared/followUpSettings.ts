/** Stored step IDs are opaque; older clients also use positive numeric IDs. */
export type FollowUpStepId = string | number;
export function isFollowUpStepId(value: unknown): value is FollowUpStepId {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && value.length <= 100 && value.trim().length > 0);
}
export interface FollowUpSettingsStep {
  id: FollowUpStepId;
  /** Omitted only by pre-DTO clients, whose submitted rows were all enabled. */
  enabled?: boolean;
  delayValue: number;
  delayUnit: 'minutes' | 'hours' | 'days';
  delayHours?: number;
  templateId: number | null;
  templateName: string;
}
export interface ChannelFollowUpSettingsDTO {
  revision?: string;
  fenced?: boolean;
  enableAutoFollowUp: boolean;
  followUpSteps: FollowUpSettingsStep[];
}
