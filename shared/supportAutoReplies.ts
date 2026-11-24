export const SUPPORT_REPLY_PLATFORMS = ['instagram', 'facebook', 'email', 'whatsapp', 'web'] as const;
export type SupportReplyPlatform = typeof SUPPORT_REPLY_PLATFORMS[number];
export type PlatformAutoReplies = Partial<Record<SupportReplyPlatform, boolean>>;

export interface SupportReplyConfiguration {
  channelScope?: unknown;
  metadata?: unknown;
}

/** Legacy empty scopes mean all channels; explicit platform switches take precedence. */
export function supportAutoReplyEnabled(config: SupportReplyConfiguration, channel: string): boolean {
  const platform = channel.replace(/_comment$/, '') as SupportReplyPlatform;
  const metadata = config.metadata as { platformAutoReplies?: PlatformAutoReplies } | null | undefined;
  const override = metadata?.platformAutoReplies?.[platform];
  if (typeof override === 'boolean') return override;
  const scope = Array.isArray(config.channelScope) ? config.channelScope : [];
  return scope.length === 0 || scope.includes(channel) || scope.includes(platform);
}
