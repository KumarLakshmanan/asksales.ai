import { reviewedMediaPrompts } from './ReviewedMediaBudget.js';

/** Queue requested videos only after a durable parent exists. Provider work is worker-only. */
export async function queueSavedContentVideos(options: {
  userId: number;
  threadId?: number;
  parentAssetId: number;
  assetType: string;
  prompts: string[];
  maxVideos?: number;
  provider?: 'google' | 'openrouter';
  model?: string;
  operationName?: string;
  brandContext?: string;
  brandLogoUrl?: string | null;
  videoConfig?: Record<string, unknown>;
  image?: { base64Data: string; mimeType: string };
}): Promise<{ status: 'queued' | 'partial_success' | 'failed'; jobIds: string[]; errors: string[] }> {
  if (!Number.isSafeInteger(options.parentAssetId) || options.parentAssetId <= 0) {
    throw new Error('Save the parent content before requesting video generation.');
  }
  const boundedPrompts = reviewedMediaPrompts(options.prompts, options.maxVideos ?? 4);
  const { jobDispatcher } = await import('../../queues/JobDispatcher.js');
  const jobIds: string[] = [];
  const errors: string[] = [];
  const { prompts: _prompts, maxVideos: _maximum, ...common } = options;
  const prompts = boundedPrompts;
  if (!prompts.length) errors.push('No video prompt was generated.');
  for (const [index, prompt] of prompts.entries()) {
    try {
      const job = await jobDispatcher.dispatch('generate_video', { ...common, prompt }, {
        jobId: `content-video-${options.parentAssetId}-${index}`,
      });
      jobIds.push(job.jobId);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Video generation could not be queued.');
    }
  }
  return { status: errors.length ? jobIds.length ? 'partial_success' : 'failed' : 'queued', jobIds, errors };
}
