export const FOLLOW_UP_CHANNELS = ['email', 'whatsapp', 'instagram', 'facebook', 'sms'] as const;
export type FollowUpChannel = typeof FOLLOW_UP_CHANNELS[number];

export function isFollowUpChannel(value: string): value is FollowUpChannel {
  return (FOLLOW_UP_CHANNELS as readonly string[]).includes(value);
}

export function followUpTemplateType(channel: FollowUpChannel): string {
  return channel === 'instagram' || channel === 'facebook' ? 'social_message' : channel;
}
