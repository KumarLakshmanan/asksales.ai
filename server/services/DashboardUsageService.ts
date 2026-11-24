import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';

/** Admin-only caller supplies platform scope. Aggregate every matching record
 * in the database instead of presenting a capped 5,000-row sample as a total. */
export async function dashboardUsage(start: Date, executor: Pick<typeof db, 'execute'> = db) {
  const aggregate = async (table: string, countKey: string, fields: Record<string, string>, provider?: string) => {
    const columns = Object.entries(fields).map(([key, column]) => sql`COALESCE(sum(${sql.identifier(column)}),0) AS ${sql.identifier(key)}`);
    const result = await executor.execute(sql`SELECT count(*) AS ${sql.identifier(countKey)}, ${sql.join(columns, sql`, `)}
      FROM ${sql.identifier(table)} WHERE created_at>=${start.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      ${provider ? sql`AND ${provider === 'openai' ? sql`(provider='openai' OR provider IS NULL)` : sql`provider=${provider}`}` : sql``}`);
    const row = result.rows[0] || {};
    return Object.fromEntries([countKey, ...Object.keys(fields)].map(key => [key, Number(row[key] || 0)]));
  };
  const llm = { totalCostCents: 'estimated_cost_cents', totalTokens: 'total_tokens', promptTokens: 'prompt_tokens', completionTokens: 'completion_tokens' };
  const [openai, openrouter, apify, gemini, zerobounce] = await Promise.all([
    aggregate('openai_usages', 'totalCalls', llm, 'openai'),
    aggregate('openai_usages', 'totalCalls', llm, 'openrouter'),
    aggregate('apify_usages', 'totalRuns', { totalCostCents: 'estimated_cost_cents', totalComputeUnits: 'compute_units', totalItemsScraped: 'items_scraped' }),
    aggregate('gemini_usages', 'totalRequests', { totalCostCents: 'cost_cents', totalImages: 'images_generated', totalVideos: 'videos_generated' }),
    aggregate('zerobounce_usages', 'totalRequests', { totalCostCents: 'cost_cents', totalEmailsValidated: 'emails_validated', totalValidEmails: 'valid_emails', totalCreditsUsed: 'credits_used' }),
  ]);
  return { openai, openrouter, apify, gemini, zerobounce };
}
