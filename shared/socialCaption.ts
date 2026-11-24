/** The exact text shown in previews and checked against platform limits. */
export function composeSocialCaption(value: Record<string, unknown>): string {
  let caption = String(value.caption || value.content || value.body || value.text || value.message || '');
  const ctaValue = value.callToAction || value.call_to_action || value.cta;
  const cta = typeof ctaValue === 'string' ? ctaValue.trim() : '';
  if (cta && !caption.includes(cta)) caption += `${caption ? '\n\n' : ''}${cta}`;
  const tags = Array.isArray(value.hashtags) ? value.hashtags : typeof value.hashtags === 'string' ? value.hashtags.split(/[\s,]+/) : [];
  const existing = new Set((caption.match(/#[\p{L}\p{N}_]+/gu) || []).map(tag => tag.toLowerCase()));
  const missing = tags.filter((tag): tag is string => typeof tag === 'string').map(tag => `#${tag.trim().replace(/^#+/, '')}`).filter(tag => {
    if (tag === '#' || existing.has(tag.toLowerCase())) return false;
    existing.add(tag.toLowerCase());
    return true;
  });
  if (missing.length) caption += `${caption ? '\n\n' : ''}${missing.join(' ')}`;
  return caption;
}
