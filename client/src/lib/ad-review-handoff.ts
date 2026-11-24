/** A card click requests preparation only; it never authorizes provider mutations. */
export function adReviewHandoff(ads: ReadonlyArray<{ id: string; version?: number }>): string {
  if (!ads.length) throw new Error('Select at least one saved ad creative.');
  const assets = ads.map(ad => {
    if (!/^db-[1-9]\d*$/.test(ad.id)) throw new Error('Save every selected creative before preparing a campaign review.');
    const assetId = Number(ad.id.slice(3));
    if (!Number.isSafeInteger(assetId)) throw new Error('Invalid saved creative ID.');
    return { assetId, displayedRevision: ad.version ?? null };
  });
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) {
    throw new Error('Select each creative only once.');
  }
  return `Prepare a saved performance campaign draft and final review using only these selected content assets: ${JSON.stringify(assets)}. Verify the current saved creative revisions and show the exact revisions in the review. Ask me for any missing platforms, provider accounts, budget, destination, or schedule. Do not substitute other assets, publish, activate, or begin spend. Wait for my explicit approval of the saved final review.`;
}
