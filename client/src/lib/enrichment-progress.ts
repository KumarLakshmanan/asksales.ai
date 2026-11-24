export type EnrichmentPhase = 'started' | 'progress' | 'completed' | 'failed';
export interface EnrichmentProgress {
  runId: number;
  status: EnrichmentPhase;
  iteration?: number;
  platform?: string;
  identifier?: string;
  total?: number;
  receivedAt: number;
}
export type EnrichmentProgressState = Record<number, EnrichmentProgress>;

/** Never assign an uncorrelated event to whichever result happens to be open. */
export function updateEnrichmentProgress(state: EnrichmentProgressState, phase: EnrichmentPhase, data: Record<string, unknown>): EnrichmentProgressState {
  if (data.toolName !== 'deep_enrichment' && data.toolName !== 'handle_enrichment') return state;
  const runId = typeof data.runId === 'number' ? data.runId : null;
  if (!runId || !Number.isSafeInteger(runId) || runId < 1) return state;
  const previous = state[runId];
  if (previous?.status === 'completed' || previous?.status === 'failed') return state;
  return { ...state, [runId]: {
    runId, status: phase, receivedAt: Date.now(),
    iteration: typeof data.iteration === 'number' ? data.iteration : previous?.iteration,
    platform: typeof data.platform === 'string' ? data.platform : previous?.platform,
    identifier: typeof data.identifier === 'string' ? data.identifier : previous?.identifier,
    total: typeof data.total === 'number' ? data.total : previous?.total,
  } };
}

/** Stale activity is unknown, not proof that a provider failed or stopped. */
export function hasStaleEnrichmentActivity(run: { status: string; startedAt?: string; createdAt: string; steps?: { createdAt: string }[] }, progress?: EnrichmentProgress | null, now = Date.now()): boolean {
  if (!['running', 'pending'].includes(run.status)) return false;
  const dates = [run.startedAt, run.createdAt, ...(run.steps || []).map(step => step.createdAt)]
    .map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
  const latest = Math.max(0, ...dates, progress?.receivedAt || 0);
  return latest > 0 && now - latest > 15 * 60 * 1000;
}
