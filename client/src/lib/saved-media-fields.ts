type SavedMediaFields = { prompt?: string; performance?: Record<string, unknown> };

/** The generation prompt saved on a media asset: performance.prompt first, then prompt. */
export function extractPrompt(asset: SavedMediaFields): string {
  const perf = asset.performance || {};
  return typeof perf.prompt === "string" ? perf.prompt : asset.prompt || "";
}

/** The style saved in a media asset's performance data, or "". */
export function extractStyle(asset: SavedMediaFields): string {
  const perf = asset.performance || {};
  return typeof perf.style === "string" ? perf.style : "";
}
