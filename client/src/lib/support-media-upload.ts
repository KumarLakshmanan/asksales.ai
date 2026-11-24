const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function galleryUploadBatches(files: File[]): Array<{ files: File[]; offset: number }> {
  if (!files.length || files.length > 50) throw new Error('Choose between 1 and 50 images.');
  const batches: Array<{ files: File[]; offset: number }> = [];
  let batch: File[] = [], size = 0, offset = 0;
  for (const file of files) {
    if (!TYPES.has(file.type) || !file.size || file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: choose a JPEG, PNG, or WebP image up to 5 MB.`);
    if (batch.length === 5 || size + file.size > MAX_REQUEST_BYTES) {
      batches.push({ files: batch, offset });
      offset += batch.length;
      batch = []; size = 0;
    }
    batch.push(file); size += file.size;
  }
  if (batch.length) batches.push({ files: batch, offset });
  return batches;
}

export interface GalleryUploadResult {
  assets?: Array<{ publication_state: string }>;
  outcomes?: Array<{ index: number; status: string; error?: string }>;
}

export async function uploadGalleryFiles(
  files: File[], metadata: unknown[],
  send: (payload: FormData) => Promise<GalleryUploadResult>,
  progress?: (completed: number) => void,
): Promise<GalleryUploadResult> {
  const result: GalleryUploadResult = { assets: [], outcomes: [] };
  for (const batch of galleryUploadBatches(files)) {
    const payload = new FormData();
    batch.files.forEach(file => payload.append('images', file));
    payload.append('metadata', JSON.stringify(metadata.slice(batch.offset, batch.offset + batch.files.length)));
    const uploaded = await send(payload);
    result.assets!.push(...(uploaded.assets || []));
    result.outcomes!.push(...(uploaded.outcomes || []).map(outcome => ({ ...outcome, index: outcome.index + batch.offset })));
    progress?.(batch.offset + batch.files.length);
  }
  return result;
}
