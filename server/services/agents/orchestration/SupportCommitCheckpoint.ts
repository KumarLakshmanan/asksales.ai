import { AsyncLocalStorage } from 'node:async_hooks';

const checkpoints = new AsyncLocalStorage<() => Promise<void>>();
/** Recovery has its own lease because it runs after the original worker exited. */
export function withSupportCommitCheckpoint<T>(checkpoint: () => Promise<void>, work: () => Promise<T>) {
  return checkpoints.run(checkpoint, work);
}
export async function checkpointSupportCommit() {
  const { assertAssistantFresh } = await import('../../assistants/AssistantFreshness.js');
  await assertAssistantFresh();
  await checkpoints.getStore()?.();
}
