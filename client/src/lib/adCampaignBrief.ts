export function adCampaignBrief(asset: { id: number; type: string; title: string; content: string; channel?: string; imageUrls?: string[]; videoUrls?: string[] }) {
  if (asset.type !== 'ad_copy') throw new Error('Choose a saved ad-copy draft.');
  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(asset.content);
    content = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { primaryText: asset.content };
  } catch { content = { primaryText: asset.content }; }
  const lines = [
    'Help me prepare an ad campaign using the reviewed draft below. Do not launch, publish, or spend money. First confirm platform, connected ad account, audience, budget, schedule, destination and policy checks.',
    `Saved content asset: ${asset.id}`, `Title: ${asset.title}`, `Platform: ${asset.channel || content.platform || 'Choose platform'}`,
    `Headline: ${content.headline || ''}`, `Copy: ${content.primaryText || content.body || ''}`,
    `Description: ${content.description || ''}`, `CTA: ${content.callToAction || ''}`, `Landing page: ${content.displayUrl || ''}`,
  ];
  if (Array.isArray(content.headlines)) lines.push(`Headline alternatives: ${content.headlines.join(' | ')}`);
  if (asset.imageUrls?.length) lines.push(`Images: ${asset.imageUrls.join(', ')}`);
  if (asset.videoUrls?.length) lines.push(`Videos: ${asset.videoUrls.join(', ')}`);
  return lines.join('\n');
}
