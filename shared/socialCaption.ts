/**
 * Hashtags from `hashtags` that the caption does not already contain, each
 * with a single leading `#`, in order and without repeats. Generated posts often
 * end their caption with the same tags that are also returned as a list.
 */
export function hashtagsMissingFromCaption(caption: string, hashtags: unknown): string[] {
  const tags = Array.isArray(hashtags) ? hashtags : typeof hashtags === 'string' ? hashtags.split(/[\s,]+/) : [];
  const existing = new Set((caption.match(/#[\p{L}\p{N}_]+/gu) || []).map(tag => tag.toLowerCase()));
  return tags.filter((tag): tag is string => typeof tag === 'string').map(tag => `#${tag.trim().replace(/^#+/, '')}`).filter(tag => {
    if (tag === '#' || existing.has(tag.toLowerCase())) return false;
    existing.add(tag.toLowerCase());
    return true;
  });
}

/** The exact text shown in previews and checked against platform limits. */
export function composeSocialCaption(value: Record<string, unknown>): string {
  let caption = String(value.caption || value.content || value.body || value.text || value.message || '');
  const ctaValue = value.callToAction || value.call_to_action || value.cta;
  const cta = typeof ctaValue === 'string' ? ctaValue.trim() : '';
  if (cta && !caption.includes(cta)) caption += `${caption ? '\n\n' : ''}${cta}`;
  const missing = hashtagsMissingFromCaption(caption, value.hashtags);
  if (missing.length) caption += `${caption ? '\n\n' : ''}${missing.join(' ')}`;
  return caption;
}
