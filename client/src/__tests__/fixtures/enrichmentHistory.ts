export const stepStatuses = ['completed', 'failed', 'running', 'pending'] as const;
export const stepDurations: (number | null | undefined)[] = [null, 0, 1250, undefined];

const stepTypes = ['actor_run', 'llm_extraction', 'handle_discovery', 'lead_update'];
export const historySteps = stepStatuses.flatMap((status, statusIndex) => stepDurations.map((durationMs, durationIndex) => {
  const id = statusIndex * stepDurations.length + durationIndex + 1;
  return {
    id, runId: 901, stepNumber: id, stepType: stepTypes[durationIndex], status, durationMs,
    identifier: `synthetic-step-${id}`, createdAt: '2026-10-11T00:00:00Z',
    errorMessage: status === 'failed' ? 'Synthetic recorded step failure' : null,
  };
}));

export function historyRun(status = 'completed', id = 901, createdAt = new Date().toISOString()) {
  return {
    id, userId: 4101, leadName: `Synthetic ${status} history`, status, createdAt, startedAt: createdAt,
    completedAt: status === 'completed' ? createdAt : null, summary: {},
    steps: historySteps.map(step => ({ ...step, runId: id, createdAt })),
  };
}

export function ordinaryHistoryRun(status: 'running' | 'pending', id: number, createdAt = new Date().toISOString()) {
  const run = historyRun(status, id, createdAt);
  const indexes = status === 'running' ? [0, 1, 8, 12] : [12, 13];
  return { ...run, steps: indexes.map(index => run.steps[index]) };
}
