import { AsyncLocalStorage } from "node:async_hooks";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../models/db.js";
export class SetupAnalysisCancelled extends Error {}
type Progress = (
  stage: string,
  detail: string,
  extra?: Record<string, unknown>,
) => Promise<void>;
export type SetupAnalysisExecutor = Pick<NodePgDatabase, "insert" | "update">;
type Commit = <T>(work: (executor: SetupAnalysisExecutor) => Promise<T>) => Promise<T>;
const analysisContext = new AsyncLocalStorage<{
  progress: Progress;
  commit?: Commit;
}>();
export function withSetupAnalysisProgress<T>(
  progress: Progress,
  work: () => Promise<T>,
  commit?: Commit,
) {
  return analysisContext.run({ progress, commit }, work);
}
export async function updateSetupAnalysisProgress(
  stage: string,
  detail: string,
  extra?: Record<string, unknown>,
) {
  await analysisContext.getStore()?.progress(stage, detail, extra);
}

export async function withSetupAnalysisCommit<T>(
  work: (executor: SetupAnalysisExecutor) => Promise<T>,
): Promise<T> {
  const commit = analysisContext.getStore()?.commit;
  return commit ? commit(work) : work(db);
}
