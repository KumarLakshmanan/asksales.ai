import type { Logger } from 'pino';

export interface MaintenanceStep {
  name: string;
  run: () => Promise<unknown>;
}

export interface MaintenanceRun {
  results: Record<string, unknown>;
  failed: string[];
}

/** Runs every step even when an earlier one throws, so one broken check
 * (for example SLA detection) cannot stop privacy purges or delivery
 * recovery. Each failure is logged with its own error; the caller decides
 * whether the overall job fails. */
export async function runMaintenanceSteps(steps: MaintenanceStep[], log: Pick<Logger, 'error'>): Promise<MaintenanceRun> {
  const results: Record<string, unknown> = {};
  const failed: string[] = [];
  for (const step of steps) {
    try {
      results[step.name] = await step.run();
    } catch (error) {
      failed.push(step.name);
      log.error({ err: error, step: step.name }, 'Support maintenance step failed');
    }
  }
  return { results, failed };
}

/** Fail the job after all steps ran, so the queue still records the failure. */
export function assertMaintenanceSucceeded(job: string, run: MaintenanceRun): void {
  if (run.failed.length) throw new Error(`${job}: ${run.failed.length} step(s) failed (${run.failed.join(', ')}); the remaining steps completed.`);
}
