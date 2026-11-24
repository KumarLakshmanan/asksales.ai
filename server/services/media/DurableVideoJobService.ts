import { UnrecoverableError } from 'bullmq';

type VideoResult = {
  success: boolean; status?: string; operationName?: string; videoUrl?: string; error?: string;
  provider?: string; model?: string;
};

/** Persist provider identity/results before any attachment or event can fail. */
export async function runDurableVideoJob<T extends VideoResult>(job: {
  data: Record<string, unknown>;
  updateData(data: Record<string, unknown>): Promise<void>;
}, generate: (operationName?: string) => Promise<T>): Promise<T> {
  if (job.data.completedVideoResult) return job.data.completedVideoResult as T;
  const operationName = typeof job.data.operationName === 'string' ? job.data.operationName : undefined;
  if (!operationName && job.data.videoSubmissionStarted) {
    throw new UnrecoverableError('Video submission outcome is unknown. Reconcile the provider request before retrying; no duplicate generation was started.');
  }
  if (!operationName) {
    job.data.videoSubmissionStarted = true;
    await job.updateData(job.data);
  }
  const result = await generate(operationName);
  if (result.operationName) job.data.operationName = result.operationName;
  if (result.provider) job.data.provider = result.provider;
  if (result.model) job.data.model = result.model;
  if (result.success && result.videoUrl) job.data.completedVideoResult = result;
  await job.updateData(job.data);
  return result;
}
