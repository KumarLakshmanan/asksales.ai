const supported = new Set(['linkedin', 'twitter', 'facebook', 'instagram']);

/** A preview override is explicit; otherwise respect the saved asset channel. */
export function socialPreviewPlatform(override: string | null, channel: string): string {
  if (override && supported.has(override)) return override;
  return supported.has(channel) ? channel : 'linkedin';
}
