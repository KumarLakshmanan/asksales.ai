import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

export interface InsightsRuntime { enabled: boolean; pricingGuardEnabled: boolean; instrumentationStartedAt: string | null }
let cached: { value: InsightsRuntime; expires: number } | undefined;
export function clearInsightsRuntimeCache() { cached = undefined; }
export async function getInsightsRuntime(): Promise<InsightsRuntime> {
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const result = await db.execute(sql`SELECT enabled,pricing_guard_enabled,instrumentation_started_at FROM workspace_insights_runtime WHERE id=1`);
    const row = result.rows[0];
    const value = { enabled: row?.enabled === true, pricingGuardEnabled: row?.pricing_guard_enabled === true,
      instrumentationStartedAt: row?.instrumentation_started_at instanceof Date
        ? row.instrumentation_started_at.toISOString() : row?.instrumentation_started_at ? String(row.instrumentation_started_at) : null };
    cached = { value, expires: Date.now() + 15_000 };
    return value;
  } catch (error) {
    const databaseError=error as {code?:string;cause?:{code?:string}};
    if ((databaseError?.code ?? databaseError?.cause?.code) !== '42P01') throw error;
    return { enabled: false, pricingGuardEnabled: false, instrumentationStartedAt: null };
  }
}
