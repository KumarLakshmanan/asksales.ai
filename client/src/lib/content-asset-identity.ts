/** UI IDs carry a db- prefix; provider-facing requests require exact saved IDs. */
export function savedContentAssetId(value: string): number {
  const match = /^(?:db-)?([1-9]\d*)$/.exec(value);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id)) throw new Error('Save the content before attaching media.');
  return id;
}

export function requireAttachedMediaReceipt(response: { assetId?: number; persisted?: boolean }, parentId: number): void {
  if (response.persisted !== true || response.assetId !== parentId) {
    throw new Error('Media was not confirmed attached to this content. Reload before trying again.');
  }
}

export function attachedVideoOutcome(response: { success?: boolean; assetId?: number; persisted?: boolean; videoUrl?: string; operationName?: string }, parentId: number): 'saved' | 'queued' {
  if (response.success !== true) throw new Error('Video generation failed.');
  requireAttachedMediaReceipt(response, parentId);
  if (typeof response.videoUrl === 'string' && response.videoUrl.trim()) return 'saved';
  if (typeof response.operationName === 'string' && response.operationName.trim()) return 'queued';
  throw new Error('No saved video or trackable generation operation was returned.');
}
